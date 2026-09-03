package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"time"
)

// duplicateFingerprintStaleFloor is the hard safety floor for auto-revoking a device whose
// hardware fingerprint exactly matches another already-active device's locked baseline - never
// lower than this regardless of how aggressively a tenant has tuned its own offline-alerting
// threshold (offline_threshold_minutes can be as low as 1 minute - fine for a fast "stopped
// reporting" warning, not nearly enough certainty before touching a device's own
// authentication). A tenant that's deliberately configured something even more conservative than
// this is still respected - see checkForDuplicateFingerprint's own use of it.
const duplicateFingerprintStaleFloor = 30 * time.Minute

// checkForDuplicateFingerprint is called once, right after a NEW device's first-ever
// hardware-check locks in its baseline (handleHardwareCheck's storedJSON == nil branch) - the
// earliest point a real fingerprint exists for this device AND the caller is already
// authenticated (its own API key, issued at registration). Never trusts an unauthenticated
// fingerprint claim - there isn't one before this point, so this can't run any earlier.
//
// Compares against every OTHER currently-active device in the same tenant that already has a
// locked baseline, reusing the exact same field-by-field compareFingerprints tamper detection
// already trusts. Deliberately excludes revoked devices - a match against one of those is the
// legitimate re-enrollment case (wipe credentials, re-register, new device_id, same real
// hardware, old registration already properly revoked), not a duplicate-enrollment concern.
//
// A match against a still-live older device is a real, unresolved security question (two
// simultaneously-active registrations claiming identical physical hardware) - flagged as a
// critical event for admin review, nothing auto-revoked. Only once that older device has
// genuinely stopped reporting for at least duplicateFingerprintStaleFloor does this auto-revoke
// it, using the same real "latest of last_seen_at and device_live_status.updated_at" contact-
// recency rule offline_detection.go's own sweep already uses (see isDeviceStale).
//
// Additive, like verifyDeviceIdentity in device_identity.go: never changes handleHardwareCheck's
// own response to the calling device either way, whatever happens here.
func checkForDuplicateFingerprint(db *DB, hub *liveHub, device *Device, current HardwareFingerprint, now time.Time) {
	rows, err := db.Query(
		`SELECT id, hostname, hardware_fingerprint FROM devices
		 WHERE tenant_id = ? AND id != ? AND status = 'active' AND hardware_fingerprint IS NOT NULL`,
		device.TenantID, device.ID,
	)
	if err != nil {
		log.Printf("duplicate-fingerprint: failed to query other devices for %s: %v", device.ID, err)
		return
	}
	// Fully drained and closed before any further query below (revokeDevice/isDeviceStale/
	// insertEvent) - this project's db.SetMaxOpenConns(1) means a held-open SELECT cursor
	// blocks every other query on the whole process (see anyDeviceAuthMiddleware's own comment
	// on the real, confirmed deadlock this exact mistake caused elsewhere).
	type candidate struct {
		id, hostname, fingerprintJSON string
	}
	var candidates []candidate
	for rows.Next() {
		var c candidate
		if err := rows.Scan(&c.id, &c.hostname, &c.fingerprintJSON); err != nil {
			log.Printf("duplicate-fingerprint: scan failed for %s: %v", device.ID, err)
			continue
		}
		candidates = append(candidates, c)
	}
	rows.Close()

	if len(candidates) == 0 {
		return
	}

	thresholdMinutes, err := getOfflineThresholdMinutes(db, device.TenantID)
	if err != nil || thresholdMinutes <= 0 {
		thresholdMinutes = defaultOfflineThresholdMinutes
	}
	staleFloor := duplicateFingerprintStaleFloor
	if tenantThreshold := time.Duration(thresholdMinutes) * time.Minute; tenantThreshold > staleFloor {
		staleFloor = tenantThreshold
	}

	for _, c := range candidates {
		var baseline HardwareFingerprint
		if err := json.Unmarshal([]byte(c.fingerprintJSON), &baseline); err != nil {
			log.Printf("duplicate-fingerprint: stored fingerprint for %s is corrupt: %v", c.id, err)
			continue
		}
		if fields, _ := compareFingerprints(baseline, current); len(fields) > 0 {
			continue // genuinely different hardware, not a match
		}

		stale, err := isDeviceStale(db, c.id, staleFloor, now)
		if err != nil {
			log.Printf("duplicate-fingerprint: isDeviceStale failed for %s: %v", c.id, err)
			continue
		}

		if stale {
			if err := revokeDevice(db, c.id); err != nil {
				log.Printf("duplicate-fingerprint: failed to auto-revoke %s: %v", c.id, err)
				continue
			}
			msg := fmt.Sprintf(
				"Device %s (%s) auto-revoked: identical hardware to newly-registered device %s (%s), and this device has not reported in over %s - most likely a re-image/re-enrollment of the same physical machine.",
				c.hostname, c.id, device.Hostname, device.ID, staleFloor,
			)
			fireDuplicateFingerprintEvent(db, hub, c.id, device.TenantID, "duplicate-fingerprint-auto-revoked", msg, "warning", now)
		} else {
			msg := fmt.Sprintf(
				"This device's hardware fingerprint exactly matches already-registered device %s (%s), which is currently still reporting. Review before assuming this is a benign re-image - possible cloned/duplicate enrollment.",
				c.hostname, c.id,
			)
			fireDuplicateFingerprintEvent(db, hub, device.ID, device.TenantID, "duplicate-fingerprint-detected", msg, "critical", now)
		}
	}
}

