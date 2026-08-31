package main

import (
	"database/sql"
	"fmt"
	"log"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite"
)

func defaultSQLitePath() string {
	if p := os.Getenv("SQLITE_MIGRATE_PATH"); p != "" {
		return p
	}
	programData := os.Getenv("ProgramData")
	if programData == "" {
		programData = `C:\ProgramData`
	}
	return filepath.Join(programData, "Pulse Endpoint", "backend", "command-center.db")
}

func maybeMigrateFromSQLite(pg *DB) error {
	path := defaultSQLitePath()
	if _, err := os.Stat(path); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}

	var n int
	if err := pg.QueryRow(`SELECT COUNT(*) FROM devices`).Scan(&n); err != nil {
		return fmt.Errorf("count postgres devices: %w", err)
	}
	if n > 0 {
		return nil
	}

	log.Printf("migrating existing SQLite fleet data from %s into PostgreSQL", path)
	if err := copySQLiteToPostgres(pg, path); err != nil {
		return err
	}
	log.Printf("SQLite migration complete")
	return nil
}

func sqliteHasColumn(db *sql.DB, table, column string) bool {
	rows, err := db.Query(`PRAGMA table_info(` + table + `)`)
	if err != nil {
		return false
	}
	defer rows.Close()
	for rows.Next() {
		var cid int
		var name, colType string
		var notNull, pk int
		var dflt any
		if err := rows.Scan(&cid, &name, &colType, &notNull, &dflt, &pk); err != nil {
			return false
		}
		if name == column {
			return true
		}
	}
	return false
}

func copySQLiteToPostgres(pg *DB, sqlitePath string) error {
	src, err := sql.Open("sqlite", "file:"+sqlitePath+"?mode=ro&_pragma=busy_timeout=5000")
	if err != nil {
		return fmt.Errorf("open sqlite for migrate: %w", err)
	}
	defer src.Close()
	if err := src.Ping(); err != nil {
		return fmt.Errorf("ping sqlite for migrate: %w", err)
	}

	if err := copyTenants(src, pg); err != nil {
		return err
	}
	if err := copyEntitlements(src, pg); err != nil {
		return err
	}
	if err := copyPlanFeatures(src, pg); err != nil {
		return err
	}
	if err := copyDevices(src, pg); err != nil {
		return err
	}
	if err := copyEvents(src, pg); err != nil {
		return err
	}
	if err := copyNotificationState(src, pg); err != nil {
		return err
	}
	if err := copyApprovalRequests(src, pg); err != nil {
		return err
	}
	if err := copyMetricSnapshots(src, pg); err != nil {
		return err
	}
	if err := copyLiveStatus(src, pg); err != nil {
		return err
	}
	if err := copyIncidents(src, pg); err != nil {
		return err
	}
	if err := copyIncidentNotes(src, pg); err != nil {
		return err
	}
	return copyAlertRules(src, pg)
}

