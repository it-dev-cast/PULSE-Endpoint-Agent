package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
)

// corsMiddleware is what actually lets a browser-based dashboard (a different origin than this
// API, even at the same localhost - browsers key origin on port too) call any endpoint here at
// all. Every request this dashboard makes either carries an Authorization header (all admin/
// device calls) or a JSON body (login), and both are "non-simple" under the CORS spec - the
// browser sends a preflight OPTIONS request first for every one of them, which this handles
// directly (before any real route/auth logic runs) rather than needing an explicit OPTIONS
// route registered for every real endpoint above.
func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		// Every method this API actually registers a route for - found real and missing PATCH
		// and DELETE specifically (settings.go's offline-threshold PATCH, alert_rules.go's rule
		// PATCH/DELETE): those genuinely worked over curl (which doesn't enforce CORS at all) but
		// failed as an opaque "Failed to fetch" from a real browser, since DELETE - and PATCH,
		// same root cause, just not yet exercised from a fresh browser session when this was
		// found - both require a real CORS preflight (any method beyond GET/HEAD/POST does, and
		// this API's real Authorization header forces one even for those), and the browser
		// correctly refuses to send the actual request once the preflight's own
		// Access-Control-Allow-Methods response doesn't list the method being asked for.
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ─── Admin-facing views of data that already exists, device-scoped only until now ──────
// Everything below exposes real, already-stored data through new admin-authenticated routes.
// None of it is new collection or new business logic - handleGetEntitlement, listMetricSnapshots,
// and the approval_requests table (schema.sql) already exist; a device could always read its own
// entitlement/metric history, and an admin could always decide a specific approval request by ID
// (handleApproveRequest/handleRejectRequest). What was missing was any admin-scoped way to see
// this data across the fleet without already knowing a device ID or request ID in advance - the
// same "foundation for a fleet view" framing handleListTenantDevices already established.

// tenantEntitlementResponse mirrors entitlementResponse (handlers.go) minus DeviceStatus - that
// field means "this calling device's own status," which doesn't apply to a tenant-wide admin
// view the way it does to a single device asking about itself.
type tenantEntitlementResponse struct {
	Entitlement
	DeviceCount *deviceCountInfo `json:"deviceCount"`
	Features    []PlanFeature    `json:"features"`
}

// handleTenantEntitlement is the admin-authenticated equivalent of handleGetEntitlement - same
// derivation logic (deriveEntitlementStatus recomputes the real status from expires_at on every
// call, never trusting the stale stored column), just reachable without holding a specific
// device's own API key.
func handleTenantEntitlement(db *DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := chi.URLParam(r, "id")

		entitlement, err := getEntitlementByTenant(db, tenantID)
		if err == ErrNotFound {
			writeError(w, http.StatusNotFound, "no entitlement found for this tenant")
			return
		}
		if err != nil {
			log.Printf("tenant-entitlement: getEntitlementByTenant failed for tenant %s: %v", tenantID, err)
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		var expiresAt *time.Time
		if entitlement.ExpiresAt != nil {
			if parsed, err := time.Parse(time.RFC3339Nano, *entitlement.ExpiresAt); err == nil {
				expiresAt = &parsed
			}
		}
		entitlement.Status = deriveEntitlementStatus(entitlement.Status, expiresAt, time.Now())

		usedCount, err := countDevicesByTenant(db, tenantID)
		if err != nil {
			log.Printf("tenant-entitlement: countDevicesByTenant failed for tenant %s: %v", tenantID, err)
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}
		var deviceCount *deviceCountInfo
		if entitlement.LicensedDevices != nil {
			deviceCount = &deviceCountInfo{Used: usedCount, Licensed: *entitlement.LicensedDevices}
		}

		features, err := getPlanFeatures(db, entitlement.Plan)
		if err != nil {
			log.Printf("tenant-entitlement: getPlanFeatures failed for plan %s: %v", entitlement.Plan, err)
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		writeJSON(w, http.StatusOK, tenantEntitlementResponse{
			Entitlement: *entitlement, DeviceCount: deviceCount, Features: features,
		})
	}
}

// handleListDeviceMetricSnapshotsAdmin is the admin-authenticated equivalent of
// handleListMetricSnapshots - reuses listMetricSnapshots (metrics.go) unchanged. Not scoped by
// the tenantId path segment beyond routing convention: a device belongs to exactly one tenant in
// this schema, so there's nothing additional to filter by at this project's real scale (same
// reasoning handleListDeviceMetricSnapshotsAdmin's sibling admin routes already follow).
func handleListDeviceMetricSnapshotsAdmin(db *DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		deviceID := chi.URLParam(r, "deviceId")
		snapshots, err := listMetricSnapshots(db, deviceID)
		if err != nil {
			log.Printf("device-metric-snapshots: listMetricSnapshots failed for %s: %v", deviceID, err)
			writeError(w, http.StatusInternalServerError, "failed to list snapshots")
			return
		}
		writeJSON(w, http.StatusOK, snapshots)
	}
}

