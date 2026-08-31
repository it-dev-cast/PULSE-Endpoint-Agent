# Cloud Command Center (v1)

The real, minimal v1 of the Casterly Endpoint Agent PRD's §13 "Cloud Command Center" and §7
"Subscription Enforcement". See the scope-boundary comment at the top of `main.go` for exactly
what this deliberately does not implement yet (Kafka, Kubernetes, multi-tenant isolation beyond
a `tenant_id` column, the ADE console, ESG intelligence, tiered SLA logic, MQTT, TPM-sealed
offline tokens) — this is a real, working single-tenant/single-device service, not the PRD's
full enterprise-SaaS design built ahead of having a second tenant or device to justify it.

## Running locally

Requires Go 1.22+.

```
cd backend
go mod tidy   # first time only, or after editing go.mod
PORT=8443 JWT_SECRET=<a long random string> ADMIN_PASSWORD=<pick an admin password> go run .
```

All three environment variables are required — the process fails fast with a clear error at
startup if any are missing. Nothing is ever hardcoded.

Typing `$env:`/env vars by hand every session is also why the process kept disappearing between
sessions before this was added: a `.env.local` file (gitignored — it holds real secrets, not
placeholders) in this directory is read automatically at startup (`dotenv.go`) if present. Real
process environment variables still win if both are set — this is purely a local convenience,
never a way to silently override an explicit deployment config (a CI pipeline, a container's
own env block, etc.). Format is plain `KEY=VALUE` per line:

```
PORT=8443
JWT_SECRET=<a long random string>
ADMIN_PASSWORD=<a real password>
```

A SQLite file (`command-center.db`) is created in the working directory on first run, seeded
with one tenant (`tenant-1`) and one entitlement row for it. Re-running is safe — the schema
migration is idempotent (see `schema.sql`).

## Auto-start (Scheduled Task)

Same problem `local-agent/server/start-telemetry-server.cmd` + its `PulseEndpointTelemetryServer`
Scheduled Task already solve for the telemetry server, applied here: `start-command-center.cmd`
`cd /d`s to this directory (so `.env.local` and the binary are both found by relative path,
and because `schtasks /Create` has no working-directory switch at all) and runs the already-
built `command-center.exe` — not `go run .`, which would recompile on every logon and require
the Go toolchain to be installed and on PATH for whatever account runs the task. Build it
yourself first, and again after any code change:

```
go build -o command-center.exe .
```

**Unlike the telemetry server's task, this one should NOT use `/RL HIGHEST`** — this backend
never touches TPM, BitLocker, or anything else requiring elevation; only `local-agent`'s
telemetry collector does. Registering it elevated anyway would just be an unnecessary privilege
grant for a process that has no use for it.

This registration is deliberately **not run automatically** — review and run it yourself from a
terminal (elevation not required, unlike the telemetry server's task). It's registered through a
generic hidden-window launcher, `local-agent/scripts/run-hidden.vbs` (see the top-level
`README.md`'s "Running everything completely hidden" section for what that script does and why),
so `command-center.exe`'s console never shows up at logon:

```
schtasks /Create /TN PulseEndpointCommandCenter /TR "wscript.exe C:\PULSEE~1\LOCAL-~1\scripts\RUN-HI~1.VBS C:\PULSEE~1\backend\START-~1.CMD" /SC ONLOGON
```

The `C:\PULSEE~1\backend\START-~1.CMD` path is the real Windows short (8.3) form of this
directory's `start-command-center.cmd` — required because `schtasks /Create /TR` cannot store a
path containing a space (it strips one layer of quoting and splits the stored command on the
first space regardless of how the value was quoted going in), and "Pulse endpoint" contains one.
The hidden-launcher script's own path (`C:\PULSEE~1\LOCAL-~1\scripts\RUN-HI~1.VBS`) needs the same
short-path treatment for the same reason. If this project ever moves again, get the current real
short paths rather than guessing:

```powershell
(New-Object -ComObject Scripting.FileSystemObject).GetFile("C:\Pulse endpoint\backend\start-command-center.cmd").ShortPath
(New-Object -ComObject Scripting.FileSystemObject).GetFile("C:\Pulse endpoint\local-agent\scripts\run-hidden.vbs").ShortPath
```

To remove or disable it later: `schtasks /Delete /TN PulseEndpointCommandCenter /F` (or
`/Change /DISABLE`).

## Environment variables

| Variable         | Required | Purpose                                                                      |
|------------------|----------|-------------------------------------------------------------------------------|
| `PORT`           | yes      | TCP port the HTTP server listens on                                          |
| `JWT_SECRET`     | yes      | HMAC signing secret for admin session JWTs                                  |
| `ADMIN_PASSWORD` | yes      | Admin password — bcrypt-hashed once at startup, never logged or persisted   |

This process speaks plain HTTP, the same local-dev pattern `local-agent/server/telemetry-server.mjs`
already uses in this project — a real deployment would sit it behind a TLS-terminating reverse
proxy. Implementing TLS termination itself is out of scope for this minimal v1.

## Endpoints

### `POST /v1/devices/register`

Creates a device under the (one) tenant and returns a plaintext API key — **shown exactly
once**; only its bcrypt hash is ever stored.

```
curl -X POST http://localhost:8443/v1/devices/register \
  -H "Content-Type: application/json" \
  -d '{"hostname": "my-laptop"}'
```

### `POST /v1/devices/{id}/heartbeat` — device-authenticated

```
curl -X POST http://localhost:8443/v1/devices/<device-id>/heartbeat \
  -H "Authorization: Bearer <api-key-from-register>"
```

### `GET /v1/devices/{id}/entitlement` — device-authenticated

```
curl http://localhost:8443/v1/devices/<device-id>/entitlement \
  -H "Authorization: Bearer <api-key-from-register>"
```

### `POST /v1/auth/login`

```
curl -X POST http://localhost:8443/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"password": "<your ADMIN_PASSWORD value>"}'
```

Returns a JWT valid for 12 hours.

### `GET /v1/tenants/{id}/devices` — admin-authenticated

The foundation for a future fleet view — returns exactly one device today, since that's
genuinely all there is in v1.

```
curl http://localhost:8443/v1/tenants/tenant-1/devices \
  -H "Authorization: Bearer <jwt-from-login>"
```

## Schema

- `tenants(id, name, created_at)` — one seeded row (`tenant-1`) today.
- `devices(id, tenant_id, hostname, api_key_hash, enrolled_at, last_seen_at)`
- `entitlements(id, tenant_id, plan, status, renewed_at, expires_at)` — `status` uses the same
  vocabulary as the frontend's real Warranty state machine (`getWarrantyState` in
  `src/app/App.tsx`): `Active | Expiring | Grace | Expired | Suspended`.

Migrations are a single embedded `schema.sql`, idempotently re-run on every startup
(`CREATE TABLE IF NOT EXISTS` + `WHERE NOT EXISTS`-guarded seed inserts) — no migration
framework at this scale.
