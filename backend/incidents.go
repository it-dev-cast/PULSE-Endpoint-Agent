package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
)

// ─── Alert vs Incident ───────────────────────────────────────────────────
// A row in `events` with severity warning/critical is an alert: "something abnormal was
// detected." Not every alert warrants an incident - an incident means "an operator is tracking
// and acting on this." This file is the real, minimal v1 of that distinction: an operator
// promotes a specific alert (or opens one directly) into a tracked incident, moves it through a
// real status lifecycle, and leaves a note trail - the operational workflow this dashboard was
// missing entirely until now (a flat event feed has no way to say "I'm on this" or "this is
// resolved").

type Incident struct {
	ID            string  `json:"id"`
	TenantID      string  `json:"tenantId"`
	DeviceID      string  `json:"deviceId"`
	SourceEventID *string `json:"sourceEventId"`
	Title         string  `json:"title"`
	Severity      string  `json:"severity"`
	Status        string  `json:"status"`
	AssignedTo    *string `json:"assignedTo"`
	CreatedAt     string  `json:"createdAt"`
	UpdatedAt     string  `json:"updatedAt"`
	ResolvedAt    *string `json:"resolvedAt"`
	ClosedAt      *string `json:"closedAt"`
}

type IncidentNote struct {
	ID         string `json:"id"`
	IncidentID string `json:"incidentId"`
	TenantID   string `json:"tenantId"`
	Note       string `json:"note"`
	CreatedAt  string `json:"createdAt"`
}

// validIncidentStatuses is the real, complete lifecycle - not every incident passes through
// every state, but the workflow supports all of them (same "recommended states, not mandatory"
// framing as the PRD this was built from).
var validIncidentStatuses = map[string]bool{
	"open": true, "acknowledged": true, "investigating": true, "customer_contacted": true,
	"service_scheduled": true, "in_repair": true, "resolved": true, "closed": true,
}