// listApprovalRequestsByTenant is the admin-side discovery mechanism the PRD §9.2 workflow was
// missing (see main.go's own comment on handleApproveRequest/handleRejectRequest being "the
// honest stand-in" for a real approval UI - this is that UI's real data source). Every request
// regardless of status, newest first - the dashboard filters client-side, same convention as
// listEventsByTenant above.
func listApprovalRequestsByTenant(db *DB, tenantID string, limit int) ([]ApprovalRequest, error) {
	rows, err := db.Query(
		`SELECT id, tenant_id, device_id, action, status, signature, expires_at, created_at, decided_at FROM approval_requests WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?`,
		tenantID, limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []ApprovalRequest{}
	for rows.Next() {
		var a ApprovalRequest
		if err := rows.Scan(&a.ID, &a.TenantID, &a.DeviceID, &a.Action, &a.Status, &a.Signature, &a.ExpiresAt, &a.CreatedAt, &a.DecidedAt); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

const defaultTenantApprovalRequestsLimit = 100

func handleListTenantApprovalRequests(db *DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := chi.URLParam(r, "id")
		requests, err := listApprovalRequestsByTenant(db, tenantID, defaultTenantApprovalRequestsLimit)
		if err != nil {
			log.Printf("tenant-approval-requests: listApprovalRequestsByTenant failed for tenant %s: %v", tenantID, err)
			writeError(w, http.StatusInternalServerError, "failed to list approval requests")
			return
		}
		writeJSON(w, http.StatusOK, requests)
	}
}

// ─── Live device status ─────────────────────────────────────────────────
// LiveStatus is one device's most recent real telemetry sample (see schema.sql's own comment
// on device_live_status for why this is a single overwritten row, not an append-only log).

type LiveStatus struct {
	DeviceID   string          `json:"deviceId"`
	TenantID   string          `json:"tenantId"`
	CPUPct     *float64        `json:"cpuPct"`
	RAMPct     *float64        `json:"ramPct"`
	DiskPct    *float64        `json:"diskPct"`
	BatteryPct *float64        `json:"batteryPct"`
	Detail     json.RawMessage `json:"detail,omitempty"`
	UpdatedAt  string          `json:"updatedAt"`
}

const maxLiveStatusDetailBytes = 32 * 1024

func applyLiveStatusDetail(s *LiveStatus, raw sql.NullString) {
	if !raw.Valid || raw.String == "" {
		return
	}
	b := []byte(raw.String)
	if json.Valid(b) && b[0] == '{' {
		s.Detail = json.RawMessage(b)
	}
}

func normalizeLiveStatusDetail(raw json.RawMessage) (json.RawMessage, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	if len(raw) > maxLiveStatusDetailBytes {
		return nil, fmt.Errorf("detail exceeds %d bytes", maxLiveStatusDetailBytes)
	}
	if !json.Valid(raw) || raw[0] != '{' {
		return nil, fmt.Errorf("detail must be a JSON object")
	}
	return raw, nil
}

// upsertLiveStatus overwrites this device's one live-status row - unlike recordMetricSnapshot's
// dedup-by-day logic (a different table, a different cadence), every real call here is meant to
// replace the previous value outright: the whole point is "what's true right now," not a history
// of past values. COALESCE still applies per-field, same reasoning as recordMetricSnapshot - a
// cycle where only some real sources were available shouldn't blank out the others.
func upsertLiveStatus(db *DB, deviceID, tenantID string, cpuPct, ramPct, diskPct, batteryPct *float64, detail json.RawMessage, now time.Time) error {
	nowStr := now.UTC().Format(time.RFC3339Nano)
	var detailArg interface{}
	if len(detail) > 0 {
		detailArg = string(detail)
	}
	_, err := db.Exec(
		`INSERT INTO device_live_status (device_id, tenant_id, cpu_pct, ram_pct, disk_pct, battery_pct, detail, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT (device_id) DO UPDATE SET
		   cpu_pct = COALESCE(excluded.cpu_pct, device_live_status.cpu_pct),
		   ram_pct = COALESCE(excluded.ram_pct, device_live_status.ram_pct),
		   disk_pct = COALESCE(excluded.disk_pct, device_live_status.disk_pct),
		   battery_pct = COALESCE(excluded.battery_pct, device_live_status.battery_pct),
		   detail = COALESCE(excluded.detail, device_live_status.detail),
		   updated_at = excluded.updated_at`,
		deviceID, tenantID, cpuPct, ramPct, diskPct, batteryPct, detailArg, nowStr,
	)
	return err
}

func getLiveStatusByDevice(db *DB, deviceID string) (*LiveStatus, error) {
	var s LiveStatus
	var detail sql.NullString
	err := db.QueryRow(
		`SELECT device_id, tenant_id, cpu_pct, ram_pct, disk_pct, battery_pct, detail, updated_at FROM device_live_status WHERE device_id = ?`,
		deviceID,
	).Scan(&s.DeviceID, &s.TenantID, &s.CPUPct, &s.RAMPct, &s.DiskPct, &s.BatteryPct, &detail, &s.UpdatedAt)
	if err != nil {
		return nil, err
	}
	applyLiveStatusDetail(&s, detail)
	return &s, nil
}

// listLiveStatusByTenant returns every device's current live status for this tenant - never nil
// (see handleListTenantDevices's own comment on why an empty fleet isn't the same as a failure).
func listLiveStatusByTenant(db *DB, tenantID string) ([]LiveStatus, error) {
	rows, err := db.Query(
		`SELECT device_id, tenant_id, cpu_pct, ram_pct, disk_pct, battery_pct, detail, updated_at FROM device_live_status WHERE tenant_id = ?`,
		tenantID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []LiveStatus{}
	for rows.Next() {
		var s LiveStatus
		var detail sql.NullString
		if err := rows.Scan(&s.DeviceID, &s.TenantID, &s.CPUPct, &s.RAMPct, &s.DiskPct, &s.BatteryPct, &detail, &s.UpdatedAt); err != nil {
			return nil, err
		}
		applyLiveStatusDetail(&s, detail)
		out = append(out, s)
	}
	return out, rows.Err()
}

type recordLiveStatusRequest struct {
	CPUPct     *float64        `json:"cpuPct"`
	RAMPct     *float64        `json:"ramPct"`
	DiskPct    *float64        `json:"diskPct"`
	BatteryPct *float64        `json:"batteryPct"`
	Detail     json.RawMessage `json:"detail"`
}

// handleRecordLiveStatus is the real endpoint local-agent's already-existing 5s poll cycle pushes
// to (see telemetry-server.mjs's postLiveStatus) - device-authenticated, same pattern as
// heartbeat/events: a device only ever records its own status. Also updates last_seen_at and
// clears the offline detector immediately, because live telemetry is contact - not only the
// slower heartbeat. Publishes to the tenant's live hub after a successful write so an open
// dashboard stream sees it immediately, same publish-after-commit ordering as handleCreateEvent
// below.
func handleRecordLiveStatus(db *DB, hub *liveHub, detector *offlineDetector) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		device, ok := deviceFromContext(r)
		if !ok {
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		var req recordLiveStatusRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		if req.CPUPct == nil && req.RAMPct == nil && req.DiskPct == nil && req.BatteryPct == nil && len(req.Detail) == 0 {
			writeError(w, http.StatusBadRequest, "at least one of cpuPct, ramPct, diskPct, batteryPct, or detail is required")
			return
		}
		detail, err := normalizeLiveStatusDetail(req.Detail)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}

		now := time.Now()
		if err := upsertLiveStatus(db, device.ID, device.TenantID, req.CPUPct, req.RAMPct, req.DiskPct, req.BatteryPct, detail, now); err != nil {
			log.Printf("live-status: upsertLiveStatus failed for device %s: %v", device.ID, err)
			writeError(w, http.StatusInternalServerError, "failed to record live status")
			return
		}
		// Live telemetry is proof of contact - same last-seen column heartbeat writes. Without
		// this, last_seen_at only moved on the agent's 60s heartbeat while CPU/RAM/Disk arrived
		// every 5s, so the offline detector (and dashboard "Last seen") lagged a live device.
		if err := touchDeviceLastSeen(db, device.ID, now); err != nil {
			log.Printf("live-status: touchDeviceLastSeen failed for device %s: %v", device.ID, err)
		}
		detector.noteReporting(db, hub, device.ID, device.TenantID, device.Hostname)

		// Publish the row after COALESCE so a cycle that omitted detail/cpu doesn't wipe the
		// dashboard's last good values with nulls.
		status, err := getLiveStatusByDevice(db, device.ID)
		if err != nil {
			log.Printf("live-status: getLiveStatusByDevice failed for device %s: %v", device.ID, err)
			writeError(w, http.StatusInternalServerError, "failed to record live status")
			return
		}
		hub.publishLiveStatus(device.TenantID, *status)

		writeJSON(w, http.StatusOK, map[string]string{"deviceId": device.ID, "status": "recorded"})
	}
}

// handleListTenantLiveStatus is the admin-authenticated read side of the table above - the
// dashboard's initial page load (before the live stream below takes over), same foundation-for-
// a-fleet-view framing as handleListTenantDevices.
func handleListTenantLiveStatus(db *DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := chi.URLParam(r, "id")
		statuses, err := listLiveStatusByTenant(db, tenantID)
		if err != nil {
			log.Printf("live-status: listLiveStatusByTenant failed for tenant %s: %v", tenantID, err)
			writeError(w, http.StatusInternalServerError, "failed to list live status")
			return
		}
		writeJSON(w, http.StatusOK, statuses)
	}
}

