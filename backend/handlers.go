package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
)

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

// handleHealth is a plain liveness/readiness check - no auth, since a health probe that itself
// requires a working auth path can't distinguish "credentials wrong" from "actually down."
// Runs a trivial real query rather than just db.Ping(): a connection can be alive while the
// database file itself is missing/corrupted/locked in a way Ping alone wouldn't surface, and a
// query against a real table (tenants) exercises the same path every other real query does.
func handleHealth(db *DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var count int
		if err := db.QueryRow(`SELECT COUNT(*) FROM tenants`).Scan(&count); err != nil {
			log.Printf("health: tenants count query failed: %v", err)
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "error", "error": "database query failed"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	}
}

// Same constant pruneEventsForDevice uses - a live readout, not a second copied number.
func handleEventRetention() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]int{"eventRetentionDays": eventRetentionDays})
	}
}

type registerDeviceRequest struct {
	Hostname string `json:"hostname"`
}

type registerDeviceResponse struct {
	ID       string `json:"id"`
	TenantID string `json:"tenantId"`
	Hostname string `json:"hostname"`
	// The only time this plaintext value ever exists outside the caller's own hands - never
	// logged, never persisted (only its bcrypt hash is written to devices.api_key_hash).
	APIKey string `json:"apiKey"`
}

func handleRegisterDevice(db *DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req registerDeviceRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Hostname == "" {
			writeError(w, http.StatusBadRequest, "hostname is required")
			return
		}

		tenantID, err := getSingleTenantID(db)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "no tenant available")
			return
		}

		apiKey, err := generateAPIKey()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to generate api key")
			return
		}
		apiKeyHash, err := hashSecret(apiKey)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to secure api key")
			return
		}

		deviceID, err := newID("device")
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to generate device id")
			return
		}

		if err := insertDevice(db, deviceID, tenantID, req.Hostname, apiKeyHash, time.Now()); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to register device")
			return
		}

		writeJSON(w, http.StatusCreated, registerDeviceResponse{
			ID:       deviceID,
			TenantID: tenantID,
			Hostname: req.Hostname,
			APIKey:   apiKey,
		})
	}
}

// deviceFromContext retrieves the device deviceAuthMiddleware already fetched (and
// authenticated the bearer token against) - handlers behind that middleware don't re-query it.
func deviceFromContext(r *http.Request) (*Device, bool) {
	device, ok := r.Context().Value(deviceContextKey).(*Device)
	return device, ok
}

func handleHeartbeat(db *DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		device, ok := deviceFromContext(r)
		if !ok {
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		now := time.Now()
		if err := touchDeviceLastSeen(db, device.ID, now); err != nil {
			log.Printf("heartbeat: touchDeviceLastSeen failed for device %s: %v", device.ID, err)
			writeError(w, http.StatusInternalServerError, "failed to update heartbeat")
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{
			"status":     "ok",
			"lastSeenAt": now.UTC().Format(time.RFC3339),
		})
	}
}

// deviceCountInfo is real device-license usage for this tenant - used is a live COUNT(*),
// licensed is the real seat count the tenant purchased (entitlements.licensed_devices).
type deviceCountInfo struct {
	Used     int `json:"used"`
	Licensed int `json:"licensed"`
}

type entitlementResponse struct {
	Entitlement
	DeviceCount *deviceCountInfo `json:"deviceCount"`
	Features    []PlanFeature    `json:"features"`
	// DeviceStatus is this calling device's own real device-registry lifecycle state (see
	// schema.sql's own comment) - the honest source for a UI surface showing "is my device
	// still active." A device whose status is genuinely "revoked" can't reach this handler at
	// all (deviceAuthMiddleware rejects it first), so in practice this is always "active" - it's
	// still real data, not hardcoded, and correctly reflects the one lifecycle state that can
	// exist for a device that got this far.
	DeviceStatus string `json:"deviceStatus"`
	// WarrantyState is PRD Section 6.4's real, honest v1 (see warranty.go's own comment for
	// exactly which of the five PRD states this can and can't be) - "" when there isn't yet a
	// locked baseline to derive it from, never a fabricated default.
	WarrantyState string `json:"warrantyState"`
}