func insertIncident(db *DB, id, tenantID, deviceID string, sourceEventID *string, title, severity string, now time.Time) error {
	nowStr := now.UTC().Format(time.RFC3339Nano)
	_, err := db.Exec(
		`INSERT INTO incidents (id, tenant_id, device_id, source_event_id, title, severity, status, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
		id, tenantID, deviceID, sourceEventID, title, severity, nowStr, nowStr,
	)
	return err
}

func getIncident(db *DB, id string) (*Incident, error) {
	var inc Incident
	err := db.QueryRow(
		`SELECT id, tenant_id, device_id, source_event_id, title, severity, status, assigned_to, created_at, updated_at, resolved_at, closed_at
		 FROM incidents WHERE id = ?`, id,
	).Scan(&inc.ID, &inc.TenantID, &inc.DeviceID, &inc.SourceEventID, &inc.Title, &inc.Severity, &inc.Status,
		&inc.AssignedTo, &inc.CreatedAt, &inc.UpdatedAt, &inc.ResolvedAt, &inc.ClosedAt)
	if err == sql.ErrNoRows {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &inc, nil
}

func listIncidentsByTenant(db *DB, tenantID, statusFilter string) ([]Incident, error) {
	query := `SELECT id, tenant_id, device_id, source_event_id, title, severity, status, assigned_to, created_at, updated_at, resolved_at, closed_at
		FROM incidents WHERE tenant_id = ?`
	args := []interface{}{tenantID}
	if statusFilter != "" {
		query += ` AND status = ?`
		args = append(args, statusFilter)
	}
	query += ` ORDER BY created_at DESC`

	rows, err := db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Incident{}
	for rows.Next() {
		var inc Incident
		if err := rows.Scan(&inc.ID, &inc.TenantID, &inc.DeviceID, &inc.SourceEventID, &inc.Title, &inc.Severity, &inc.Status,
			&inc.AssignedTo, &inc.CreatedAt, &inc.UpdatedAt, &inc.ResolvedAt, &inc.ClosedAt); err != nil {
			return nil, err
		}
		out = append(out, inc)
	}
	return out, rows.Err()
}

func updateIncidentStatus(db *DB, id, status string, now time.Time) error {
	nowStr := now.UTC().Format(time.RFC3339Nano)
	_, err := db.Exec(
		`UPDATE incidents SET
		   status = ?,
		   updated_at = ?,
		   resolved_at = CASE WHEN ? = 'resolved' THEN COALESCE(resolved_at, ?) ELSE resolved_at END,
		   closed_at = CASE WHEN ? = 'closed' THEN COALESCE(closed_at, ?) ELSE closed_at END
		 WHERE id = ?`,
		status, nowStr, status, nowStr, status, nowStr, id,
	)
	return err
}

func insertIncidentNote(db *DB, id, incidentID, tenantID, note string, now time.Time) error {
	_, err := db.Exec(
		`INSERT INTO incident_notes (id, incident_id, tenant_id, note, created_at) VALUES (?, ?, ?, ?, ?)`,
		id, incidentID, tenantID, note, now.UTC().Format(time.RFC3339Nano),
	)
	return err
}

func listIncidentNotes(db *DB, incidentID string) ([]IncidentNote, error) {
	rows, err := db.Query(
		`SELECT id, incident_id, tenant_id, note, created_at FROM incident_notes WHERE incident_id = ? ORDER BY created_at ASC`,
		incidentID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []IncidentNote{}
	for rows.Next() {
		var n IncidentNote
		if err := rows.Scan(&n.ID, &n.IncidentID, &n.TenantID, &n.Note, &n.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

type createIncidentRequest struct {
	DeviceID      string  `json:"deviceId"`
	SourceEventID *string `json:"sourceEventId"`
	Title         string  `json:"title"`
	Severity      string  `json:"severity"`
}

func handleCreateIncident(db *DB, hub *liveHub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := chi.URLParam(r, "id")

		var req createIncidentRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.DeviceID == "" || req.Title == "" {
			writeError(w, http.StatusBadRequest, "deviceId and title are required")
			return
		}
		if req.Severity == "" {
			req.Severity = "warning"
		}
		if req.Severity != "warning" && req.Severity != "critical" {
			writeError(w, http.StatusBadRequest, "severity must be one of: warning, critical")
			return
		}

		id, err := newID("inc")
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to generate incident id")
			return
		}
		now := time.Now()
		if err := insertIncident(db, id, tenantID, req.DeviceID, req.SourceEventID, req.Title, req.Severity, now); err != nil {
			log.Printf("incidents: insertIncident failed: %v", err)
			writeError(w, http.StatusInternalServerError, "failed to create incident")
			return
		}

		if eventID, err := newID("event"); err == nil {
			msg := fmt.Sprintf("Incident opened: %s (%s)", req.Title, id)
			event := Event{
				ID: eventID, TenantID: tenantID, DeviceID: req.DeviceID,
				EventType: "incident-created", Message: msg, Severity: req.Severity,
				CreatedAt: now.UTC().Format(time.RFC3339Nano),
			}
			if err := insertEvent(db, eventID, tenantID, req.DeviceID, event.EventType, event.Message, event.Severity, now); err != nil {
				log.Printf("incidents: failed to log incident-created event: %v", err)
			} else {
				hub.publishEvent(tenantID, event)
			}
		}

		incident, err := getIncident(db, id)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "incident created but failed to read it back")
			return
		}
		writeJSON(w, http.StatusCreated, incident)
	}
}

func handleListTenantIncidents(db *DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := chi.URLParam(r, "id")
		statusFilter := r.URL.Query().Get("status")
		if statusFilter != "" && !validIncidentStatuses[statusFilter] {
			writeError(w, http.StatusBadRequest, "invalid status filter")
			return
		}
		incidents, err := listIncidentsByTenant(db, tenantID, statusFilter)
		if err != nil {
			log.Printf("incidents: listIncidentsByTenant failed: %v", err)
			writeError(w, http.StatusInternalServerError, "failed to list incidents")
			return
		}
		writeJSON(w, http.StatusOK, incidents)
	}
}

func handleGetIncidentDetail(db *DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		incident, err := getIncident(db, id)
		if err == ErrNotFound {
			writeError(w, http.StatusNotFound, "incident not found")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}
		notes, err := listIncidentNotes(db, id)
		if err != nil {
			log.Printf("incidents: listIncidentNotes failed: %v", err)
			writeError(w, http.StatusInternalServerError, "failed to load notes")
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"incident": incident, "notes": notes})
	}
}

type updateIncidentStatusRequest struct {
	Status string `json:"status"`
}

func handleUpdateIncidentStatus(db *DB, hub *liveHub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		incident, err := getIncident(db, id)
		if err == ErrNotFound {
			writeError(w, http.StatusNotFound, "incident not found")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		var req updateIncidentStatusRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || !validIncidentStatuses[req.Status] {
			writeError(w, http.StatusBadRequest, "status must be a valid incident status")
			return
		}

		now := time.Now()
		if err := updateIncidentStatus(db, id, req.Status, now); err != nil {
			log.Printf("incidents: updateIncidentStatus failed: %v", err)
			writeError(w, http.StatusInternalServerError, "failed to update status")
			return
		}

		if eventID, err := newID("event"); err == nil {
			msg := fmt.Sprintf("Incident %s status changed: %s -> %s", id, incident.Status, req.Status)
			event := Event{
				ID: eventID, TenantID: incident.TenantID, DeviceID: incident.DeviceID,
				EventType: "incident-status-changed", Message: msg, Severity: "info",
				CreatedAt: now.UTC().Format(time.RFC3339Nano),
			}
			if err := insertEvent(db, eventID, incident.TenantID, incident.DeviceID, event.EventType, event.Message, event.Severity, now); err != nil {
				log.Printf("incidents: failed to log incident-status-changed event: %v", err)
			} else {
				hub.publishEvent(incident.TenantID, event)
			}
		}

		updated, err := getIncident(db, id)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "status updated but failed to read it back")
			return
		}
		writeJSON(w, http.StatusOK, updated)
	}
}

type addIncidentNoteRequest struct {
	Note string `json:"note"`
}

func handleAddIncidentNote(db *DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		incidentID := chi.URLParam(r, "id")
		if _, err := getIncident(db, incidentID); err == ErrNotFound {
			writeError(w, http.StatusNotFound, "incident not found")
			return
		} else if err != nil {
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		var req addIncidentNoteRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Note == "" {
			writeError(w, http.StatusBadRequest, "note is required")
			return
		}

		id, err := newID("note")
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to generate note id")
			return
		}
		incident, _ := getIncident(db, incidentID)
		now := time.Now()
		if err := insertIncidentNote(db, id, incidentID, incident.TenantID, req.Note, now); err != nil {
			log.Printf("incidents: insertIncidentNote failed: %v", err)
			writeError(w, http.StatusInternalServerError, "failed to add note")
			return
		}

		writeJSON(w, http.StatusCreated, IncidentNote{
			ID: id, IncidentID: incidentID, TenantID: incident.TenantID, Note: req.Note,
			CreatedAt: now.UTC().Format(time.RFC3339Nano),
		})
	}
}
