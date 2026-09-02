package main

import (
	"database/sql"
	"time"
)

// Real, honest v1 of PRD Section 6.4's Warranty State Machine - derived live from signals this
// codebase already has, computed fresh on every request rather than stored (same philosophy as
// deriveEntitlementStatus in models.go: a value that could silently drift stale is worse than
// recomputing it every time).
//
// Only three of the PRD's five states are reachable from here, on purpose:
//   - Active:  the hardware baseline is intact AND the tenant's real entitlement is in good
//     standing (Active/Expiring/Grace).
//   - Warning: an unresolved hardware-tamper-detected or device-identity-invalid event exists
//     for this device since its baseline was last locked (fingerprint_locked_at).
//   - Expired: the tenant's real entitlement has lapsed (Expired/Suspended).
//
// UnderReview and Voided are deliberately never returned - both require a real, human-confirmed
// adjudication step (PRD's "formal ADE verification") that doesn't exist anywhere in this
// codebase yet (see backend/main.go's own scope-boundary comment: the ADE console is explicitly
// out of scope). Returning either of those here would fabricate a "confirmed" determination this
// system has no way to actually make. The frontend's own WarrantyState type (src/app/App.tsx)
// already anticipates exactly this - it defines both states but documents them as structurally
// unreachable until that workflow exists.
const (
	warrantyStateActive  = "Active"
	warrantyStateWarning = "Warning"
	warrantyStateExpired = "Expired"
)

// hasUnresolvedIntegrityEvent reports whether a hardware-tamper-detected or device-identity-invalid
// event exists for this device at or after `since` - uses the existing
// idx_events_device_id_created_at index, no new index needed.
//
// Both event types share this one boundary even though only hardware_fingerprint's own reset
// ("Reset FP", see fingerprint.go's resetDeviceFingerprint) actually clears fingerprint_locked_at.
// device-identity-invalid events have no reset lifecycle of their own yet (see device_identity.go's
// own comment on this being a known, deliberate gap) - reusing fingerprint_locked_at as their
// boundary too is a disclosed simplification, not a hidden assumption: it's the only reset-like
// timestamp this system has today, and an identity-invalid event genuinely predating the current
// baseline era is reasonably treated as stale, the same way a pre-reset tamper event is.
func hasUnresolvedIntegrityEvent(db *DB, deviceID string, since time.Time) (bool, error) {
	var found int
	err := db.QueryRow(
		`SELECT 1 FROM events
		 WHERE device_id = ? AND event_type IN ('hardware-tamper-detected', 'device-identity-invalid') AND created_at >= ?
		 ORDER BY created_at DESC LIMIT 1`,
		deviceID, since.UTC().Format(time.RFC3339Nano),
	).Scan(&found)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// computeDeviceWarrantyState returns "" when there isn't yet enough real data to derive a state
// (no locked baseline) - the same "unknown, not a fabricated default" honesty this codebase
// already applies to FingerprintLockedAt/"Baseline Pending" and to Health Score's dimensions.
// entitlementStatus is expected to already be the live, deriveEntitlementStatus-computed value,
// not the raw stored column.
func computeDeviceWarrantyState(db *DB, device *Device, entitlementStatus string) (string, error) {
	if device.FingerprintLockedAt == nil {
		return "", nil
	}
	lockedAt, err := time.Parse(time.RFC3339Nano, *device.FingerprintLockedAt)
	if err != nil {
		// A corrupt/unparseable timestamp is treated as unknown rather than failing the whole
		// entitlement response over one malformed field.
		return "", nil
	}

	unresolved, err := hasUnresolvedIntegrityEvent(db, device.ID, lockedAt)
	if err != nil {
		return "", err
	}
	if unresolved {
		return warrantyStateWarning, nil
	}

	switch entitlementStatus {
	case "Active", "Expiring", "Grace":
		return warrantyStateActive, nil
	case "Expired", "Suspended":
		return warrantyStateExpired, nil
	default:
		return "", nil
	}
}
