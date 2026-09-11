package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"
)

// Real, admin-configurable tenant settings. Exactly one setting exists today - the
// offline-detection staleness threshold offline_detection.go's sweep uses - not a generic
// key/value settings table: this project has exactly one tenant and exactly one real setting to
// store, and a dedicated column (schema.sql's tenants.offline_threshold_minutes) matches every
// other purpose-built column in this schema (entitlements.licensed_devices, devices.tags, etc.)
// rather than introducing a new generic abstraction to serve a single value.

const minOfflineThresholdMinutes = 1
const maxOfflineThresholdMinutes = 60

// getOfflineThresholdMinutes reads the real, currently-configured value - called fresh on every
// offline_detection.go sweep (not cached at startup), so a change made via
// handlePatchOfflineThreshold takes effect on the very next sweep, not only after a restart.
func getOfflineThresholdMinutes(db *DB, tenantID string) (int, error) {
	var minutes int
	err := db.QueryRow(`SELECT offline_threshold_minutes FROM tenants WHERE id = ?`, tenantID).Scan(&minutes)
	if err == sql.ErrNoRows {
		return 0, ErrNotFound
	}
	return minutes, err
}

func setOfflineThresholdMinutes(db *DB, tenantID string, minutes int) error {
	res, err := db.Exec(`UPDATE tenants SET offline_threshold_minutes = ? WHERE id = ?`, minutes, tenantID)
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

type offlineThresholdResponse struct {
	Minutes int `json:"minutes"`
}

func handleGetOfflineThreshold(db *DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := chi.URLParam(r, "id")
		minutes, err := getOfflineThresholdMinutes(db, tenantID)
		if err == ErrNotFound {
			writeError(w, http.StatusNotFound, "tenant not found")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to read offline threshold")
			return
		}
		writeJSON(w, http.StatusOK, offlineThresholdResponse{Minutes: minutes})
	}
}

type patchOfflineThresholdRequest struct {
	Minutes int `json:"minutes"`
}

// handlePatchOfflineThreshold validates bounds server-side (not trusting the frontend's own
// number-input min/max alone, the same "never trust the client for anything that matters"
// discipline every other real validation in this backend already follows - e.g.
// handleUpdateIncidentStatus's validIncidentStatuses check).
func handlePatchOfflineThreshold(db *DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := chi.URLParam(r, "id")

		var req patchOfflineThresholdRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		if req.Minutes < minOfflineThresholdMinutes || req.Minutes > maxOfflineThresholdMinutes {
			writeError(w, http.StatusBadRequest, fmt.Sprintf("minutes must be between %d and %d", minOfflineThresholdMinutes, maxOfflineThresholdMinutes))
			return
		}

		if err := setOfflineThresholdMinutes(db, tenantID, req.Minutes); err == ErrNotFound {
			writeError(w, http.StatusNotFound, "tenant not found")
			return
		} else if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to update offline threshold")
			return
		}

		writeJSON(w, http.StatusOK, offlineThresholdResponse{Minutes: req.Minutes})
	}
}

// Remote command/PowerShell execution's real, admin-configurable kill switch (schema.sql's own
// comment on tenants.remote_command_execution_enabled) - a second, independent gate on top of
// plan_features' "Remote Command Execution" row (see isRemoteCommandExecutionAllowed in
// device_commands.go, which checks both). Read fresh on every check, same reasoning as
// getOfflineThresholdMinutes above - a change takes effect on the very next dispatch attempt.
func getRemoteCommandExecutionEnabled(db *DB, tenantID string) (bool, error) {
	var enabled bool
	err := db.QueryRow(`SELECT remote_command_execution_enabled FROM tenants WHERE id = ?`, tenantID).Scan(&enabled)
	if err == sql.ErrNoRows {
		return false, ErrNotFound
	}
	return enabled, err
}

func setRemoteCommandExecutionEnabled(db *DB, tenantID string, enabled bool) error {
	res, err := db.Exec(`UPDATE tenants SET remote_command_execution_enabled = ? WHERE id = ?`, enabled, tenantID)
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

type remoteCommandExecutionSettingResponse struct {
	Enabled bool `json:"enabled"`
}

func handleGetRemoteCommandExecutionSetting(db *DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := chi.URLParam(r, "id")
		enabled, err := getRemoteCommandExecutionEnabled(db, tenantID)
		if err == ErrNotFound {
			writeError(w, http.StatusNotFound, "tenant not found")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to read remote command execution setting")
			return
		}
		writeJSON(w, http.StatusOK, remoteCommandExecutionSettingResponse{Enabled: enabled})
	}
}

type patchRemoteCommandExecutionSettingRequest struct {
	Enabled bool `json:"enabled"`
}

func handlePatchRemoteCommandExecutionSetting(db *DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := chi.URLParam(r, "id")

		var req patchRemoteCommandExecutionSettingRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body")
			return
		}

		if err := setRemoteCommandExecutionEnabled(db, tenantID, req.Enabled); err == ErrNotFound {
			writeError(w, http.StatusNotFound, "tenant not found")
			return
		} else if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to update remote command execution setting")
			return
		}

		writeJSON(w, http.StatusOK, remoteCommandExecutionSettingResponse{Enabled: req.Enabled})
	}
}
