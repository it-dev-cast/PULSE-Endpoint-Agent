package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
)

// PRD §9 Self-Healing - real v1 remote dispatch. See schema.sql's own comment on device_commands
// for how this relates to the immutable events log (this table is current dispatch status, not a
// second audit trail) and telemetry-server.mjs's own PRD §9 comment for the 3 real remediation
// actions this dispatches to, unchanged.

// knownRemediationActions mirrors telemetry-server.mjs's REMEDIATION_ACTIONS keys exactly - the
// backend validates against the same real, fixed vocabulary rather than accepting any string (
// unlike approval_requests' Action, which is intentionally free-form since that table gates
// whatever the device itself decides to ask permission for, not a backend-dispatched action).
var knownRemediationActions = map[string]bool{
	"flush-dns":       true,
	"clean-temp":      true,
	"restart-service": true,
}

type DeviceCommand struct {
	ID          string  `json:"id"`
	TenantID    string  `json:"tenantId"`
	DeviceID    string  `json:"deviceId"`
	Action      string  `json:"action"`
	Status      string  `json:"status"`
	Result      *string `json:"result"`
	CreatedAt   string  `json:"createdAt"`
	CompletedAt *string `json:"completedAt"`
}

func insertDeviceCommand(db *DB, id, tenantID, deviceID, action string, now time.Time) error {
	_, err := db.Exec(
		`INSERT INTO device_commands (id, tenant_id, device_id, action, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)`,
		id, tenantID, deviceID, action, now.UTC().Format(time.RFC3339Nano),
	)
	return err
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
		`SELECT id, tenant_id, device_id, action, status, result, created_at, completed_at
		 FROM device_commands WHERE device_id = ? AND status = 'pending' ORDER BY created_at ASC LIMIT 1`,
		deviceID,
	).Scan(&c.ID, &c.TenantID, &c.DeviceID, &c.Action, &c.Status, &c.Result, &c.CreatedAt, &c.CompletedAt)
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
		`SELECT id, tenant_id, device_id, action, status, result, created_at, completed_at FROM device_commands WHERE id = ?`,
		id,
	).Scan(&c.ID, &c.TenantID, &c.DeviceID, &c.Action, &c.Status, &c.Result, &c.CreatedAt, &c.CompletedAt)
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
	Action string `json:"action"`
}

// handleEnqueueCommand is the admin-facing dispatch entry point - "run action X on device Y."
// v1 deliberately rejects a second pending command for a device that already has one (409, same
// pattern handleApproveRequest already uses for "already X, not pending") rather than building
// queue-ordering UI - a real, disclosed v1 scope limit, not an oversight. Policy (is Self-Healing
// even included in this tenant's plan) is deliberately NOT checked here - the device's own next
// poll re-checks that fresh (isSelfHealingAllowed in telemetry-server.mjs), the same single
// source of truth the local "Run Now" button already relies on, so this endpoint doesn't need a
// second, potentially-stale copy of that policy check.
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
			writeError(w, http.StatusBadRequest, "action must be one of: flush-dns, clean-temp, restart-service")
			return
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
		if err := insertDeviceCommand(db, id, device.TenantID, device.ID, req.Action, now); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to enqueue command")
			return
		}

		if eventID, err := newID("event"); err == nil {
			msg := fmt.Sprintf("Remediation requested: %s on %s (command %s) - awaiting device pickup.", req.Action, device.Hostname, id)
			event := Event{
				ID: eventID, TenantID: device.TenantID, DeviceID: device.ID,
				EventType: "remediation-requested-" + req.Action, Message: msg, Severity: "info",
				CreatedAt: now.UTC().Format(time.RFC3339Nano),
			}
			if err := insertEvent(db, eventID, device.TenantID, device.ID, event.EventType, event.Message, event.Severity, now); err == nil {
				hub.publishEvent(device.TenantID, event)
			}
		}

		writeJSON(w, http.StatusCreated, DeviceCommand{
			ID: id, TenantID: device.TenantID, DeviceID: device.ID, Action: req.Action,
			Status: "pending", CreatedAt: now.UTC().Format(time.RFC3339Nano),
		})
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