func handleGetEntitlement(db *DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		device, ok := deviceFromContext(r)
		if !ok {
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		entitlement, err := getEntitlementByTenant(db, device.TenantID)
		if errors.Is(err, ErrNotFound) {
			writeError(w, http.StatusNotFound, "no entitlement found for this device's tenant")
			return
		}
		if err != nil {
			log.Printf("entitlement: getEntitlementByTenant failed for tenant %s: %v", device.TenantID, err)
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		// The stored `status` column only reflects whatever was true at last write - recomputed
		// here from the real expires_at on every request, so a caller can never observe a
		// status that's silently drifted stale (see deriveEntitlementStatus's comment).
		var expiresAt *time.Time
		if entitlement.ExpiresAt != nil {
			if parsed, err := time.Parse(time.RFC3339Nano, *entitlement.ExpiresAt); err == nil {
				expiresAt = &parsed
			}
			// A genuinely unparseable expires_at is treated the same as absent below (deriveEntitlementStatus
			// falls back to the stored status) rather than failing the whole request over a
			// formatting problem in one field.
		}
		entitlement.Status = deriveEntitlementStatus(entitlement.Status, expiresAt, time.Now())

		usedCount, err := countDevicesByTenant(db, device.TenantID)
		if err != nil {
			log.Printf("entitlement: countDevicesByTenant failed for tenant %s: %v", device.TenantID, err)
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}
		// licensed_devices is nullable only for a database mid-upgrade before its backfill runs
		// (see ensureLicensedDevicesColumn in db.go) - deviceCount stays nil rather than
		// reporting a fabricated licensed figure in that narrow window.
		var deviceCount *deviceCountInfo
		if entitlement.LicensedDevices != nil {
			deviceCount = &deviceCountInfo{Used: usedCount, Licensed: *entitlement.LicensedDevices}
		}

		features, err := getPlanFeatures(db, entitlement.Plan)
		if err != nil {
			log.Printf("entitlement: getPlanFeatures failed for plan %s: %v", entitlement.Plan, err)
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		warrantyState, err := computeDeviceWarrantyState(db, device, entitlement.Status)
		if err != nil {
			log.Printf("entitlement: computeDeviceWarrantyState failed for %s: %v", device.ID, err)
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		writeJSON(w, http.StatusOK, entitlementResponse{
			Entitlement:   *entitlement,
			DeviceCount:   deviceCount,
			Features:      features,
			DeviceStatus:  device.Status,
			WarrantyState: warrantyState,
		})
	}
}

type createEventRequest struct {
	EventType string `json:"eventType"`
	Message   string `json:"message"`
	Severity  string `json:"severity"`
}

var validEventSeverities = map[string]bool{"info": true, "warning": true, "critical": true}

// handleCreateEvent appends one real, durable event for the authenticated device - the source
// of truth for AI Intel's Timeline/Insights cards. Device-authenticated, same pattern as
// heartbeat/entitlement: a device can only ever log an event under itself, not any other
// device, and tenant_id is derived from the device row rather than trusted from the request
// body.
func handleCreateEvent(db *DB, hub *liveHub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		device, ok := deviceFromContext(r)
		if !ok {
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		var req createEventRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.EventType == "" || req.Message == "" {
			writeError(w, http.StatusBadRequest, "eventType and message are required")
			return
		}
		if req.Severity == "" {
			req.Severity = "info"
		}
		if !validEventSeverities[req.Severity] {
			writeError(w, http.StatusBadRequest, "severity must be one of: info, warning, critical")
			return
		}

		id, err := newID("event")
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to generate event id")
			return
		}
		now := time.Now()
		if err := insertEvent(db, id, device.TenantID, device.ID, req.EventType, req.Message, req.Severity, now); err != nil {
			log.Printf("events: insertEvent failed for device %s: %v", device.ID, err)
			writeError(w, http.StatusInternalServerError, "failed to record event")
			return
		}

		event := Event{
			ID: id, TenantID: device.TenantID, DeviceID: device.ID,
			EventType: req.EventType, Message: req.Message, Severity: req.Severity,
			CreatedAt: now.UTC().Format(time.RFC3339Nano),
		}
		// Published after the insert commits, not before - a dashboard reacting to this message
		// (e.g. immediately calling GET /v1/tenants/{id}/events) must find the row already
		// there, same ordering handleRecordLiveStatus follows.
		hub.publishEvent(device.TenantID, event)

		writeJSON(w, http.StatusCreated, event)
	}
}

// defaultEventsLimit/maxEventsLimit bound GET /v1/devices/{id}/events?limit=N - a default for
// callers that omit it, and a hard ceiling so a client can't force an unbounded scan/response
// (the real retention cap is maxEventsPerDevice in models.go; this is a separate, smaller
// per-request cap for the same reason a UI never needs to ask for its entire retained history
// at once).
const (
	defaultEventsLimit = 20
	maxEventsLimit     = 200
)

func handleListEvents(db *DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		device, ok := deviceFromContext(r)
		if !ok {
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		limit := defaultEventsLimit
		if raw := r.URL.Query().Get("limit"); raw != "" {
			parsed, err := strconv.Atoi(raw)
			if err != nil || parsed <= 0 {
				writeError(w, http.StatusBadRequest, "limit must be a positive integer")
				return
			}
			limit = parsed
		}
		if limit > maxEventsLimit {
			limit = maxEventsLimit
		}

		events, err := listEventsByDevice(db, device.ID, limit)
		if err != nil {
			log.Printf("events: listEventsByDevice failed for device %s: %v", device.ID, err)
			writeError(w, http.StatusInternalServerError, "failed to list events")
			return
		}

		writeJSON(w, http.StatusOK, events)
	}
}

type loginRequest struct {
	Password string `json:"password"`
}

type loginResponse struct {
	Token string `json:"token"`
}

func handleLogin(adminPasswordHash, jwtSecret string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req loginRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Password == "" {
			writeError(w, http.StatusBadRequest, "password is required")
			return
		}

		// Deliberately the same generic message on both "no such thing" and "wrong password" -
		// there's no username to enumerate here, but no reason to be more specific than needed.
		if !secretMatchesHash(req.Password, adminPasswordHash) {
			writeError(w, http.StatusUnauthorized, "invalid credentials")
			return
		}

		token, err := issueAdminToken(jwtSecret)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to issue token")
			return
		}

		writeJSON(w, http.StatusOK, loginResponse{Token: token})
	}
}

