# Phase 1 Development Progress

## Completed Components (Phase 1 Foundation)

### ✅ Real Telemetry Pipeline

The dashboard is backed by a live, multi-source telemetry collector — not the earlier
MQTT/health-scoring scaffold described in a previous version of this document (see
"Superseded/Removed" below).

1. **`server/telemetry-server.mjs`** — a Node HTTP server (port 4317) that polls every 5s via a
   self-rescheduling loop (not `setInterval`, to avoid overlapping cycles when a poll runs long)
   and serves the merged result at `/api/telemetry`. Combines three independent sources every
   cycle:
   - **`server/get-telemetry.ps1`** — the primary source. WMI/CIM-based (`Get-CimInstance`),
     covering system/BIOS/CPU/memory/storage/battery/GPU/network/OS/TPM/Secure
     Boot/BitLocker/SMART (via `smartctl`)/Wi-Fi signal (via `netsh`) and more. Several fields
     (TPM, BitLocker, SMART) require the process to run elevated.
   - **`rust-collector/`** — a native Rust binary (`sysinfo` + `starship-battery` + `wmi` +
     `winreg` crates) providing real cpu/memory/battery/tpm/gpu/network/secureBootEnabled/
     bitlockerStatus data via direct Windows APIs, as a first step toward the Rust agent
     architecture described in the PRD. Its output is merged additively into the PowerShell
     payload (`mergeRustData()`), never dropping a PowerShell-only field, and falls back
     cleanly to PowerShell-only data if the binary is missing, crashes, times out, or emits
     invalid JSON — verified directly against a real injected panic, not assumed.
   - **LibreHardwareMonitor** (optional, user-installed, separate app) — its Remote Web Server
     JSON API (`localhost:8085/data.json`) supplies CPU/GPU/motherboard temperatures, fan RPM,
     CPU voltage, and a second independent battery health/remaining-time estimate. Degrades to
     `null` per-sensor if not running or a sensor isn't exposed on this hardware.
   - Auto-start: a Windows Scheduled Task (`PulseEndpointTelemetryServer`) launches the server
     elevated at logon; `npm run dev:all` self-heals via `server/ensure-telemetry-running.mjs`
     if nothing is already listening on the port.

2. **`src/app/hooks/useTelemetry.ts`** — polls `/api/telemetry` every 5s from the frontend.
   `data` is never cleared on disconnect (only `connected` flips to `false`), so every consumer
   must gate on `connected`, not just field presence.

3. **`src/app/lib/derived.ts`** — single source of truth for every derived value shown in more
   than one place (battery health %, storage wear %, CPU/memory load, performance score, TPM
   status, risk tiers), so the same underlying reality can't drift apart across the Dashboard,
   Hardware, and AI Intel pages.

### ✅ Real Dashboard / Hardware / AI Intel Pages

`src/app/App.tsx` — every card either shows a genuinely real value derived from the pipeline
above, or is explicitly marked with a `SampleTag` badge when it's illustrative/hardcoded. This
real-vs-sample discipline is enforced throughout: no fabricated number is ever presented as if
it were real telemetry. Cards with zero real backing at all (rather than a mix of real and
sample fields) are collapsed/redesigned instead of showing fake specific numbers.

### ✅ Real Alert Engine

**`src/app/hooks/useAlertEngine.ts`** — threshold-based rules (CPU load, memory usage, battery
low while discharging) evaluated only against real, connected telemetry — never fabricates an
alert from stale or sample data. Each rule fires once per threshold crossing (won't re-fire
until the value drops back below threshold first) and persists state/alert history to
`localStorage`.

### ✅ Type Safety & Build Hygiene

- `tsconfig.json` + `npm run typecheck` (`tsc --noEmit`) — added after this project ran for a
  long time with esbuild transpile-only and no type-checking at all. Currently passes cleanly
  with zero errors.
- `npm run build` (`vite build`) passes cleanly with zero errors and zero warnings.
- `src/app/components/shared/ErrorBoundary.tsx` — a last-resort React error boundary at the app
  root (`src/main.tsx`), so an unexpected render error shows a recoverable fallback instead of a
  white screen.

## Architecture Overview

### Real Telemetry Flow

```
get-telemetry.ps1 (WMI/CIM) ---\
rust-collector (native Rust) ----+--> telemetry-server.mjs (merge, 5s poll) --> /api/telemetry --> useTelemetry() --> App.tsx cards
LibreHardwareMonitor (optional) -/
```

### Real-vs-Sample Disclosure

```
Every displayed value:
  real telemetry available?  -> show it
  not available / sample?    -> show it tagged with <SampleTag />, never silently
```

## Superseded / Removed

An earlier draft of this project scaffolded a separate architecture aimed at the same PRD goals
(MQTT telemetry streaming, a composite health-scoring engine, a remote-assistance consent UI) as
standalone service/component files. That scaffold was never wired into the app's actual render
tree (`src/main.tsx` → `App.tsx`) at any point — confirmed by an exhaustive search of `src/` for
any import of these files or the types/symbols they exported before removal. It has been deleted
as abandoned, unreachable code, superseded by the real telemetry pipeline and `derived.ts`
formulas described above:

- `src/services/MQTTTelemetryService.ts`
- `src/services/HealthScoreService.ts`
- `src/app/components/dashboard/EndpointDashboard.tsx`
- `src/app/components/health-score/HealthScoreDisplay.tsx`
- `src/app/components/remote-assistance/RemoteAssistanceConsent.tsx`

`src/types/endpoint.ts` (the type definitions these files used) was left in place — it isn't
imported by anything real either at this point, but wasn't in scope for this cleanup pass.

## Honest Status

- **Real telemetry pipeline**: working, verified live (PowerShell + Rust + LibreHardwareMonitor
  merge, elevation-aware, with a tested fallback path).
- **Dashboard/Hardware/AI Intel pages**: working, real-vs-sample disclosure enforced throughout.
- **Alert engine**: working, real-data-only.
- **MQTT streaming to a Command Center, remote assistance, self-update rings, subscription
  validation, hardware attestation**: none of this exists yet. The PRD describes them as future
  phases; the removed scaffold was a first, disconnected attempt at some of this surface area,
  not a working implementation.

---

**Last Updated**: 2026-07-22
**Environment**: Development
