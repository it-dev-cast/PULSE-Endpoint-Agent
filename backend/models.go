package main

import (
	"database/sql"
	"errors"
	"strings"
	"time"
)

var ErrNotFound = errors.New("not found")

type Tenant struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	CreatedAt string `json:"createdAt"`
}

type Device struct {
	ID         string  `json:"id"`
	TenantID   string  `json:"tenantId"`
	Hostname   string  `json:"hostname"`
	EnrolledAt string  `json:"enrolledAt"`
	LastSeenAt *string `json:"lastSeenAt"`
	// Status is the real device-registry lifecycle state (PRD's device-registry/ component) -
	// "active" or "revoked" (see schema.sql's own comment for the CHECK constraint and why
	// revoked devices are never deleted).
	Status string `json:"status"`
	// FingerprintLockedAt is null until this device's first real hardware-check call captures a
	// baseline (see fingerprint.go's setDeviceFingerprint) - the fleet dashboard's honest signal
	// for "Baseline Pending" vs "Baseline Locked," the same real state Tamper Detection itself
	// already keys off of, not a separately-derived guess.
	FingerprintLockedAt *string `json:"fingerprintLockedAt"`
	// Tags is real device grouping/organization - split from the single comma-separated
	// storage column at read time (see splitTags/joinTags below), never stored as JSON in the
	// column itself since a plain comma-separated TEXT is simpler for this project's real
	// scale and trivially SQL-searchable with a LIKE if ever needed.
	Tags []string `json:"tags"`
}

type Entitlement struct {
	ID              string  `json:"id"`
	TenantID        string  `json:"tenantId"`
	Plan            string  `json:"plan"`
	Status          string  `json:"status"`
	RenewedAt       *string `json:"renewedAt"`
	ExpiresAt       *string `json:"expiresAt"`
	LicensedDevices *int    `json:"licensedDevices"`
}

// PlanFeature is one row of the plan_features table - a real, plan-wide business rule (not a
// per-tenant fact), applied the same way to every device on that plan.
type PlanFeature struct {
	Feature  string `json:"feature"`
	Included bool   `json:"included"`
}

// Event is one row of real, durable event history - AI Intel's Timeline/Insights cards read
// these instead of the illustrative entries they used to hardcode.
type Event struct {
	ID        string `json:"id"`
	TenantID  string `json:"tenantId"`
	DeviceID  string `json:"deviceId"`
	EventType string `json:"eventType"`
	Message   string `json:"message"`
	Severity  string `json:"severity"`
	CreatedAt string `json:"createdAt"`
}

// maxEventsPerDevice/eventRetentionDays are this project's real retention policy, applied by
// pruneEventsForDevice after every insert - named constants so the actual policy (not just that
// one exists) is visible in one place. 200 is comfortably more than this UI ever displays at
// once (Timeline/Insights show a handful of the most recent) while still bounding memory/disk
// for a device that generates events often (e.g. a flapping alert rule); 90 days bounds
// staleness independently, since a device that goes quiet for long stretches would otherwise
// keep arbitrarily old rows purely because it never generates enough new ones to age them out
// by count alone. Both apply together (whichever is more restrictive), not one or the other.
const (
	maxEventsPerDevice = 200
	eventRetentionDays = 90
)

