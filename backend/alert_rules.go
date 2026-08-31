package main

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
)

// Real, admin-configurable alert-rule CRUD (evaluation lives in alert_engine.go). Route shape
// mirrors incidents.go/approval_requests exactly: create+list are tenant-scoped
// (/tenants/{id}/alert-rules), update+delete act on the rule's own already-unique ID
// (/alert-rules/{id}) the same way /incidents/{id}/status and /approval-requests/{id}/approve do.

var validAlertMetrics = map[string]bool{"cpu": true, "ram": true, "disk": true, "battery": true}
var validAlertOperators = map[string]bool{">": true, "<": true}
var validAlertSeverities = map[string]bool{"warning": true, "critical": true}

type AlertRule struct {
	ID        string  `json:"id"`
	TenantID  string  `json:"tenantId"`
	Metric    string  `json:"metric"`
	Operator  string  `json:"operator"`
	Threshold float64 `json:"threshold"`
	Severity  string  `json:"severity"`
	Enabled   bool    `json:"enabled"`
	CreatedAt string  `json:"createdAt"`
}

func insertAlertRule(db *DB, id, tenantID, metric, operator string, threshold float64, severity string, now time.Time) error {
	_, err := db.Exec(
		`INSERT INTO alert_rules (id, tenant_id, metric, operator, threshold, severity, enabled, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
		id, tenantID, metric, operator, threshold, severity, now.UTC().Format(time.RFC3339Nano),
	)
	return err
}

func scanAlertRule(row interface{ Scan(...interface{}) error }) (AlertRule, error) {
	var r AlertRule
	var enabled int
	err := row.Scan(&r.ID, &r.TenantID, &r.Metric, &r.Operator, &r.Threshold, &r.Severity, &enabled, &r.CreatedAt)
	r.Enabled = enabled == 1
	return r, err
}

func listAlertRulesByTenant(db *DB, tenantID string) ([]AlertRule, error) {
	rows, err := db.Query(
		`SELECT id, tenant_id, metric, operator, threshold, severity, enabled, created_at
		 FROM alert_rules WHERE tenant_id = ? ORDER BY created_at DESC`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []AlertRule{}
	for rows.Next() {
		r, err := scanAlertRule(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func getAlertRule(db *DB, id string) (AlertRule, error) {
	row := db.QueryRow(
		`SELECT id, tenant_id, metric, operator, threshold, severity, enabled, created_at
		 FROM alert_rules WHERE id = ?`, id)
	r, err := scanAlertRule(row)
	if err == sql.ErrNoRows {
		return AlertRule{}, ErrNotFound
	}
	return r, err
}

func deleteAlertRule(db *DB, id string) error {
	res, err := db.Exec(`DELETE FROM alert_rules WHERE id = ?`, id)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

type createAlertRuleRequest struct {
	Metric    string  `json:"metric"`
	Operator  string  `json:"operator"`
	Threshold float64 `json:"threshold"`
	Severity  string  `json:"severity"`
}

func (req createAlertRuleRequest) validate() string {
	if !validAlertMetrics[req.Metric] {
		return "metric must be one of cpu, ram, disk, battery"
	}
	if !validAlertOperators[req.Operator] {
		return "operator must be > or <"
	}
	if req.Threshold < 0 || req.Threshold > 100 {
		return "threshold must be between 0 and 100 (all real metrics are percentages)"
	}
	if !validAlertSeverities[req.Severity] {
		return "severity must be warning or critical"
	}
	return ""
}

func handleCreateAlertRule(db *DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := chi.URLParam(r, "id")

		var req createAlertRuleRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		if msg := req.validate(); msg != "" {
			writeError(w, http.StatusBadRequest, msg)
			return
		}

		id, err := newID("alert-rule")
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to generate id")
			return
		}
		now := time.Now()
		if err := insertAlertRule(db, id, tenantID, req.Metric, req.Operator, req.Threshold, req.Severity, now); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to create alert rule")
			return
		}

		rule, err := getAlertRule(db, id)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "rule created but failed to read it back")
			return
		}
		writeJSON(w, http.StatusCreated, rule)
	}
}

func handleListAlertRules(db *DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := chi.URLParam(r, "id")
		rules, err := listAlertRulesByTenant(db, tenantID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to list alert rules")
			return
		}
		writeJSON(w, http.StatusOK, rules)
	}
}

type patchAlertRuleRequest struct {
	Metric    *string  `json:"metric"`
	Operator  *string  `json:"operator"`
	Threshold *float64 `json:"threshold"`
	Severity  *string  `json:"severity"`
	Enabled   *bool    `json:"enabled"`
}

// handlePatchAlertRule applies only the fields present in the request (a bare {"enabled":false}
// toggles just that, without requiring the caller to resend the whole rule) - the same partial-
// update shape as handleUpdateIncidentStatus's own single-field PATCH, just generalized to
// several optional fields since a rule has more than one thing worth changing independently.
func handlePatchAlertRule(db *DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")

		existing, err := getAlertRule(db, id)
		if err == ErrNotFound {
			writeError(w, http.StatusNotFound, "alert rule not found")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		var req patchAlertRuleRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body")
			return
		}

		metric, operator, severity := existing.Metric, existing.Operator, existing.Severity
		threshold, enabled := existing.Threshold, existing.Enabled
		if req.Metric != nil {
			metric = *req.Metric
		}
		if req.Operator != nil {
			operator = *req.Operator
		}
		if req.Threshold != nil {
			threshold = *req.Threshold
		}
		if req.Severity != nil {
			severity = *req.Severity
		}
		if req.Enabled != nil {
			enabled = *req.Enabled
		}

		merged := createAlertRuleRequest{Metric: metric, Operator: operator, Threshold: threshold, Severity: severity}
		if msg := merged.validate(); msg != "" {
			writeError(w, http.StatusBadRequest, msg)
			return
		}

		enabledInt := 0
		if enabled {
			enabledInt = 1
		}
		if _, err := db.Exec(
			`UPDATE alert_rules SET metric = ?, operator = ?, threshold = ?, severity = ?, enabled = ? WHERE id = ?`,
			metric, operator, threshold, severity, enabledInt, id,
		); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to update alert rule")
			return
		}

		updated, err := getAlertRule(db, id)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "rule updated but failed to read it back")
			return
		}
		writeJSON(w, http.StatusOK, updated)
	}
}

func handleDeleteAlertRule(db *DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		if err := deleteAlertRule(db, id); err == ErrNotFound {
			writeError(w, http.StatusNotFound, "alert rule not found")
			return
		} else if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to delete alert rule")
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"id": id, "status": "deleted"})
	}
}