func handleListTenantDevices(db *DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := chi.URLParam(r, "id")

		devices, err := listDevicesByTenant(db, tenantID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to list devices")
			return
		}
		// nil slice marshals to JSON `null`, not `[]` - always a real empty array when there
		// are no rows, per the foundation-for-a-fleet-view framing (an empty fleet is not the
		// same fact as "the request failed").
		if devices == nil {
			devices = []Device{}
		}

		writeJSON(w, http.StatusOK, devices)
	}
}

// ─── PRD §9.2 ADE Approval Workflows - real v1 ─────────────
// Distinct from Self-Healing's policy-gated-but-immediately-executed remediation actions (see
// local-agent/server/telemetry-server.mjs's own PRD §9 comment): a high-impact action requests
// approval, the device waits, and only proceeds once it holds a real cryptographically signed
// token from this backend (signing.go). There's no real admin UI/human-approval workflow built
// yet, so handleApproveRequest/handleRejectRequest are the honest stand-in for one - a human
// calls them directly (curl, for now), which genuinely is the approver, not a simulated one.
const approvalTokenValidity = 5 * time.Minute

type createApprovalRequestRequest struct {
	Action string `json:"action"`
}

func handleCreateApprovalRequest(db *DB, hub *liveHub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		device, ok := deviceFromContext(r)
		if !ok {
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		var req createApprovalRequestRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Action == "" {
			writeError(w, http.StatusBadRequest, "action is required")
			return
		}

		id, err := newID("appr")
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to generate request id")
			return
		}
		now := time.Now()
		if err := insertApprovalRequest(db, id, device.TenantID, device.ID, req.Action, now); err != nil {
			log.Printf("approval-requests: insertApprovalRequest failed for device %s: %v", device.ID, err)
			writeError(w, http.StatusInternalServerError, "failed to create approval request")
			return
		}

		if eventID, err := newID("event"); err == nil {
			msg := fmt.Sprintf("High-impact action requested approval: %s (request %s).", req.Action, id)
			event := Event{
				ID: eventID, TenantID: device.TenantID, DeviceID: device.ID,
				EventType: "approval-requested-" + req.Action, Message: msg, Severity: "warning",
				CreatedAt: now.UTC().Format(time.RFC3339Nano),
			}
			if err := insertEvent(db, eventID, device.TenantID, device.ID, event.EventType, event.Message, event.Severity, now); err != nil {
				log.Printf("approval-requests: failed to log approval-requested event: %v", err)
			} else {
				hub.publishEvent(device.TenantID, event)
			}
		}

		writeJSON(w, http.StatusCreated, ApprovalRequest{
			ID: id, TenantID: device.TenantID, DeviceID: device.ID, Action: req.Action,
			Status: "pending", CreatedAt: now.UTC().Format(time.RFC3339Nano),
		})
	}
}

