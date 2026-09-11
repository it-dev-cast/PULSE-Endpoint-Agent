package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
)

// PRD §9 Self-Healing - real v1 remote dispatch. See schema.sql's own comment on device_commands
// for how this relates to the immutable events log (this table is current dispatch status, not a
// second audit trail) and telemetry-server.mjs's own PRD §9 comment for the 6 real remediation
// actions this dispatches to, unchanged.

// knownRemediationActions mirrors telemetry-server.mjs's REMEDIATION_ACTIONS keys exactly - the
// backend validates against the same real, fixed vocabulary rather than accepting any string (
// unlike approval_requests' Action, which is intentionally free-form since that table gates
// whatever the device itself decides to ask permission for, not a backend-dispatched action).
// "run-custom-command" is the one exception to "fixed vocabulary" in spirit - only the ACTION
// TYPE is whitelisted here, the actual script text travels in Params below and is intentionally
// unconstrained (see runCustomCommand's own comment in telemetry-server.mjs on why there's
// nothing to sanitize without defeating the feature).
var knownRemediationActions = map[string]bool{
	"flush-dns":                true,
	"clean-temp":               true,
	"restart-service":          true,
	"clear-teams-cache":        true,
	"repair-vpn":               true,
	"collect-bsod-diagnostics": true,
	"run-custom-command":       true,
}

// maxCustomCommandTextLength bounds the admin-supplied script text stored in Params - generous
// enough for a real multi-line remediation script, small enough to keep the JSONB column and the
// audit-event message it gets summarized into bounded.
const maxCustomCommandTextLength = 8000

type DeviceCommand struct {
	ID          string  `json:"id"`
	TenantID    string  `json:"tenantId"`
	DeviceID    string  `json:"deviceId"`
	Action      string  `json:"action"`
	Status      string  `json:"status"`
	Result      *string `json:"result"`
	CreatedAt   string  `json:"createdAt"`
	CompletedAt *string `json:"completedAt"`
	// Params is opaque, raw JSON text - only "run-custom-command" populates it today (see
	// customCommandParams below), but it's generic on purpose so a future parameterized action
	// doesn't need its own column/migration.
	Params *string `json:"params,omitempty"`
}

// customCommandParams is the one currently-defined shape for DeviceCommand.Params, used only
// when Action == "run-custom-command". Actor is a free-text label the admin dashboard asks for,
// NOT a real authenticated identity - this backend's admin auth has no per-user identity to
// attach instead (see auth.go's issueAdminToken, whose JWT subject is the fixed literal "admin").
// Honestly labeled as such in the dashboard UI, not presented as real attribution.
type customCommandParams struct {
	CommandText string `json:"commandText"`
	Actor       string `json:"actor"`
}

