// Command command-center is the real, minimal v1 of Casterly Endpoint Agent PRD §13's "Cloud
// Command Center" and §7's "Subscription Enforcement".
//
// This is deliberately NOT the PRD's full design - that design is Kafka/message-queue
// ingestion, Kubernetes, multi-tenant data isolation beyond a tenant_id foreign key, an ADE
// (Automated Device Enrollment) console, ESG intelligence, tiered SLA logic, MQTT, and
// TPM-sealed offline tokens with ECDSA device attestation. That is enterprise-SaaS scale for
// many tenants and many devices; this project has exactly one of each today. Building that
// full architecture now, before there's a second tenant or device to actually justify it, would
// be the backend equivalent of this project's own real-vs-sample discipline in reverse -
// impressive-looking infrastructure standing in for something this project doesn't actually
// need yet. So v1 here is the honest, working equivalent instead: one Go service, one PostgreSQL
// database, plain HTTPS (via a reverse proxy in front - this process itself speaks plain HTTP, the
// same pattern local-agent/server/telemetry-server.mjs already uses locally) + JWT, one tenant, one device
// (this laptop). Scale past this only once a second tenant or device makes it real work, not
// speculative work.
package main

import (
	"log"
	"net/http"
	"os"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

const dotEnvFileName = ".env.local"

// mustEnv fails fast with a clear error rather than falling back to a hardcoded default -
// there is no safe default for a port/secret/password, and a silent fallback here would be
// exactly the kind of unearned "looks configured" behavior this project avoids everywhere else.
func mustEnv(name string) string {
	v := os.Getenv(name)
	if v == "" {
		log.Fatalf("missing required environment variable %s - refusing to start without it (see README.md)", name)
	}
	return v
}

func main() {
	// .env.local is read relative to the current working directory - correct both for local
	// dev (`cd backend && go run .`) and for start-command-center.cmd, which explicitly `cd
	// /d`s to this directory first for exactly this reason (see that script's own comment).
	loadDotEnvIfPresent(dotEnvFileName)

	port := mustEnv("PORT")
	jwtSecret := mustEnv("JWT_SECRET")
	adminPassword := mustEnv("ADMIN_PASSWORD")

	// adminPassword is hashed immediately and never referenced again, logged, or persisted -
	// only adminPasswordHash lives on past this point, exactly like how a device's own API key
	// is only ever handled as a hash after handleRegisterDevice returns it once (see handlers.go).
	adminPasswordHash, err := hashSecret(adminPassword)
	if err != nil {
		log.Fatalf("failed to hash admin password: %v", err)
	}

	databaseURL := mustEnv("DATABASE_URL")

	db, err := openDB(databaseURL)
	if err != nil {
		log.Fatalf("failed to open database: %v", err)
	}
	defer db.Close()

	if err := runMigrations(db); err != nil {
		log.Fatalf("failed to run migrations: %v", err)
	}
	if err := maybeMigrateFromSQLite(db); err != nil {
		log.Fatalf("failed to migrate SQLite data into PostgreSQL: %v", err)
	}

	remoteSessions := newRemoteSessionStore()
	remoteSessions.startCleanupLoop()

	// liveHub is the fleet dashboard's real live-push channel (SSE) - see live.go's own
	// comment on why SSE, not WebSocket, and why an in-memory hub rather than a message queue
	// at this project's real scale (same reasoning as remoteSessions above).
	liveHub := newLiveHub()

	// Real offline detection - see offline_detection.go's own comment for why this is a
	// derived liveness signal, not a new device.status value.
	offlineDetector := newOfflineDetector()
	offlineDetector.startLoop(db, liveHub)

	// Real, admin-configurable alert-rule engine (see alert_engine.go) - same sweep-loop and
	// per-key active/clear dedup pattern as offlineDetector above, applied to real live-telemetry
	// thresholds instead of liveness.
	alertEngine := newAlertEngine()
	alertEngine.startLoop(db, liveHub)

	signingPublicKey, signingPrivateKey, err := loadOrGenerateSigningKey(signingKeyFileName)
	if err != nil {
		log.Fatalf("failed to load/generate ADE approval signing key: %v", err)
	}

	r := chi.NewRouter()
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	// The fleet dashboard is a browser app served from its own dev server (a different port,
	// hence a different origin as far as the browser is concerned) - without this, every
	// request from it fails as an opaque "Failed to fetch" before it even reaches a handler
	// below, since browsers (unlike curl, which is how this API was verified working) enforce
	// CORS themselves. "*" (not a reflected origin) is deliberately fine here: this API is
	// Bearer-token authenticated (Authorization header), never cookie/session based, so there's
	// no ambient browser credential a wildcard origin could leak.
	r.Use(corsMiddleware)

	r.Route("/v1", func(r chi.Router) {
		r.Get("/health", handleHealth(db))
		// No auth - this is the same named retention policy pruneEventsForDevice already
		// enforces (eventRetentionDays in models.go). Agents need it for an honest Settings
		// readout; it is not a secret.
		r.Get("/event-retention", handleEventRetention())
		r.Post("/devices/register", handleRegisterDevice(db))
		r.Post("/auth/login", handleLogin(adminPasswordHash, jwtSecret))
		// No auth - a public key is not a secret by definition. Lets local-agent verify an ADE
		// approval token's signature without ever holding the private key.
		r.Get("/public-key", handlePublicKey(signingPublicKey))
		// No auth - every installed agent (including one that has not enrolled yet) needs to
		// learn whether a newer Pulse Endpoint build has been published. The JSON is not a
		// secret; the installer file is the same NSIS setup you would copy by hand.
		r.Get("/agent/latest", handleAgentLatest())
		r.Get("/agent/download", handleAgentDownload())

		// Device-authenticated: a bearer token matching the specific device's own stored key.
		r.Group(func(r chi.Router) {
			r.Use(deviceAuthMiddleware(db))
			r.Post("/devices/{id}/heartbeat", handleHeartbeat(db))
			r.Get("/devices/{id}/entitlement", handleGetEntitlement(db))
			r.Post("/devices/{id}/events", handleCreateEvent(db, liveHub))
			r.Get("/devices/{id}/events", handleListEvents(db))
			// PRD §9.2 ADE Approval Workflows - a device requests approval for its own
			// high-impact action, and polls its own request for the decision/signed token.
			r.Post("/devices/{id}/approval-requests", handleCreateApprovalRequest(db, liveHub))
			r.Get("/devices/{id}/approval-requests/{requestId}", handleGetApprovalRequest(db))
			// Real hardware-fingerprint baseline capture/compare (Hardware page's Tamper
			// Detection) - a device only ever compares against and overwrites its own baseline.
			r.Post("/devices/{id}/hardware-check", handleHardwareCheck(db, liveHub))
			// Real time-series for AI Intel's SSD/Battery Remaining Life predictions - a device
			// records its own daily measurement and reads back its own history (the latter is
			// what ai-service's regression actually queries, using this same device credential
			// passed through by local-agent - see handleListMetricSnapshots' own comment).
			r.Post("/devices/{id}/metric-snapshot", handleRecordMetricSnapshot(db))
			r.Get("/devices/{id}/metric-snapshots", handleListMetricSnapshots(db))
			// Real live telemetry for the fleet dashboard (cpu/ram/disk/battery, updated on
			// local-agent's existing ~5s poll cadence - see live.go's own comment on why this is
			// a separate, single-row-per-device table from the daily metric-snapshot above).
			r.Post("/devices/{id}/live-status", handleRecordLiveStatus(db, liveHub, offlineDetector))
			// PRD §9 Self-Healing v1 remote dispatch - a device reports the real outcome of a
			// command it discovered via its own heartbeat poll (handleHeartbeat's pendingCommand).
			r.Post("/devices/{id}/commands/{commandId}/complete", handleCompleteCommand(db))
		})

		// Admin-authenticated: a valid JWT from /v1/auth/login. The foundation for a future
		// fleet view - returns exactly one device today, since that's genuinely all there is.
		r.Group(func(r chi.Router) {
			r.Use(adminAuthMiddleware(jwtSecret))
			r.Get("/tenants/{id}/devices", handleListTenantDevices(db))
			// Real device-registry lifecycle transition (PRD's device-registry/ component) - sets
			// status to revoked, which deviceAuthMiddleware and countDevicesByTenant both key off.
			r.Post("/devices/{id}/revoke", handleRevokeDevice(db, liveHub))
			// Real, necessary escape hatch for a legitimate hardware upgrade - clears the
			// locked baseline so the device's next hardware-check captures a fresh one.
			r.Post("/devices/{id}/reset-fingerprint", handleResetFingerprint(db, liveHub))
			r.Post("/devices/{id}/tags", handleSetDeviceTags(db))
			// PRD §9 Self-Healing v1 remote dispatch - "run action X on device Y" (see
			// device_commands.go's own comment for the one-pending-at-a-time v1 scope limit).
			r.Post("/devices/{id}/commands", handleEnqueueCommand(db, liveHub))
			// Fleet dashboard reads: current live telemetry per device, the tenant-wide event
			// feed (unlike device-scoped GET /v1/devices/{id}/events above), and the real-time
			// SSE stream both feed into for instant updates instead of a polling delay.
			r.Get("/tenants/{id}/live-status", handleListTenantLiveStatus(db))
			r.Get("/tenants/{id}/events", handleListTenantEvents(db))
			// Real tamper-evident hash-chain verification (see event_chain.go) - walks every
			// chained event for this tenant and reports whether it's intact, and if not, exactly
			// which event broke it.
			r.Get("/tenants/{id}/events/verify-chain", handleVerifyEventChain(db))
			// Dashboard notification bell - real per-tenant read/cleared state layered on the
			// same immutable events table above (see event_notification_state's own schema.sql
			// comment). New notifications arrive live via the existing SSE "event" message
			// below, not a separate push channel.
			r.Get("/tenants/{id}/notifications", handleListTenantNotifications(db))
			r.Post("/tenants/{id}/notifications/mark-all-read", handleMarkAllNotificationsRead(db))
			r.Post("/tenants/{id}/notifications/clear", handleClearAllNotifications(db))
			r.Get("/tenants/{id}/stream", handleTenantStream(liveHub))
			// Admin-scoped views of data a device could always read about itself - real
			// subscription/entitlement state, a device's own battery/SSD history, and the
			// fleet-wide approval-request queue (previously only reachable by already knowing
			// a specific request ID - see handleApproveRequest/handleRejectRequest's own
			// comment on why those existed with no way to discover what to call them on).
			r.Get("/tenants/{id}/entitlement", handleTenantEntitlement(db))
			// Real, admin-configurable offline-detection threshold (see settings.go and
			// offline_detection.go) - previously a hardcoded Go constant.
			r.Get("/tenants/{id}/settings/offline-threshold", handleGetOfflineThreshold(db))
			r.Patch("/tenants/{id}/settings/offline-threshold", handlePatchOfflineThreshold(db))
			// Real alert-rule CRUD (see alert_rules.go) - same tenant-scoped-create/list,
			// ID-scoped-update/delete route shape as incidents.go/approval_requests above.
			r.Get("/tenants/{id}/alert-rules", handleListAlertRules(db))
			r.Post("/tenants/{id}/alert-rules", handleCreateAlertRule(db))
			r.Patch("/alert-rules/{id}", handlePatchAlertRule(db))
			r.Delete("/alert-rules/{id}", handleDeleteAlertRule(db))
			r.Get("/tenants/{id}/devices/{deviceId}/metric-snapshots", handleListDeviceMetricSnapshotsAdmin(db))
			r.Get("/tenants/{id}/approval-requests", handleListTenantApprovalRequests(db))
			// Real Alert -> Incident workflow (see incidents.go) - an operator promotes a
			// specific alert (or opens one directly) into a tracked incident with a real
			// status lifecycle and note trail.
			r.Post("/tenants/{id}/incidents", handleCreateIncident(db, liveHub))
			r.Get("/tenants/{id}/incidents", handleListTenantIncidents(db))
			r.Get("/incidents/{id}", handleGetIncidentDetail(db))
			r.Post("/incidents/{id}/status", handleUpdateIncidentStatus(db, liveHub))
			r.Post("/incidents/{id}/notes", handleAddIncidentNote(db))
			// Real Remote Assist queue - live event already fires on creation (see
			// handleCreateRemoteSession), this is the admin-facing read for the initial page
			// load and for confirming whether a session is still waiting or already connected.
			r.Get("/tenants/{id}/remote-sessions", handleListTenantRemoteSessions(remoteSessions))
			// PRD §30 Remote Assist hardening - real, time-limited TURN relay credentials for the
			// dashboard operator side (see turn.go's own comment). Device-side issuance is the
			// identical handler, registered separately below under anyDeviceAuthMiddleware.
			r.Get("/tenants/{id}/turn-credentials", handleIssueTurnCredentials())
			// The real, honest stand-in for an admin approval UI that doesn't exist yet - see
			// handleApproveRequest's own comment.
			r.Post("/approval-requests/{id}/approve", handleApproveRequest(db, signingPrivateKey, liveHub))
			r.Post("/approval-requests/{id}/reject", handleRejectRequest(db, liveHub))
		})

		// Agent-authenticated (any device's own real API key - see anyDeviceAuthMiddleware's
		// own comment on why this, not the admin JWT). Creates the real WebRTC signaling
		// session Remote Assist's screen-share POC joins.
		r.Group(func(r chi.Router) {
			r.Use(anyDeviceAuthMiddleware(db))
			r.Post("/remote-sessions", handleCreateRemoteSession(remoteSessions, liveHub, db))
			r.Get("/turn-credentials", handleIssueTurnCredentials())
		})

		// No auth - the session ID itself is the access control (see handleRemoteSessionWS's
		// own comment). The customer side of a real support session isn't logged into anything.
		r.Get("/remote-sessions/{id}/ws", handleRemoteSessionWS(remoteSessions))
		r.Get("/remote-sessions/{id}", handleRemoteSessionExists(remoteSessions))
	})

	log.Printf("command-center listening on :%s", port)
	if err := http.ListenAndServe(":"+port, r); err != nil {
		log.Fatalf("server error: %v", err)
	}
}
