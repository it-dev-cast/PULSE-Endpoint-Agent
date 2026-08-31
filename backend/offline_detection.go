package main

import (
	"fmt"
	"log"
	"sync"
	"time"
)

// Real, periodic liveness check - previously, a device that stopped reporting just silently
// showed an increasingly stale lastSeenAt with no actual alert ever firing. This closes that
// gap: any active device that hasn't reported in its tenant's real, admin-configurable threshold
// (tenants.offline_threshold_minutes - see settings.go) is now a real, once-fired
// "device-offline" warning event (not re-fired every sweep while it remains offline), and a
// real "device-online" event when it reports again after having been marked offline. "Reported"
// means last_seen_at OR a live-status row (the agent posts live telemetry every ~5s and
// heartbeat only every ~60s - both are contact). Live-status also calls noteReporting so
// device-online is not delayed until the next sweep.
//
// Deliberately NOT a new device.status value ("active"/"revoked" is an authorization state
// checked by every auth middleware in this project - conflating that with "is it currently
// reporting" would be a real, confusing change to what "active" has meant everywhere else).
// This is purely a derived, real-time liveness signal, tracked in memory only (same reasoning
// as remote_session.go's own in-memory state: this isn't durable business data, just "was this
// specific device already flagged offline in this backend's current run").
const offlineCheckInterval = 60 * time.Second

// defaultOfflineThresholdMinutes is only a defensive fallback for the (shouldn't-happen) case of
// a device whose tenant row is missing from the thresholds map built in sweep() below - the real,
// live-configurable value now comes from tenants.offline_threshold_minutes (see settings.go),
// re-read fresh every sweep rather than cached at startup, so a change made via
// PATCH /v1/tenants/{id}/settings/offline-threshold takes effect on the very next sweep (within
// offlineCheckInterval), not only after a process restart.
const defaultOfflineThresholdMinutes = 2

type offlineDetector struct {
	mu               sync.Mutex
	offlineDeviceIDs map[string]bool
}

func newOfflineDetector() *offlineDetector {
	return &offlineDetector{offlineDeviceIDs: make(map[string]bool)}
}

func (o *offlineDetector) startLoop(db *DB, hub *liveHub) {
	go func() {
		for {
			time.Sleep(offlineCheckInterval)
			o.sweep(db, hub)
		}
	}()
}

// noteReporting is the live-status path: a device that just posted telemetry is reachable now,
// so don't wait for the next 60s sweep (or for heartbeat, which only runs every 60s) to fire
// device-online. No-op if this device wasn't flagged offline in this process.
func (o *offlineDetector) noteReporting(db *DB, hub *liveHub, deviceID, tenantID, hostname string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if !o.offlineDeviceIDs[deviceID] {
		return
	}
	delete(o.offlineDeviceIDs, deviceID)
	msg := fmt.Sprintf("Device %s (%s) is reporting again after being offline.", hostname, deviceID)
	o.fireEvent(db, hub, deviceID, tenantID, "device-online", msg, "info", time.Now())
}