func insertDeviceCommand(db *DB, id, tenantID, deviceID, action string, params *string, now time.Time) error {
	_, err := db.Exec(
		`INSERT INTO device_commands (id, tenant_id, device_id, action, status, params, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
		id, tenantID, deviceID, action, params, now.UTC().Format(time.RFC3339Nano),
	)
	return err
}

// isRemoteCommandExecutionAllowed is the double gate this feature's own design requires - both
// the tenant's own explicit opt-in (tenants.remote_command_execution_enabled, a deliberate second
// switch independent of the plan) AND the plan-tier entitlement itself must be true. Checked here
// (enqueue time) in addition to the agent's own fresh recheck before execution (see
// isRemoteCommandExecutionAllowed's JS namesake in telemetry-server.mjs) - unlike the existing 6
// remediation actions, which only ever check Self-Healing policy device-side, this one is
// deliberately re-verified server-side too: relying solely on a hidden UI button would mean
// anyone who could reach the API directly could bypass both gates, for a feature this dangerous.
func isRemoteCommandExecutionAllowed(db *DB, tenantID string) (bool, error) {
	enabled, err := getRemoteCommandExecutionEnabled(db, tenantID)
	if err != nil || !enabled {
		return false, err
	}
	entitlement, err := getEntitlementByTenant(db, tenantID)
	if err != nil {
		return false, err
	}
	features, err := getPlanFeatures(db, entitlement.Plan)
	if err != nil {
		return false, err
	}
	for _, f := range features {
		if f.Feature == "Remote Command Execution" {
			return f.Included, nil
		}
	}
	return false, nil
}

// hasPendingCommand backs the one-pending-command-at-a-time v1 constraint (see
// handleEnqueueCommand) - a real, current DB check rather than trusting client-side state, since
// two admin tabs (or an admin and a retry) could otherwise both believe nothing is pending.
func hasPendingCommand(db *DB, deviceID string) (bool, error) {
	var found int
	err := db.QueryRow(`SELECT 1 FROM device_commands WHERE device_id = ? AND status = 'pending' LIMIT 1`, deviceID).Scan(&found)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// getOldestPendingCommand is what handleHeartbeat polls - FIFO by created_at, though v1's
// one-pending-at-a-time constraint means there's never more than one row to choose from anyway.
func getOldestPendingCommand(db *DB, deviceID string) (*DeviceCommand, error) {
	var c DeviceCommand
	err := db.QueryRow(
		`SELECT id, tenant_id, device_id, action, status, result, created_at, completed_at, params
		 FROM device_commands WHERE device_id = ? AND status = 'pending' ORDER BY created_at ASC LIMIT 1`,
		deviceID,
	).Scan(&c.ID, &c.TenantID, &c.DeviceID, &c.Action, &c.Status, &c.Result, &c.CreatedAt, &c.CompletedAt, &c.Params)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &c, nil
}

func getDeviceCommand(db *DB, id string) (*DeviceCommand, error) {
	var c DeviceCommand
	err := db.QueryRow(
		`SELECT id, tenant_id, device_id, action, status, result, created_at, completed_at, params FROM device_commands WHERE id = ?`,
		id,
	).Scan(&c.ID, &c.TenantID, &c.DeviceID, &c.Action, &c.Status, &c.Result, &c.CreatedAt, &c.CompletedAt, &c.Params)
	if err == sql.ErrNoRows {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &c, nil
}

var validCommandCompletionStatuses = map[string]bool{"succeeded": true, "failed": true, "blocked": true}

func completeDeviceCommand(db *DB, id, status, result string, now time.Time) error {
	_, err := db.Exec(
		`UPDATE device_commands SET status = ?, result = ?, completed_at = ? WHERE id = ?`,
		status, result, now.UTC().Format(time.RFC3339Nano), id,
	)
	return err
}

type enqueueCommandRequest struct {
	Action string          `json:"action"`
	Params json.RawMessage `json:"params,omitempty"`
}

// handleEnqueueCommand is the admin-facing dispatch entry point - "run action X on device Y."
// v1 deliberately rejects a second pending command for a device that already has one (409, same
// pattern handleApproveRequest already uses for "already X, not pending") rather than building
// queue-ordering UI - a real, disclosed v1 scope limit, not an oversight. Policy (is Self-Healing
// even included in this tenant's plan) is deliberately NOT checked here for the original 6
// actions - the device's own next poll re-checks that fresh (isSelfHealingAllowed in
// telemetry-server.mjs), the same single source of truth the local "Run Now" button already
// relies on. "run-custom-command" is the deliberate exception (see isRemoteCommandExecutionAllowed's
// own comment): checked here too, not just device-side, since this is arbitrary code execution,
// not one of six fixed, reviewed actions.
func handleEnqueueCommand(db *DB, hub *liveHub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		deviceID := chi.URLParam(r, "id")
		device, _, err := getDeviceByID(db, deviceID)
		if errors.Is(err, ErrNotFound) {
			writeError(w, http.StatusNotFound, "device not found")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		var req enqueueCommandRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || !knownRemediationActions[req.Action] {
			writeError(w, http.StatusBadRequest, "action must be one of: flush-dns, clean-temp, restart-service, clear-teams-cache, repair-vpn, collect-bsod-diagnostics, run-custom-command")
			return
		}

		var paramsToStore *string
		if req.Action == "run-custom-command" {
			allowed, err := isRemoteCommandExecutionAllowed(db, device.TenantID)
			if err != nil {
				writeError(w, http.StatusInternalServerError, "internal error")
				return
			}
			if !allowed {
				writeError(w, http.StatusForbidden, "Remote Command Execution is not enabled for this tenant - both the plan entitlement and the tenant's own settings toggle must be on")
				return
			}

			var custom customCommandParams
			if len(req.Params) == 0 || json.Unmarshal(req.Params, &custom) != nil {
				writeError(w, http.StatusBadRequest, "params.commandText and params.actor are required for run-custom-command")
				return
			}
			custom.CommandText = strings.TrimSpace(custom.CommandText)
			custom.Actor = strings.TrimSpace(custom.Actor)
			if custom.CommandText == "" {
				writeError(w, http.StatusBadRequest, "params.commandText must not be empty")
				return
			}
			if len(custom.CommandText) > maxCustomCommandTextLength {
				writeError(w, http.StatusBadRequest, fmt.Sprintf("params.commandText must be at most %d characters", maxCustomCommandTextLength))
				return
			}
			if custom.Actor == "" {
				writeError(w, http.StatusBadRequest, "params.actor is required - a name/initials for the audit trail (not a real authenticated identity, this backend has none - see issueAdminToken's own comment)")
				return
			}
			encoded, err := json.Marshal(custom)
			if err != nil {
				writeError(w, http.StatusInternalServerError, "internal error")
				return
			}
			s := string(encoded)
			paramsToStore = &s
		}

		pending, err := hasPendingCommand(db, device.ID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}
		if pending {
			writeError(w, http.StatusConflict, "a command is already pending for this device")
			return
		}

		id, err := newID("cmd")
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to generate command id")
			return
		}
		now := time.Now()
		if err := insertDeviceCommand(db, id, device.TenantID, device.ID, req.Action, paramsToStore, now); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to enqueue command")
			return
		}

		if eventID, err := newID("event"); err == nil {
			var msg string
			var eventType string
			// "warning" (not "info", unlike the six fixed remediation actions) even for the
			// request/success events - a custom command is inherently more sensitive than a
			// known-safe canned action, and should stand out in the event feed accordingly.
			severity := "info"
			if req.Action == "run-custom-command" {
				var custom customCommandParams
				_ = json.Unmarshal([]byte(*paramsToStore), &custom)
				preview := custom.CommandText
				if len(preview) > 200 {
					preview = preview[:200] + "…"
				}
				msg = fmt.Sprintf("Remote command requested by %s on %s (command %s): %s", custom.Actor, device.Hostname, id, preview)
				eventType = "remote-command-requested"
				severity = "warning"
			} else {
				msg = fmt.Sprintf("Remediation requested: %s on %s (command %s) - awaiting device pickup.", req.Action, device.Hostname, id)
				eventType = "remediation-requested-" + req.Action
			}
			event := Event{
				ID: eventID, TenantID: device.TenantID, DeviceID: device.ID,
				EventType: eventType, Message: msg, Severity: severity,
				CreatedAt: now.UTC().Format(time.RFC3339Nano),
			}
			if err := insertEvent(db, eventID, device.TenantID, device.ID, event.EventType, event.Message, event.Severity, now); err == nil {
				hub.publishEvent(device.TenantID, event)
			}
		}

		writeJSON(w, http.StatusCreated, DeviceCommand{
			ID: id, TenantID: device.TenantID, DeviceID: device.ID, Action: req.Action,
			Status: "pending", CreatedAt: now.UTC().Format(time.RFC3339Nano), Params: paramsToStore,
		})
	}
}

// handleGetDeviceCommand is the one new read endpoint this feature needs (see its own design
// note: the existing 6 remediation actions never needed this, since their result is a short
// summary that fits in the events feed's own message - a custom command's full stdout/stderr can
// be much larger, so the dashboard fetches it here on demand ("View full output") rather than
// stuffing it into the truncated event message). Admin-authenticated, tenant+device scoped - a
// command for a device outside this tenant (or a mismatched device/command pair) is a 404, same
// "don't reveal existence" reasoning as handleCompleteCommand's own device-ownership check.
func handleGetDeviceCommand(db *DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := chi.URLParam(r, "id")
		deviceID := chi.URLParam(r, "deviceId")
		commandID := chi.URLParam(r, "commandId")

		cmd, err := getDeviceCommand(db, commandID)
		if errors.Is(err, ErrNotFound) {
			writeError(w, http.StatusNotFound, "command not found")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}
		if cmd.DeviceID != deviceID || cmd.TenantID != tenantID {
			writeError(w, http.StatusNotFound, "command not found")
			return
		}

		writeJSON(w, http.StatusOK, cmd)
	}
}

type completeCommandRequest struct {
	Status string `json:"status"`
	Result string `json:"result"`
}

// handleCompleteCommand is device-authenticated and scoped to the calling device's own command,
// same "wrong device gets a 404, not a 403" reasoning as handleGetApprovalRequest - a device has
// no legitimate reason to learn that some other device's command exists at all.
func handleCompleteCommand(db *DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		device, ok := deviceFromContext(r)
		if !ok {
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		cmdID := chi.URLParam(r, "commandId")
		cmd, err := getDeviceCommand(db, cmdID)
		if errors.Is(err, ErrNotFound) {
			writeError(w, http.StatusNotFound, "command not found")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}
		if cmd.DeviceID != device.ID {
			writeError(w, http.StatusNotFound, "command not found")
			return
		}
		if cmd.Status != "pending" {
			writeError(w, http.StatusConflict, fmt.Sprintf("command is already %s, not pending", cmd.Status))
			return
		}

		var req completeCommandRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || !validCommandCompletionStatuses[req.Status] {
			writeError(w, http.StatusBadRequest, "status must be one of: succeeded, failed, blocked")
			return
		}

		if err := completeDeviceCommand(db, cmd.ID, req.Status, req.Result, time.Now()); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to record command result")
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	}
}
