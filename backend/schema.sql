-- Cloud Command Center v1 schema. Re-run idempotently on every startup (see runMigrations in
-- db.go) via IF NOT EXISTS / WHERE NOT EXISTS guards - no migration framework at this scale.

-- offline_threshold_minutes is the real, admin-configurable setting behind offline_detection.go's
-- liveness sweep (see settings.go) - previously a hardcoded 2-minute Go constant, now a per-tenant
-- value an admin can read/change via GET/PATCH /v1/tenants/{id}/settings/offline-threshold. The
-- sweep re-reads this column fresh on every 60s pass rather than caching it at startup, so a
-- change takes effect on the very next sweep, not only after a restart. 2 matches the previous
-- hardcoded default exactly, so an upgraded database's behavior doesn't silently change.
CREATE TABLE IF NOT EXISTS tenants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    offline_threshold_minutes INTEGER NOT NULL DEFAULT 2,
    created_at TEXT NOT NULL DEFAULT (to_char((CURRENT_TIMESTAMP AT TIME ZONE 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS') || 'Z')
);

-- status is the real device-registry lifecycle state PRD's device-registry/ component names
-- ("Device inventory and lifecycle state") without defining exact values - active/revoked is a
-- reasonable minimal model: a revoked device's real API key is genuinely rejected on its next
-- call (see deviceAuthMiddleware in auth.go), but the row itself is never deleted - real
-- historical/audit data (when it was enrolled, when it was revoked) outlives the device's
-- ability to authenticate. A database created before this column existed gets it added
-- idempotently in Go (see ensureDeviceStatusColumn in db.go), same PRAGMA-checked pattern as
-- entitlements.licensed_devices above - this SQLite build has no `ALTER TABLE ... ADD COLUMN
-- IF NOT EXISTS`.
CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    hostname TEXT NOT NULL,
    api_key_hash TEXT NOT NULL,
    enrolled_at TEXT NOT NULL DEFAULT (to_char((CURRENT_TIMESTAMP AT TIME ZONE 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS') || 'Z'),
    last_seen_at TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
    tags TEXT NOT NULL DEFAULT '',
    hardware_fingerprint TEXT,
    fingerprint_locked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_devices_tenant_id ON devices(tenant_id);

-- Real TPM-backed device identity (PRD Section 14.1) - a real, non-exportable ECDSA P-256 key
-- created in the device's TPM via Windows' Platform Crypto Provider (see rust-collector's
-- tpm_identity.rs), locked here the same way hardware_fingerprint/fingerprint_locked_at above
-- lock in a baseline: the first real publicKey a device ever sends is stored permanently, never
-- silently overwritten by a later, different one (see handleHardwareCheck's own comment on why a
-- changed public key is a real, flagged event, not a routine update). Deliberately independent of
-- hardware_fingerprint's own reset lifecycle ("Reset FP") - a legitimate RAM/SSD/GPU swap doesn't
-- change which physical TPM this machine has, so resetting the hardware baseline must not also
-- discard a still-correct device identity. device_identity_attestation is
-- NCRYPT_PCP_KEYATTESTATION_PROPERTY's real blob (proof the key is genuinely TPM-resident), kept
-- for audit/future verification even though nothing parses it yet - see tpm_identity.rs's own
-- comment on why this specific property name isn't independently confirmed. This backend runs on
-- PostgreSQL (see db.go), which - unlike the SQLite build the comment above this table predates -
-- supports ADD COLUMN IF NOT EXISTS natively, so no Go-side idempotent-migration helper is needed
-- for either column.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS device_identity_public_key TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS device_identity_attestation TEXT;

-- Real, durable event history (AI Intel's Timeline/Insights cards) - unlike remote_session.go's
-- in-memory signaling sessions, this genuinely belongs in SQLite: it's meant to survive a
-- restart and answer "what actually happened on this device," not just exist for the duration
-- of one live connection. severity mirrors the frontend's existing AlertItem vocabulary
-- ("critical"/"warning") plus "info" for neutral/positive events (a rule clearing, a source
-- reconnecting) that were never a problem in the first place.
--
-- prev_hash/hash are the real tamper-evident hash chain (see event_chain.go) - one chain per
-- tenant, in insertion (rowid) order: hash = SHA256(this row's own content || prev_hash), with
-- prev_hash pointing at the immediately-preceding event's own hash for the same tenant (or the
-- fixed genesis string for that tenant's first-ever event). Both nullable and left NULL on
-- purpose for every row that existed before this feature shipped - see event_chain.go's own
-- comment on why those are deliberately marked as predating the chain rather than having hashes
-- computed retroactively, which would falsely vouch for data that was never actually protected
-- at write time. A database created before these columns existed gets them added idempotently in
-- Go (see ensureEventHashColumns in db.go), same PRAGMA-checked pattern as devices.status above -
-- this SQLite build has no `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.
CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    device_id TEXT NOT NULL REFERENCES devices(id),
    event_type TEXT NOT NULL,
    message TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
    created_at TEXT NOT NULL DEFAULT (to_char((CURRENT_TIMESTAMP AT TIME ZONE 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS') || 'Z'),
    prev_hash TEXT,
    hash TEXT,
    seq BIGSERIAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_device_id_created_at ON events(device_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_tenant_seq ON events(tenant_id, seq);

-- Real per-notification read/cleared state for the dashboard's notification bell - deliberately
-- a separate table from `events` above, not new columns on it, for the same reason
-- incidents/approval_requests already are: events is an immutable append-only log every other
-- page (Activity Log, per-device Event History, AI Intel) reads in full, and must stay
-- unaffected by what one admin has read or dismissed from the bell. One row per event that's
-- actually been read or cleared - not one row per event ever created - so an event nobody has
-- touched yet has no row here at all and is correctly treated as unread/uncleared by default
-- (see listNotificationsByTenant's own LEFT JOIN in live.go).
CREATE TABLE IF NOT EXISTS event_notification_state (
    event_id TEXT PRIMARY KEY REFERENCES events(id),
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    read_at TEXT,
    cleared_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_event_notification_state_tenant_id ON event_notification_state(tenant_id);

-- PRD §9.2 "ADE Approval Workflows" - the real, mutable state machine behind a specific
-- high-impact action's approval (pending -> approved/rejected). Distinct from `events` above:
-- events is an immutable append-only log of what happened (and every transition here still
-- gets logged there too, for the audit trail), while this table is "what's the current,
-- authoritative status of THIS specific request right now" - a genuinely different shape of
-- data that an immutable log isn't the right structure for. signature/expires_at are only ever
-- set once a request is approved (see handleApproveRequest) - a still-pending or rejected
-- request has neither.
CREATE TABLE IF NOT EXISTS approval_requests (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    device_id TEXT NOT NULL REFERENCES devices(id),
    action TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')) DEFAULT 'pending',
    signature TEXT,
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (to_char((CURRENT_TIMESTAMP AT TIME ZONE 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS') || 'Z'),
    decided_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_approval_requests_device_id ON approval_requests(device_id);

-- Real, genuine time-series for AI Intel's SSD/Battery Remaining Life predictions - distinct
-- from `events` above (a discrete log of things that happened) and from approval_requests (a
-- mutable current-state machine): this is a slowly-accumulating measurement history, one real
-- row per device per real calendar day (see backend's recordMetricSnapshot for the actual
-- dedup-by-day logic - a brand new table needs no PRAGMA-checked ALTER path, unlike adding a
-- column to an existing one elsewhere in this file). Both value columns are nullable
-- independently - a day where only one real source was available (e.g. smartctl failed but
-- LibreHardwareMonitor's battery-health reading succeeded) still records whichever real value it
-- actually has, rather than skipping the whole row or fabricating the other.
CREATE TABLE IF NOT EXISTS device_metric_snapshots (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    device_id TEXT NOT NULL REFERENCES devices(id),
    battery_health_pct REAL,
    ssd_wear_pct REAL,
    recorded_at TEXT NOT NULL DEFAULT (to_char((CURRENT_TIMESTAMP AT TIME ZONE 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS') || 'Z')
);

-- Composite, not just device_id alone - every real query pattern (a device's own history for
-- ai-service's regression, dedup-by-day on insert) filters by device_id and orders/compares on
-- recorded_at together, same reasoning as idx_events_device_id_created_at above.
CREATE INDEX IF NOT EXISTS idx_device_metric_snapshots_device_id_recorded_at ON device_metric_snapshots(device_id, recorded_at);

-- status vocabulary matches the frontend's real Warranty state machine (getWarrantyState in
-- src/app/App.tsx) rather than inventing a second, different real-state vocabulary for the same
-- kind of fact. licensed_devices is a real seat count this tenant purchased under the plan - a
-- genuine business value, not measured/derived data (see the seed INSERT below and its comment
-- on where 10 came from). A database created before this column existed gets it added
-- idempotently in Go (see ensureLicensedDevicesColumn in db.go) - SQLite here has no `ALTER
-- TABLE ... ADD COLUMN IF NOT EXISTS` (confirmed directly: it's a syntax error on this
-- modernc.org/sqlite build), so a fresh install gets the column from CREATE TABLE below while
-- an existing database needs the PRAGMA-checked ALTER path instead.
CREATE TABLE IF NOT EXISTS entitlements (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    plan TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('Active', 'Expiring', 'Grace', 'Expired', 'Suspended')),
    renewed_at TEXT,
    expires_at TEXT,
    licensed_devices INTEGER
);

CREATE INDEX IF NOT EXISTS idx_entitlements_tenant_id ON entitlements(tenant_id);

-- Which of the app's real feature flags this plan tier includes - a real, defined business
-- rule (applied consistently to every device on this plan), not a per-request fabrication.
-- Reasoning for ProSupport specifically, modeled loosely on Dell's own real support-tier
-- naming (ProSupport < ProSupport Plus < Enterprise/Premium): AI Predictions, Remote Assist,
-- Hardware Attestation, Alerts, and API Access are core/compliance-adjacent capabilities
-- reasonable to include at a mid support tier. Self-Healing (automated remediation) is held
-- back for a higher tier (ProSupport Plus-equivalent) since it's a proactive capability beyond
-- plain support. ADE Console (fleet enrollment/management) and ESG Reports (sustainability/
-- governance reporting) are both fleet-scale, enterprise-IT concerns this single-tenant/
-- single-device v1's own plan shouldn't plausibly unlock. A different plan name would get its
-- own row set here rather than reusing ProSupport's - this table is keyed by plan, not tenant,
-- since feature inclusion is a property of the plan tier, not of any one tenant's entitlement.
CREATE TABLE IF NOT EXISTS plan_features (
    plan TEXT NOT NULL,
    feature TEXT NOT NULL,
    included INTEGER NOT NULL CHECK (included IN (0, 1)),
    PRIMARY KEY (plan, feature)
);

-- Real, live (not historical) per-device snapshot for the fleet dashboard - one row per device,
-- overwritten on every real POST /v1/devices/:id/live-status (local-agent's already-existing
-- 5s telemetry poll pushes here - see telemetry-server.mjs's postLiveStatus). Deliberately a
-- single-row-per-device table, not an append-only log like `events`: the fleet dashboard only
-- ever needs "what is this device's health right now," not a retained history of every 5s
-- sample, which device_metric_snapshots (once-a-day, long-term trend) already exists for at a
-- different cadence and purpose. The four percentages are independently nullable - a cycle
-- where only some real sources were available (see get-telemetry.ps1) still records whichever
-- real values it actually has, same convention as device_metric_snapshots above, rather than
-- being forced to fabricate the rest or drop the whole update. `detail` is optional JSON the
-- agent posts alongside those percentages (identity, battery health vs charge, security, temps)
-- so Command Centre's device page can show the same live facts the endpoint UI already has.
CREATE TABLE IF NOT EXISTS device_live_status (
    device_id TEXT PRIMARY KEY REFERENCES devices(id),
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    cpu_pct REAL,
    ram_pct REAL,
    disk_pct REAL,
    battery_pct REAL,
    detail TEXT,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_device_live_status_tenant_id ON device_live_status(tenant_id);

-- Real incident-management state machine (PRD's "telemetry is not an alert" distinction) - an
-- alert (a row in `events` with severity warning/critical) means "something abnormal happened."
-- An incident means "an operator is tracking and acting on it." Not every alert becomes an
-- incident, and this table is deliberately separate from `events`: events is an immutable log of
-- what happened, this is "what's the current, authoritative status of this specific problem
-- right now" - the same reasoning approval_requests already uses for the same kind of
-- distinction. source_event_id is nullable - an operator can open an incident directly (e.g.
-- from a customer phone call) without a specific triggering alert row to point at.
CREATE TABLE IF NOT EXISTS incidents (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    device_id TEXT NOT NULL REFERENCES devices(id),
    source_event_id TEXT REFERENCES events(id),
    title TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('warning', 'critical')),
    status TEXT NOT NULL CHECK (status IN (
        'open', 'acknowledged', 'investigating', 'customer_contacted',
        'service_scheduled', 'in_repair', 'resolved', 'closed'
    )) DEFAULT 'open',
    assigned_to TEXT,
    created_at TEXT NOT NULL DEFAULT (to_char((CURRENT_TIMESTAMP AT TIME ZONE 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS') || 'Z'),
    updated_at TEXT NOT NULL DEFAULT (to_char((CURRENT_TIMESTAMP AT TIME ZONE 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS') || 'Z'),
    resolved_at TEXT,
    closed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_incidents_tenant_id_status ON incidents(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_incidents_device_id ON incidents(device_id);

-- Real, append-only operator log for one incident - customer contact records, investigation
-- findings, service updates. Kept as free-text notes rather than a rigid structured form: at
-- this project's real scale (one operator, not yet a support team), a flexible note is honest;
-- a dropdown-heavy structured workflow would be presenting a maturity this system doesn't have
-- yet (same "don't build what isn't justified" principle the rest of this schema follows).
CREATE TABLE IF NOT EXISTS incident_notes (
    id TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL REFERENCES incidents(id),
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    note TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (to_char((CURRENT_TIMESTAMP AT TIME ZONE 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS') || 'Z')
);

CREATE INDEX IF NOT EXISTS idx_incident_notes_incident_id ON incident_notes(incident_id, created_at);

-- Real, admin-configurable alert-rule thresholds (see alert_rules.go) - evaluated against real
-- live telemetry (device_live_status above) by a real sweep loop, the same architectural pattern
-- offline_detection.go already uses for its own liveness check. metric is constrained to the
-- four real percentages device_live_status actually has - cpu/ram/disk/battery - never a metric
-- this backend doesn't actually collect. operator is intentionally not restricted per-metric
-- (e.g. "cpu < 5" is a real, legitimate way to detect an idle/asleep machine, not just "cpu > 90"
-- for a hot one) - the alert_rules.go comment on metricValue explains the typical direction per
-- metric without hard-blocking the other one.
CREATE TABLE IF NOT EXISTS alert_rules (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    metric TEXT NOT NULL CHECK (metric IN ('cpu', 'ram', 'disk', 'battery')),
    operator TEXT NOT NULL CHECK (operator IN ('>', '<')),
    threshold REAL NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('warning', 'critical')),
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)) DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (to_char((CURRENT_TIMESTAMP AT TIME ZONE 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS') || 'Z')
);

CREATE INDEX IF NOT EXISTS idx_alert_rules_tenant_id ON alert_rules(tenant_id);

-- Seed: exactly one tenant and one entitlement - real rows to query against, not placeholders.
-- This is v1's whole world (see main.go's scope-boundary comment); a second tenant/device is
-- what would justify moving past WHERE-NOT-EXISTS seeding into a real migration tool.
INSERT INTO tenants (id, name)
SELECT 'tenant-1', 'Default Tenant'
WHERE NOT EXISTS (SELECT 1 FROM tenants WHERE id = 'tenant-1');

-- 10 is a deliberately chosen seed business value for this tenant's purchased device-license
-- count under ProSupport - not the old fabricated "150", and not measured/derived from
-- anything (there's no real source for "how many devices this tenant is licensed for" other
-- than whatever the business actually sold them). Pick a different number here if the real
-- figure for this tenant is known to be something else.
INSERT INTO entitlements (id, tenant_id, plan, status, renewed_at, expires_at, licensed_devices)
SELECT
    'entitlement-1',
    'tenant-1',
    'ProSupport',
    'Active',
    to_char((CURRENT_TIMESTAMP AT TIME ZONE 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS') || 'Z',
    to_char(((CURRENT_TIMESTAMP + INTERVAL '365 days') AT TIME ZONE 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS') || 'Z',
    10
WHERE NOT EXISTS (SELECT 1 FROM entitlements WHERE id = 'entitlement-1');

-- Backfills licensed_devices for a database created before this column existed - the INSERT
-- above only ever fires once (WHERE NOT EXISTS), so an already-seeded entitlement-1 row from an
-- older schema would otherwise keep a NULL forever. Only fills a NULL, never overwrites a real
-- value once one exists (e.g. a future admin action changing the seat count).
UPDATE entitlements SET licensed_devices = 10 WHERE id = 'entitlement-1' AND licensed_devices IS NULL;

-- See plan_features' own comment above for the reasoning behind each include/exclude decision.
INSERT INTO plan_features (plan, feature, included)
SELECT 'ProSupport', 'AI Predictions', 1 WHERE NOT EXISTS (SELECT 1 FROM plan_features WHERE plan = 'ProSupport' AND feature = 'AI Predictions');
INSERT INTO plan_features (plan, feature, included)
SELECT 'ProSupport', 'Self-Healing', 0 WHERE NOT EXISTS (SELECT 1 FROM plan_features WHERE plan = 'ProSupport' AND feature = 'Self-Healing');
INSERT INTO plan_features (plan, feature, included)
SELECT 'ProSupport', 'Remote Assist', 1 WHERE NOT EXISTS (SELECT 1 FROM plan_features WHERE plan = 'ProSupport' AND feature = 'Remote Assist');
INSERT INTO plan_features (plan, feature, included)
SELECT 'ProSupport', 'ADE Console', 0 WHERE NOT EXISTS (SELECT 1 FROM plan_features WHERE plan = 'ProSupport' AND feature = 'ADE Console');
INSERT INTO plan_features (plan, feature, included)
SELECT 'ProSupport', 'Hardware Attestation', 1 WHERE NOT EXISTS (SELECT 1 FROM plan_features WHERE plan = 'ProSupport' AND feature = 'Hardware Attestation');
INSERT INTO plan_features (plan, feature, included)
SELECT 'ProSupport', 'ESG Reports', 0 WHERE NOT EXISTS (SELECT 1 FROM plan_features WHERE plan = 'ProSupport' AND feature = 'ESG Reports');
INSERT INTO plan_features (plan, feature, included)
SELECT 'ProSupport', 'Alerts', 1 WHERE NOT EXISTS (SELECT 1 FROM plan_features WHERE plan = 'ProSupport' AND feature = 'Alerts');
INSERT INTO plan_features (plan, feature, included)
SELECT 'ProSupport', 'API Access', 1 WHERE NOT EXISTS (SELECT 1 FROM plan_features WHERE plan = 'ProSupport' AND feature = 'API Access');