// handleGetApprovalRequest is how a device polls for its own request's decision - and, once
// approved, retrieves the actual signed token to verify and act on.
func handleGetApprovalRequest(db *DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		device, ok := deviceFromContext(r)
		if !ok {
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		reqID := chi.URLParam(r, "requestId")
		request, err := getApprovalRequest(db, reqID)
		if errors.Is(err, ErrNotFound) {
			writeError(w, http.StatusNotFound, "approval request not found")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}
		// Deliberately the same 404 as "genuinely doesn't exist" rather than a distinct
		// "forbidden" - a device has no legitimate reason to learn that a request belonging to
		// some other device exists at all, let alone see its status/token.
		if request.DeviceID != device.ID {
			writeError(w, http.StatusNotFound, "approval request not found")
			return
		}

		writeJSON(w, http.StatusOK, request)
	}
}

func handleApproveRequest(db *DB, priv ed25519.PrivateKey, hub *liveHub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		reqID := chi.URLParam(r, "id")
		request, err := getApprovalRequest(db, reqID)
		if errors.Is(err, ErrNotFound) {
			writeError(w, http.StatusNotFound, "approval request not found")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}
		if request.Status != "pending" {
			writeError(w, http.StatusConflict, fmt.Sprintf("approval request is already %s, not pending", request.Status))
			return
		}

		now := time.Now()
		expiresAt := now.Add(approvalTokenValidity).UTC().Format(time.RFC3339Nano)
		signature := signApprovalToken(priv, request.ID, request.DeviceID, request.Action, expiresAt)

		if err := decideApprovalRequest(db, request.ID, "approved", &signature, &expiresAt, now); err != nil {
			log.Printf("approval-requests: decideApprovalRequest (approve) failed for %s: %v", request.ID, err)
			writeError(w, http.StatusInternalServerError, "failed to approve request")
			return
		}

		if eventID, err := newID("event"); err == nil {
			msg := fmt.Sprintf("High-impact action approved: %s (request %s), token valid until %s.", request.Action, request.ID, expiresAt)
			event := Event{
				ID: eventID, TenantID: request.TenantID, DeviceID: request.DeviceID,
				EventType: "approval-approved-" + request.Action, Message: msg, Severity: "warning",
				CreatedAt: now.UTC().Format(time.RFC3339Nano),
			}
			if err := insertEvent(db, eventID, request.TenantID, request.DeviceID, event.EventType, event.Message, event.Severity, now); err != nil {
				log.Printf("approval-requests: failed to log approval-approved event: %v", err)
			} else {
				hub.publishEvent(request.TenantID, event)
			}
		}

		writeJSON(w, http.StatusOK, map[string]string{
			"requestId": request.ID,
			"deviceId":  request.DeviceID,
			"action":    request.Action,
			"expiresAt": expiresAt,
			"signature": signature,
		})
	}
}

