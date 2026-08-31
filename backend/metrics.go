package main

import (
	"database/sql"
	"time"
)

// MetricSnapshot is one real, dated point in a device's slowly-accumulating measurement history
// (device_metric_snapshots) - the genuine time-series AI Intel's SSD/Battery Remaining Life
// predictions need, distinct from the discrete events log. Either percentage is independently
// nullable - a day where only one real source was available still records whichever real value
// it actually has.
type MetricSnapshot struct {
	RecordedAt       string   `json:"recordedAt"`
	BatteryHealthPct *float64 `json:"batteryHealthPct"`
	SSDWearPct       *float64 `json:"ssdWearPct"`
}

// recordMetricSnapshot is a real dedup-by-calendar-day upsert, not a plain insert - local-agent
// already avoids redundant same-day calls on its own (see telemetry-server.mjs's persisted
// lastSnapshotDate), but this is the authoritative guarantee: whatever calls this, however many
// times in one day (a local-agent restart, a bug, a second device instance), a single real day
// only ever produces one row. COALESCE on the UPDATE path deliberately never lets a later
// null overwrite an earlier real value recorded the same day - only a genuinely non-null new
// reading ever replaces what's already stored for today.
func recordMetricSnapshot(db *DB, id, tenantID, deviceID string, batteryHealthPct, ssdWearPct *float64, now time.Time) error {
	today := now.UTC().Format("2006-01-02")
	nowStr := now.UTC().Format(time.RFC3339Nano)

	var existingID string
	err := db.QueryRow(
		`SELECT id FROM device_metric_snapshots WHERE device_id = ? AND substr(recorded_at, 1, 10) = ? ORDER BY recorded_at DESC LIMIT 1`,
		deviceID, today,
	).Scan(&existingID)
	if err == nil {
		_, err = db.Exec(
			`UPDATE device_metric_snapshots SET battery_health_pct = COALESCE(?, battery_health_pct), ssd_wear_pct = COALESCE(?, ssd_wear_pct), recorded_at = ? WHERE id = ?`,
			batteryHealthPct, ssdWearPct, nowStr, existingID,
		)
		return err
	}
	if err != sql.ErrNoRows {
		return err
	}

	_, err = db.Exec(
		`INSERT INTO device_metric_snapshots (id, tenant_id, device_id, battery_health_pct, ssd_wear_pct, recorded_at) VALUES (?, ?, ?, ?, ?, ?)`,
		id, tenantID, deviceID, batteryHealthPct, ssdWearPct, nowStr,
	)
	return err
}

// listMetricSnapshots returns every real recorded day for this device, oldest first - the
// natural order for ai-service's regression (which needs day-offset-from-first-point, not
// newest-first like listEventsByDevice above).
func listMetricSnapshots(db *DB, deviceID string) ([]MetricSnapshot, error) {
	rows, err := db.Query(
		`SELECT recorded_at, battery_health_pct, ssd_wear_pct FROM device_metric_snapshots WHERE device_id = ? ORDER BY recorded_at ASC`,
		deviceID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []MetricSnapshot{}
	for rows.Next() {
		var s MetricSnapshot
		if err := rows.Scan(&s.RecordedAt, &s.BatteryHealthPct, &s.SSDWearPct); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}