func insertEvent(db *DB, id, tenantID, deviceID, eventType, message, severity string, now time.Time) error {
	createdAt := now.UTC().Format(time.RFC3339Nano)

	// Real tamper-evident hash chain (see event_chain.go) - reads this tenant's current chain
	// tip via QueryRow (auto-closes its cursor on Scan, safe on this project's single-connection
	// pool) before the INSERT below, rather than holding a cursor open across it.
	prevHash, err := chainPrevHashForTenant(db, tenantID)
	if err != nil {
		return err
	}
	hash := computeEventHash(id, tenantID, deviceID, eventType, message, severity, createdAt, prevHash)

	_, err = db.Exec(
		`INSERT INTO events (id, tenant_id, device_id, event_type, message, severity, created_at, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, tenantID, deviceID, eventType, message, severity, createdAt, prevHash, hash,
	)
	if err != nil {
		return err
	}
	return pruneEventsForDevice(db, deviceID)
}

// pruneEventsForDevice enforces the real retention policy above - called after every insert
// rather than on a separate timer, since there's no background scheduler in this project at
// this scale (same reasoning as remote_session.go's cleanup loop being the one exception, for a
// different reason: in-memory state with no other trigger to hang cleanup off of). Age-based
// pruning runs first so a device that reconnects after a long absence doesn't keep truly stale
// rows just because they're still within the count cap.
func pruneEventsForDevice(db *DB, deviceID string) error {
	cutoff := time.Now().Add(-eventRetentionDays * 24 * time.Hour).UTC().Format(time.RFC3339Nano)
	if _, err := db.Exec(`DELETE FROM events WHERE device_id = ? AND created_at < ?`, deviceID, cutoff); err != nil {
		return err
	}
	_, err := db.Exec(
		`DELETE FROM events WHERE device_id = ? AND id NOT IN (
			SELECT id FROM (
				SELECT id FROM events WHERE device_id = ? ORDER BY created_at DESC LIMIT ?
			) keep
		)`,
		deviceID, deviceID, maxEventsPerDevice,
	)
	return err
}

// listEventsByDevice returns the most recent `limit` events for a device, newest first - the
// natural order for both Timeline (most recent history) and Insights (a recent-activity feed).
func listEventsByDevice(db *DB, deviceID string, limit int) ([]Event, error) {
	rows, err := db.Query(
		`SELECT id, tenant_id, device_id, event_type, message, severity, created_at FROM events WHERE device_id = ? ORDER BY created_at DESC LIMIT ?`,
		deviceID, limit,
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

// getSingleTenantID returns the one tenant this v1 has, rather than a hardcoded ID literal -
// so device registration keeps working correctly if the seed row's ID ever changes, without
// needing a second place in the code to update.
func getSingleTenantID(db *DB) (string, error) {
	var id string
	err := db.QueryRow(`SELECT id FROM tenants ORDER BY created_at LIMIT 1`).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	return id, err
}

// splitTags/joinTags convert between the real comma-separated storage column and the []string
// the API/frontend actually work with - trims whitespace and drops empty entries so
// "sales, , mumbai" and "sales,mumbai" behave identically, and an empty column reliably becomes
// an empty slice (never [""]) rather than requiring every caller to special-case that.
func splitTags(raw string) []string {
	if raw == "" {
		return []string{}
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

func joinTags(tags []string) string {
	cleaned := make([]string, 0, len(tags))
	for _, t := range tags {
		t = strings.TrimSpace(t)
		if t != "" {
			cleaned = append(cleaned, t)
		}
	}
	return strings.Join(cleaned, ",")
}

// getDeviceByID also returns the device's api_key_hash - callers that only need the Device
// (e.g. handleGetEntitlement) can discard it; deviceAuthMiddleware is the one that needs it.
func getDeviceByID(db *DB, id string) (*Device, string, error) {
	var d Device
	var apiKeyHash string
	var rawTags string
	err := db.QueryRow(
		`SELECT id, tenant_id, hostname, api_key_hash, enrolled_at, last_seen_at, status, fingerprint_locked_at, tags FROM devices WHERE id = ?`,
		id,
	).Scan(&d.ID, &d.TenantID, &d.Hostname, &apiKeyHash, &d.EnrolledAt, &d.LastSeenAt, &d.Status, &d.FingerprintLockedAt, &rawTags)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, "", ErrNotFound
	}
	if err != nil {
		return nil, "", err
	}
	d.Tags = splitTags(rawTags)
	return &d, apiKeyHash, nil
}

// revokeDevice sets a device's real lifecycle state to 'revoked' - the row itself is never
// deleted (see schema.sql's own comment on why: real historical/audit data outlives the
// device's ability to authenticate).
func revokeDevice(db *DB, id string) error {
	_, err := db.Exec(`UPDATE devices SET status = 'revoked' WHERE id = ?`, id)
	return err
}

func insertDevice(db *DB, id, tenantID, hostname, apiKeyHash string, now time.Time) error {
	_, err := db.Exec(
		`INSERT INTO devices (id, tenant_id, hostname, api_key_hash, enrolled_at) VALUES (?, ?, ?, ?, ?)`,
		id, tenantID, hostname, apiKeyHash, now.UTC().Format(time.RFC3339),
	)
	return err
}

func touchDeviceLastSeen(db *DB, id string, now time.Time) error {
	_, err := db.Exec(`UPDATE devices SET last_seen_at = ? WHERE id = ?`, now.UTC().Format(time.RFC3339), id)
	return err
}

// listDevicesByTenant deliberately returns every device regardless of status, not just active
// ones - a revoked device stays visible with its real status labeled (the whole point of a
// status column, rather than deleting the row and losing that it ever existed).
func listDevicesByTenant(db *DB, tenantID string) ([]Device, error) {
	rows, err := db.Query(
		`SELECT id, tenant_id, hostname, enrolled_at, last_seen_at, status, fingerprint_locked_at, tags FROM devices WHERE tenant_id = ? ORDER BY enrolled_at`,
		tenantID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Device
	for rows.Next() {
		var d Device
		var rawTags string
		if err := rows.Scan(&d.ID, &d.TenantID, &d.Hostname, &d.EnrolledAt, &d.LastSeenAt, &d.Status, &d.FingerprintLockedAt, &rawTags); err != nil {
			return nil, err
		}
		d.Tags = splitTags(rawTags)
		out = append(out, d)
	}
	return out, rows.Err()
}

// setDeviceTags overwrites a device's real tags entirely (not merge/append) - simplest,
// unambiguous semantics matching what the dashboard's tag editor actually does: shows the
// current full set, lets the operator edit it, sends the full new set back.
func setDeviceTags(db *DB, id string, tags []string) error {
	_, err := db.Exec(`UPDATE devices SET tags = ? WHERE id = ?`, joinTags(tags), id)
	return err
}

// getEntitlementByTenant returns the row exactly as stored - `status` here is whatever was
// last written (at seed time, or a future renewal/admin action), not necessarily what's true
// right now. Callers that display this to a user should run it through deriveEntitlementStatus
// first (see handleGetEntitlement) rather than trusting the stored column directly - a "status"
// column that isn't re-derived from the real expires_at timestamp is exactly the same class of
// bug AppContext's old fake sync clock and AIVerdictCard's old fake timestamp were: a value
// that silently drifts from reality instead of being computed fresh on every read.
func getEntitlementByTenant(db *DB, tenantID string) (*Entitlement, error) {
	var e Entitlement
	err := db.QueryRow(
		`SELECT id, tenant_id, plan, status, renewed_at, expires_at, licensed_devices FROM entitlements WHERE tenant_id = ?`,
		tenantID,
	).Scan(&e.ID, &e.TenantID, &e.Plan, &e.Status, &e.RenewedAt, &e.ExpiresAt, &e.LicensedDevices)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &e, nil
}

// countDevicesByTenant is a real COUNT(*), not the length of a fetched device list - cheaper,
// and device-authenticated callers (handleGetEntitlement) have no admin JWT to call the
// admin-only /v1/tenants/{id}/devices endpoint that would otherwise provide this.
// countDevicesByTenant only counts devices with status = 'active' - the real fix for the
// orphaned-device discrepancy a re-registration (e.g. after PRD §9.2's ADE approval clearing a
// device's cached credentials) leaves behind: an old, abandoned device row would otherwise
// count against the tenant's real license limit forever, even though nothing is actually using
// that identity anymore. Revoking it (see revokeDevice) is what actually corrects the count,
// not deleting the row.
func countDevicesByTenant(db *DB, tenantID string) (int, error) {
	var count int
	err := db.QueryRow(`SELECT COUNT(*) FROM devices WHERE tenant_id = ? AND status = 'active'`, tenantID).Scan(&count)
	return count, err
}

// getPlanFeatures returns the real, plan-wide include/exclude row for every feature this plan
// has a row for (see plan_features' seed comment in schema.sql for the reasoning behind each
// one). A feature with no row for this plan simply isn't in the returned slice - callers treat
// that as "unknown", not as false, the same real-vs-absent distinction used everywhere else.
func getPlanFeatures(db *DB, plan string) ([]PlanFeature, error) {
	rows, err := db.Query(`SELECT feature, included FROM plan_features WHERE plan = ?`, plan)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []PlanFeature{}
	for rows.Next() {
		var f PlanFeature
		if err := rows.Scan(&f.Feature, &f.Included); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

// Windows around expires_at that turn a plain past/future comparison into the real four
// date-derived states in the PRD's vocabulary (Active/Expiring/Grace/Expired) - named constants
// rather than magic numbers so the actual policy is visible and adjustable in one place.
const (
	entitlementExpiringWindow = 30 * 24 * time.Hour // "Expiring": within this long before expiry
	entitlementGraceWindow    = 15 * 24 * time.Hour // "Grace": within this long after expiry
)

// deriveEntitlementStatus computes the real, current status from expires_at rather than
// trusting the stored column, which only reflects whatever was true at last write (seed time,
// or a future renewal). "Suspended" is deliberately exempted - it represents a real
// administrative fact (e.g. a billing failure) that no date comparison could infer, so the
// stored value wins outright when that's what's stored. A missing expires_at (nil) means there
// is nothing to compute against, so the stored status is trusted as-is rather than guessed at.
func deriveEntitlementStatus(storedStatus string, expiresAt *time.Time, now time.Time) string {
	if storedStatus == "Suspended" {
		return "Suspended"
	}
	if expiresAt == nil {
		return storedStatus
	}

	switch {
	case now.Before(expiresAt.Add(-entitlementExpiringWindow)):
		return "Active"
	case now.Before(*expiresAt):
		return "Expiring"
	case now.Before(expiresAt.Add(entitlementGraceWindow)):
		return "Grace"
	default:
		return "Expired"
	}
}

// ApprovalRequest is one row of the real approval_requests state machine (PRD §9.2) - see
// schema.sql's own comment on why this needs to be a mutable table, not just another row shape
// in the immutable events log.
type ApprovalRequest struct {
	ID        string  `json:"id"`
	TenantID  string  `json:"tenantId"`
	DeviceID  string  `json:"deviceId"`
	Action    string  `json:"action"`
	Status    string  `json:"status"`
	Signature *string `json:"signature"`
	ExpiresAt *string `json:"expiresAt"`
	CreatedAt string  `json:"createdAt"`
	DecidedAt *string `json:"decidedAt"`
}

func insertApprovalRequest(db *DB, id, tenantID, deviceID, action string, now time.Time) error {
	_, err := db.Exec(
		`INSERT INTO approval_requests (id, tenant_id, device_id, action, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)`,
		id, tenantID, deviceID, action, now.UTC().Format(time.RFC3339Nano),
	)
	return err
}

// getApprovalRequest doesn't scope by device/tenant itself - callers that need to enforce "a
// device may only ever see its own request" (handleGetApprovalRequest) check
// request.DeviceID against the authenticated device explicitly, so a wrong-device request
// reads as a real 404, not a leak of another device's pending action or issued token.
func getApprovalRequest(db *DB, id string) (*ApprovalRequest, error) {
	var r ApprovalRequest
	err := db.QueryRow(
		`SELECT id, tenant_id, device_id, action, status, signature, expires_at, created_at, decided_at FROM approval_requests WHERE id = ?`,
		id,
	).Scan(&r.ID, &r.TenantID, &r.DeviceID, &r.Action, &r.Status, &r.Signature, &r.ExpiresAt, &r.CreatedAt, &r.DecidedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &r, nil
}

func decideApprovalRequest(db *DB, id, status string, signature, expiresAt *string, now time.Time) error {
	_, err := db.Exec(
		`UPDATE approval_requests SET status = ?, signature = ?, expires_at = ?, decided_at = ? WHERE id = ?`,
		status, signature, expiresAt, now.UTC().Format(time.RFC3339Nano), id,
	)
	return err
}