func handleRejectRequest(db *DB, hub *liveHub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		reqID := chi.URLParam(r, "id")
		request, err := getApprovalRequest(db, reqID)
		if errors.Is(err, ErrNotFound) {
			writeError(w, http.StatusNotFound, "approval request not found")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}
		if request.Status != "pending" {
			writeError(w, http.StatusConflict, fmt.Sprintf("approval request is already %s, not pending", request.Status))
			return
		}

		now := time.Now()
		if err := decideApprovalRequest(db, request.ID, "rejected", nil, nil, now); err != nil {
			log.Printf("approval-requests: decideApprovalRequest (reject) failed for %s: %v", request.ID, err)
			writeError(w, http.StatusInternalServerError, "failed to reject request")
			return
		}

		if eventID, err := newID("event"); err == nil {
			msg := fmt.Sprintf("High-impact action rejected: %s (request %s).", request.Action, request.ID)
			event := Event{
				ID: eventID, TenantID: request.TenantID, DeviceID: request.DeviceID,
				EventType: "approval-rejected-" + request.Action, Message: msg, Severity: "warning",
				CreatedAt: now.UTC().Format(time.RFC3339Nano),
			}
			if err := insertEvent(db, eventID, request.TenantID, request.DeviceID, event.EventType, event.Message, event.Severity, now); err != nil {
				log.Printf("approval-requests: failed to log approval-rejected event: %v", err)
			} else {
				hub.publishEvent(request.TenantID, event)
			}
		}

		writeJSON(w, http.StatusOK, map[string]string{"requestId": request.ID, "status": "rejected"})
	}
}

// handleRevokeDevice is the real device-registry lifecycle transition (PRD's device-registry/
// component) - admin-authenticated, same as handleListTenantDevices, since revoking a device is
// a fleet-management action, not something a device does to itself. The row is never deleted
// (see schema.sql's own comment): revoking only flips status, which deviceAuthMiddleware then
// genuinely enforces on the device's next call, and countDevicesByTenant then genuinely excludes
// from the license count - this handler doesn't touch either of those directly, it just sets the
// one fact both already key off of.
func handleRevokeDevice(db *DB, hub *liveHub) http.HandlerFunc {
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
		if device.Status == "revoked" {
			writeError(w, http.StatusConflict, "device is already revoked")
			return
		}

		if err := revokeDevice(db, device.ID); err != nil {
			log.Printf("devices: revokeDevice failed for %s: %v", device.ID, err)
			writeError(w, http.StatusInternalServerError, "failed to revoke device")
			return
		}

		now := time.Now()
		if eventID, err := newID("event"); err == nil {
			msg := fmt.Sprintf("Device %s (%s) revoked - its API key will be rejected on its next call.", device.ID, device.Hostname)
			event := Event{
				ID: eventID, TenantID: device.TenantID, DeviceID: device.ID,
				EventType: "device-revoked", Message: msg, Severity: "warning",
				CreatedAt: now.UTC().Format(time.RFC3339Nano),
			}
			if err := insertEvent(db, eventID, device.TenantID, device.ID, event.EventType, event.Message, event.Severity, now); err != nil {
				log.Printf("devices: failed to log device-revoked event: %v", err)
			} else {
				hub.publishEvent(device.TenantID, event)
			}
		}

		writeJSON(w, http.StatusOK, map[string]string{"deviceId": device.ID, "status": "revoked"})
	}
}

// hardwareCheckResponse mirrors the exact vocabulary the task's real POST
// /v1/devices/:id/hardware-check needs: "baseline-set" the first real call for a device with no
// stored baseline, "match"/"mismatch" every call after. Fields is only ever populated for
// "mismatch" - omitted (not an empty array) otherwise, so a caller can't mistake "no fields
// listed" for "nothing changed" when there was in fact no comparison to report on at all.
type hardwareCheckResponse struct {
	Status string   `json:"status"`
	Fields []string `json:"fields,omitempty"`
}