// loadOfflineThresholds reads the real, currently-configured per-tenant threshold fresh on every
// call - one query, same cost as the devices query below, so a PATCHed value is live within one
// sweep interval rather than requiring a restart. Missing/invalid rows fall back to
// defaultOfflineThresholdMinutes rather than failing the whole sweep over one bad value.
func loadOfflineThresholds(db *DB) (map[string]time.Duration, error) {
	rows, err := db.Query(`SELECT id, offline_threshold_minutes FROM tenants`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make(map[string]time.Duration)
	for rows.Next() {
		var tenantID string
		var minutes int
		if err := rows.Scan(&tenantID, &minutes); err != nil {
			continue
		}
		if minutes <= 0 {
			minutes = defaultOfflineThresholdMinutes
		}
		out[tenantID] = time.Duration(minutes) * time.Minute
	}
	return out, rows.Err()
}

func (o *offlineDetector) sweep(db *DB, hub *liveHub) {
	rows, err := db.Query(`
		SELECT d.id, d.tenant_id, d.hostname, d.last_seen_at, ls.updated_at
		FROM devices d
		LEFT JOIN device_live_status ls ON ls.device_id = d.id
		WHERE d.status = 'active'`)
	if err != nil {
		log.Printf("offline-detector: failed to query active devices: %v", err)
		return
	}

	type deviceRow struct {
		id, tenantID, hostname string
		lastSeenAt             *string
		liveUpdatedAt          *string
	}
	var active []deviceRow
	for rows.Next() {
		var d deviceRow
		if err := rows.Scan(&d.id, &d.tenantID, &d.hostname, &d.lastSeenAt, &d.liveUpdatedAt); err != nil {
			log.Printf("offline-detector: scan failed: %v", err)
			continue
		}
		active = append(active, d)
	}
	rows.Close()

	thresholds, err := loadOfflineThresholds(db)
	if err != nil {
		log.Printf("offline-detector: failed to load offline thresholds, using default for this sweep: %v", err)
		thresholds = map[string]time.Duration{}
	}

	now := time.Now()
	o.mu.Lock()
	defer o.mu.Unlock()

	stillActiveIDs := make(map[string]bool, len(active))
	for _, d := range active {
		stillActiveIDs[d.id] = true
		threshold, ok := thresholds[d.tenantID]
		if !ok {
			threshold = defaultOfflineThresholdMinutes * time.Minute
		}
		// Live telemetry (~5s) is as much "reporting" as heartbeat (~60s). Use the later of
		// last_seen_at and device_live_status.updated_at so a device posting CPU/RAM/Disk
		// cannot be flagged offline just because heartbeat hasn't run yet.
		latest := laterTime(d.lastSeenAt, d.liveUpdatedAt)
		isStale := true
		if latest != nil {
			isStale = now.Sub(*latest) > threshold
		}

		wasOffline := o.offlineDeviceIDs[d.id]
		if isStale && !wasOffline {
			o.offlineDeviceIDs[d.id] = true
			msg := fmt.Sprintf("Device %s (%s) has stopped reporting - no telemetry received in over %s.", d.hostname, d.id, threshold)
			o.fireEvent(db, hub, d.id, d.tenantID, "device-offline", msg, "warning", now)
		} else if !isStale && wasOffline {
			delete(o.offlineDeviceIDs, d.id)
			msg := fmt.Sprintf("Device %s (%s) is reporting again after being offline.", d.hostname, d.id)
			o.fireEvent(db, hub, d.id, d.tenantID, "device-online", msg, "info", now)
		}
	}

	// Real cleanup: a device that's no longer active (revoked, or gone) shouldn't linger in
	// this in-memory map forever.
	for id := range o.offlineDeviceIDs {
		if !stillActiveIDs[id] {
			delete(o.offlineDeviceIDs, id)
		}
	}
}

func (o *offlineDetector) fireEvent(db *DB, hub *liveHub, deviceID, tenantID, eventType, message, severity string, now time.Time) {
	eventID, err := newID("event")
	if err != nil {
		log.Printf("offline-detector: failed to generate event id: %v", err)
		return
	}
	if err := insertEvent(db, eventID, tenantID, deviceID, eventType, message, severity, now); err != nil {
		log.Printf("offline-detector: failed to insert %s event: %v", eventType, err)
		return
	}
	event := Event{
		ID: eventID, TenantID: tenantID, DeviceID: deviceID,
		EventType: eventType, Message: message, Severity: severity,
		CreatedAt: now.UTC().Format(time.RFC3339Nano),
	}
	hub.publishEvent(tenantID, event)
	log.Printf("offline-detector: fired %s for device %s", eventType, deviceID)
}

func laterTime(a, b *string) *time.Time {
	ta, tb := parseRFC3339(a), parseRFC3339(b)
	if ta == nil {
		return tb
	}
	if tb == nil {
		return ta
	}
	if tb.After(*ta) {
		return tb
	}
	return ta
}

func parseRFC3339(s *string) *time.Time {
	if s == nil || *s == "" {
		return nil
	}
	if t, err := time.Parse(time.RFC3339Nano, *s); err == nil {
		return &t
	}
	return nil
}