// ─── Tenant-wide event feed ─────────────────────────────────────────────
// listEventsByDevice (models.go) is scoped to one device's own history - a device can only ever
// read its own events (see handleListEvents' own auth). This is the admin-side equivalent: every
// event across every device in a tenant, for the fleet dashboard's incident stream. Reuses the
// existing Event struct from models.go unchanged - this is a different query, not a different
// shape of data.
func listEventsByTenant(db *DB, tenantID string, limit int) ([]Event, error) {
	rows, err := db.Query(
		`SELECT id, tenant_id, device_id, event_type, message, severity, created_at FROM events WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?`,
		tenantID, limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Event{}
	for rows.Next() {
		var e Event
		if err := rows.Scan(&e.ID, &e.TenantID, &e.DeviceID, &e.EventType, &e.Message, &e.Severity, &e.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// defaultTenantEventsLimit/maxTenantEventsLimit mirror defaultEventsLimit/maxEventsLimit in
// handlers.go - same reasoning, a separate named pair since this is a different endpoint with
// its own callers, not a shared constant that would couple the two unnecessarily.
const (
	defaultTenantEventsLimit = 50
	maxTenantEventsLimit     = 200
)

// Notification is the dashboard bell's own view of an event - the same immutable Event data,
// plus this tenant's real read state layered on top (see event_notification_state's own
// schema.sql comment for why that's a separate table). Cleared notifications are never
// returned by listNotificationsByTenant at all, so there's no "cleared" field to expose here.
type Notification struct {
	ID        string `json:"id"`
	TenantID  string `json:"tenantId"`
	DeviceID  string `json:"deviceId"`
	EventType string `json:"eventType"`
	Message   string `json:"message"`
	Severity  string `json:"severity"`
	CreatedAt string `json:"createdAt"`
	Read      bool   `json:"read"`
}

// defaultNotificationsLimit/maxNotificationsLimit bound GET .../notifications - a bell dropdown
// shows a bounded recent list, not this tenant's full retained event history (which Activity
// Log/handleListTenantEvents above already exists for, uncapped by this smaller limit).
const (
	defaultNotificationsLimit = 50
	maxNotificationsLimit     = 100
)

// listNotificationsByTenant left-joins event_notification_state rather than requiring one row
// per event to exist - an event with no state row at all has never been read or cleared, so
// readAt scanning as NULL (Read: false) and it simply passing the "not cleared" filter are both
// the correct, honest default with no backfill needed for events that predate this feature.
func listNotificationsByTenant(db *DB, tenantID string, limit int) ([]Notification, error) {
	rows, err := db.Query(
		`SELECT e.id, e.tenant_id, e.device_id, e.event_type, e.message, e.severity, e.created_at, ns.read_at
		 FROM events e
		 LEFT JOIN event_notification_state ns ON ns.event_id = e.id
		 WHERE e.tenant_id = ? AND ns.cleared_at IS NULL
		 ORDER BY e.created_at DESC LIMIT ?`,
		tenantID, limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Notification{}
	for rows.Next() {
		var n Notification
		var readAt *string
		if err := rows.Scan(&n.ID, &n.TenantID, &n.DeviceID, &n.EventType, &n.Message, &n.Severity, &n.CreatedAt, &readAt); err != nil {
			return nil, err
		}
		n.Read = readAt != nil
		out = append(out, n)
	}
	return out, rows.Err()
}

// markAllNotificationsRead marks every currently-unread, non-cleared notification for this
// tenant as read. Two real steps (ensure a state row exists for every event, then update the
// unread ones) rather than a single ON CONFLICT DO UPDATE upsert - simpler, more readable SQL at
// this project's real scale (a handful of tenant-wide notifications, not a hot path that
// genuinely needs one round trip).
func markAllNotificationsRead(db *DB, tenantID string, now time.Time) error {
	if _, err := db.Exec(
		`INSERT INTO event_notification_state (event_id, tenant_id) SELECT id, tenant_id FROM events WHERE tenant_id = ? ON CONFLICT (event_id) DO NOTHING`,
		tenantID,
	); err != nil {
		return err
	}
	_, err := db.Exec(
		`UPDATE event_notification_state SET read_at = ? WHERE tenant_id = ? AND read_at IS NULL`,
		now.UTC().Format(time.RFC3339Nano), tenantID,
	)
	return err
}

// clearAllNotifications dismisses every currently-visible (non-cleared) notification for this
// tenant from the bell's own list - genuinely distinct from markAllNotificationsRead above (per
// the dashboard's own two separate buttons): this removes rows from the bell entirely, read or
// not, while never touching or deleting the underlying `events` rows themselves, so Activity
// Log/per-device Event History are completely unaffected by what's been cleared from the bell.
func clearAllNotifications(db *DB, tenantID string, now time.Time) error {
	if _, err := db.Exec(
		`INSERT INTO event_notification_state (event_id, tenant_id) SELECT id, tenant_id FROM events WHERE tenant_id = ? ON CONFLICT (event_id) DO NOTHING`,
		tenantID,
	); err != nil {
		return err
	}
	_, err := db.Exec(
		`UPDATE event_notification_state SET cleared_at = ? WHERE tenant_id = ? AND cleared_at IS NULL`,
		now.UTC().Format(time.RFC3339Nano), tenantID,
	)
	return err
}

// handleListTenantNotifications is admin-authenticated (same group as handleListTenantEvents) -
// the dashboard bell's initial load, before the existing live SSE stream (new events already
// arrive there in real time, same "event" message type this reads from the same events table).
func handleListTenantNotifications(db *DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := chi.URLParam(r, "id")

		limit := defaultNotificationsLimit
		if raw := r.URL.Query().Get("limit"); raw != "" {
			var parsed int
			if _, err := fmt.Sscanf(raw, "%d", &parsed); err != nil || parsed <= 0 {
				writeError(w, http.StatusBadRequest, "limit must be a positive integer")
				return
			}
			limit = parsed
		}
		if limit > maxNotificationsLimit {
			limit = maxNotificationsLimit
		}

		notifications, err := listNotificationsByTenant(db, tenantID, limit)
		if err != nil {
			log.Printf("notifications: listNotificationsByTenant failed for tenant %s: %v", tenantID, err)
			writeError(w, http.StatusInternalServerError, "failed to list notifications")
			return
		}
		writeJSON(w, http.StatusOK, notifications)
	}
}

func handleMarkAllNotificationsRead(db *DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := chi.URLParam(r, "id")
		if err := markAllNotificationsRead(db, tenantID, time.Now()); err != nil {
			log.Printf("notifications: markAllNotificationsRead failed for tenant %s: %v", tenantID, err)
			writeError(w, http.StatusInternalServerError, "failed to mark notifications read")
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	}
}

func handleClearAllNotifications(db *DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := chi.URLParam(r, "id")
		if err := clearAllNotifications(db, tenantID, time.Now()); err != nil {
			log.Printf("notifications: clearAllNotifications failed for tenant %s: %v", tenantID, err)
			writeError(w, http.StatusInternalServerError, "failed to clear notifications")
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	}
}

// handleListTenantEvents is admin-authenticated (same group as handleListTenantDevices) - the
// fleet dashboard's initial incident-stream load, before the live SSE stream below takes over.
func handleListTenantEvents(db *DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := chi.URLParam(r, "id")

		limit := defaultTenantEventsLimit
		if raw := r.URL.Query().Get("limit"); raw != "" {
			var parsed int
			if _, err := fmt.Sscanf(raw, "%d", &parsed); err != nil || parsed <= 0 {
				writeError(w, http.StatusBadRequest, "limit must be a positive integer")
				return
			}
			limit = parsed
		}
		if limit > maxTenantEventsLimit {
			limit = maxTenantEventsLimit
		}

		events, err := listEventsByTenant(db, tenantID, limit)
		if err != nil {
			log.Printf("tenant-events: listEventsByTenant failed for tenant %s: %v", tenantID, err)
			writeError(w, http.StatusInternalServerError, "failed to list events")
			return
		}
		writeJSON(w, http.StatusOK, events)
	}
}

// ─── Live push (Server-Sent Events) ─────────────────────────────────────
// liveHub is an in-memory pub/sub, deliberately the same shape as remote_session.go's peer map -
// no message queue/Kafka (see main.go's own scope-boundary comment on why not, at this project's
// real scale), just a mutex-guarded map of open subscriber channels per tenant. SSE, not
// WebSocket: this is one-way (server -> dashboard) push only, the dashboard never needs to send
// anything back over this connection, so the simpler unidirectional protocol is the honest fit,
// not a heavier bidirectional one this doesn't need.
type liveHub struct {
	mu   sync.Mutex
	subs map[string]map[chan []byte]bool // tenantID -> set of open subscriber channels
}

func newLiveHub() *liveHub {
	return &liveHub{subs: make(map[string]map[chan []byte]bool)}
}

func (h *liveHub) subscribe(tenantID string) chan []byte {
	ch := make(chan []byte, 16)
	h.mu.Lock()
	if h.subs[tenantID] == nil {
		h.subs[tenantID] = make(map[chan []byte]bool)
	}
	h.subs[tenantID][ch] = true
	h.mu.Unlock()
	return ch
}

func (h *liveHub) unsubscribe(tenantID string, ch chan []byte) {
	h.mu.Lock()
	delete(h.subs[tenantID], ch)
	h.mu.Unlock()
	close(ch)
}

// publish is fire-and-forget on a full channel - a select/default rather than a blocking send,
// so one slow/stuck dashboard tab can never make a device's own request handler hang waiting on
// a browser it has no relationship to. A dropped message here just means that one open dashboard
// misses one update; its next real event/live-status write arrives on the next publish shortly
// after, same as a missed frame in any best-effort live view.
func (h *liveHub) publish(tenantID string, payload []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.subs[tenantID] {
		select {
		case ch <- payload:
		default:
		}
	}
}

// liveMessage is the one envelope shape every SSE frame uses - a discriminated union via `type`
// rather than two separate SSE event types, so the dashboard's single onmessage handler can
// switch on one field instead of registering two named listeners for what's conceptually the
// same "something about this tenant's fleet just changed" stream.
type liveMessage struct {
	Type   string      `json:"type"` // "event" | "live-status"
	Event  *Event      `json:"event,omitempty"`
	Status *LiveStatus `json:"status,omitempty"`
}

func (h *liveHub) publishEvent(tenantID string, event Event) {
	payload, err := json.Marshal(liveMessage{Type: "event", Event: &event})
	if err != nil {
		log.Printf("live-hub: failed to marshal event message: %v", err)
		return
	}
	h.publish(tenantID, payload)
}

func (h *liveHub) publishLiveStatus(tenantID string, status LiveStatus) {
	payload, err := json.Marshal(liveMessage{Type: "live-status", Status: &status})
	if err != nil {
		log.Printf("live-hub: failed to marshal live-status message: %v", err)
		return
	}
	h.publish(tenantID, payload)
}

// sseKeepaliveInterval is how often a comment-line keepalive is sent on an otherwise-quiet
// stream - long enough to not be chatty, short enough that an intermediate proxy/load balancer
// doesn't treat the connection as dead and close it out from under a dashboard that's simply
// waiting for the next real update.
const sseKeepaliveInterval = 20 * time.Second

// handleTenantStream is the real live-push endpoint the dashboard's popups/instant-update
// behavior depends on - admin-authenticated (same group as handleListTenantDevices/Events),
// since this is the fleet-wide view, not a single device's own data. Every event and live-status
// update published for this tenant (see handleCreateEvent/handleRevokeDevice/etc. below and
// handleRecordLiveStatus above) is relayed here the instant it's published - no polling delay.
func handleTenantStream(hub *liveHub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := chi.URLParam(r, "id")

		flusher, ok := w.(http.Flusher)
		if !ok {
			writeError(w, http.StatusInternalServerError, "streaming unsupported")
			return
		}

		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.WriteHeader(http.StatusOK)
		flusher.Flush()

		ch := hub.subscribe(tenantID)
		defer hub.unsubscribe(tenantID, ch)
		log.Printf("live-stream: dashboard connected for tenant %s", tenantID)

		ticker := time.NewTicker(sseKeepaliveInterval)
		defer ticker.Stop()

		for {
			select {
			case <-r.Context().Done():
				log.Printf("live-stream: dashboard disconnected for tenant %s", tenantID)
				return
			case msg, ok := <-ch:
				if !ok {
					return
				}
				if _, err := fmt.Fprintf(w, "data: %s\n\n", msg); err != nil {
					return
				}
				flusher.Flush()
			case <-ticker.C:
				if _, err := fmt.Fprint(w, ": keepalive\n\n"); err != nil {
					return
				}
				flusher.Flush()
			}
		}
	}
}