// handleHardwareCheck is the real hardware-fingerprint baseline capture/compare Hardware page's
// Tamper Detection needs (see fingerprint.go's HardwareFingerprint and compareFingerprints).
// Device-authenticated, same as heartbeat/entitlement: a device only ever compares against and
// overwrites its own baseline. First real call with no stored baseline locks in whatever the
// device just sent as that baseline (see resetDeviceFingerprint for the only way to clear it
// again); every call after genuinely compares field-by-field and logs a real critical event on
// any mismatch rather than only reporting it in the response.
func handleHardwareCheck(db *DB, hub *liveHub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		device, ok := deviceFromContext(r)
		if !ok {
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		var req hardwareCheckRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid hardware fingerprint payload")
			return
		}
		current := req.HardwareFingerprint

		// Real, additive TPM device-identity check (see device_identity.go's own comment) - fires
		// its own events, never changes this handler's response either way, and runs regardless
		// of which real outcome (baseline-set/match/mismatch) the comparison below ends in.
		verifyDeviceIdentity(db, hub, device, req, time.Now())

		storedJSON, err := getDeviceFingerprint(db, device.ID)
		if err != nil {
			log.Printf("hardware-check: getDeviceFingerprint failed for %s: %v", device.ID, err)
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		now := time.Now()
		if storedJSON == nil {
			currentJSON, err := json.Marshal(current.normalize())
			if err != nil {
				writeError(w, http.StatusInternalServerError, "failed to encode fingerprint")
				return
			}
			if err := setDeviceFingerprint(db, device.ID, string(currentJSON), now); err != nil {
				log.Printf("hardware-check: setDeviceFingerprint failed for %s: %v", device.ID, err)
				writeError(w, http.StatusInternalServerError, "failed to store baseline")
				return
			}
			writeJSON(w, http.StatusOK, hardwareCheckResponse{Status: "baseline-set"})
			return
		}

		var baseline HardwareFingerprint
		if err := json.Unmarshal([]byte(*storedJSON), &baseline); err != nil {
			log.Printf("hardware-check: stored fingerprint for %s is corrupt: %v", device.ID, err)
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		fields, details := compareFingerprints(baseline, current)
		if len(fields) == 0 {
			writeJSON(w, http.StatusOK, hardwareCheckResponse{Status: "match"})
			return
		}

		if eventID, err := newID("event"); err == nil {
			msg := fmt.Sprintf("Hardware tamper detected on %s: %s.", device.Hostname, strings.Join(details, "; "))
			if err := insertEvent(db, eventID, device.TenantID, device.ID, "hardware-tamper-detected", msg, "critical", now); err != nil {
				log.Printf("hardware-check: failed to log hardware-tamper-detected event: %v", err)
			} else {
				hub.publishEvent(device.TenantID, Event{
					ID: eventID, TenantID: device.TenantID, DeviceID: device.ID,
					EventType: "hardware-tamper-detected", Message: msg, Severity: "critical",
					CreatedAt: now.UTC().Format(time.RFC3339Nano),
				})
			}
		}

		writeJSON(w, http.StatusOK, hardwareCheckResponse{Status: "mismatch", Fields: fields})
	}
}

// handleResetFingerprint is the real, necessary escape hatch for a legitimate hardware upgrade -
// admin-authenticated, same as handleRevokeDevice, since clearing a device's tamper baseline is
// a fleet-management action, not something a device does to itself. Without this, a genuine
// RAM/storage/GPU swap would permanently misflag as tamper forever, since nothing else in this
// system ever clears a locked baseline on its own.
func handleResetFingerprint(db *DB, hub *liveHub) http.HandlerFunc {
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

		if err := resetDeviceFingerprint(db, device.ID); err != nil {
			log.Printf("reset-fingerprint: resetDeviceFingerprint failed for %s: %v", device.ID, err)
			writeError(w, http.StatusInternalServerError, "failed to reset fingerprint")
			return
		}

		now := time.Now()
		if eventID, err := newID("event"); err == nil {
			msg := fmt.Sprintf("Hardware fingerprint baseline reset for device %s (%s) - a legitimate hardware change is expected; the next hardware check will capture a fresh baseline.", device.ID, device.Hostname)
			if err := insertEvent(db, eventID, device.TenantID, device.ID, "hardware-fingerprint-reset", msg, "warning", now); err != nil {
				log.Printf("reset-fingerprint: failed to log hardware-fingerprint-reset event: %v", err)
			} else {
				hub.publishEvent(device.TenantID, Event{
					ID: eventID, TenantID: device.TenantID, DeviceID: device.ID,
					EventType: "hardware-fingerprint-reset", Message: msg, Severity: "warning",
					CreatedAt: now.UTC().Format(time.RFC3339Nano),
				})
			}
		}

		writeJSON(w, http.StatusOK, map[string]string{"deviceId": device.ID, "status": "reset"})
	}
}

