package main

import (
	"os"
	"testing"
	"time"
)

func setupTestDB(t *testing.T) *DB {
	t.Helper()
	url := os.Getenv("DATABASE_URL_TEST")
	if url == "" {
		t.Skip("DATABASE_URL_TEST not set")
	}
	db, err := openDB(url)
	if err != nil {
		t.Fatalf("openDB: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	if err := runMigrations(db); err != nil {
		t.Fatalf("runMigrations: %v", err)
	}

	t.Cleanup(func() {
		_, _ = db.Exec(`DELETE FROM events WHERE device_id = ?`, "device_test1")
		_, _ = db.Exec(`DELETE FROM devices WHERE id = ?`, "device_test1")
	})
	if _, err := db.Exec(
		`INSERT INTO devices (id, tenant_id, hostname, api_key_hash) VALUES (?, ?, ?, ?)
		 ON CONFLICT (id) DO NOTHING`,
		"device_test1", "tenant-1", "TEST-HOST", "unused-hash",
	); err != nil {
		t.Fatalf("insert test device: %v", err)
	}
	return db
}

func TestEventChainIntactOnRealInserts(t *testing.T) {
	db := setupTestDB(t)
	now := time.Now()
	events := []struct {
		id, eventType, message, severity string
	}{
		{"evt_a", "device-online", "Device came online", "info"},
		{"evt_b", "cpu-high", "CPU crossed warning", "warning"},
		{"evt_c", "disk-full", "Disk crossed critical", "critical"},
	}
	for i, e := range events {
		if err := insertEvent(db, e.id, "tenant-1", "device_test1", e.eventType, e.message, e.severity, now.Add(time.Duration(i)*time.Second)); err != nil {
			t.Fatalf("insertEvent %s: %v", e.id, err)
		}
	}
	got, err := verifyEventChain(db, "tenant-1")
	if err != nil {
		t.Fatalf("verifyEventChain: %v", err)
	}
	if !got.Intact {
		t.Fatalf("chain should be intact, got %#v", got)
	}
}

func TestEventChainDetectsContentTamper(t *testing.T) {
	db := setupTestDB(t)
	now := time.Now()
	for i, id := range []string{"evt_a", "evt_b", "evt_c"} {
		if err := insertEvent(db, id, "tenant-1", "device_test1", "info-event", "original "+id, "info", now.Add(time.Duration(i)*time.Second)); err != nil {
			t.Fatalf("insertEvent %s: %v", id, err)
		}
	}
	if _, err := db.Exec(`UPDATE events SET message = ? WHERE id = ?`, "TAMPERED: this was not the original message", "evt_c"); err != nil {
		t.Fatalf("tamper update: %v", err)
	}
	got, err := verifyEventChain(db, "tenant-1")
	if err != nil {
		t.Fatalf("verifyEventChain: %v", err)
	}
	if got.Intact {
		t.Fatal("tampered chain reported intact")
	}
	if got.BrokenAtEventID == nil || *got.BrokenAtEventID != "evt_c" {
		t.Fatalf("expected break at evt_c, got %#v", got)
	}
}

func TestEventChainSurvivesPruningOldest(t *testing.T) {
	db := setupTestDB(t)
	now := time.Now()
	for i, id := range []string{"evt_p1", "evt_p2", "evt_p3"} {
		if err := insertEvent(db, id, "tenant-1", "device_test1", "info-event", id, "info", now.Add(time.Duration(i)*time.Second)); err != nil {
			t.Fatalf("insertEvent %s: %v", id, err)
		}
	}
	if _, err := db.Exec(`DELETE FROM events WHERE id = ?`, "evt_p1"); err != nil {
		t.Fatalf("prune: %v", err)
	}
	got, err := verifyEventChain(db, "tenant-1")
	if err != nil {
		t.Fatalf("verifyEventChain: %v", err)
	}
	if !got.Intact {
		t.Fatalf("pruned chain should still verify among survivors, got %#v", got)
	}
}

func TestUntrackedHistoricalEvents(t *testing.T) {
	db := setupTestDB(t)
	if _, err := db.Exec(
		`INSERT INTO events (id, tenant_id, device_id, event_type, message, severity, created_at, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
		"evt_legacy", "tenant-1", "device_test1", "legacy", "predates chain", "info", time.Now().UTC().Format(time.RFC3339Nano),
	); err != nil {
		t.Fatalf("insert untracked: %v", err)
	}
	got, err := verifyEventChain(db, "tenant-1")
	if err != nil {
		t.Fatalf("verifyEventChain: %v", err)
	}
	if got.UntrackedHistoricalEvents < 1 {
		t.Fatalf("expected at least one untracked row, got %#v", got)
	}
}
