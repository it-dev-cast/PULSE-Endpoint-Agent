package main

import (
	"fmt"
	"log"
	"sync"
	"time"
)

// Real, periodic alert-rule evaluation - the same architectural pattern as offline_detection.go's
// liveness sweep, reused deliberately rather than designed from scratch: a goroutine ticking on
// an interval, comparing real current state against a real threshold, and firing a real event
// only on the genuine inactive->active transition (never once per sweep while a breach persists).
//
// This directly fixes a real bug found earlier in this project (the Tauri app's client-side alert
// engine fired hundreds of duplicate alerts for a metric hovering near a threshold, with no
// per-device/per-rule "already firing" state at all) - tracking activeBreaches here the same way
// offlineDeviceIDs already does is that exact proven fix, not a new design. A breach only re-fires
// after a real clear (the value genuinely crossing back past the threshold, observed on some
// later sweep - not just one favorable reading), because clearing is itself gated the same way:
// activeBreaches only deletes an entry once isBreached is false, so a single noisy reading that
// dips below threshold for one sweep and immediately breaches again on the next sweep would (like
// offline_detection.go's own dedup) still only produce one clear+one re-fire, not a flood.
const alertCheckInterval = 60 * time.Second

type alertEngine struct {
	mu             sync.Mutex
	activeBreaches map[string]bool // key: ruleID + ":" + deviceID
}

func newAlertEngine() *alertEngine {
	return &alertEngine{activeBreaches: make(map[string]bool)}
}

func (a *alertEngine) startLoop(db *DB, hub *liveHub) {
	go func() {
		for {
			time.Sleep(alertCheckInterval)
			a.sweep(db, hub)
		}
	}()
}

// metricValue picks the one real field a rule's metric refers to - never a fabricated reading.
// nil (not 0) when this device has no real value for that metric yet, so a device that's never
// reported battery, say, is correctly treated as "no data to evaluate" rather than as a false 0%.
func metricValue(metric string, cpu, ram, disk, battery *float64) *float64 {
	switch metric {
	case "cpu":
		return cpu
	case "ram":
		return ram
	case "disk":
		return disk
	case "battery":
		return battery
	default:
		return nil
	}
}

func evaluateBreach(operator string, value, threshold float64) bool {
	if operator == ">" {
		return value > threshold
	}
	return value < threshold
}

func metricLabel(metric string) string {
	switch metric {
	case "cpu":
		return "CPU usage"
	case "ram":
		return "RAM usage"
	case "disk":
		return "Disk usage"
	case "battery":
		return "Battery"
	default:
		return metric
	}
}

func (a *alertEngine) sweep(db *DB, hub *liveHub) {
	// enabled=1 re-read fresh every sweep, not cached at startup or between sweeps - the exact
	// same live-reload approach settings.go's offline threshold already established: a rule
	// created, edited, or disabled via the real CRUD API takes effect on the very next sweep.
	ruleRows, err := db.Query(`SELECT id, tenant_id, metric, operator, threshold, severity FROM alert_rules WHERE enabled = 1`)
	if err != nil {
		log.Printf("alert-engine: failed to query enabled alert rules: %v", err)
		return
	}
	type ruleRow struct {
		id, tenantID, metric, operator, severity string
		threshold                                float64
	}
	var rules []ruleRow
	for ruleRows.Next() {
		var rr ruleRow
		if err := ruleRows.Scan(&rr.id, &rr.tenantID, &rr.metric, &rr.operator, &rr.threshold, &rr.severity); err != nil {
			log.Printf("alert-engine: rule scan failed: %v", err)
			continue
		}
		rules = append(rules, rr)
	}
	ruleRows.Close()
	if len(rules) == 0 {
		return
	}

	deviceRows, err := db.Query(
		`SELECT ls.device_id, ls.tenant_id, d.hostname, ls.cpu_pct, ls.ram_pct, ls.disk_pct, ls.battery_pct
		 FROM device_live_status ls
		 JOIN devices d ON d.id = ls.device_id
		 WHERE d.status = 'active'`)
	if err != nil {
		log.Printf("alert-engine: failed to query live status: %v", err)
		return
	}
	type deviceRow struct {
		id, tenantID, hostname  string
		cpu, ram, disk, battery *float64
	}
	var devices []deviceRow
	for deviceRows.Next() {
		var d deviceRow
		if err := deviceRows.Scan(&d.id, &d.tenantID, &d.hostname, &d.cpu, &d.ram, &d.disk, &d.battery); err != nil {
			log.Printf("alert-engine: device scan failed: %v", err)
			continue
		}
		devices = append(devices, d)
	}
	deviceRows.Close()

	now := time.Now()
	a.mu.Lock()
	defer a.mu.Unlock()

	stillPossible := make(map[string]bool, len(rules)*len(devices))
	for _, rule := range rules {
		for _, d := range devices {
			if d.tenantID != rule.tenantID {
				continue
			}
			value := metricValue(rule.metric, d.cpu, d.ram, d.disk, d.battery)
			key := rule.id + ":" + d.id
			stillPossible[key] = true

			if value == nil {
				// No real reading for this metric yet on this device - not evaluable, and not a
				// clear either (clearing implies we know the real current value and it's fine).
				continue
			}

			isBreached := evaluateBreach(rule.operator, *value, rule.threshold)
			wasBreached := a.activeBreaches[key]

			if isBreached && !wasBreached {
				a.activeBreaches[key] = true
				msg := fmt.Sprintf("%s on %s (%s) %s %.0f%% - current value %.1f%%.",
					metricLabel(rule.metric), d.hostname, d.id, breachVerb(rule.operator), rule.threshold, *value)
				a.fireEvent(db, hub, d.id, d.tenantID, "alert-rule-triggered", msg, rule.severity, now)
			} else if !isBreached && wasBreached {
				delete(a.activeBreaches, key)
				msg := fmt.Sprintf("%s on %s (%s) is back within the configured threshold (%.0f%%) - current value %.1f%%.",
					metricLabel(rule.metric), d.hostname, d.id, rule.threshold, *value)
				a.fireEvent(db, hub, d.id, d.tenantID, "alert-rule-cleared", msg, "info", now)
			}
		}
	}

	// Same real cleanup offline_detection.go's own sweep does - a rule that's been deleted/
	// disabled, or a device that's no longer active, shouldn't leave a stale entry here forever.
	for key := range a.activeBreaches {
		if !stillPossible[key] {
			delete(a.activeBreaches, key)
		}
	}
}

func breachVerb(operator string) string {
	if operator == ">" {
		return "exceeds"
	}
	return "is below"
}

func (a *alertEngine) fireEvent(db *DB, hub *liveHub, deviceID, tenantID, eventType, message, severity string, now time.Time) {
	eventID, err := newID("event")
	if err != nil {
		log.Printf("alert-engine: failed to generate event id: %v", err)
		return
	}
	if err := insertEvent(db, eventID, tenantID, deviceID, eventType, message, severity, now); err != nil {
		log.Printf("alert-engine: failed to insert %s event: %v", eventType, err)
		return
	}
	event := Event{
		ID: eventID, TenantID: tenantID, DeviceID: deviceID,
		EventType: eventType, Message: message, Severity: severity,
		CreatedAt: now.UTC().Format(time.RFC3339Nano),
	}
	hub.publishEvent(tenantID, event)
	log.Printf("alert-engine: fired %s for device %s (rule severity %s)", eventType, deviceID, severity)
}