// handleSetDeviceTags overwrites a device's real tags - see setDeviceTags's own comment for why
// this is full-replace, not merge/append semantics. No live event fired for this one: unlike
// revoke/reset-fingerprint (genuinely significant, alert-worthy device-lifecycle actions),
// organizing a device into a group is routine bookkeeping, not something that warrants a
// dashboard-wide notification.
func handleSetDeviceTags(db *DB) http.HandlerFunc {
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

		var body struct {
			Tags []string `json:"tags"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body")
			return
		}

		if err := setDeviceTags(db, device.ID, body.Tags); err != nil {
			log.Printf("set-tags: setDeviceTags failed for %s: %v", device.ID, err)
			writeError(w, http.StatusInternalServerError, "failed to set tags")
			return
		}

		writeJSON(w, http.StatusOK, map[string]interface{}{"deviceId": device.ID, "tags": splitTags(joinTags(body.Tags))})
	}
}

type recordMetricSnapshotRequest struct {
	BatteryHealthPct *float64 `json:"batteryHealthPct"`
	SSDWearPct       *float64 `json:"ssdWearPct"`
}

// handleRecordMetricSnapshot appends (or, for a second same-day call, updates - see
// recordMetricSnapshot's own comment) one real day's measurement for AI Intel's SSD/Battery
// Remaining Life predictions. Device-authenticated, same as heartbeat/events: a device only ever
// records its own history. Both fields are optional - a caller with only one real source
// available that cycle (see telemetry-server.mjs's own comment on why either can be null) still
// records whichever real value it has, rather than being forced to fabricate the other.
func handleRecordMetricSnapshot(db *DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		device, ok := deviceFromContext(r)
		if !ok {
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		var req recordMetricSnapshotRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		if req.BatteryHealthPct == nil && req.SSDWearPct == nil {
			writeError(w, http.StatusBadRequest, "at least one of batteryHealthPct or ssdWearPct is required")
			return
		}

		id, err := newID("snap")
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to generate snapshot id")
			return
		}
		if err := recordMetricSnapshot(db, id, device.TenantID, device.ID, req.BatteryHealthPct, req.SSDWearPct, time.Now()); err != nil {
			log.Printf("metric-snapshot: recordMetricSnapshot failed for %s: %v", device.ID, err)
			writeError(w, http.StatusInternalServerError, "failed to record snapshot")
			return
		}

		writeJSON(w, http.StatusCreated, map[string]string{"deviceId": device.ID, "status": "recorded"})
	}
}

// handleListMetricSnapshots is what ai-service's real linear regression queries (see its own
// app.py) - device-authenticated using that specific device's own API key, passed through
// transiently by local-agent on each prediction request rather than a separate credential
// ai-service holds of its own (see telemetry-server.mjs's fetchPrediction for the actual
// passthrough).
func handleListMetricSnapshots(db *DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		device, ok := deviceFromContext(r)
		if !ok {
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		snapshots, err := listMetricSnapshots(db, device.ID)
		if err != nil {
			log.Printf("metric-snapshots: listMetricSnapshots failed for %s: %v", device.ID, err)
			writeError(w, http.StatusInternalServerError, "failed to list snapshots")
			return
		}

		writeJSON(w, http.StatusOK, snapshots)
	}
}

// handlePublicKey is what lets local-agent verify a token's signature without ever holding the
// private key - no auth needed, a public key is not a secret by definition.
func handlePublicKey(pub ed25519.PublicKey) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"publicKey": base64.StdEncoding.EncodeToString(pub)})
	}
}