func copyTenants(src *sql.DB, pg *DB) error {
	rows, err := src.Query(`SELECT id, name, COALESCE(offline_threshold_minutes, 2), created_at FROM tenants`)
	if err != nil {
		return fmt.Errorf("sqlite tenants: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id, name, createdAt string
		var minutes int
		if err := rows.Scan(&id, &name, &minutes, &createdAt); err != nil {
			return err
		}
		if _, err := pg.Exec(
			`INSERT INTO tenants (id, name, offline_threshold_minutes, created_at) VALUES (?, ?, ?, ?)
			 ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, offline_threshold_minutes = EXCLUDED.offline_threshold_minutes, created_at = EXCLUDED.created_at`,
			id, name, minutes, createdAt,
		); err != nil {
			return fmt.Errorf("postgres tenants: %w", err)
		}
	}
	return rows.Err()
}

func copyEntitlements(src *sql.DB, pg *DB) error {
	rows, err := src.Query(`SELECT id, tenant_id, plan, status, renewed_at, expires_at, licensed_devices FROM entitlements`)
	if err != nil {
		return fmt.Errorf("sqlite entitlements: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id, tenantID, plan, status string
		var renewed, expires sql.NullString
		var licensed sql.NullInt64
		if err := rows.Scan(&id, &tenantID, &plan, &status, &renewed, &expires, &licensed); err != nil {
			return err
		}
		if _, err := pg.Exec(
			`INSERT INTO entitlements (id, tenant_id, plan, status, renewed_at, expires_at, licensed_devices) VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (id) DO UPDATE SET plan = EXCLUDED.plan, status = EXCLUDED.status, renewed_at = EXCLUDED.renewed_at, expires_at = EXCLUDED.expires_at, licensed_devices = EXCLUDED.licensed_devices`,
			id, tenantID, plan, status, nullStr(renewed), nullStr(expires), nullInt(licensed),
		); err != nil {
			return fmt.Errorf("postgres entitlements: %w", err)
		}
	}
	return rows.Err()
}

func copyPlanFeatures(src *sql.DB, pg *DB) error {
	rows, err := src.Query(`SELECT plan, feature, included FROM plan_features`)
	if err != nil {
		return fmt.Errorf("sqlite plan_features: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var plan, feature string
		var included int
		if err := rows.Scan(&plan, &feature, &included); err != nil {
			return err
		}
		if _, err := pg.Exec(
			`INSERT INTO plan_features (plan, feature, included) VALUES (?, ?, ?)
			 ON CONFLICT (plan, feature) DO UPDATE SET included = EXCLUDED.included`,
			plan, feature, included,
		); err != nil {
			return fmt.Errorf("postgres plan_features: %w", err)
		}
	}
	return rows.Err()
}

func copyDevices(src *sql.DB, pg *DB) error {
	q := `SELECT id, tenant_id, hostname, api_key_hash, enrolled_at, last_seen_at, status, hardware_fingerprint, fingerprint_locked_at`
	if sqliteHasColumn(src, "devices", "tags") {
		q += `, tags`
	} else {
		q += `, '' AS tags`
	}
	q += ` FROM devices`
	rows, err := src.Query(q)
	if err != nil {
		return fmt.Errorf("sqlite devices: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id, tenantID, hostname, apiKeyHash, enrolledAt, status, tags string
		var lastSeen, fp, fpAt sql.NullString
		if err := rows.Scan(&id, &tenantID, &hostname, &apiKeyHash, &enrolledAt, &lastSeen, &status, &fp, &fpAt, &tags); err != nil {
			return err
		}
		if _, err := pg.Exec(
			`INSERT INTO devices (id, tenant_id, hostname, api_key_hash, enrolled_at, last_seen_at, status, tags, hardware_fingerprint, fingerprint_locked_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (id) DO NOTHING`,
			id, tenantID, hostname, apiKeyHash, enrolledAt, nullStr(lastSeen), status, tags, nullStr(fp), nullStr(fpAt),
		); err != nil {
			return fmt.Errorf("postgres devices: %w", err)
		}
	}
	return rows.Err()
}

func copyEvents(src *sql.DB, pg *DB) error {
	rows, err := src.Query(`SELECT id, tenant_id, device_id, event_type, message, severity, created_at, prev_hash, hash FROM events ORDER BY rowid`)
	if err != nil {
		return fmt.Errorf("sqlite events: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id, tenantID, deviceID, eventType, message, severity, createdAt string
		var prev, hash sql.NullString
		if err := rows.Scan(&id, &tenantID, &deviceID, &eventType, &message, &severity, &createdAt, &prev, &hash); err != nil {
			return err
		}
		if _, err := pg.Exec(
			`INSERT INTO events (id, tenant_id, device_id, event_type, message, severity, created_at, prev_hash, hash)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (id) DO NOTHING`,
			id, tenantID, deviceID, eventType, message, severity, createdAt, nullStr(prev), nullStr(hash),
		); err != nil {
			return fmt.Errorf("postgres events: %w", err)
		}
	}
	return rows.Err()
}

func copyNotificationState(src *sql.DB, pg *DB) error {
	rows, err := src.Query(`SELECT event_id, tenant_id, read_at, cleared_at FROM event_notification_state`)
	if err != nil {
		return fmt.Errorf("sqlite event_notification_state: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var eventID, tenantID string
		var readAt, clearedAt sql.NullString
		if err := rows.Scan(&eventID, &tenantID, &readAt, &clearedAt); err != nil {
			return err
		}
		if _, err := pg.Exec(
			`INSERT INTO event_notification_state (event_id, tenant_id, read_at, cleared_at) VALUES (?, ?, ?, ?)
			 ON CONFLICT (event_id) DO NOTHING`,
			eventID, tenantID, nullStr(readAt), nullStr(clearedAt),
		); err != nil {
			return fmt.Errorf("postgres event_notification_state: %w", err)
		}
	}
	return rows.Err()
}

func copyApprovalRequests(src *sql.DB, pg *DB) error {
	rows, err := src.Query(`SELECT id, tenant_id, device_id, action, status, signature, expires_at, created_at, decided_at FROM approval_requests`)
	if err != nil {
		return fmt.Errorf("sqlite approval_requests: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id, tenantID, deviceID, action, status, createdAt string
		var signature, expiresAt, decidedAt sql.NullString
		if err := rows.Scan(&id, &tenantID, &deviceID, &action, &status, &signature, &expiresAt, &createdAt, &decidedAt); err != nil {
			return err
		}
		if _, err := pg.Exec(
			`INSERT INTO approval_requests (id, tenant_id, device_id, action, status, signature, expires_at, created_at, decided_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (id) DO NOTHING`,
			id, tenantID, deviceID, action, status, nullStr(signature), nullStr(expiresAt), createdAt, nullStr(decidedAt),
		); err != nil {
			return fmt.Errorf("postgres approval_requests: %w", err)
		}
	}
	return rows.Err()
}

func copyMetricSnapshots(src *sql.DB, pg *DB) error {
	rows, err := src.Query(`SELECT id, tenant_id, device_id, battery_health_pct, ssd_wear_pct, recorded_at FROM device_metric_snapshots`)
	if err != nil {
		return fmt.Errorf("sqlite device_metric_snapshots: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id, tenantID, deviceID, recordedAt string
		var battery, ssd sql.NullFloat64
		if err := rows.Scan(&id, &tenantID, &deviceID, &battery, &ssd, &recordedAt); err != nil {
			return err
		}
		if _, err := pg.Exec(
			`INSERT INTO device_metric_snapshots (id, tenant_id, device_id, battery_health_pct, ssd_wear_pct, recorded_at)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT (id) DO NOTHING`,
			id, tenantID, deviceID, nullFloat(battery), nullFloat(ssd), recordedAt,
		); err != nil {
			return fmt.Errorf("postgres device_metric_snapshots: %w", err)
		}
	}
	return rows.Err()
}

func copyLiveStatus(src *sql.DB, pg *DB) error {
	q := `SELECT device_id, tenant_id, cpu_pct, ram_pct, disk_pct, battery_pct, updated_at`
	if sqliteHasColumn(src, "device_live_status", "detail") {
		q += `, detail`
	} else {
		q += `, NULL AS detail`
	}
	q += ` FROM device_live_status`
	rows, err := src.Query(q)
	if err != nil {
		return fmt.Errorf("sqlite device_live_status: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var deviceID, tenantID, updatedAt string
		var cpu, ram, disk, battery sql.NullFloat64
		var detail sql.NullString
		if err := rows.Scan(&deviceID, &tenantID, &cpu, &ram, &disk, &battery, &updatedAt, &detail); err != nil {
			return err
		}
		if _, err := pg.Exec(
			`INSERT INTO device_live_status (device_id, tenant_id, cpu_pct, ram_pct, disk_pct, battery_pct, detail, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (device_id) DO NOTHING`,
			deviceID, tenantID, nullFloat(cpu), nullFloat(ram), nullFloat(disk), nullFloat(battery), nullStr(detail), updatedAt,
		); err != nil {
			return fmt.Errorf("postgres device_live_status: %w", err)
		}
	}
	return rows.Err()
}

func copyIncidents(src *sql.DB, pg *DB) error {
	rows, err := src.Query(`SELECT id, tenant_id, device_id, source_event_id, title, severity, status, assigned_to, created_at, updated_at, resolved_at, closed_at FROM incidents`)
	if err != nil {
		return fmt.Errorf("sqlite incidents: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id, tenantID, deviceID, title, severity, status, createdAt, updatedAt string
		var source, assigned, resolved, closed sql.NullString
		if err := rows.Scan(&id, &tenantID, &deviceID, &source, &title, &severity, &status, &assigned, &createdAt, &updatedAt, &resolved, &closed); err != nil {
			return err
		}
		if _, err := pg.Exec(
			`INSERT INTO incidents (id, tenant_id, device_id, source_event_id, title, severity, status, assigned_to, created_at, updated_at, resolved_at, closed_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (id) DO NOTHING`,
			id, tenantID, deviceID, nullStr(source), title, severity, status, nullStr(assigned), createdAt, updatedAt, nullStr(resolved), nullStr(closed),
		); err != nil {
			return fmt.Errorf("postgres incidents: %w", err)
		}
	}
	return rows.Err()
}

func copyIncidentNotes(src *sql.DB, pg *DB) error {
	rows, err := src.Query(`SELECT id, incident_id, tenant_id, note, created_at FROM incident_notes`)
	if err != nil {
		return fmt.Errorf("sqlite incident_notes: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id, incidentID, tenantID, note, createdAt string
		if err := rows.Scan(&id, &incidentID, &tenantID, &note, &createdAt); err != nil {
			return err
		}
		if _, err := pg.Exec(
			`INSERT INTO incident_notes (id, incident_id, tenant_id, note, created_at) VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT (id) DO NOTHING`,
			id, incidentID, tenantID, note, createdAt,
		); err != nil {
			return fmt.Errorf("postgres incident_notes: %w", err)
		}
	}
	return rows.Err()
}

func copyAlertRules(src *sql.DB, pg *DB) error {
	rows, err := src.Query(`SELECT id, tenant_id, metric, operator, threshold, severity, enabled, created_at FROM alert_rules`)
	if err != nil {
		return fmt.Errorf("sqlite alert_rules: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id, tenantID, metric, operator, severity, createdAt string
		var threshold float64
		var enabled int
		if err := rows.Scan(&id, &tenantID, &metric, &operator, &threshold, &severity, &enabled, &createdAt); err != nil {
			return err
		}
		if _, err := pg.Exec(
			`INSERT INTO alert_rules (id, tenant_id, metric, operator, threshold, severity, enabled, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (id) DO NOTHING`,
			id, tenantID, metric, operator, threshold, severity, enabled, createdAt,
		); err != nil {
			return fmt.Errorf("postgres alert_rules: %w", err)
		}
	}
	return rows.Err()
}

func nullStr(v sql.NullString) any {
	if !v.Valid {
		return nil
	}
	return v.String
}

func nullInt(v sql.NullInt64) any {
	if !v.Valid {
		return nil
	}
	return v.Int64
}

func nullFloat(v sql.NullFloat64) any {
	if !v.Valid {
		return nil
	}
	return v.Float64
}