// isDeviceStale reports whether a single device hasn't reported in longer than threshold, using
// the same "latest of last_seen_at and device_live_status.updated_at" contact-recency rule
// offline_detection.go's own periodic sweep uses (live telemetry every ~5s is as much "reporting"
// as heartbeat every ~60s) - reuses that file's own laterTime/parseRFC3339 rather than a second,
// possibly-diverging copy of the same real rule.
//
// enrolled_at (always non-null) is included as a third, floor reference point - found live, not
// guessed: a real test device whose hardware-check ran (as it commonly does, real timing)
// before its first-ever heartbeat had a still-null last_seen_at seconds after registering, and
// the original null-means-stale fallback here read that as "abandoned for 30+ minutes" instead
// of "hasn't had time to report yet," incorrectly auto-revoking a device that had only existed
// for a few seconds. Falling back to enrolled_at instead means "how long since ANY contact,
// enrollment included," not "no positive signal yet, therefore assume the worst."
func isDeviceStale(db *DB, deviceID string, threshold time.Duration, now time.Time) (bool, error) {
	var enrolledAt string
	var lastSeenAt, liveUpdatedAt sql.NullString
	err := db.QueryRow(
		`SELECT d.enrolled_at, d.last_seen_at, ls.updated_at FROM devices d
		 LEFT JOIN device_live_status ls ON ls.device_id = d.id
		 WHERE d.id = ?`,
		deviceID,
	).Scan(&enrolledAt, &lastSeenAt, &liveUpdatedAt)
	if err != nil {
		return false, err
	}
	var lastSeenPtr, liveUpdatedPtr *string
	if lastSeenAt.Valid {
		lastSeenPtr = &lastSeenAt.String
	}
	if liveUpdatedAt.Valid {
		liveUpdatedPtr = &liveUpdatedAt.String
	}
	latest := laterTime(lastSeenPtr, liveUpdatedPtr)
	if enrolledTime := parseRFC3339(&enrolledAt); enrolledTime != nil && (latest == nil || enrolledTime.After(*latest)) {
		latest = enrolledTime
	}
	if latest == nil {
		// enrolled_at itself unparseable - genuinely can't tell how long it's been, so this
		// stays the one case treated as stale defensively rather than silently never-stale.
		return true, nil
	}
	return now.Sub(*latest) > threshold, nil
}

func fireDuplicateFingerprintEvent(db *DB, hub *liveHub, deviceID, tenantID, eventType, message, severity string, now time.Time) {
	eventID, err := newID("event")
	if err != nil {
		log.Printf("duplicate-fingerprint: failed to generate %s event id: %v", eventType, err)
		return
	}
	if err := insertEvent(db, eventID, tenantID, deviceID, eventType, message, severity, now); err != nil {
		log.Printf("duplicate-fingerprint: failed to log %s event: %v", eventType, err)
		return
	}
	hub.publishEvent(tenantID, Event{
		ID: eventID, TenantID: tenantID, DeviceID: deviceID,
		EventType: eventType, Message: message, Severity: severity,
		CreatedAt: now.UTC().Format(time.RFC3339Nano),
	})
}
