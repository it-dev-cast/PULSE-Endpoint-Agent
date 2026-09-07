import { createServer } from "node:http";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { isSea } from "node:sea";

// Two real launch contexts, not one: `node telemetry-server.mjs` (dev, and still how
// start-telemetry-server.cmd's own debugging fallback works - see README's "Running the pieces
// separately") vs. the packaged single-executable build (build-telemetry-exe.ps1) the real
// installer ships instead, since a customer machine has no Node.js to run the .mjs directly.
// `import.meta.url` is the right answer for the first (this file's own real path) but resolves
// to an empty string inside a SEA bundle (confirmed directly - esbuild's own cjs-output warning
// says as much, and the file crashed with "Cannot use import statement outside a module" before
// bundling was even added, then threw on a null fileURLToPath(undefined) after bundling to cjs
// without this fix). `process.execPath` is the right answer for the second (the packaged .exe's
// own real path, which is where get-telemetry.ps1/pulse-telemetry.exe/the state files are
// installed alongside it) but is WRONG for the first - it would resolve to node.exe's own
// install directory (e.g. C:\Program Files\nodejs), not this script's directory, silently
// breaking every relative path below on every plain `node` invocation. `isSea()` is Node's own
// real signal for which context this actually is - not a guess based on argv or an env var.
const __dirname = isSea() ? path.dirname(process.execPath) : path.dirname(fileURLToPath(import.meta.url));
const PS_SCRIPT = path.join(__dirname, "get-telemetry.ps1");
const RUST_BINARY = path.join(__dirname, "..", "rust-collector", "target", "release", "pulse-telemetry.exe");

const PORT = 4317;
const POLL_INTERVAL_MS = 5000;

const AGENT_CONFIG_PATH = path.join(__dirname, "pulse-agent.config.json");

function loadAgentConfig() {
  try {
    if (fs.existsSync(AGENT_CONFIG_PATH)) {
      const raw = fs.readFileSync(AGENT_CONFIG_PATH, "utf-8");
      const parsed = JSON.parse(raw);
      console.log(`[telemetry] loaded ${AGENT_CONFIG_PATH} - backendUrl override: ${parsed.backendUrl || "(not set, using default)"}`);
      return parsed;
    }
    console.log(`[telemetry] no pulse-agent.config.json found - using default backend URL (localhost:8443 unless PULSE_BACKEND_URL is set)`);
  } catch (e) {
    console.error(`[telemetry] failed to read/parse pulse-agent.config.json - falling back to defaults:`, e.message);
  }
  return {};
}
const agentConfig = loadAgentConfig();

// backend/ (the Cloud Command Center Go service) - real, but optional: this collector already
// works standalone without it (that's how it's run throughout most of this project's history),
// so every call below degrades to null/no-op rather than failing collect() if it's not running.
// Resolution order: pulse-agent.config.json's backendUrl (real per-install override) ->
// PULSE_BACKEND_URL env var (real override for a scripted/service-managed launch) -> this
// hardcoded localhost default (this dev machine's own real, current setup - unchanged for
// everyone who hasn't set an override).
let BACKEND_URL = agentConfig.backendUrl || process.env.PULSE_BACKEND_URL || "http://localhost:8443";

// BACKEND_REQUEST_TIMEOUT_MS - was a hardcoded 5000 (5s) at every one of these call sites,
// which is fine for a same-machine/same-LAN backend but genuinely too aggressive for a real
// remote deployment - confirmed directly: a device reaching its backend over a Tailscale
// cross-tailnet share (relayed rather than a direct peer connection) legitimately took longer
// than 5s to complete a request that a plain curl (no client-side timeout) completed without
// issue. 15s gives real remote/relayed network paths room to complete without meaningfully
// delaying detection of a genuinely offline backend (these are all background poll/push calls,
// nothing synchronous a user is waiting on).
const BACKEND_REQUEST_TIMEOUT_MS = 15000;
// Persisted once per device, reused across restarts rather than re-registering every time -
// gitignored (see .gitignore) since it holds a real, live API key, not a placeholder.
const DEVICE_CREDENTIALS_PATH = path.join(__dirname, ".device-credentials.json");

// PRD Section 31 Self-Update v1. AGENT_VERSION is this build's own installed version - baked in
// by build-telemetry-exe.ps1 via esbuild's --define (see that script's own comment); typeof-
// guarded so running unbundled from source doesn't throw on a genuinely undeclared identifier -
// it safely resolves to null instead, and every self-update check is skipped entirely (logged
// once) rather than guessing whether an update is needed with no real version to compare against.
const AGENT_VERSION = typeof __AGENT_VERSION__ !== "undefined" ? __AGENT_VERSION__ : null;

// The real Casterly release-signing public key (Ed25519) - deliberately embedded here, baked into
// the build, rather than fetched from the backend at runtime the way the ADE approval-token
// public key is (see getBackendPublicKey below). That's fine for approval tokens (the device
// already trusts the backend to decide approve/reject; handing over the right key adds no new
// risk), but would defeat the entire point of a separate release-signing trust root - a
// compromised backend could otherwise swap this key and a malicious manifest/signature together,
// and the "verification" would prove nothing. See backend/cmd/gen-release-key's own comment for
// where the matching private key lives (never on any device) and
// installer/publish-agent-release.ps1 for how it signs what this verifies.
const RELEASE_PUBLIC_KEY_B64 = "UjQeOVEt9lKOzZlf9JFd6jXoiT+1xtjv1RFfGbpK43Q=";

// Real, persisted anti-replay state (PRD Section 31.2 Step 4) - plain, unencrypted JSON, not
// DPAPI-protected like DEVICE_CREDENTIALS_PATH. A sequence number isn't a secret, and DPAPI's
// LocalMachine scope (see protectCredentials's own comment) wouldn't meaningfully protect it from
// an attacker who already has local write access to this device anyway - decryptable by any
// process on the same machine. This genuinely protects against network-level replay (an old,
// validly-signed manifest served again by a compromised/reverted mirror); it does NOT protect
// against a local attacker rolling this specific file back - that stronger guarantee is what a
// future TPM-sealed counter would add, deliberately deferred for this v1 (disclosed, not hidden).
const SELF_UPDATE_STATE_PATH = path.join(__dirname, ".self-update-state.json");
// Real, persisted last-known-good entitlement + when it was actually last confirmed - mirrors
// SELF_UPDATE_STATE_PATH's own load-once-at-startup, write-on-change pattern exactly. Plain,
// unencrypted JSON like METRIC_SNAPSHOT_STATE_PATH below, not DPAPI-protected like
// DEVICE_CREDENTIALS_PATH - this is a cached read of what the backend already told this device,
// not a secret.
const ENTITLEMENT_CACHE_PATH = path.join(__dirname, ".entitlement-cache.json");
// Entitlement/heartbeat don't need the same 5s cadence as hardware telemetry - a subscription
// plan or last-seen timestamp doesn't change fast enough to justify polling it 12x/minute, and
// this is a separate named interval specifically so that policy is visible and adjustable in
// one place rather than a magic number buried in a setTimeout call.
const BACKEND_POLL_INTERVAL_MS = 60000;
// PRD §7's real 72h offline-tolerance window (see resolveEntitlementState below) - within it, a
// failed poll still serves the last successfully-verified entitlement (marked stale) rather than
// collapsing to the genuine "Unknown" of a device that has never once reached the backend; past
// it, an honest "unverified" state takes over instead of continuing to vouch for a read that
// could be days old. Named here, not a magic number, same convention as every other interval
// above.
const ENTITLEMENT_OFFLINE_TOLERANCE_MS = 72 * 60 * 60 * 1000;
// Hardware tamper/change detection (real device-registry hardware baseline) doesn't need
// BACKEND_POLL_INTERVAL_MS's own cadence either - the fields it compares (serials, model names,
// installed capacity) never change between one minute and the next in legitimate use, so
// checking every cycle would just be BACKEND_POLL_INTERVAL_MS-many redundant identical POSTs for
// every one that could possibly matter. A separate, slower named interval, same reasoning as
// BACKEND_POLL_INTERVAL_MS's own comment above.
const HARDWARE_CHECK_INTERVAL_MS = 5 * 60 * 1000;
// Windows Update Agent's real search (Microsoft.Update.Session COM object) is genuinely slow -
// measured directly on this machine at ~17s for a single IsInstalled=0/Type='Software' search,
// not something to run on POLL_INTERVAL_MS's 5s cadence or even BACKEND_POLL_INTERVAL_MS's own
// 60s one. Whether Windows has pending software updates changes on the order of days, not
// minutes, so once an hour is more than sufficient real freshness for the OS card's badge.
const WINDOWS_UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
// ai-service/ (the real, minimal Python prediction service) - real, but optional, same
// degrade-to-null convention as BACKEND_URL above: predictionState just stays whatever it last
// was if this isn't reachable.
const AI_SERVICE_URL = "http://localhost:8001";
// Real per-device metric-snapshot/prediction cadence - once per real calendar day, not once per
// BACKEND_POLL_INTERVAL_MS tick, since the whole point (AI Intel's SSD/Battery Remaining Life
// trend) is a slowly-accumulating history: battery health / SSD wear don't move enough in one
// minute to justify checking that often, and doing so would just be noise, not more real signal.
const METRIC_SNAPSHOT_STATE_PATH = path.join(__dirname, ".metric-snapshot-state.json");

if (process.platform !== "win32") {
  console.warn(
    `[telemetry] This collector requires Windows (uses powershell.exe) — running on ${process.platform}, telemetry will be unavailable.`,
  );
}

// Last-resort backstop, not a substitute for the try/catch boundaries already in collect() and
// the HTTP handler - this exists for whatever a future edit might introduce outside those. Node's
// own guidance is that resuming after an uncaught exception is inherently unsafe and the correct
// response is to log and exit, letting a process supervisor restart a clean instance. This
// process has no such supervisor reliably watching it mid-session (the Scheduled Task and
// ensure-telemetry-running.mjs both only (re)launch it at logon / when nothing is listening on
// the port, not on an unexpected exit), so exiting here would leave the dashboard's telemetry
// dead until the next full logon or `npm run dev:all`. Staying alive with whatever `cache`
// already holds (last-known-good, unaffected by an error thrown elsewhere) is judged the better
// default for this specific stateless polling design - logged loudly so it's not silently masked.
process.on("uncaughtException", (e) => {
  console.error("[telemetry] uncaughtException (server kept running, cache unaffected):", e);
});
process.on("unhandledRejection", (e) => {
  console.error("[telemetry] unhandledRejection (server kept running, cache unaffected):", e);
});

let cache = { data: null, error: null, updatedAt: null };
let loggedStartupDiagnostics = false;
let loggedHwMonDiagnostics = false;
let loggedScheduledTaskDiagnostics = false;
// null = not yet determined; otherwise "ok" | "unavailable" | "invalid-json" - logged whenever
// this changes, not just once, so a mid-run change in availability isn't silently swallowed.
let lastRustOutcome = null;
// Epoch ms of the start of the CURRENT continuous non-"ok" streak, or null while rust-collector
// is fine. Distinct from lastRustOutcome's single-transition logging below: that fires once per
// change (a real signal, but "warning"-severity and easy to scroll past in a busy fleet's event
// window - the same class of gap the offline-detector's own one-time event had). This is what
// RUST_DEGRADED_ESCALATION_MS checks against to fire one real "this has been broken a while,
// pay attention" critical event instead of relying on that single warning ever being noticed.
let rustUnavailableSinceMs = null;
// Whether the critical escalation below has already fired for the CURRENT streak - reset on
// recovery so a later, separate outage escalates again on its own timeline rather than staying
// permanently silent after the first one ever fires.
let rustDegradedEscalated = false;
const RUST_DEGRADED_ESCALATION_MS = 5 * 60 * 1000;
// Same transition-only pattern as lastRustOutcome, for LibreHardwareMonitor specifically -
// loggedHwMonDiagnostics above is a one-shot "log the full field dump once" latch, not a real
// connected/disconnected tracker, so it can't tell a mid-run LHM outage from steady-state.
let lastLhmOutcome = null;

// { id, apiKey, hostname } once enrolled, else null - loaded from DEVICE_CREDENTIALS_PATH or
// obtained via POST /v1/devices/register, see loadOrRegisterDevice.
let deviceCredentials = null;
// Last POST /v1/devices/register failure, cleared on success. Two PCs on different Tailscale
// accounts using the owner's 100.x IP (instead of the Shared-in IP) fail here and stay off
// the Command Centre dashboard until the URL is corrected.
let lastRegisterError = null;
// { plan, status, expiresAt, ..., lastVerifiedAt, stale, unverified } | null - updated by
// runBackendCycle on its own slower interval via resolveEntitlementState below, read (not
// re-fetched) by collect() on every 5s cycle. null means this device has never once successfully
// reached the backend (no cache to fall back to either) - the frontend's SampleTag convention,
// not a fake plan name. A non-null value can be a fresh live read (stale: false) or a real
// last-known-good value served from entitlementCache while the backend is currently unreachable
// (stale: true) - see resolveEntitlementState for the real 72h tolerance window that decides
// between that and unverified: true.
let entitlementState = null;
// Real, persisted { deviceId, entitlement, lastVerifiedAt } from the last successful
// fetchEntitlement - loaded once at startup (same pattern as pendingUpdateConfirmation above),
// updated and persisted only on a fresh success in resolveEntitlementState below. deviceId is
// checked before ever trusting this as a fallback - a cache left over from a previous enrollment
// on this same machine (e.g. after a full reset/re-register) isn't a real fact about the device
// currently running, so it's treated as no cache at all rather than a cross-identity leak.
let entitlementCache = loadEntitlementCache();
// Same transition-only logging pattern as lastRustOutcome above.
let lastBackendOutcome = null;
// boolean | null - real GET /v1/health result, updated by runBackendCycle. null means the
// backend itself couldn't be reached at all (distinct from false: reachable but the query failed).
let dbHealthyState = null;
// { telemetryServer, commandCenter, frontend, libreHardwareMonitor, desktopApp }: boolean | null
// per task, or null (the whole object) before the first check has ever run - updated by
// runBackendCycle.
let scheduledTaskState = null;
// { status: "baseline-set" | "match" | "mismatch", mismatchedFields: string[] } | null - real
// backend/'s POST /v1/devices/:id/hardware-check result, updated by runBackendCycle on its own
// HARDWARE_CHECK_INTERVAL_MS cadence (not every runBackendCycle tick - see that constant's own
// comment), read (not re-fetched) by collect() on every 5s cycle. null means no real check has
// completed yet (not enrolled, backend unreachable, or the very first cycle hasn't run) -
// Hardware page's Tamper Detection reads this as "Baseline Pending", never a fabricated "Clear".
// Deliberately left untouched (not reset to null) on cycles where a check isn't due yet, so the
// UI doesn't flicker back to "Baseline Pending" between every real ~5-minute check.
let hardwareIntegrityState = null;
// Epoch ms of the last real hardware-check attempt (success or failure) - what
// HARDWARE_CHECK_INTERVAL_MS gates against. 0 so the very first eligible runBackendCycle tick
// always performs a real check rather than waiting a full interval after startup.
let lastHardwareCheckAt = 0;

// { upToDate: boolean, pendingCount: number, checkedAt: string } | null - real Windows Update
// Agent (Microsoft.Update.Session COM object) IsInstalled=0/Type='Software' search result,
// updated by runBackendCycle on its own slower WINDOWS_UPDATE_CHECK_INTERVAL_MS cadence (see that
// constant's own comment - this search takes ~17s, confirmed directly, nowhere near cheap enough
// for a frequent poll). null means no real search has ever completed yet (WUA unreachable, the
// COM call failed, or the very first check hasn't run) - the OS card reads this as "Unknown", not
// a fabricated "Up to date". Deliberately left untouched (not reset to null) when a check isn't
// due yet or a single attempt fails - same reasoning as hardwareIntegrityState above, a transient
// COM failure on an hourly cadence shouldn't flicker a real prior result back to unknown.
let windowsUpdateState = null;
// Epoch ms of the last real Windows Update check attempt (success or failure) - what
// WINDOWS_UPDATE_CHECK_INTERVAL_MS gates against. 0 so the very first eligible runBackendCycle
// tick always performs a real check rather than waiting a full hour after startup.
let lastWindowsUpdateCheckAt = 0;

// { updateAvailable: boolean, latestVersion: string | null, checkedAt: string } | null - same
// Windows Update Agent search as windowsUpdateState above, but Type='Driver' filtered to
// DriverClass='Firmware' entries whose DriverModel starts with "System Firmware" - confirmed
// directly on this real machine that Dell genuinely publishes BIOS/platform firmware updates
// through Windows Update this way (a real pending update here: DriverModel "System Firmware
// 1.42.0", DriverHardwareID "uefi\res_{...}" - the standard UEFI ESRT capsule-update identifier
// for system firmware specifically, not some other device's firmware). Filtered on DriverModel's
// own "System Firmware" prefix, not just DriverClass='Firmware' alone, since a peripheral (SSD,
// webcam, touchpad) could in principle also report DriverClass='Firmware' for its own unrelated
// firmware - this is what actually distinguishes "the machine's own BIOS" from that. null means
// no real search has ever completed yet, same honest-Unknown convention as windowsUpdateState.
let biosFirmwareUpdateState = null;

// { azureAdJoined, domainJoined, enterpriseJoined, workplaceJoined: boolean, mdmEnrolled:
// boolean, tenantName: string | null, checkedAt: string } | null - real `dsregcmd /status`
// output (Microsoft's own authoritative domain-join/Azure AD-join/MDM-enrollment tool - there is
// no registry/WMI shortcut this app should prefer over asking the OS the same question `dsregcmd`
// itself answers), parsed off the SAME WINDOWS_UPDATE_CHECK_INTERVAL_MS hourly cadence as
// windowsUpdateState/biosFirmwareUpdateState above (dsregcmd is cheap/local/no-network, but this
// isn't a signal that needs sub-hourly freshness, so reusing the existing shared timer instead of
// inventing a new one keeps this consistent with the other two). mdmEnrolled is derived from a
// real MDM management URL being present - confirmed live on this machine (Workplace/Azure-AD-
// registered, not device-joined) that WorkplaceMdmUrl is genuinely blank when not MDM-enrolled.
// The device-level equivalent (an AzureAdJoined machine's own top-level MdmUrl field) is handled
// the same way but is UNVERIFIED on this specific machine, since it isn't joined that way - it's
// well-documented, stable dsregcmd behavior, not a guess, but disclosed here rather than silently
// assumed. null means no real check has ever completed yet, same honest-Unknown convention as
// windowsUpdateState/biosFirmwareUpdateState.
let domainMdmState = null;

// { licenseStatus: number, licenseFamily: string | null, productKeyChannel: string | null,
// checkedAt: string } | null - real SoftwareLicensingProduct data, same hourly cadence as
// windowsUpdateState/biosFirmwareUpdateState/domainMdmState above. NOT a cheap query like
// dsregcmd - confirmed live on this machine that Get-CimInstance SoftwareLicensingProduct alone
// takes ~42 SECONDS (WMI enumerating ~60 decoy placeholder SKU rows before this app's own filter
// narrows to the one real license). This was originally wired into get-telemetry.ps1's per-5s
// cycle and broke live telemetry collection entirely (blew past the 30s script timeout, killing
// the whole cycle's output, not just this field) - moved here specifically because license status
// is exactly the kind of slow-changing fact the hourly cadence exists for, same reasoning as the
// other three. null means no real check has ever completed yet, same honest-Unknown convention.
let windowsLicenseState = null;

// { chipset, intelMe, wifi, audio, bluetooth: { deviceName, version, date } | null } | null - real
// Win32_PnPSignedDriver data (Drivers & Firmware card), same hourly cadence as the others.
// Profiled at ~5.5-5.9s on this real machine - structurally slow (verifies Authenticode signing
// for every driver package in the store, not just cached inventory), unrelated to filtering, so
// no WMI-side optimization exists - just moved off the 5s hot path since driver versions/dates are
// exactly the "essentially never changes between reboots" class of fact.
let driverVersionsState = null;

// { present: boolean, checkedAt: string } | null - real Win32_PnPEntity Biometric-class presence
// check (Hardware Integrity card's Fingerprint row), same hourly cadence. Profiled at ~0.75-0.83s
// - not as dramatic as the other moves, but sensor presence is equally a static hardware fact.
let fingerprintSensorState = null;

// { tpm: {...} | null, bitlockerStatus: string | null, checkedAt: string } | null - a FALLBACK
// only, never the primary source: rust-collector already independently supplies both tpm and
// bitlockerStatus every cycle via its own separate, already-elevated read (see mergeRustData) -
// confirmed real tpmActive/bitlockerOn values already reach device_live_status.detail from that
// path alone. get-telemetry.ps1's own per-5s attempts at these two profiled at ~5s EACH (measured
// non-elevated - unverified whether the real elevated Scheduled Task's timing differs, but this
// fallback's value doesn't depend on that answer either way), together over a third of the
// script's ~27s baseline, for data rust already provides. Applied in collect() only when rust
// hasn't supplied a value that cycle - see collect()'s own comment at the merge site.
let tpmBitlockerFallbackState = null;

// { letter: string, diskModel: string | null, diskSerial: string | null }[] | null - real
// Get-Partition/Get-Disk per-volume enrichment (model/serial), overlaid onto the fast-path
// logicalDisks array by drive letter (see collect()'s own merge comment) - the same "additive
// overlay by key, not wholesale replace" pattern mergeRustData already uses for GPU. Size/
// FreeSpace stay on the 5s path (real-time disk usage); model/serial are static hardware facts
// profiled at ~1.3-2.2s combined with the LogicalDisk query itself, moved here instead.
let diskEnrichmentState = null;

// { battery: MetricPrediction, ssd: MetricPrediction } | null - ai-service's real regression
// result, updated by runBackendCycle at most once per real calendar day (see
// METRIC_SNAPSHOT_STATE_PATH). null means no real prediction has ever completed (not enrolled,
// backend/ai-service unreachable, or the very first day hasn't finished yet) - AI Intel's
// SSD/Battery Remaining Life tiles read this as "Collecting data (day 0 of 3)", never a
// fabricated projection. Deliberately left untouched (not reset to null) on a day this cycle's
// fetch attempt fails - same reasoning as hardwareIntegrityState above, a single transient
// failure on a once-a-day cadence shouldn't flicker a real prior result back to "collecting."
let predictionState = null;

// { lastSnapshotDate, lastPredictionDate }: "YYYY-MM-DD" (UTC) | null each, plus lastPrediction
// (the real ai-service payload). Dates are persisted so a same-day restart doesn't re-POST a
// snapshot it already landed; lastPrediction is persisted because predictionState is otherwise
// memory-only - a restart used to leave the local UI with predictions: null until the next UTC
// day even though lastPredictionDate was already today (so the fetch was skipped).
function predictionFromDisk(parsed) {
  const p = parsed?.lastPrediction;
  if (!p || typeof p !== "object" || !p.battery || !p.ssd) return null;
  return { battery: p.battery, ssd: p.ssd };
}

function loadMetricSnapshotState() {
  try {
    const raw = fs.readFileSync(METRIC_SNAPSHOT_STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return {
      lastSnapshotDate: typeof parsed.lastSnapshotDate === "string" ? parsed.lastSnapshotDate : null,
      lastPredictionDate: typeof parsed.lastPredictionDate === "string" ? parsed.lastPredictionDate : null,
      lastPrediction: predictionFromDisk(parsed),
    };
  } catch {
    // Missing/corrupt file - genuinely never recorded anything yet (or can't tell), same
    // honest-default handling as loadOrRegisterDevice's own missing-credentials case below.
    return { lastSnapshotDate: null, lastPredictionDate: null, lastPrediction: null };
  }
}

function saveMetricSnapshotState() {
  try {
    fs.writeFileSync(METRIC_SNAPSHOT_STATE_PATH, JSON.stringify(metricSnapshotState, null, 2));
  } catch (e) {
    console.error("[telemetry] failed to persist metric-snapshot state:", e.message);
  }
}

function todayUtcDateString() {
  return new Date().toISOString().slice(0, 10);
}

let metricSnapshotState = loadMetricSnapshotState();
// Backend upserts by calendar day, so one POST per process start is safe and recovers the case
// where the local date file said "already done today" but the backend row never landed.
let snapshotPostedThisProcess = false;
if (
  metricSnapshotState.lastPrediction
  && metricSnapshotState.lastPredictionDate === todayUtcDateString()
) {
  predictionState = metricSnapshotState.lastPrediction;
}

const LHM_URL = "http://localhost:8085/data.json";

// LibreHardwareMonitor's Remote Web Server exposes a tree of hardware/sensor nodes. Leaf
// sensor nodes carry a non-empty SensorId shaped like "/{hwtype}/{index}/{sensortype}/{index}"
// (e.g. "/amdcpu/0/temperature/2", "/gpu-nvidia/0/temperature/0", "/lpc/nct6798d/0/fan/1").
// That path encodes both which hardware the sensor belongs to and what kind of sensor it is,
// so hardware/sensor category is read straight from SensorId rather than tracked via tree
// ancestry - simpler and doesn't depend on the exact node nesting for a given hardware vendor.
function collectSensors(node, out) {
  if (!node) return out;
  if (node.SensorId) {
    out.push({ text: node.Text, sensorId: node.SensorId, value: node.Value });
  }
  if (Array.isArray(node.Children)) {
    for (const child of node.Children) collectSensors(child, out);
  }
  return out;
}

function sensorTypeOf(sensorId) {
  const m = /\/([a-zA-Z]+)\/\d+$/.exec(sensorId || "");
  return m ? m[1].toLowerCase() : null;
}

function hardwareCategoryOf(sensorId) {
  const m = /^\/([a-zA-Z0-9-]+)\//.exec(sensorId || "");
  const seg = (m ? m[1] : "").toLowerCase();
  if (seg === "amdcpu" || seg === "intelcpu") return "cpu";
  if (seg.startsWith("gpu-")) return "gpu";
  if (seg === "mainboard" || seg === "motherboard" || seg === "lpc" || seg === "embeddedcontroller") return "motherboard";
  if (seg === "battery") return "battery";
  return "other";
}

function parseNumericValue(raw) {
  if (typeof raw !== "string") return null;
  const m = /-?[\d.]+/.exec(raw);
  return m ? Number(m[0]) : null;
}

// LHM's "Remaining Time (Estimated)" sensor is formatted as H:MM:SS (e.g. "1:09:23"), not a
// plain number - normalized to total minutes here so it's directly comparable/interchangeable
// with Windows' own batteryRunTimeMinutes (EstimatedRunTime) on the frontend.
function parseHmsToMinutes(raw) {
  if (typeof raw !== "string") return null;
  const m = /^(\d+):(\d{2}):(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const [, hours, minutes, seconds] = m;
  return Number(hours) * 60 + Number(minutes) + Math.round(Number(seconds) / 60);
}

async function fetchHardwareMonitor() {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    let tree;
    try {
      const res = await fetch(LHM_URL, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      tree = await res.json();
    } finally {
      clearTimeout(timeoutId);
    }

    const sensors = collectSensors(tree, []);

    const cpuTemps = sensors.filter(
      (s) => hardwareCategoryOf(s.sensorId) === "cpu" && sensorTypeOf(s.sensorId) === "temperature",
    );
    const cpuTempSensor = cpuTemps.find((s) => /package/i.test(s.text || "")) ?? cpuTemps[0] ?? null;

    // "Distance to TjMax" is LHM's per-core margin (in °C) before that core's own thermal
    // throttle point - a real hardware-reported value (Intel's Digital Thermal Sensor), not
    // derived from the plain current-temp reading above. One sensor per core (e.g. "P-Core #1
    // Distance to TjMax", "E-Core #3 Distance to TjMax"), hence a substring match rather than
    // an exact label - same caveat as every other LHM sensor match in this file: exact wording
    // isn't guaranteed across LHM versions/hardware. The worst-case (minimum) core is what
    // actually matters for real throttling risk - one hot core throttles the whole chip
    // regardless of what the others are doing, so this is never averaged.
    const tjMaxDistanceSensors = cpuTemps.filter((s) => /distance.*tjmax/i.test(s.text || ""));
    const tjMaxDistanceValues = tjMaxDistanceSensors
      .map((s) => parseNumericValue(s.value))
      .filter((v) => v != null);
    const cpuMinDistanceToTjMaxC = tjMaxDistanceValues.length > 0 ? Math.min(...tjMaxDistanceValues) : null;

    const gpuTemps = sensors.filter(
      (s) => hardwareCategoryOf(s.sensorId) === "gpu" && sensorTypeOf(s.sensorId) === "temperature",
    );
    const gpuTempSensor = gpuTemps[0] ?? null;

    const moboTemps = sensors.filter(
      (s) => hardwareCategoryOf(s.sensorId) === "motherboard" && sensorTypeOf(s.sensorId) === "temperature",
    );
    const moboTempSensor = moboTemps[0] ?? null;

    // DIMM SPD thermal sensors (LibreHardwareMonitor `/memory/dimm/.../temperature/0`, label
    // "DIMM #N"). These are RAM module temps, not Super I/O "Motherboard"/"System" - this
    // laptop has no mainboard/lpc/embeddedcontroller temperature node at all. Hottest DIMM
    // is the one that matters; skip the resolution/limit companion sensors on the same path.
    const dimmTempValues = sensors
      .filter(
        (s) =>
          /^\/memory\//i.test(s.sensorId || "") &&
          sensorTypeOf(s.sensorId) === "temperature" &&
          /^DIMM #\d+$/i.test((s.text || "").trim()),
      )
      .map((s) => parseNumericValue(s.value))
      .filter((v) => v != null);
    const dimmTempC = dimmTempValues.length > 0 ? Math.max(...dimmTempValues) : null;

    // LHM's Battery hardware node (when present) typically exposes Level/Voltage/Charge-rate/
    // Degradation - a Temperature sensor under it depends on the laptop's EC/ACPI exposing one,
    // which many don't. Detected the same way as every other category: read from SensorId, not
    // assumed to exist.
    const batteryTemps = sensors.filter(
      (s) => hardwareCategoryOf(s.sensorId) === "battery" && sensorTypeOf(s.sensorId) === "temperature",
    );
    const batteryTempSensor = batteryTemps[0] ?? null;

    // LHM's own independent battery-health calculation. Its "Degradation Level" sensor is the
    // inverse of health (capacity lost, not capacity remaining), so it's converted to a health
    // percentage here rather than passing the raw degradation number under a "health" name.
    const batteryDegradationSensor =
      sensors.find(
        (s) =>
          hardwareCategoryOf(s.sensorId) === "battery" &&
          sensorTypeOf(s.sensorId) === "level" &&
          /degradation/i.test(s.text || ""),
      ) ?? null;

    // LHM's own independent remaining-time estimate - a second, separate source from Windows'
    // Win32_Battery.EstimatedRunTime, useful specifically when that one is null (e.g. charging).
    const batteryRemainingTimeSensor =
      sensors.find(
        (s) =>
          hardwareCategoryOf(s.sensorId) === "battery" &&
          sensorTypeOf(s.sensorId) === "timespan" &&
          /remaining/i.test(s.text || ""),
      ) ?? null;

    // Many laptops expose no fan sensor at all through LibreHardwareMonitor - that's a real
    // absence, not a bug, so this stays null rather than guessing.
    const fanSensor = sensors.find((s) => sensorTypeOf(s.sensorId) === "fan") ?? null;

    const cpuVoltages = sensors.filter(
      (s) => hardwareCategoryOf(s.sensorId) === "cpu" && sensorTypeOf(s.sensorId) === "voltage",
    );
    const cpuVoltageSensor =
      cpuVoltages.find((s) => /core|vid/i.test(s.text || "")) ?? cpuVoltages[0] ?? null;

    const batteryDegradationPct = batteryDegradationSensor ? parseNumericValue(batteryDegradationSensor.value) : null;

    const result = {
      cpuTempC: cpuTempSensor ? parseNumericValue(cpuTempSensor.value) : null,
      gpuTempC: gpuTempSensor ? parseNumericValue(gpuTempSensor.value) : null,
      motherboardTempC: moboTempSensor ? parseNumericValue(moboTempSensor.value) : null,
      dimmTempC,
      fanRpm: fanSensor ? parseNumericValue(fanSensor.value) : null,
      cpuVoltage: cpuVoltageSensor ? parseNumericValue(cpuVoltageSensor.value) : null,
      batteryTemperatureC: batteryTempSensor ? parseNumericValue(batteryTempSensor.value) : null,
      batteryHealthLhmPercent: batteryDegradationPct != null ? Math.round(100 - batteryDegradationPct) : null,
      batteryRemainingTimeLhm: batteryRemainingTimeSensor ? parseHmsToMinutes(batteryRemainingTimeSensor.value) : null,
      cpuMinDistanceToTjMaxC,
    };

    if (!loggedHwMonDiagnostics) {
      loggedHwMonDiagnostics = true;
      console.log(
        "[telemetry] LibreHardwareMonitor connected -",
        `cpuTemp=${result.cpuTempC ?? "not found"}`,
        `gpuTemp=${result.gpuTempC ?? "not found"}`,
        `motherboardTemp=${result.motherboardTempC ?? "not found"}`,
        `dimmTemp=${result.dimmTempC ?? "not found"}`,
        `fanRpm=${result.fanRpm ?? "not found"}`,
        `cpuVoltage=${result.cpuVoltage ?? "not found"}`,
        `batteryTemp=${result.batteryTemperatureC ?? "not found"}`,
        `batteryHealthLhm=${result.batteryHealthLhmPercent ?? "not found"}`,
        `batteryRemainingTimeLhm=${result.batteryRemainingTimeLhm ?? "not found"}`,
        `cpuMinDistanceToTjMax=${result.cpuMinDistanceToTjMaxC ?? "not found"} (${tjMaxDistanceSensors.length} core sensors)`,
      );
    }

    // Real transition, not just-once - a LHM outage mid-run (someone closes it, a crash) is
    // exactly the kind of thing worth a persisted event, not just a console line nobody's
    // watching. Only fires on an actual ok<->unavailable flip (see lastLhmOutcome's own comment).
    if (lastLhmOutcome !== "ok") {
      if (lastLhmOutcome === "unavailable") logEvent("lhm-available", "LibreHardwareMonitor became available again.", "info");
      lastLhmOutcome = "ok";
    }

    return result;
  } catch (e) {
    if (!loggedHwMonDiagnostics) {
      loggedHwMonDiagnostics = true;
      console.log(
        `[telemetry] LibreHardwareMonitor not reachable at ${LHM_URL} (${e.message}) - install it and enable ` +
          `Options > Remote Web Server in its menu for CPU/GPU/motherboard temps, fan RPM, and CPU voltage.`,
      );
    }
    if (lastLhmOutcome !== "unavailable") {
      if (lastLhmOutcome === "ok") logEvent("lhm-unavailable", "LibreHardwareMonitor became unavailable.", "warning");
      lastLhmOutcome = "unavailable";
    }
    return null;
  }
}

// HWiNFO (via rust-collector/src/hwinfo.rs's shared-memory reader) is a second, optional real
// source for exactly three hardwareMonitor fields LibreHardwareMonitor also covers: cpuVoltage,
// motherboardTempC, fanRpm. Neither source is treated as authoritative - whichever one actually
// has a non-null reading for a given field wins, so a real LHM value is never discarded just
// because HWiNFO didn't find a matching sensor name on this hardware (or vice versa). `lhm` is
// used as the base (it already covers cpuTempC/gpuTempC/batteryTemperatureC/etc. that HWiNFO's
// reader doesn't even attempt), with only these three fields patched from `hwinfo` when lhm's
// own value for that field is null.
function mergeHwInfoIntoHardwareMonitor(lhm, hwinfo) {
  if (!hwinfo) return lhm;
  const base = lhm ?? {
    cpuTempC: null,
    gpuTempC: null,
    motherboardTempC: null,
    dimmTempC: null,
    fanRpm: null,
    cpuVoltage: null,
    batteryTemperatureC: null,
    batteryHealthLhmPercent: null,
    batteryRemainingTimeLhm: null,
    cpuMinDistanceToTjMaxC: null,
  };
  return {
    ...base,
    cpuVoltage: base.cpuVoltage ?? hwinfo.cpuVoltage ?? null,
    motherboardTempC: base.motherboardTempC ?? hwinfo.motherboardTempC ?? null,
    fanRpm: base.fanRpm ?? hwinfo.fanRpm ?? null,
  };
}

function normalizeBackendUrl(raw) {
  const s = String(raw || "").trim().replace(/\/+$/, "");
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.hostname) return null;
  return s;
}

function persistBackendUrl(url) {
  fs.writeFileSync(AGENT_CONFIG_PATH, `${JSON.stringify({ backendUrl: url }, null, 2)}\n`, "utf8");
}

function enrollmentPayload() {
  return {
    enrolled: !!deviceCredentials,
    deviceId: deviceCredentials?.id ?? null,
    hostname: deviceCredentials?.hostname ?? os.hostname(),
    backendUrl: BACKEND_URL,
    lastError: deviceCredentials ? null : lastRegisterError,
  };
}

async function enrollmentHostname() {
  const host = os.hostname();
  const { err, stdout } = await execPowerShellCommand(
    "(Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography' -Name MachineGuid).MachineGuid",
    8000,
  );
  if (err) return host;
  const guid = String(stdout).trim().replace(/-/g, "");
  if (guid.length < 6) return host;
  // Two Windows PCs can share a hostname (this fleet had two DESKTOP-MLQLP7J). Suffix with a
  // stable MachineGuid slice so Command Centre shows two endpoints instead of one name twice.
  return `${host}-${guid.slice(-6).toUpperCase()}`;
}

function registerFailureMessage(err) {
  if (!err) return `failed to reach ${BACKEND_URL}`;
  if (err.name === "AbortError") return `timed out reaching ${BACKEND_URL}`;
  const msg = String(err.message || err);
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH/i.test(msg)) {
    return `cannot reach Command Centre at ${BACKEND_URL} (${msg})`;
  }
  return `${msg} (${BACKEND_URL})`;
}

// Reads DEVICE_CREDENTIALS_PATH if it already holds a real id+apiKey; otherwise registers this
// device with backend/ (POST /v1/devices/register) using hostname plus a stable machine id and
// persists the result. Only ever called when deviceCredentials is still null, so a device already
// enrolled is never re-registered - re-registering on every restart would silently mint a new,
// orphaned device row in backend/'s database every time this process starts.
async function loadOrRegisterDevice() {
  try {
    const raw = fs.readFileSync(DEVICE_CREDENTIALS_PATH, "utf8");
    let parsed;
    let wasLegacyPlaintext = false;
    try {
      // Legacy pre-DPAPI format: the raw file content IS valid JSON directly. A real DPAPI-
      // protected blob (base64 of encrypted bytes) is never valid JSON on its own, so this
      // check alone is a reliable, self-describing migration gate - no separate persisted
      // "migration done" flag needed (unlike the Tauri app's ruleId-dedup alert migration, which
      // needed one because its data stayed validly-shaped whether migrated or not).
      parsed = JSON.parse(raw);
      wasLegacyPlaintext = true;
    } catch {
      // Not directly-parseable JSON - assume it's already a real DPAPI-protected blob from a
      // previous run and decrypt it. A genuine decrypt failure (corrupted file, moved to a
      // different machine where LocalMachine-scope DPAPI keys don't match) throws here and is
      // caught by the outer catch below, logged, and treated the same as a missing file -
      // falling through to fresh registration rather than crashing.
      const decrypted = await unprotectCredentials(raw);
      parsed = JSON.parse(decrypted);
    }

    if (parsed?.id && parsed?.apiKey) {
      if (wasLegacyPlaintext) {
        console.warn(`[telemetry] ${DEVICE_CREDENTIALS_PATH} is in the old plaintext format - encrypting it in place.`);
        try {
          const protectedBlob = await protectCredentials(JSON.stringify(parsed, null, 2));
          fs.writeFileSync(DEVICE_CREDENTIALS_PATH, protectedBlob, { mode: 0o600 });
          console.log(`[telemetry] migrated ${DEVICE_CREDENTIALS_PATH} to DPAPI-encrypted format.`);
        } catch (migrateErr) {
          // Non-fatal for this cycle - the plaintext credentials we already parsed are still
          // real and usable now; migration just retries on the next restart instead of blocking
          // this one on a local disk/PowerShell hiccup.
          console.warn(`[telemetry] failed to encrypt ${DEVICE_CREDENTIALS_PATH} in place (${migrateErr.message}) - will retry on next restart; continuing with the plaintext credentials for now.`);
        }
      }
      console.log(`[telemetry] reusing existing device credentials (id=${parsed.id}) from ${DEVICE_CREDENTIALS_PATH} - not re-registering.`);
      return parsed;
    }
    console.warn(`[telemetry] ${DEVICE_CREDENTIALS_PATH} exists but is missing id/apiKey - re-registering.`);
  } catch (e) {
    if (e.code !== "ENOENT") {
      console.warn(`[telemetry] failed to read/decrypt ${DEVICE_CREDENTIALS_PATH} (${e.message}) - re-registering.`);
    }
    // ENOENT (file doesn't exist yet) is the expected first-run case - falls through to
    // registration silently, no warning needed for that specific case.
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), BACKEND_REQUEST_TIMEOUT_MS);
    let body;
    try {
      const hostname = await enrollmentHostname();
      const res = await fetch(`${BACKEND_URL}/v1/devices/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostname }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      body = await res.json();
    } finally {
      clearTimeout(timeoutId);
    }

    lastRegisterError = null;
    const credentials = { id: body.id, apiKey: body.apiKey, hostname: body.hostname };
    // Mode 0o600 (owner read/write only) AND DPAPI-encrypted (LocalMachine scope, see
    // protectCredentials's own comment) - this file holds a real, live API key, the one and
    // only place it exists outside backend/'s own bcrypt hash of it, so both protections stack
    // rather than either alone standing in for the other.
    const protectedBlob = await protectCredentials(JSON.stringify(credentials, null, 2));
    fs.writeFileSync(DEVICE_CREDENTIALS_PATH, protectedBlob, { mode: 0o600 });
    console.log(`[telemetry] registered this device with Cloud Command Center (id=${credentials.id}, hostname=${credentials.hostname}) - credentials saved to ${DEVICE_CREDENTIALS_PATH} (DPAPI-encrypted).`);
    return credentials;
  } catch (e) {
    lastRegisterError = registerFailureMessage(e);
    // Not logged here - runBackendCycle's transition-only logging (lastBackendOutcome) covers
    // this so a backend that's simply not running yet doesn't spam a warning every 60s.
    return null;
  }
}

// Returns the parsed body (not just ok/fail) since PRD §9 Self-Healing v1 rides this same cycle
// for its remote-dispatch poll - pendingCommand is real only when the backend actually has one
// queued for this device (see backend/handlers.go's handleHeartbeat), null/absent otherwise, same
// "absence, not fabricated" pattern as every other field this device reads from the backend.
// Returns null (not a boolean) on any failure, so a caller can tell "heartbeat genuinely
// succeeded with no pending command" apart from "the request itself failed."
async function sendHeartbeat(credentials) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), BACKEND_REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${BACKEND_URL}/v1/devices/${credentials.id}/heartbeat`, {
        method: "POST",
        headers: { Authorization: `Bearer ${credentials.apiKey}` },
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const body = await res.json();
      return { ok: true, pendingCommand: body.pendingCommand ?? null };
    } finally {
      clearTimeout(timeoutId);
    }
  } catch {
    return null;
  }
}

// Exposes this device's real, configured BACKEND_URL to the frontend - safe to expose (it's
// just an address, never a secret; the device's real API key never leaves this process). Real
// gap found live: ScreenSharePOC.tsx's WebSocket signaling connection was still hardcoded to
// ws://localhost:8443, which only ever worked when the Tauri app and backend happened to be the
// same machine (this dev setup's own original reality) - a genuinely remote laptop's session
// creation correctly reached the real backend (it already goes through
// handleRemoteSessionCreate above), but the WebSocket join then failed outright, since that one
// connection never had a way to learn this device's real BACKEND_URL. This endpoint is that way.
function handleBackendUrlProxy(res) {
  res.writeHead(200);
  res.end(JSON.stringify({ backendUrl: BACKEND_URL }));
}

function handleEnrollmentStatus(res) {
  res.writeHead(200);
  res.end(JSON.stringify(enrollmentPayload()));
}

// Proxies GET /v1/event-retention - the same named constant backend pruneEventsForDevice
// already enforces. Null (not a copied 90) when the backend is unreachable so Settings can
// show "Not synced" instead of a second static number that would drift.
async function handleEventRetentionProxy(res) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BACKEND_REQUEST_TIMEOUT_MS);
  try {
    const backendRes = await fetch(`${BACKEND_URL}/v1/event-retention`, { signal: controller.signal });
    const body = await backendRes.json().catch(() => null);
    const days = Number(body?.eventRetentionDays);
    if (!backendRes.ok || !Number.isFinite(days) || days <= 0) {
      res.writeHead(200);
      res.end(JSON.stringify({ eventRetentionDays: null }));
      return;
    }
    res.writeHead(200);
    res.end(JSON.stringify({ eventRetentionDays: days }));
  } catch {
    res.writeHead(200);
    res.end(JSON.stringify({ eventRetentionDays: null }));
  } finally {
    clearTimeout(timer);
  }
}

// Real published agent version from Command Centre (GET /v1/agent/latest). The UI compares
// this to the version baked into the running app and shows "Update available" - never a
// hardcoded newer number. 404/unreachable → { version: null } so a missing publish file
// cannot look like a fake update.
async function handleAgentLatestProxy(res) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BACKEND_REQUEST_TIMEOUT_MS);
  try {
    const backendRes = await fetch(`${BACKEND_URL}/v1/agent/latest`, { signal: controller.signal });
    const text = await backendRes.text();
    if (!backendRes.ok) {
      res.writeHead(200);
      res.end(JSON.stringify({ version: null, downloadUrl: null, error: `HTTP ${backendRes.status}` }));
      return;
    }
    res.writeHead(200);
    res.end(text);
  } catch (e) {
    res.writeHead(200);
    res.end(JSON.stringify({ version: null, downloadUrl: null, error: registerFailureMessage(e) }));
  } finally {
    clearTimeout(timer);
  }
}

const OLLAMA_URL = process.env.PULSE_OLLAMA_URL || "http://127.0.0.1:11434";
const OLLAMA_MODEL = process.env.PULSE_OLLAMA_MODEL || "";
const OLLAMA_CHAT_TIMEOUT_MS = 120000;

function supportDeviceBrief(data) {
  if (!data) return "Live telemetry is not available yet.";
  const cpu = data.cpu || {};
  const mem = data.memory || {};
  const drives = Array.isArray(data.storage) ? data.storage : [];
  const disks = Array.isArray(data.logicalDisks) ? data.logicalDisks : [];
  const gpus = Array.isArray(data.gpu) ? data.gpu : [];
  const battery = Array.isArray(data.battery) ? data.battery[0] : null;
  const wifi = data.wifi || {};
  const usedPct = mem.totalKB ? Math.round(((mem.usedKB || 0) / mem.totalKB) * 100) : null;
  const volumeLines = disks
    .filter((d) => d && d.Size > 0)
    .map((d) => {
      const freeGb = d.FreeSpace != null ? (d.FreeSpace / 1024 / 1024 / 1024).toFixed(1) : "—";
      const used = d.Size && d.FreeSpace != null ? Math.round(((d.Size - d.FreeSpace) / d.Size) * 100) : null;
      return `${d.DeviceID || "?"} ${d.DiskModel || ""} ${used != null ? `${used}% used` : ""} ${freeGb} GB free`.replace(/\s+/g, " ").trim();
    });
  const driveModels = drives.map((d) => d.Model).filter(Boolean).join(", ") || "—";
  const gpuNames = gpus.map((g) => g.Name).filter(Boolean).join(", ") || "—";
  return [
    `Hostname: ${os.hostname()}`,
    `Model: ${data.system?.Vendor || "—"} ${data.system?.Name || "—"}`.trim(),
    `OS: ${data.osDetail?.Caption || "—"}`,
    `CPU: ${cpu.Name || "—"} at ${cpu.LoadPercentage ?? "—"}% load`,
    `Memory: ${usedPct != null ? `${usedPct}% used` : "—"}`,
    `Disks: ${driveModels}`,
    `Volumes: ${volumeLines.length > 0 ? volumeLines.join("; ") : "—"}`,
    `GPU: ${gpuNames}`,
    `Battery: ${battery?.Name || "—"}, charge ${battery?.EstimatedChargeRemaining ?? "—"}%`,
    `Wi-Fi: ${wifi.state || "unknown"}${wifi.ssid ? ` SSID ${wifi.ssid}` : ""}`,
    `Address: ${data.localIp || "—"}`,
  ].join("\n");
}

async function pickOllamaModel() {
  if (OLLAMA_MODEL) return OLLAMA_MODEL;
  const res = await fetch(`${OLLAMA_URL}/api/tags`);
  if (!res.ok) throw new Error("ollama tags failed");
  const body = await res.json();
  const names = (body.models || []).map((m) => m.name);
  return (
    names.find((n) => n.startsWith("llama3.2")) ||
    names.find((n) => n.startsWith("llama3.1")) ||
    names.find((n) => n.startsWith("llama3")) ||
    names.find((n) => n.startsWith("phi")) ||
    names.find((n) => n.startsWith("gemma")) ||
    names.find((n) => n.startsWith("qwen")) ||
    names[0] ||
    null
  );
}

async function handleSupportChat(req, res) {
  try {
    const parsed = JSON.parse((await readRequestBody(req)) || "{}");
    const message = String(parsed.message || "").trim();
    const history = Array.isArray(parsed.history) ? parsed.history.slice(-12) : [];
    if (!message) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "message is required" }));
      return;
    }
    let model;
    try {
      model = await pickOllamaModel();
    } catch {
      res.writeHead(503);
      res.end(JSON.stringify({ error: "Ollama is not running on this PC. Open Ollama, then try again." }));
      return;
    }
    if (!model) {
      res.writeHead(503);
      res.end(JSON.stringify({ error: "Ollama is running but has no model. Run: ollama pull llama3.2" }));
      return;
    }
    const system = [
      "You are Casterly Support, the in-app assistant for Pulse Endpoint agent on this Windows PC.",
      "Answer using the live device facts below. If a fact is missing, say you do not have it — never invent hardware, serials, IPs, or alert history.",
      "Be concise and practical. You cannot remote-control the PC.",
      "",
      "Live device facts:",
      supportDeviceBrief(cache.data),
    ].join("\n");
    const messages = [
      { role: "system", content: system },
      ...history.map((m) => ({
        role: m.who === "Customer" ? "user" : "assistant",
        content: String(m.text || ""),
      })),
      { role: "user", content: message },
    ];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OLLAMA_CHAT_TIMEOUT_MS);
    let ollamaRes;
    try {
      ollamaRes = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, stream: false, messages }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!ollamaRes.ok) {
      const errText = await ollamaRes.text();
      res.writeHead(502);
      res.end(JSON.stringify({ error: errText || `Ollama HTTP ${ollamaRes.status}` }));
      return;
    }
    const body = await ollamaRes.json();
    const reply = (body.message && body.message.content ? String(body.message.content) : "").trim();
    if (!reply) {
      res.writeHead(502);
      res.end(JSON.stringify({ error: "Ollama returned an empty reply." }));
      return;
    }
    res.writeHead(200);
    res.end(JSON.stringify({ reply, model }));
  } catch (e) {
    const msg = e.name === "AbortError" ? "Ollama took too long to reply." : (e.message || "support chat failed");
    res.writeHead(503);
    res.end(JSON.stringify({ error: msg }));
  }
}

async function handleBackendUrlUpdate(req, res) {
  try {
    const parsed = JSON.parse((await readRequestBody(req)) || "{}");
    const next = normalizeBackendUrl(parsed.backendUrl);
    if (!next) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "backendUrl must be an http(s) URL, e.g. http://<command-center-ip>:8443" }));
      return;
    }
    BACKEND_URL = next;
    persistBackendUrl(next);
    if (!deviceCredentials) {
      lastRegisterError = null;
      deviceCredentials = await loadOrRegisterDevice();
    }
    res.writeHead(200);
    res.end(JSON.stringify(enrollmentPayload()));
  } catch (e) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: e.message || "failed to update backend URL" }));
  }
}

// Proxies real WebRTC signaling-session creation to the backend, using this device's own
// already-issued API key (the same Bearer credential heartbeat/entitlement already use) -
// the browser itself never sees or handles this key, the same convention every other backend
// call in this file already follows. There is no admin-JWT-acquisition flow anywhere in this
// project (no login UI exists in the frontend), so the device's own real credential is what
// "agent-authenticated" means here (see the backend's anyDeviceAuthMiddleware for the other
// half of this).
async function handleRemoteSessionCreate(req, res) {
  if (!deviceCredentials) {
    res.writeHead(503);
    res.end(JSON.stringify({
      error: "this device is not yet enrolled with the Cloud Command Center",
      backendUrl: BACKEND_URL,
      lastError: lastRegisterError,
    }));
    return;
  }
  try {
    // Real fix: this used to never read the incoming request body at all, silently dropping
    // whatever the frontend sent (e.g. mode: "screen"|"voice"|"chat") - the backend's own new
    // mode field would have gone through as empty every time regardless of what the customer
    // actually chose, defaulting silently to "screen" on the backend side. Tolerates an
    // empty/missing body gracefully (same as the backend does), for older frontend builds.
    let requestBody = "{}";
    try {
      if (req.method === "GET") {
        const u = new URL(req.url || "/", "http://127.0.0.1");
        const mode = u.searchParams.get("mode");
        if (mode) requestBody = JSON.stringify({ mode });
      } else {
        const raw = await readRequestBody(req);
        if (raw) requestBody = raw;
      }
    } catch {
      // fall through with the default empty body
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), BACKEND_REQUEST_TIMEOUT_MS);
    let backendRes;
    try {
      backendRes = await fetch(`${BACKEND_URL}/v1/remote-sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${deviceCredentials.apiKey}` },
        body: requestBody,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
    const body = await backendRes.text();
    res.writeHead(backendRes.status);
    res.end(body);
  } catch (err) {
    console.error("[telemetry] remote-session create proxy failed:", err.message);
    res.writeHead(502);
    res.end(JSON.stringify({ error: "backend unreachable" }));
  }
}

// PRD §30 Remote Assist hardening - proxies the device-authenticated POST .../remote-sessions/
// {id}/end (the real, instant Stop Sharing action - see backend/remote_session.go's own
// endImmediately/handleEndRemoteSessionAsDevice comments), same device-API-key-never-reaches-the-
// browser convention as handleRemoteSessionCreate above.
async function handleRemoteSessionEndProxy(sessionId, res) {
  if (!deviceCredentials) {
    res.writeHead(503);
    res.end(JSON.stringify({ error: "this device is not yet enrolled with the Cloud Command Center" }));
    return;
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), BACKEND_REQUEST_TIMEOUT_MS);
  try {
    const backendRes = await fetch(`${BACKEND_URL}/v1/remote-sessions/${encodeURIComponent(sessionId)}/end`, {
      method: "POST",
      headers: { Authorization: `Bearer ${deviceCredentials.apiKey}` },
      signal: controller.signal,
    });
    const body = await backendRes.text();
    res.writeHead(backendRes.status);
    res.end(body);
  } catch (err) {
    console.error("[telemetry] remote-session end proxy failed:", err.message);
    res.writeHead(502);
    res.end(JSON.stringify({ error: "backend unreachable" }));
  } finally {
    clearTimeout(timeoutId);
  }
}

// PRD §30 Remote Assist hardening - proxies the device-authenticated GET /v1/turn-credentials so
// the browser/webview (which never holds this device's real API key) can get real, time-limited
// TURN relay credentials without that key ever reaching it - same device-auth-proxy pattern as
// handleRemoteSessionCreate above. Always responds 200 with a real {configured: false} on
// any failure (not enrolled, backend unreachable, TURN not set up) rather than an error status -
// the client's real fallback is "use STUN only," never a hard failure.
async function handleTurnCredentialsProxy(res) {
  if (!deviceCredentials) {
    res.writeHead(200);
    res.end(JSON.stringify({ configured: false }));
    return;
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), BACKEND_REQUEST_TIMEOUT_MS);
  try {
    const backendRes = await fetch(`${BACKEND_URL}/v1/turn-credentials`, {
      headers: { Authorization: `Bearer ${deviceCredentials.apiKey}` },
      signal: controller.signal,
    });
    if (!backendRes.ok) {
      res.writeHead(200);
      res.end(JSON.stringify({ configured: false }));
      return;
    }
    res.writeHead(200);
    res.end(await backendRes.text());
  } catch (err) {
    console.error("[telemetry] turn-credentials proxy failed:", err.message);
    res.writeHead(200);
    res.end(JSON.stringify({ configured: false }));
  } finally {
    clearTimeout(timeoutId);
  }
}

// Real, durable event-append - POSTs to the backend using this device's own already-issued API
// key (same convention as every other backend call in this file). Used both for transitions
// this file detects directly (LHM/HWiNFO/backend reachability - see their own call sites below)
// and, via handleEventCreateProxy, for events the frontend reports (alert rule fire/clear,
// telemetry reconnection). A no-op (not an error) before enrollment - there's no device row yet
// to log an event under, and every other real feature in this file degrades the same way.
async function logEvent(eventType, message, severity = "info") {
  if (!deviceCredentials) return;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), BACKEND_REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${BACKEND_URL}/v1/devices/${deviceCredentials.id}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${deviceCredentials.apiKey}` },
        body: JSON.stringify({ eventType, message, severity }),
        signal: controller.signal,
      });
      if (!res.ok) console.error(`[telemetry] logEvent(${eventType}) failed: HTTP ${res.status}`);
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (err) {
    console.error(`[telemetry] logEvent(${eventType}) failed:`, err.message);
  }
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

// Proxies a frontend-reported event (alert rule fire/clear, telemetry reconnection - see
// useAlertEngine.ts/useTelemetry.ts) straight through to logEvent's own backend call, reusing
// the exact same request shape ({eventType, message, severity}) rather than a second one.
async function handleEventCreateProxy(req, res) {
  if (!deviceCredentials) {
    res.writeHead(503);
    res.end(JSON.stringify({ error: "this device is not yet enrolled with the Cloud Command Center" }));
    return;
  }
  try {
    const body = JSON.parse(await readRequestBody(req));
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), BACKEND_REQUEST_TIMEOUT_MS);
    let backendRes;
    try {
      backendRes = await fetch(`${BACKEND_URL}/v1/devices/${deviceCredentials.id}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${deviceCredentials.apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
    const responseBody = await backendRes.text();
    res.writeHead(backendRes.status);
    res.end(responseBody);
  } catch (err) {
    console.error("[telemetry] event create proxy failed:", err.message);
    res.writeHead(502);
    res.end(JSON.stringify({ error: "backend unreachable" }));
  }
}

// Proxies GET /v1/devices/{id}/events - a genuine 503 here (not enrolled/backend unreachable)
// is deliberately distinct from a real 200 with an empty array (this device really has no
// history yet), so the frontend can tell "couldn't check" apart from "genuinely nothing to show"
// rather than collapsing both into the same honest-looking empty state.
async function handleEventsListProxy(req, res) {
  if (!deviceCredentials) {
    res.writeHead(503);
    res.end(JSON.stringify({ error: "this device is not yet enrolled with the Cloud Command Center" }));
    return;
  }
  try {
    const requestUrl = new URL(req.url, "http://localhost");
    const limit = requestUrl.searchParams.get("limit") ?? "";
    const backendUrl = `${BACKEND_URL}/v1/devices/${deviceCredentials.id}/events${limit ? `?limit=${encodeURIComponent(limit)}` : ""}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), BACKEND_REQUEST_TIMEOUT_MS);
    let backendRes;
    try {
      backendRes = await fetch(backendUrl, {
        headers: { Authorization: `Bearer ${deviceCredentials.apiKey}` },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
    const responseBody = await backendRes.text();
    res.writeHead(backendRes.status);
    res.end(responseBody);
  } catch (err) {
    console.error("[telemetry] events list proxy failed:", err.message);
    res.writeHead(502);
    res.end(JSON.stringify({ error: "backend unreachable" }));
  }
}

// ─── PRD §9 Self-Healing & Automation - real v1 ────────────
// Real policy gate + 6 real, safe remediation actions, gated on the tenant's actual
// plan_features.Self-Healing row (backend/schema.sql) - currently false for this tenant's
// ProSupport plan (see that schema's own reasoning comment). Clear Teams cache confirmed real
// via direct investigation (new Teams/MSIX genuinely installed and running on this machine, real
// LocalCache path verified on disk) - runClearTeamsCache below still treats a device where Teams
// isn't installed as a real, reported failure, not an assumption every fleet device has it.
//
// Repair VPN (runRepairVpn) and Collect BSOD Diagnostics (runCollectBsodDiagnostics) are both
// built too now, but with a real, disclosed gap each - see their own comments below for why: no
// VPN exists anywhere in this fleet to verify the repair actually fixes anything, and no real
// crash/bugcheck has ever been recorded on this device to verify the detection actually finds
// something when one exists. Built as honest best-effort mechanisms using only built-in Windows
// APIs, not verified fixes/detections - the gap is disclosed in code, not hidden.
//
// Certificate renewal is the one action still deliberately NOT built: no PKI/SCEP infrastructure
// exists anywhere in this project, so there is genuinely no cert to renew against - this stays
// honestly unbuilt rather than faked.

// A fresh check on every remediation request, not a read of entitlementState (which only
// refreshes every BACKEND_POLL_INTERVAL_MS/60s) - a policy gate that could act on a stale
// cached value for up to a minute is a real correctness gap for something that gates real
// system changes, worth the extra request. Fails closed (false) on any error - if the policy
// can't be confirmed, the safe default is to refuse, not to assume permission.
async function isSelfHealingAllowed() {
  if (!deviceCredentials) return false;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), BACKEND_REQUEST_TIMEOUT_MS);
    let body;
    try {
      const res = await fetch(`${BACKEND_URL}/v1/devices/${deviceCredentials.id}/entitlement`, {
        headers: { Authorization: `Bearer ${deviceCredentials.apiKey}` },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      body = await res.json();
    } finally {
      clearTimeout(timeoutId);
    }
    const feature = (body.features || []).find((f) => f.feature === "Self-Healing");
    return feature?.included === true;
  } catch (err) {
    console.error("[telemetry] isSelfHealingAllowed check failed - failing closed (refused):", err.message);
    return false;
  }
}

function execPowerShellCommand(command, timeoutMs = 15000) {
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-Command", command], { maxBuffer: 10 * 1024 * 1024, timeout: timeoutMs }, (err, stdout, stderr) =>
      resolve({ err, stdout: stdout ?? "", stderr: stderr ?? "" }),
    );
  });
}

// DPAPI (Windows Data Protection API) via PowerShell's System.Security.Cryptography.ProtectedData -
// keeps local-agent's zero-native-dependency property (no npm crypto/DPAPI addon) by reusing
// execPowerShellCommand above, the same in-box-PowerShell-only mechanism already used for the
// Windows Update check below. System.Security is part of the in-box .NET Framework shipped with
// Windows PowerShell 5.1 on every current Windows install - Add-Type -AssemblyName System.Security
// loads an assembly already on disk, no install/module/internet access involved (confirmed live on
// this machine before writing this).
//
// LocalMachine scope, not CurrentUser - deliberate. The real PulseEndpointTelemetryServer
// scheduled task runs as the actual logged-on interactive user (confirmed via `schtasks /Query
// /V`: Run As User = the real Windows account, Logon Mode = Interactive only - NOT SYSTEM/a
// service account), which would make CurrentUser scope the "tighter" choice on paper. But
// CurrentUser-scope DPAPI ties the encryption key to that Windows account's profile master key,
// which an IT admin resetting the device's Windows password via AD/local tools (a realistic,
// even routine event on a fleet-managed device - as opposed to the user changing their own
// password while logged in) does NOT correctly re-wrap, permanently breaking decryption.
// LocalMachine scope survives that. The real threat this defends against is a plaintext API key
// being trivially scraped by anything with raw filesystem read access (malware, a misdirected
// backup, a support-ticket zip) - not cross-user isolation on this specific device - so
// LocalMachine's marginal looseness (another logged-in user on the same physical machine could
// also decrypt it) is an acceptable tradeoff for this deployment context.
//
// Binary DPAPI output can't safely cross execFile's stdout as raw bytes, so both directions
// base64-encode: protectCredentials's caller passes plaintext JSON in as a JS string (base64'd
// before embedding in the PowerShell command text), and gets back base64 of the protected bytes
// to write to disk; unprotectCredentials takes that base64 blob and returns base64 of the
// decrypted bytes, which the caller decodes to UTF-8 and JSON.parses.
const DPAPI_PROTECT_SCRIPT_TEMPLATE = `
try {
    Add-Type -AssemblyName System.Security
    $bytes = [Convert]::FromBase64String("__INPUT_B64__")
    $protected = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::LocalMachine)
    [PSCustomObject]@{ ok = $true; blob = [Convert]::ToBase64String($protected) } | ConvertTo-Json -Compress
} catch {
    [PSCustomObject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
}
`;

const DPAPI_UNPROTECT_SCRIPT_TEMPLATE = `
try {
    Add-Type -AssemblyName System.Security
    $bytes = [Convert]::FromBase64String("__INPUT_B64__")
    $unprotected = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::LocalMachine)
    [PSCustomObject]@{ ok = $true; blob = [Convert]::ToBase64String($unprotected) } | ConvertTo-Json -Compress
} catch {
    [PSCustomObject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
}
`;

async function protectCredentials(json) {
  const inputB64 = Buffer.from(json, "utf8").toString("base64");
  const script = DPAPI_PROTECT_SCRIPT_TEMPLATE.replace("__INPUT_B64__", inputB64);
  const { err, stdout, stderr } = await execPowerShellCommand(script);
  if (err) throw new Error(`DPAPI protect failed to run: ${err.message}${stderr ? ` (stderr: ${stderr})` : ""}`);
  let result;
  try {
    result = JSON.parse(stdout);
  } catch {
    throw new Error(`DPAPI protect returned unparseable output: ${stdout}`);
  }
  if (!result.ok) throw new Error(`DPAPI protect failed: ${result.error}`);
  return result.blob;
}

async function unprotectCredentials(blobB64) {
  const script = DPAPI_UNPROTECT_SCRIPT_TEMPLATE.replace("__INPUT_B64__", blobB64.trim());
  const { err, stdout, stderr } = await execPowerShellCommand(script);
  if (err) throw new Error(`DPAPI unprotect failed to run: ${err.message}${stderr ? ` (stderr: ${stderr})` : ""}`);
  let result;
  try {
    result = JSON.parse(stdout);
  } catch {
    throw new Error(`DPAPI unprotect returned unparseable output: ${stdout}`);
  }
  if (!result.ok) throw new Error(`DPAPI unprotect failed: ${result.error}`);
  return Buffer.from(result.blob, "base64").toString("utf8");
}

// Real Windows Update Agent search via the same COM object Windows' own Settings > Windows
// Update page uses internally (Microsoft.Update.Session -> CreateUpdateSearcher -> Search) -
// Type='Software' specifically (not drivers - those belong to Hardware page's own driver card,
// a separate real concern), matching exactly how a user would check "is this PC up to date"
// themselves. ResultCode is Windows Update's own OperationResultCode enum - 2 is orcSucceeded,
// the only value this treats as a genuinely completed search; anything else (a partial failure,
// an aborted search) is treated the same as a thrown error below, since a non-2 result code means
// the update count it returned can't be trusted as complete.
const WINDOWS_UPDATE_SEARCH_SCRIPT = `
try {
    $session = New-Object -ComObject Microsoft.Update.Session
    $searcher = $session.CreateUpdateSearcher()
    $result = $searcher.Search("IsInstalled=0 and Type='Software'")
    if ($result.ResultCode -ne 2) {
        [PSCustomObject]@{ ok = $false; error = "search completed with non-success ResultCode $($result.ResultCode)" } | ConvertTo-Json -Compress
    } else {
        [PSCustomObject]@{ ok = $true; pendingCount = $result.Updates.Count } | ConvertTo-Json -Compress
    }
} catch {
    [PSCustomObject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
}
`;

// Measured directly on this machine at ~17s for a real search - 120s comfortably covers a
// slower/cold-WUA-cache run without this ever being mistaken for a hang given how infrequently
// it's actually called (WINDOWS_UPDATE_CHECK_INTERVAL_MS, once an hour).
async function runWindowsUpdateCheck() {
  const { err, stdout, stderr } = await execPowerShellCommand(WINDOWS_UPDATE_SEARCH_SCRIPT, 120000);
  if (err) {
    console.error("[telemetry] Windows Update check failed to run:", err.message);
    if (stderr) console.error("[telemetry]   stderr:", stderr.toString());
    return null;
  }
  try {
    const parsed = JSON.parse(stdout);
    if (!parsed.ok) {
      console.error("[telemetry] Windows Update check completed but reported failure:", parsed.error);
      return null;
    }
    return { upToDate: parsed.pendingCount === 0, pendingCount: parsed.pendingCount, checkedAt: new Date().toISOString() };
  } catch (e) {
    console.error("[telemetry] Windows Update check produced unparseable output:", e.message, "raw:", stdout);
    return null;
  }
}

// Same Windows Update Agent search mechanism as WINDOWS_UPDATE_SEARCH_SCRIPT above, but
// Type='Driver' (drivers/firmware, not software updates), filtered to entries whose DriverClass
// is "Firmware" AND whose DriverModel starts with "System Firmware" - confirmed directly on this
// real machine that this is exactly how Dell publishes BIOS/platform firmware updates through
// Windows Update (DriverModel "System Firmware 1.42.0", DriverHardwareID "uefi\res_{...}" - the
// standard UEFI ESRT capsule-update identifier for the machine's own system firmware). The
// DriverModel prefix check matters: DriverClass='Firmware' alone isn't specific enough to mean
// "this is the BIOS" - a peripheral (SSD, webcam, touchpad) could genuinely report its own
// firmware update the same way, and this app has no basis to claim THAT is a BIOS update.
const BIOS_FIRMWARE_UPDATE_SEARCH_SCRIPT = `
try {
    $session = New-Object -ComObject Microsoft.Update.Session
    $searcher = $session.CreateUpdateSearcher()
    $result = $searcher.Search("IsInstalled=0 and Type='Driver'")
    if ($result.ResultCode -ne 2) {
        [PSCustomObject]@{ ok = $false; error = "search completed with non-success ResultCode $($result.ResultCode)" } | ConvertTo-Json -Compress
    } else {
        $firmwareModels = @()
        for ($i = 0; $i -lt $result.Updates.Count; $i++) {
            $u = $result.Updates.Item($i)
            if ($u.DriverClass -eq "Firmware" -and $u.DriverModel -like "System Firmware*") {
                $firmwareModels += $u.DriverModel
            }
        }
        [PSCustomObject]@{ ok = $true; pendingCount = $firmwareModels.Count; latestModel = if ($firmwareModels.Count -gt 0) { $firmwareModels[0] } else { $null } } | ConvertTo-Json -Compress
    }
} catch {
    [PSCustomObject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
}
`;

async function runBiosFirmwareUpdateCheck() {
  const { err, stdout, stderr } = await execPowerShellCommand(BIOS_FIRMWARE_UPDATE_SEARCH_SCRIPT, 120000);
  if (err) {
    console.error("[telemetry] BIOS firmware update check failed to run:", err.message);
    if (stderr) console.error("[telemetry]   stderr:", stderr.toString());
    return null;
  }
  try {
    const parsed = JSON.parse(stdout);
    if (!parsed.ok) {
      console.error("[telemetry] BIOS firmware update check completed but reported failure:", parsed.error);
      return null;
    }
    return {
      updateAvailable: parsed.pendingCount > 0,
      latestVersion: parsed.latestModel ? parsed.latestModel.replace(/^System Firmware\s*/, "") : null,
      checkedAt: new Date().toISOString(),
    };
  } catch (e) {
    console.error("[telemetry] BIOS firmware update check produced unparseable output:", e.message, "raw:", stdout);
    return null;
  }
}

// Real `dsregcmd /status` output, regex-parsed - there is no JSON output mode, so this reads the
// same colon-separated text table a human would (confirmed directly against a real run on this
// machine: "AzureAdJoined : NO", "WorkplaceJoined : YES", "WorkplaceTenantName : Casterly Private
// Limited", "WorkplaceMdmUrl : " (blank = not MDM-enrolled)). Get-Field anchors each match to the
// start of the line (after whitespace) so e.g. "WorkplaceMdmUrl" can never falsely match a lookup
// for bare "MdmUrl" - the two are genuinely different fields (device-level vs. work-account-level
// MDM enrollment), and this app has no basis to claim one when it only has evidence of the other.
const DSREGCMD_STATUS_SCRIPT = `
try {
    $lines = & dsregcmd /status 2>&1
    function Get-Field($name) {
        $line = $lines | Where-Object { $_ -match "^\\s*$name\\s*:" } | Select-Object -First 1
        if ($line -and $line -match ':\\s*(.*)$') { return $matches[1].Trim() }
        return $null
    }
    $azureAdJoined = (Get-Field 'AzureAdJoined') -eq "YES"
    $domainJoined = (Get-Field 'DomainJoined') -eq "YES"
    $enterpriseJoined = (Get-Field 'EnterpriseJoined') -eq "YES"
    $workplaceJoined = (Get-Field 'WorkplaceJoined') -eq "YES"
    $deviceMdmUrl = Get-Field 'MdmUrl'
    $workplaceMdmUrl = Get-Field 'WorkplaceMdmUrl'
    $mdmUrl = if (-not [string]::IsNullOrWhiteSpace($deviceMdmUrl)) { $deviceMdmUrl } elseif (-not [string]::IsNullOrWhiteSpace($workplaceMdmUrl)) { $workplaceMdmUrl } else { $null }
    $deviceTenantName = Get-Field 'TenantName'
    $workplaceTenantName = Get-Field 'WorkplaceTenantName'
    $tenantName = if (-not [string]::IsNullOrWhiteSpace($deviceTenantName)) { $deviceTenantName } elseif (-not [string]::IsNullOrWhiteSpace($workplaceTenantName)) { $workplaceTenantName } else { $null }
    [PSCustomObject]@{
        ok = $true
        azureAdJoined = $azureAdJoined
        domainJoined = $domainJoined
        enterpriseJoined = $enterpriseJoined
        workplaceJoined = $workplaceJoined
        mdmEnrolled = -not [string]::IsNullOrWhiteSpace($mdmUrl)
        tenantName = $tenantName
    } | ConvertTo-Json -Compress
} catch {
    [PSCustomObject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
}
`;

// dsregcmd is a fast local-only call (no network, no WUA) - confirmed directly on this machine at
// well under a second - so 20s is generous headroom, not a measured worst case like the WUA
// searches above.
async function runDomainMdmCheck() {
  const { err, stdout, stderr } = await execPowerShellCommand(DSREGCMD_STATUS_SCRIPT, 20000);
  if (err) {
    console.error("[telemetry] domain/MDM status check failed to run:", err.message);
    if (stderr) console.error("[telemetry]   stderr:", stderr.toString());
    return null;
  }
  try {
    const parsed = JSON.parse(stdout);
    if (!parsed.ok) {
      console.error("[telemetry] domain/MDM status check completed but reported failure:", parsed.error);
      return null;
    }
    return {
      azureAdJoined: !!parsed.azureAdJoined,
      domainJoined: !!parsed.domainJoined,
      enterpriseJoined: !!parsed.enterpriseJoined,
      workplaceJoined: !!parsed.workplaceJoined,
      mdmEnrolled: !!parsed.mdmEnrolled,
      tenantName: parsed.tenantName || null,
      checkedAt: new Date().toISOString(),
    };
  } catch (e) {
    console.error("[telemetry] domain/MDM status check produced unparseable output:", e.message, "raw:", stdout);
    return null;
  }
}

// SoftwareLicensingProduct, filtered to Windows itself (ApplicationID is the well-known,
// Microsoft-documented GUID for the Windows OS product - excludes Office/other products that
// also register in this same WMI class). Confirmed live on this real machine: this filter alone
// still returns 61 rows - almost all decoy placeholder SKUs (every edition/channel combination
// the licensing service merely knows about, LicenseStatus=0, blank PartialProductKey)
// representing nothing actually installed. Only ONE row is real, and PartialProductKey
// (non-empty only on that real row) is the reliable way to find it - the same signal
// slmgr.vbs /dli itself uses internally, not invented for this task. Falls back to any row with
// LicenseStatus -ne 0 if none has a key - unverified on this machine (it IS licensed), a
// reasonable but untested guess for a genuinely unlicensed/grace-period device. LicenseStatus
// itself (unlike SecurityCenter2's undocumented productState) is a small, Microsoft-documented
// enum - decoded downstream, not here.
const WINDOWS_LICENSE_STATUS_SCRIPT = `
try {
    $licenseProducts = Get-CimInstance SoftwareLicensingProduct -Filter "ApplicationID='55c92734-d682-4d71-983e-d6ec3f16059f'" -ErrorAction Stop
    $realLicense = $licenseProducts | Where-Object { $_.PartialProductKey } | Select-Object -First 1
    if (-not $realLicense) {
        $realLicense = $licenseProducts | Where-Object { $_.LicenseStatus -ne 0 } | Select-Object -First 1
    }
    if ($realLicense) {
        [PSCustomObject]@{
            ok = $true
            licenseStatus = [int]$realLicense.LicenseStatus
            licenseFamily = $realLicense.LicenseFamily
            productKeyChannel = $realLicense.ProductKeyChannel
        } | ConvertTo-Json -Compress
    } else {
        [PSCustomObject]@{ ok = $false; error = "no real license row found among $($licenseProducts.Count) SoftwareLicensingProduct rows" } | ConvertTo-Json -Compress
    }
} catch {
    [PSCustomObject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
}
`;

// Measured directly on this machine at ~42s for the real query (WMI enumerating ~60 rows before
// this script's own filter narrows it down) - 60s covers that comfortably without this ever
// being mistaken for a hang, given how infrequently it's actually called (hourly).
async function runWindowsLicenseCheck() {
  const { err, stdout, stderr } = await execPowerShellCommand(WINDOWS_LICENSE_STATUS_SCRIPT, 60000);
  if (err) {
    console.error("[telemetry] Windows license check failed to run:", err.message);
    if (stderr) console.error("[telemetry]   stderr:", stderr.toString());
    return null;
  }
  try {
    const parsed = JSON.parse(stdout);
    if (!parsed.ok) {
      console.error("[telemetry] Windows license check completed but reported failure:", parsed.error);
      return null;
    }
    return {
      licenseStatus: parsed.licenseStatus,
      licenseFamily: parsed.licenseFamily || null,
      productKeyChannel: parsed.productKeyChannel || null,
      checkedAt: new Date().toISOString(),
    };
  } catch (e) {
    console.error("[telemetry] Windows license check produced unparseable output:", e.message, "raw:", stdout);
    return null;
  }
}

// Win32_PnPSignedDriver + the exact Select-PnpDriverVersion logic get-telemetry.ps1 used to run
// every 5s - moved here verbatim, just on the hourly cadence. See DRIVER_VERSIONS_SCRIPT's own
// module-level state var comment for why (profiled at ~5.5-5.9s, structurally slow regardless of
// filtering).
const PNP_DRIVER_VERSIONS_SCRIPT = `
try {
    $pnpDrivers = @(Get-CimInstance Win32_PnPSignedDriver -ErrorAction Stop |
        Select-Object DeviceName, DeviceClass, Manufacturer, DriverVersion, DriverDate)

    function Select-PnpDriverVersion($drivers, [scriptblock]$matchPredicate) {
        $match = $drivers | Where-Object $matchPredicate | Select-Object -First 1
        if (-not $match) { return $null }
        $dateVal = $null
        if ($match.DriverDate -and $match.DriverDate.Year -ge 1990) {
            $dateVal = $match.DriverDate.ToString("o")
        }
        return [ordered]@{ deviceName = $match.DeviceName; version = $match.DriverVersion; date = $dateVal }
    }

    $driverVersions = [ordered]@{
        chipset   = Select-PnpDriverVersion $pnpDrivers { $_.DeviceName -match "SMBus|LPC Controller" -and $_.Manufacturer -eq "INTEL" }
        intelMe   = Select-PnpDriverVersion $pnpDrivers { $_.DeviceName -match "Management Engine Interface" }
        wifi      = Select-PnpDriverVersion $pnpDrivers { $_.DeviceClass -eq "NET" -and $_.DeviceName -match "Wi-Fi" -and $_.DeviceName -notmatch "Direct" }
        audio     = Select-PnpDriverVersion $pnpDrivers { $_.DeviceClass -eq "MEDIA" -and $_.DeviceName -match "^(Realtek Audio|.*High Definition Audio.*)$" }
        bluetooth = Select-PnpDriverVersion $pnpDrivers { $_.DeviceClass -eq "BLUETOOTH" -and $_.DeviceName -match "Wireless Bluetooth" }
    }
    [PSCustomObject]@{ ok = $true; driverVersions = $driverVersions } | ConvertTo-Json -Compress -Depth 5
} catch {
    [PSCustomObject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
}
`;

// Measured directly at ~5.5-5.9s - 20s is generous headroom for an hourly call, not a tight ceiling.
async function runDriverVersionsCheck() {
  const { err, stdout, stderr } = await execPowerShellCommand(PNP_DRIVER_VERSIONS_SCRIPT, 20000);
  if (err) {
    console.error("[telemetry] driver versions check failed to run:", err.message);
    if (stderr) console.error("[telemetry]   stderr:", stderr.toString());
    return null;
  }
  try {
    const parsed = JSON.parse(stdout);
    if (!parsed.ok) {
      console.error("[telemetry] driver versions check completed but reported failure:", parsed.error);
      return null;
    }
    return parsed.driverVersions ?? null;
  } catch (e) {
    console.error("[telemetry] driver versions check produced unparseable output:", e.message, "raw:", stdout);
    return null;
  }
}

// Win32_PnPEntity Biometric-class presence check, moved off the 5s hot path (~0.75-0.83s measured)
// for the same "static hardware fact" reasoning as driver versions above.
const FINGERPRINT_SENSOR_SCRIPT = `
try {
    $fingerprintDevice = Get-CimInstance Win32_PnPEntity -Filter "PNPClass='Biometric'" -ErrorAction Stop |
        Where-Object { $_.Name -match "Fingerprint" } |
        Select-Object -First 1
    $present = [bool]($fingerprintDevice -and $fingerprintDevice.Present)
    [PSCustomObject]@{ ok = $true; present = $present } | ConvertTo-Json -Compress
} catch {
    [PSCustomObject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
}
`;

async function runFingerprintSensorCheck() {
  const { err, stdout, stderr } = await execPowerShellCommand(FINGERPRINT_SENSOR_SCRIPT, 20000);
  if (err) {
    console.error("[telemetry] fingerprint sensor check failed to run:", err.message);
    if (stderr) console.error("[telemetry]   stderr:", stderr.toString());
    return null;
  }
  try {
    const parsed = JSON.parse(stdout);
    if (!parsed.ok) {
      console.error("[telemetry] fingerprint sensor check completed but reported failure:", parsed.error);
      return null;
    }
    return { present: !!parsed.present, checkedAt: new Date().toISOString() };
  } catch (e) {
    console.error("[telemetry] fingerprint sensor check produced unparseable output:", e.message, "raw:", stdout);
    return null;
  }
}

// TPM + BitLocker, bundled into one script since both were previously run every 5s together and
// both are a FALLBACK only now - rust-collector already independently supplies both via its own
// separate, already-elevated read every cycle (see mergeRustData and this check's own
// module-level state var comment for the full reasoning). Each profiled at ~5s on this real
// machine (non-elevated).
const TPM_BITLOCKER_FALLBACK_SCRIPT = `
try {
    $tpm = $null
    try {
        $tpm = Get-CimInstance -Namespace "root/cimv2/Security/MicrosoftTpm" -ClassName Win32_Tpm -ErrorAction Stop |
            Select-Object ManufacturerIdTxt, ManufacturerVersion, SpecVersion, IsActivated_InitialValue, IsEnabled_InitialValue
    } catch {
        $tpm = $null
    }
    $bitlockerStatus = $null
    try {
        $volume = Get-BitLockerVolume -MountPoint $env:SystemDrive -ErrorAction Stop
        $bitlockerStatus = $volume.ProtectionStatus.ToString()
    } catch {
        $bitlockerStatus = $null
    }
    [PSCustomObject]@{ ok = $true; tpm = $tpm; bitlockerStatus = $bitlockerStatus } | ConvertTo-Json -Compress -Depth 4
} catch {
    [PSCustomObject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
}
`;

// 20s covers either query individually failing slowly (~5s each measured) with generous margin -
// this is a fallback path, not relied upon every cycle, so there's no tight budget to hit.
async function runTpmBitlockerFallbackCheck() {
  const { err, stdout, stderr } = await execPowerShellCommand(TPM_BITLOCKER_FALLBACK_SCRIPT, 20000);
  if (err) {
    console.error("[telemetry] TPM/BitLocker fallback check failed to run:", err.message);
    if (stderr) console.error("[telemetry]   stderr:", stderr.toString());
    return null;
  }
  try {
    const parsed = JSON.parse(stdout);
    if (!parsed.ok) {
      console.error("[telemetry] TPM/BitLocker fallback check completed but reported failure:", parsed.error);
      return null;
    }
    return {
      tpm: parsed.tpm ?? null,
      bitlockerStatus: parsed.bitlockerStatus ?? null,
      checkedAt: new Date().toISOString(),
    };
  } catch (e) {
    console.error("[telemetry] TPM/BitLocker fallback check produced unparseable output:", e.message, "raw:", stdout);
    return null;
  }
}

// Per-volume Get-Partition/Get-Disk model/serial enrichment, moved off the 5s hot path (~1.3-2.2s
// combined with the LogicalDisk query itself) - static hardware facts overlaid onto the fast-path
// logicalDisks array by drive letter in collect() (see its own merge comment).
const DISK_ENRICHMENT_SCRIPT = `
try {
    $entries = @(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" -ErrorAction Stop | ForEach-Object {
        $vol = $_
        $letter = $null
        if ($vol.DeviceID -match '^([A-Za-z]):') { $letter = $Matches[1] }
        if (-not $letter) { return }
        $diskModel = $null
        $diskSerial = $null
        try {
            $part = Get-Partition -DriveLetter $letter -ErrorAction Stop | Select-Object -First 1
            if ($null -ne $part) {
                $pd = Get-Disk -Number $part.DiskNumber -ErrorAction Stop
                if ($pd) {
                    $diskModel = $pd.FriendlyName
                    $diskSerial = $pd.SerialNumber
                }
            }
        } catch {}
        [ordered]@{ letter = $letter; diskModel = $diskModel; diskSerial = $diskSerial }
    })
    [PSCustomObject]@{ ok = $true; volumes = $entries } | ConvertTo-Json -Compress -Depth 4
} catch {
    [PSCustomObject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
}
`;

async function runDiskEnrichmentCheck() {
  const { err, stdout, stderr } = await execPowerShellCommand(DISK_ENRICHMENT_SCRIPT, 20000);
  if (err) {
    console.error("[telemetry] disk enrichment check failed to run:", err.message);
    if (stderr) console.error("[telemetry]   stderr:", stderr.toString());
    return null;
  }
  try {
    const parsed = JSON.parse(stdout);
    if (!parsed.ok) {
      console.error("[telemetry] disk enrichment check completed but reported failure:", parsed.error);
      return null;
    }
    // Select-Object/ConvertTo-Json can collapse a single-element array property the same way the
    // well-established top-level $net/$disks/$avProducts gotcha does - defensively re-wrap here too.
    if (Array.isArray(parsed.volumes)) return parsed.volumes;
    return parsed.volumes ? [parsed.volumes] : [];
  } catch (e) {
    console.error("[telemetry] disk enrichment check produced unparseable output:", e.message, "raw:", stdout);
    return null;
  }
}

// Real ipconfig /flushdns - success is read from its actual output text ("Successfully flushed
// the DNS Resolver Cache."), confirmed directly against a real run on this machine, not assumed
// from a zero exit code alone (ipconfig can exit 0 while still printing a failure message).
async function runFlushDns() {
  const { err, stdout, stderr } = await execPowerShellCommand("ipconfig /flushdns");
  const output = stdout.trim();
  const succeeded = !err && /successfully flushed/i.test(output);
  return {
    succeeded,
    detail: succeeded
      ? output.split("\n").pop().trim()
      : `ipconfig /flushdns did not report success (stdout="${output}" stderr="${stderr.trim()}" err=${err?.message ?? "none"}).`,
  };
}

// Real deletion of files directly in $env:TEMP - deliberately NOT recursive into
// subdirectories (a real, meaningful safety boundary here, not just a simplification: this
// machine's own working directories for other tools live nested under $env:TEMP, e.g.
// ...\Temp\claude\<session>\scratchpad\ - confirmed directly via Test-Path that a non-recursive
// Get-ChildItem -File never reaches them). Each file is deleted independently inside its own
// try/catch so one locked/in-use file (expected, not an error - confirmed several genuinely
// in-use files with very recent LastWriteTime exist in this exact directory right now) doesn't
// abort the rest. Real counts/bytes only - no estimate.
const TEMP_CLEANUP_SCRIPT = `
$files = Get-ChildItem -Path $env:TEMP -File -ErrorAction SilentlyContinue
$deletedCount = 0
$skippedCount = 0
$freedBytes = 0
foreach ($f in $files) {
  try {
    $size = $f.Length
    Remove-Item -LiteralPath $f.FullName -Force -ErrorAction Stop
    $deletedCount++
    $freedBytes += $size
  } catch {
    $skippedCount++
  }
}
[PSCustomObject]@{ deletedCount = $deletedCount; skippedCount = $skippedCount; freedBytes = $freedBytes; targetDir = $env:TEMP } | ConvertTo-Json -Compress
`;

async function runCleanTemp() {
  const { err, stdout, stderr } = await execPowerShellCommand(TEMP_CLEANUP_SCRIPT, 30000);
  if (err) return { succeeded: false, detail: `Temp cleanup script failed to run: ${err.message} (stderr="${stderr.trim()}").` };
  try {
    const result = JSON.parse(stdout.trim());
    const freedMb = (result.freedBytes / (1024 * 1024)).toFixed(1);
    return {
      succeeded: true,
      detail: `Deleted ${result.deletedCount} file(s) from ${result.targetDir}, freed ${freedMb} MB. Skipped ${result.skippedCount} locked/in-use file(s).`,
    };
  } catch {
    return { succeeded: false, detail: `Temp cleanup script produced unparseable output: "${stdout.trim()}".` };
  }
}

// Print Spooler - chosen specifically because it's safe to restart on a dev machine and has no
// relationship whatsoever to this project's own processes (telemetry-server.mjs, command-center,
// the frontend dev server, LibreHardwareMonitor) or to this remote session's own connectivity,
// unlike e.g. a network-stack-adjacent service. Confirmed directly that restarting it requires
// elevation (fails from a non-elevated session) - this process already runs elevated (see
// main.go's own RL HIGHEST reasoning for why), so this is a real, not a new, elevation need.
const SAFE_SERVICE_NAME = "Spooler";

async function runRestartService() {
  const { err, stdout, stderr } = await execPowerShellCommand(
    `Restart-Service -Name ${SAFE_SERVICE_NAME} -Force; (Get-Service -Name ${SAFE_SERVICE_NAME}).Status.ToString()`,
  );
  // Real bug found via independent verification (Get-Service + spoolsv.exe PID check before/
  // after, per this task's own instruction not to just trust this code's return value):
  // Restart-Service prints its own progress text ("WARNING: Waiting for service ... to
  // start...") into the SAME stdout stream as the final status line, not cleanly separated into
  // stderr - so comparing the whole trimmed stdout for equality against "Running" failed a
  // restart that had genuinely already succeeded (confirmed independently: Status was Running,
  // and spoolsv.exe's PID had changed, proving a real stop+start happened). The real status is
  // always the LAST non-empty line, since that's the one line this command emits after the
  // service call actually resolves.
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const statusAfter = lines[lines.length - 1] ?? "";
  const succeeded = !err && statusAfter === "Running";
  return {
    succeeded,
    detail: succeeded
      ? `${SAFE_SERVICE_NAME} (Print Spooler) service restarted successfully - status: ${statusAfter}.`
      : `${SAFE_SERVICE_NAME} restart did not confirm a Running status afterward (got "${statusAfter}", stderr="${stderr.trim()}", err=${err?.message ?? "none"}).`,
  };
}

// New Teams (MSIX) - confirmed via direct investigation to be what's actually installed here
// (classic Teams' %APPDATA%\Microsoft\Teams does not exist on this machine). The real per-user
// cache lives under the package's own LocalCache, not AppData\Roaming the way classic Teams' did -
// confirmed directly via Get-ChildItem that this exact path has real content on disk before
// writing this. Processes are stopped first (Stop-Process, not just deleting into a live cache -
// files are locked while Teams runs, the same reason runRestartService above has to check status
// after its own restart rather than assume). Deletion is per-file with its own try/catch, same
// pattern as TEMP_CLEANUP_SCRIPT above and for the same reason: a locked/in-use file mid-cleanup
// is expected, not an error, and shouldn't abort the rest of a real count.
const TEAMS_CACHE_CLEAR_SCRIPT = `
$procs = Get-Process -Name "ms-teams*" -ErrorAction SilentlyContinue
$stoppedCount = ($procs | Measure-Object).Count
if ($procs) {
  $procs | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 1500
}
$cacheDir = "$env:LOCALAPPDATA\\Packages\\MSTeams_8wekyb3d8bbwe\\LocalCache"
if (-not (Test-Path $cacheDir)) {
  [PSCustomObject]@{ installed = $false; stoppedCount = $stoppedCount; deletedCount = 0; skippedCount = 0; freedBytes = 0; targetDir = $cacheDir } | ConvertTo-Json -Compress
} else {
  $files = Get-ChildItem -Path $cacheDir -Recurse -File -Force -ErrorAction SilentlyContinue
  $deletedCount = 0
  $skippedCount = 0
  $freedBytes = 0
  foreach ($f in $files) {
    try {
      $size = $f.Length
      Remove-Item -LiteralPath $f.FullName -Force -ErrorAction Stop
      $deletedCount++
      $freedBytes += $size
    } catch {
      $skippedCount++
    }
  }
  [PSCustomObject]@{ installed = $true; stoppedCount = $stoppedCount; deletedCount = $deletedCount; skippedCount = $skippedCount; freedBytes = $freedBytes; targetDir = $cacheDir } | ConvertTo-Json -Compress
}
`;

async function runClearTeamsCache() {
  const { err, stdout, stderr } = await execPowerShellCommand(TEAMS_CACHE_CLEAR_SCRIPT, 30000);
  if (err) return { succeeded: false, detail: `Teams cache clear script failed to run: ${err.message} (stderr="${stderr.trim()}").` };
  try {
    const result = JSON.parse(stdout.trim());
    if (!result.installed) {
      return { succeeded: false, detail: `Teams is not installed on this device (checked ${result.targetDir}) - nothing to clear.` };
    }
    const freedMb = (result.freedBytes / (1024 * 1024)).toFixed(1);
    return {
      succeeded: true,
      detail: `Stopped ${result.stoppedCount} Teams process(es), deleted ${result.deletedCount} cache file(s) from ${result.targetDir}, freed ${freedMb} MB. Skipped ${result.skippedCount} locked/in-use file(s).`,
    };
  } catch {
    return { succeeded: false, detail: `Teams cache clear script produced unparseable output: "${stdout.trim()}".` };
  }
}

// Generic Windows VPN repair using only built-in APIs - no VPN-product-specific logic, since no
// VPN of any kind (built-in or 3rd-party) exists anywhere in this fleet to target one against
// (confirmed via direct investigation: no Get-VpnConnection entries, no rasphone.pbk, no known
// 3rd-party VPN client installed or running). Three real, standard Windows troubleshooting steps,
// each tolerant of the others failing: restart RasMan (the service that owns every VPN/dial-up
// connection), reset each WAN Miniport virtual adapter (a real, reversible PnP disable/enable
// cycle - doesn't touch stored connection profiles, just forces Windows to reinitialize the
// adapter), and re-register the two RAS client DLLs real Windows VPN troubleshooting guides most
// consistently cite (rasapi32.dll, rasman.dll).
//
// THIS HAS NEVER BEEN TESTED AGAINST A REAL BROKEN OR WORKING VPN CONNECTION, because none exists
// in this fleet to test against - ships as a best-effort mechanism built from real, standard
// Windows repair steps, not a verified fix. succeeded reflects only the one directly-checkable
// real signal available (did RasMan end up Running) - the miniport/DLL steps are real and
// attempted, but there is no real "did this fix a VPN" signal to check them against, so their
// counts are reported in detail only, not folded into pass/fail.
const VPN_REPAIR_SCRIPT = `
$rasmanStatus = "Unknown"
try {
  Restart-Service -Name RasMan -Force -ErrorAction Stop
  Start-Sleep -Milliseconds 500
  $rasmanStatus = (Get-Service -Name RasMan).Status.ToString()
} catch {
  $rasmanStatus = "RestartFailed"
}

$miniports = Get-PnpDevice -Class Net -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -like "WAN Miniport*" }
$miniportTotal = ($miniports | Measure-Object).Count
$miniportReset = 0
foreach ($m in $miniports) {
  try {
    Disable-PnpDevice -InstanceId $m.InstanceId -Confirm:$false -ErrorAction Stop
    Start-Sleep -Milliseconds 300
    Enable-PnpDevice -InstanceId $m.InstanceId -Confirm:$false -ErrorAction Stop
    $miniportReset++
  } catch {
  }
}

$dllNames = @("rasapi32.dll", "rasman.dll")
$dllResults = @()
foreach ($dll in $dllNames) {
  $proc = Start-Process -FilePath "regsvr32.exe" -ArgumentList "/s", $dll -PassThru -Wait -WindowStyle Hidden
  $dllResults += [PSCustomObject]@{ name = $dll; exitCode = $proc.ExitCode }
}

[PSCustomObject]@{ rasmanStatus = $rasmanStatus; miniportTotal = $miniportTotal; miniportReset = $miniportReset; dllResults = $dllResults } | ConvertTo-Json -Compress -Depth 4
`;

async function runRepairVpn() {
  const { err, stdout, stderr } = await execPowerShellCommand(VPN_REPAIR_SCRIPT, 30000);
  if (err) return { succeeded: false, detail: `VPN repair script failed to run: ${err.message} (stderr="${stderr.trim()}").` };
  try {
    const result = JSON.parse(stdout.trim());
    const dllOkCount = result.dllResults.filter((d) => d.exitCode === 0).length;
    const succeeded = result.rasmanStatus === "Running";
    return {
      succeeded,
      detail: `RasMan service: ${result.rasmanStatus}. WAN Miniport adapters reset: ${result.miniportReset}/${result.miniportTotal}. RAS DLLs re-registered: ${dllOkCount}/${result.dllResults.length}. Best-effort repair - never verified against a real VPN connection (none exists in this fleet).`,
    };
  } catch {
    return { succeeded: false, detail: `VPN repair script produced unparseable output: "${stdout.trim()}".` };
  }
}

// Detection only, deliberately - collects whatever real crash evidence already exists on this
// device rather than triggering anything. Checks the same real, in-box mechanisms confirmed via
// direct investigation: WER's LocalDumps registry config, %LOCALAPPDATA%\CrashDumps,
// C:\Windows\Minidump, C:\Windows\MEMORY.DMP, and the real Microsoft-Windows-WER-SystemErrorReporting
// event provider Windows itself uses specifically for kernel bugchecks (distinct from the general
// Windows Error Reporting provider every ordinary application crash also uses - checked separately
// so an unrelated app-crash report, e.g. this exact device's own real Windows Update Store Agent
// failures, is never mistaken for a BSOD).
//
// THIS HAS NEVER FIRED AGAINST A REAL CRASH ON THIS FLEET - confirmed directly that this device
// has no minidump, no CrashDumps file, no MEMORY.DMP, and no BugCheck event; the closest real
// signal found was one Kernel-Power dirty-shutdown event (Event ID 41) with no accompanying
// bugcheck record, which isn't itself confirmed evidence of a BSOD. succeeded reflects only
// whether the check itself ran, not whether a crash was found - "no crash record found" is a real,
// honest, and (on this device today) accurate result, not a failure.
const BSOD_DIAGNOSTIC_SCRIPT = `
$minidumpDir = "C:\\Windows\\Minidump"
$crashDumpsDir = "$env:LOCALAPPDATA\\CrashDumps"
$localDumpsKey = "HKLM:\\SOFTWARE\\Microsoft\\Windows\\Windows Error Reporting\\LocalDumps"

$minidumpFiles = if (Test-Path $minidumpDir) { Get-ChildItem -Path $minidumpDir -Filter "*.dmp" -File -ErrorAction SilentlyContinue } else { @() }
$crashDumpFiles = if (Test-Path $crashDumpsDir) { Get-ChildItem -Path $crashDumpsDir -File -ErrorAction SilentlyContinue } else { @() }
$localDumpsConfigured = Test-Path $localDumpsKey
$memoryDmpExists = Test-Path "C:\\Windows\\MEMORY.DMP"

$bugcheckEvent = Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-WER-SystemErrorReporting'} -MaxEvents 1 -ErrorAction SilentlyContinue

$allDumps = @($minidumpFiles) + @($crashDumpFiles)
$mostRecent = $allDumps | Sort-Object LastWriteTime -Descending | Select-Object -First 1

[PSCustomObject]@{
  minidumpCount = ($minidumpFiles | Measure-Object).Count
  crashDumpCount = ($crashDumpFiles | Measure-Object).Count
  memoryDmpExists = $memoryDmpExists
  localDumpsConfigured = $localDumpsConfigured
  mostRecentDumpPath = if ($mostRecent) { $mostRecent.FullName } else { $null }
  mostRecentDumpAt = if ($mostRecent) { $mostRecent.LastWriteTimeUtc.ToString("o") } else { $null }
  bugcheckEventFound = $null -ne $bugcheckEvent
  bugcheckEventAt = if ($bugcheckEvent) { $bugcheckEvent.TimeCreated.ToUniversalTime().ToString("o") } else { $null }
} | ConvertTo-Json -Compress
`;

async function runCollectBsodDiagnostics() {
  const { err, stdout, stderr } = await execPowerShellCommand(BSOD_DIAGNOSTIC_SCRIPT, 15000);
  if (err) return { succeeded: false, detail: `BSOD diagnostic check failed to run: ${err.message} (stderr="${stderr.trim()}").` };
  try {
    const result = JSON.parse(stdout.trim());
    const hasRecord = result.mostRecentDumpPath != null || result.bugcheckEventFound || result.memoryDmpExists;
    if (!hasRecord) {
      return {
        succeeded: true,
        detail: `No crash record found - no minidump/CrashDumps file, no MEMORY.DMP, and no BugCheck event on this device (LocalDumps ${result.localDumpsConfigured ? "is" : "is not"} configured).`,
      };
    }
    const parts = [];
    if (result.mostRecentDumpPath) parts.push(`most recent dump file: ${result.mostRecentDumpPath} (${result.mostRecentDumpAt})`);
    if (result.memoryDmpExists) parts.push(`C:\\Windows\\MEMORY.DMP exists`);
    if (result.bugcheckEventFound) parts.push(`most recent BugCheck event: ${result.bugcheckEventAt}`);
    return { succeeded: true, detail: `Crash record found - ${parts.join("; ")}.` };
  } catch {
    return { succeeded: false, detail: `BSOD diagnostic check produced unparseable output: "${stdout.trim()}".` };
  }
}

const REMEDIATION_ACTIONS = {
  "flush-dns": { label: "Flush DNS Cache", run: runFlushDns },
  "clean-temp": { label: "Clean Temp Files", run: runCleanTemp },
  "restart-service": { label: "Restart Print Spooler Service", run: runRestartService },
  "clear-teams-cache": { label: "Clear Teams Cache", run: runClearTeamsCache },
  "repair-vpn": { label: "Repair VPN Connection", run: runRepairVpn },
  "collect-bsod-diagnostics": { label: "Collect BSOD Diagnostics", run: runCollectBsodDiagnostics },
};

// Real, immutable audit trail - reuses the events table (backend/schema.sql) already built for
// AI Intel's Timeline/Insights, rather than a second, parallel logging system, per PRD §9's
// "logged immutably" requirement. Every attempt is logged, whichever of the three real outcomes
// actually happened (blocked/succeeded/failed) - never silently dropped.
//
// Shared by handleRemediateProxy (the local "Run Now" button, a human at this machine) and
// runPendingCommandIfAny (a remote admin's dispatch, discovered via this device's own heartbeat
// poll - see backend/device_commands.go) - the same policy check and REMEDIATION_ACTIONS handlers
// either way, only the trigger's origin differs. Neither REMEDIATION_ACTIONS nor any runXxx
// function above is touched by this - this is the one place that decides blocked/succeeded/failed
// and logs it, already correct and unchanged.
async function runRemediationAction(actionId) {
  const action = REMEDIATION_ACTIONS[actionId];
  if (!action) return { blocked: false, succeeded: false, message: "unknown action" };

  const allowed = await isSelfHealingAllowed();
  if (!allowed) {
    const message = `${action.label} blocked - Self-Healing is not included in this tenant's current plan.`;
    logEvent(`remediation-blocked-${actionId}`, message, "warning");
    return { blocked: true, succeeded: false, message };
  }

  const result = await action.run();
  const eventType = result.succeeded ? `remediation-succeeded-${actionId}` : `remediation-failed-${actionId}`;
  logEvent(eventType, `${action.label}: ${result.detail}`, result.succeeded ? "info" : "warning");
  return { blocked: false, succeeded: result.succeeded, message: result.detail };
}

async function handleRemediateProxy(req, res) {
  try {
    const body = JSON.parse(await readRequestBody(req));
    if (!REMEDIATION_ACTIONS[body.action]) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "unknown action" }));
      return;
    }
    const result = await runRemediationAction(body.action);
    res.writeHead(result.blocked ? 403 : 200);
    res.end(JSON.stringify(result));
  } catch (err) {
    console.error("[telemetry] remediate proxy failed:", err.message);
    res.writeHead(500);
    res.end(JSON.stringify({ error: "internal error" }));
  }
}

// PRD §9 Self-Healing v1 remote dispatch - called once per backend cycle after sendHeartbeat
// returns a pendingCommand (see runBackendCycle below). Runs the exact same
// runRemediationAction path the local "Run Now" button uses, then reports the real outcome back
// so the specific command row's own status reflects it (completeDeviceCommand) - separate from,
// and in addition to, the remediation-succeeded/failed/blocked event runRemediationAction already
// logs unchanged.
async function runPendingCommandIfAny(credentials, pendingCommand) {
  if (!pendingCommand) return;
  const result = await runRemediationAction(pendingCommand.action);
  const status = result.blocked ? "blocked" : result.succeeded ? "succeeded" : "failed";
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), BACKEND_REQUEST_TIMEOUT_MS);
    try {
      await fetch(`${BACKEND_URL}/v1/devices/${credentials.id}/commands/${pendingCommand.id}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${credentials.apiKey}` },
        body: JSON.stringify({ status, result: result.message }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (err) {
    // Non-fatal: the action itself already ran and already logged its real outcome via the
    // events table above - a failure here only means this specific command row's own status
    // field stays stale (still "pending"), not that the remediation or its audit trail were lost.
    console.error(`[telemetry] failed to report completion for command ${pendingCommand.id}:`, err.message);
  }
}

// Lets the UI show a real "Blocked" state proactively (before a user even clicks Run Now),
// not just after an attempt - same real policy check, just without executing/logging anything.
async function handleRemediationStatusProxy(req, res) {
  const allowed = await isSelfHealingAllowed();
  res.writeHead(200);
  res.end(JSON.stringify({ allowed }));
}

// ─── PRD §9.2 ADE Approval Workflows - real v1 ─────────────
// Distinct from Self-Healing above: a high-impact action requests approval, waits, and only
// proceeds once this device holds a real cryptographically signed token from the backend
// (Ed25519 - see backend/signing.go for why that algorithm, not ECDSA). Two real actions wired
// to this mechanism, both genuinely recoverable (not destructive to anything the backend
// holds): clearing this device's own locally cached credentials (loadOrRegisterDevice already
// re-registers a fresh device identity the moment the credentials file is gone, which is
// exactly how this gets proven real below - a new device ID/API key after "execution," not a
// simulated one), and Reset Agent's full reset (the same credential-clear, plus the frontend's
// own local app state - see executeFullReset below and App.tsx's clearResetAgentLocalStorage
// for the two real halves of what "full reset" actually clears).
//
// KNOWN_HIGH_IMPACT_ACTIONS is checked before this device ever requests approval for an action -
// the backend itself accepts any non-empty action string (see backend/handlers.go's
// handleCreateApprovalRequest), but this device should never ask for a signed token for
// something it has no real execution handler for.
const KNOWN_HIGH_IMPACT_ACTIONS = new Set(["clear-cached-credentials", "full-reset"]);

// The DER SPKI wrapper Node's crypto module needs to import a raw 32-byte Ed25519 public key -
// a fixed 12-byte prefix (algorithm identifier for Ed25519, OID 1.3.101.112) followed by the
// raw key bytes. Go's crypto/ed25519 only ever produces/consumes raw keys, so this is the one
// real interop step needed to hand that same key to Node's crypto.verify.
function wrapEd25519PublicKeyAsSpki(rawPublicKey) {
  const prefix = Buffer.from("302a300506032b6570032100", "hex");
  return Buffer.concat([prefix, rawPublicKey]);
}

let cachedPublicKey = null; // A crypto.KeyObject, fetched once and reused - a public key never changes without a redeploy.

async function getBackendPublicKey() {
  if (cachedPublicKey) return cachedPublicKey;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), BACKEND_REQUEST_TIMEOUT_MS);
  let body;
  try {
    const res = await fetch(`${BACKEND_URL}/v1/public-key`, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = await res.json();
  } finally {
    clearTimeout(timeoutId);
  }
  const raw = Buffer.from(body.publicKey, "base64");
  const der = wrapEd25519PublicKeyAsSpki(raw);
  cachedPublicKey = crypto.createPublicKey({ key: der, format: "der", type: "spki" });
  return cachedPublicKey;
}

// Rebuilds the exact same canonical byte string backend/signing.go signed - must match
// approvalTokenPayload() there byte-for-byte, or every real signature will fail to verify.
function approvalTokenPayload(requestId, deviceId, action, expiresAt) {
  return Buffer.from(`${requestId}:${deviceId}:${action}:${expiresAt}`, "utf8");
}

// Real signature verification, plus a real expiry check - a cryptographically valid signature
// on a token whose expiresAt has already passed is still a real rejection, not a pass, since
// approvalTokenValidity (backend/handlers.go) exists specifically to bound how long an issued
// token stays usable.
async function verifyApprovalToken({ requestId, deviceId, action, expiresAt, signature }) {
  if (!requestId || !deviceId || !action || !expiresAt || !signature) {
    return { valid: false, reason: "token is missing a required field" };
  }
  if (Date.parse(expiresAt) <= Date.now()) {
    return { valid: false, reason: `token expired at ${expiresAt}` };
  }
  let publicKey;
  try {
    publicKey = await getBackendPublicKey();
  } catch (err) {
    return { valid: false, reason: `could not fetch backend public key: ${err.message}` };
  }
  let signatureValid;
  try {
    signatureValid = crypto.verify(
      null,
      approvalTokenPayload(requestId, deviceId, action, expiresAt),
      publicKey,
      Buffer.from(signature, "base64"),
    );
  } catch (err) {
    // A malformed base64/signature buffer throws rather than returning false - a real rejection
    // either way, just via a different code path.
    return { valid: false, reason: `signature verification threw: ${err.message}` };
  }
  return signatureValid ? { valid: true } : { valid: false, reason: "signature does not match - token is tampered or forged" };
}

// The real credential-clearing action - deletes the real credentials file and clears the
// in-memory copy so the very next runBackendCycle tick (up to BACKEND_POLL_INTERVAL_MS away, not
// simulated/forced) calls loadOrRegisterDevice() exactly as it would on a genuine first run,
// registering a real new device identity.
function executeClearCachedCredentials() {
  try {
    fs.unlinkSync(DEVICE_CREDENTIALS_PATH);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  deviceCredentials = null;
}

// Reset Agent's full reset - this function is genuinely this action's ENTIRE server-side job
// (clearing credentials, the one piece of real state that lives here in local-agent rather than
// the browser). The other real half - this app's own localStorage (alerts, settings, trend
// history) - can only be cleared by the frontend itself (a Node.js process has no access to a
// webview's localStorage), which is why App.tsx's own handleCheckFullReset calls
// clearResetAgentLocalStorage() right after seeing this action's real executed:true response,
// not something local-agent could do on the frontend's behalf even if it wanted to.
function executeFullReset() {
  executeClearCachedCredentials();
}

async function handleHighImpactRequestProxy(req, res) {
  if (!deviceCredentials) {
    res.writeHead(503);
    res.end(JSON.stringify({ error: "this device is not yet enrolled with the Cloud Command Center" }));
    return;
  }
  let action;
  try {
    const body = JSON.parse(await readRequestBody(req));
    action = body.action;
  } catch {
    res.writeHead(400);
    res.end(JSON.stringify({ error: "action is required" }));
    return;
  }
  if (!KNOWN_HIGH_IMPACT_ACTIONS.has(action)) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: `unknown high-impact action: ${action}` }));
    return;
  }
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), BACKEND_REQUEST_TIMEOUT_MS);
    let backendRes;
    try {
      backendRes = await fetch(`${BACKEND_URL}/v1/devices/${deviceCredentials.id}/approval-requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${deviceCredentials.apiKey}` },
        body: JSON.stringify({ action }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
    const body = await backendRes.text();
    res.writeHead(backendRes.status);
    res.end(body);
  } catch (err) {
    console.error("[telemetry] high-impact approval request failed:", err.message);
    res.writeHead(502);
    res.end(JSON.stringify({ error: "backend unreachable" }));
  }
}

// Checks a specific request's real current status, and - only if it's genuinely approved with
// a signature that genuinely verifies - executes the stand-in action. There is no other path to
// execution anywhere in this file: an attempt with no request, a still-pending request, or a
// tampered/expired token all fall through to "not executed" here, never reaching
// executeClearCachedCredentials().
async function handleHighImpactCheckProxy(req, res) {
  if (!deviceCredentials) {
    res.writeHead(503);
    res.end(JSON.stringify({ error: "this device is not yet enrolled with the Cloud Command Center" }));
    return;
  }
  let requestId;
  try {
    const body = JSON.parse(await readRequestBody(req));
    requestId = body.requestId;
  } catch {
    res.writeHead(400);
    res.end(JSON.stringify({ error: "requestId is required" }));
    return;
  }
  if (!requestId) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: "requestId is required" }));
    return;
  }

  let request;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), BACKEND_REQUEST_TIMEOUT_MS);
    let backendRes;
    try {
      backendRes = await fetch(`${BACKEND_URL}/v1/devices/${deviceCredentials.id}/approval-requests/${requestId}`, {
        headers: { Authorization: `Bearer ${deviceCredentials.apiKey}` },
        signal: controller.signal,
      });
      if (!backendRes.ok) throw new Error(`HTTP ${backendRes.status}`);
      request = await backendRes.json();
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (err) {
    console.error("[telemetry] high-impact status check failed:", err.message);
    res.writeHead(502);
    res.end(JSON.stringify({ error: "backend unreachable or request not found" }));
    return;
  }

  if (request.status !== "approved") {
    res.writeHead(200);
    res.end(JSON.stringify({ status: request.status, executed: false }));
    return;
  }

  const verdict = await verifyApprovalToken({
    requestId: request.id,
    deviceId: request.deviceId,
    action: request.action,
    expiresAt: request.expiresAt,
    signature: request.signature,
  });

  if (!verdict.valid) {
    logEvent(`high-impact-rejected-${request.action}`, `Signed approval token rejected: ${verdict.reason}.`, "critical");
    res.writeHead(200);
    res.end(JSON.stringify({ status: "approved", verified: false, executed: false, error: verdict.reason }));
    return;
  }

  // Real dispatch by the request's own real action, not an unconditional single call - a
  // genuinely, cryptographically approved token for an action this device doesn't recognize
  // executes nothing, rather than silently defaulting to whichever action used to be the only
  // one that existed.
  if (request.action === "clear-cached-credentials") {
    executeClearCachedCredentials();
  } else if (request.action === "full-reset") {
    executeFullReset();
  } else {
    console.warn(`[telemetry] high-impact check: approved action "${request.action}" has no known execution handler - not executing anything.`);
    res.writeHead(200);
    res.end(JSON.stringify({ status: "approved", verified: true, executed: false, error: `no execution handler for action "${request.action}"` }));
    return;
  }
  logEvent(
    `high-impact-executed-${request.action}`,
    `High-impact action executed after verified approval (request ${request.id}): ${request.action}.`,
    "critical",
  );
  res.writeHead(200);
  res.end(JSON.stringify({ status: "approved", verified: true, executed: true }));
}

// ─── PRD §31 Self-Update v1 ────────────────────────────────
// Real, signed, verified, anti-replay-protected self-update - distinct from the older
// "Update available" badge in the Tauri app (App.tsx's useAgentUpdate), which only ever shows a
// human a manual download link. This is the actual PRD Section 31 mechanism: verify signature ->
// verify sequence is newer -> verify SHA-256 of the downloaded installer -> invoke it silently ->
// confirm healthy or roll back automatically.
//
// Health contract: SELF_UPDATE_HEARTBEATS_REQUIRED consecutive successful heartbeats within
// SELF_UPDATE_CONFIRM_WINDOW_MS of the update starting. One lucky heartbeat before a slow-onset
// crash proves nothing; 3 genuinely does, at the existing ~60s heartbeat cadence. A process
// restart during confirmation (see primeSelfUpdateConfirmation) resets the heartbeat count to
// zero - a crash-loop mid-confirmation is itself evidence of instability, not a fresh chance -
// but never extends the deadline; a crash-loop should make it expire sooner, never later. The
// Scheduled Task's own real restart policy (RestartCount=15, RestartInterval=1min, confirmed via
// Get-ScheduledTask) means a crash-looping process can keep auto-relaunching for ~15 minutes on
// its own; 10 minutes lets most of that resolve naturally before rollback acts.
//
// Rollback: detected and acted on entirely by this device's own next cycle (processPendingSelfUpdate/
// triggerSelfUpdateRollback below) - the backend is never told to make this decision, only ever
// used as a dumb file host for the retained installer bytes (?version=, already real). Verifies
// the re-downloaded previous version against previousManifest.sha256 - a hash this device already
// proved genuine via signature at the moment it originally accepted that version, so no new
// signature check or backend endpoint is needed (and none of the existing anti-replay logic
// applies - this never goes through it). A device's very first self-update has no previousManifest
// (its original install predates any signed verification) - rollback simply isn't available for
// that one case, a disclosed limitation, not a gap: there's no real signed data to verify against.
//
// watchdog.ps1 independently mirrors this same rollback for the case this process crashes too
// fast to ever run it itself (see that script's own comment) - both check the same pendingUpdate
// and use a rollbackClaimed flag to avoid a double rollback race.

const SELF_UPDATE_HEARTBEATS_REQUIRED = 3;
const SELF_UPDATE_CONFIRM_WINDOW_MS = 10 * 60 * 1000;

let selfUpdateInProgress = false; // in-memory guard - see checkAndApplySelfUpdate's own comment
let pendingUpdateConfirmation = null; // set at startup if .self-update-state.json has one waiting

function loadSelfUpdateState() {
  try {
    return JSON.parse(fs.readFileSync(SELF_UPDATE_STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function loadEntitlementCache() {
  try {
    return JSON.parse(fs.readFileSync(ENTITLEMENT_CACHE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveEntitlementCache(state) {
  try {
    fs.writeFileSync(ENTITLEMENT_CACHE_PATH, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error("[telemetry] failed to persist entitlement cache:", err.message);
  }
}

function saveSelfUpdateState(state) {
  try {
    fs.writeFileSync(SELF_UPDATE_STATE_PATH, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error("[telemetry] failed to persist self-update state:", err.message);
  }
}

// Real, at startup (module load, not inside any cycle) - if the LAST process to run left a
// pendingUpdate marker, this process is very likely the freshly-restarted result of that update
// (the installer stops and relaunches this exact process as part of its own already-existing
// upgrade path - see PulseEndpoint.iss's CurStepChanged). startCount tracks how many process
// startups have now observed this same pendingUpdate: 1 is the normal, expected post-install
// restart (nothing to reset); 2+ means THIS process itself has already died and restarted at
// least once since the update, before ever reaching this same point again - real evidence of
// instability, not a fresh chance, so heartbeat progress resets to zero (the deadline itself
// never moves - see this section's own top comment on why a crash-loop should make it expire
// sooner, not later).
(function primeSelfUpdateConfirmation() {
  const state = loadSelfUpdateState();
  if (state.pendingUpdate) {
    pendingUpdateConfirmation = state.pendingUpdate;
    pendingUpdateConfirmation.startCount = (pendingUpdateConfirmation.startCount ?? 0) + 1;
    if (pendingUpdateConfirmation.startCount > 1) {
      pendingUpdateConfirmation.consecutiveHeartbeats = 0;
      console.warn(
        `[telemetry] self-update to v${pendingUpdateConfirmation.toVersion} restarted during confirmation (start #${pendingUpdateConfirmation.startCount}) - resetting heartbeat progress, deadline unchanged.`,
      );
    }
    saveSelfUpdateState({ ...state, pendingUpdate: pendingUpdateConfirmation });
    console.log(
      `[telemetry] found a pending self-update confirmation (v${pendingUpdateConfirmation.fromVersion} -> v${pendingUpdateConfirmation.toVersion}, sequence ${pendingUpdateConfirmation.sequence}) - will confirm after ${SELF_UPDATE_HEARTBEATS_REQUIRED} consecutive successful heartbeats, within ${SELF_UPDATE_CONFIRM_WINDOW_MS / 60000} minutes of ${pendingUpdateConfirmation.startedAt}.`,
    );
  }
})();

function persistPendingUpdate() {
  const state = loadSelfUpdateState();
  saveSelfUpdateState({ ...state, pendingUpdate: pendingUpdateConfirmation });
}

// Real, in-process rollback - the actual re-download+verify+install, triggered only once this
// device's own next cycle finds the confirmation deadline passed without enough consecutive
// heartbeats (see processPendingSelfUpdate below, the one real caller). previousManifest is the
// last manifest THIS device verified via signature before this update was even attempted
// (captured in launchSilentInstall from what was lastAcceptedManifest at that moment) -
// re-verifying a freshly re-downloaded copy against that already-trusted sha256 needs no new
// signature check and no new backend endpoint, since the device already proved this exact
// combination genuine once. Terminal action for this update attempt: does not arm a fresh
// pendingUpdate for the rolled-back version - if that version is somehow also broken, that's a
// distinct, worse problem out of this v1's scope, not silently chained into another attempt.
async function triggerSelfUpdateRollback() {
  const pending = pendingUpdateConfirmation;
  if (!pending) return;

  logEvent(
    "self-update-unhealthy",
    `Agent update v${pending.fromVersion} -> v${pending.toVersion} (sequence ${pending.sequence}) did not confirm healthy within ${SELF_UPDATE_CONFIRM_WINDOW_MS / 60000} minutes (${pending.consecutiveHeartbeats ?? 0}/${SELF_UPDATE_HEARTBEATS_REQUIRED} consecutive heartbeats) - attempting automatic rollback.`,
    "warning",
  );

  const previousManifest = pending.previousManifest;
  if (!previousManifest || !previousManifest.version || !previousManifest.sha256) {
    console.error(
      "[telemetry] self-update rollback needed but no previousManifest is available (this device's first-ever self-update has no prior verified version to return to) - leaving pendingUpdate in place for a human to investigate.",
    );
    return;
  }

  // Real, file-based claim - watchdog.ps1 independently checks this same pendingUpdate on its
  // own 1-minute schedule for the case this process crashes too fast to ever reach this point
  // itself. Whichever gets here first claims it; the other sees rollbackClaimed already set and
  // skips, rather than both launching a silent install at once.
  const claimState = loadSelfUpdateState();
  if (claimState.pendingUpdate?.rollbackClaimed) {
    console.log("[telemetry] rollback already claimed (likely by watchdog.ps1) - skipping.");
    return;
  }
  saveSelfUpdateState({ ...claimState, pendingUpdate: { ...claimState.pendingUpdate, rollbackClaimed: true } });

  let installerBytes;
  try {
    const downloadUrl = `${BACKEND_URL}/v1/agent/download?version=${encodeURIComponent(previousManifest.version)}`;
    installerBytes = await downloadInstaller(downloadUrl);
  } catch (err) {
    logEvent("self-update-rejected", `Rollback to v${previousManifest.version} failed: download failed (${err.message}).`, "critical");
    return;
  }

  const actualSha256 = crypto.createHash("sha256").update(installerBytes).digest("hex");
  if (actualSha256 !== previousManifest.sha256) {
    logEvent(
      "self-update-rejected",
      `Rollback to v${previousManifest.version} refused: downloaded installer's real SHA-256 (${actualSha256}) does not match the previously-verified one (${previousManifest.sha256}) - corrupted download.`,
      "critical",
    );
    return;
  }

  const tempInstallerPath = path.join(os.tmpdir(), `PulseEndpointRollback-${previousManifest.version}.exe`);
  fs.writeFileSync(tempInstallerPath, installerBytes);

  logEvent(
    "self-update-rolled-back",
    `Rolling back v${pending.toVersion} -> v${previousManifest.version} (sequence ${previousManifest.sequence}) after it failed to confirm healthy - launching silent install of the previously-verified version.`,
    "critical",
  );

  // lastAcceptedManifest already reflects previousManifest (it was the accepted manifest before
  // this whole update attempt) - no change needed there. pendingUpdate is cleared entirely, not
  // replaced, per this function's own top comment.
  const finalState = loadSelfUpdateState();
  delete finalState.pendingUpdate;
  saveSelfUpdateState(finalState);
  pendingUpdateConfirmation = null;

  const child = spawn(tempInstallerPath, ["/VERYSILENT", "/TYPE=agent", `/BACKENDURL=${BACKEND_URL}`], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

// The one real entry point for the health contract, called once per cycle (see runBackendCycle)
// regardless of THIS cycle's own heartbeat outcome - the rollback deadline must be evaluated even
// on a cycle where the heartbeat itself failed, since that's exactly the case rollback exists
// for. heartbeatOk is this cycle's own real, fresh heartbeat result, never a cached value.
async function processPendingSelfUpdate(heartbeatOk) {
  if (!pendingUpdateConfirmation) return;

  if (heartbeatOk) {
    pendingUpdateConfirmation.consecutiveHeartbeats = (pendingUpdateConfirmation.consecutiveHeartbeats ?? 0) + 1;
    persistPendingUpdate();

    if (pendingUpdateConfirmation.consecutiveHeartbeats >= SELF_UPDATE_HEARTBEATS_REQUIRED) {
      const { fromVersion, toVersion, sequence } = pendingUpdateConfirmation;
      logEvent(
        "self-update-succeeded",
        `Agent updated v${fromVersion} -> v${toVersion} (sequence ${sequence}) and confirmed healthy after ${SELF_UPDATE_HEARTBEATS_REQUIRED} consecutive successful heartbeats.`,
        "info",
      );
      console.log(`[telemetry] self-update to v${toVersion} confirmed healthy.`);
      pendingUpdateConfirmation = null;
      const state = loadSelfUpdateState();
      delete state.pendingUpdate;
      saveSelfUpdateState(state);
      return;
    }
  }

  const startedAtMs = new Date(pendingUpdateConfirmation.startedAt).getTime();
  const deadlinePassed = Number.isFinite(startedAtMs) && Date.now() - startedAtMs > SELF_UPDATE_CONFIRM_WINDOW_MS;
  if (!deadlinePassed) return;

  await triggerSelfUpdateRollback();
}

// Positive if a is newer than b, negative if older, 0 if equal, null if either side isn't a real
// dotted version. A separate implementation from App.tsx's compareAgentVersions (that's a
// different project this one can't import from) but intentionally identical semantics.
function compareAgentVersions(a, b) {
  const parse = (v) => {
    const parts = String(v ?? "").trim().replace(/^v/i, "").split(".").map((p) => Number.parseInt(p, 10));
    return parts.length === 0 || parts.some((n) => Number.isNaN(n) || n < 0) ? null : parts;
  };
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return null;
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

let cachedReleasePublicKey = null; // A crypto.KeyObject, built once from the embedded constant.

function getReleasePublicKey() {
  if (cachedReleasePublicKey) return cachedReleasePublicKey;
  const raw = Buffer.from(RELEASE_PUBLIC_KEY_B64, "base64");
  cachedReleasePublicKey = crypto.createPublicKey({ key: wrapEd25519PublicKeyAsSpki(raw), format: "der", type: "spki" });
  return cachedReleasePublicKey;
}

// Rebuilds the exact same canonical payload backend/cmd/sign-release signed - must match
// releasePayload() there byte-for-byte, same delimited-string convention as approvalTokenPayload
// above and for the same reason (no cross-language JSON key-order/whitespace ambiguity).
function releaseManifestPayload(manifest) {
  return Buffer.from(`${manifest.version}:${manifest.sha256}:${manifest.sequence}:${manifest.ring}:${manifest.installer}`, "utf8");
}

function verifyReleaseManifestSignature(manifest) {
  if (!manifest.version || !manifest.sha256 || !manifest.sequence || !manifest.installer || !manifest.signature) {
    return { valid: false, reason: "manifest is missing a required signed field" };
  }
  let signatureValid;
  try {
    signatureValid = crypto.verify(null, releaseManifestPayload(manifest), getReleasePublicKey(), Buffer.from(manifest.signature, "base64"));
  } catch (err) {
    return { valid: false, reason: `signature verification threw: ${err.message}` };
  }
  return signatureValid ? { valid: true } : { valid: false, reason: "signature does not match - manifest is tampered or unsigned" };
}

async function fetchLatestReleaseManifest() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), BACKEND_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${BACKEND_URL}/v1/agent/latest`, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function downloadInstaller(downloadUrl) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120000); // a real installer download, not a small API call - 15s would be far too tight
  try {
    const res = await fetch(downloadUrl, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timeoutId);
  }
}

// Launches the verified installer fully detached (not awaited to completion) - this process is
// very likely to be killed shortly by the installer's own existing stop-everything step (see
// PulseEndpoint.iss's CurStepChanged, already real and tested), which is expected, not a bug. The
// pendingUpdate marker is written BEFORE launching so intent survives even if this process dies
// before the spawn call itself finishes. previousManifest (the manifest this device had already
// verified via signature, before this update) becomes the rollback target - see this section's
// own top comment.
function launchSilentInstall(installerPath, fromVersion, manifest, previousManifest) {
  const state = loadSelfUpdateState();
  saveSelfUpdateState({
    ...state,
    pendingUpdate: {
      fromVersion, toVersion: manifest.version, sequence: manifest.sequence,
      startedAt: new Date().toISOString(),
      consecutiveHeartbeats: 0, startCount: 0,
      previousManifest,
    },
  });
  const child = spawn(installerPath, ["/VERYSILENT", "/TYPE=agent", `/BACKENDURL=${BACKEND_URL}`], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  logEvent(
    "self-update-started",
    `Downloaded and verified v${manifest.version} (sequence ${manifest.sequence}) - launching silent install. Confirms healthy after ${SELF_UPDATE_HEARTBEATS_REQUIRED} consecutive successful heartbeats, or rolls back automatically after ${SELF_UPDATE_CONFIRM_WINDOW_MS / 60000} minutes without them.`,
    "info",
  );
}

// The one real entry point, called once per backend cycle (see runBackendCycle below) - verify
// signature -> verify sequence is strictly newer than the last one this device ever accepted ->
// download -> verify SHA-256 -> persist the new sequence -> install. Each step is a real,
// separate rejection reason, logged as its own event rather than a single generic failure,
// since an operator investigating a device that never updated needs to know WHICH of these
// actually happened.
async function checkAndApplySelfUpdate() {
  if (AGENT_VERSION == null) return; // unbundled dev run - see AGENT_VERSION's own comment
  if (selfUpdateInProgress) return; // already launched an install this process's lifetime
  if (pendingUpdateConfirmation) return; // waiting to confirm a just-applied update first

  const manifest = await fetchLatestReleaseManifest();
  if (!manifest || !manifest.version) return;

  if (compareAgentVersions(manifest.version, AGENT_VERSION) <= 0) return; // not newer, or unparseable - nothing to do
  if (!manifest.downloadUrl) return; // published but no installer file resolvable server-side yet

  const sigVerdict = verifyReleaseManifestSignature(manifest);
  if (!sigVerdict.valid) {
    logEvent("self-update-rejected", `Rejected v${manifest.version}: ${sigVerdict.reason}.`, "critical");
    return;
  }

  // Real anti-replay (PRD Section 31.2 Step 4) - strictly greater than the last sequence this
  // device has ever accepted, persisted across restarts. A validly-signed manifest that's merely
  // OLD (sequence <= last accepted) is rejected exactly the same as an unsigned one - a genuine
  // release the fleet already moved past, or a replayed one, look identical from here, and both
  // are correctly refused. lastAcceptedManifest (the full manifest, not just its sequence) is
  // also this update's own rollback target if it later fails to confirm healthy - see this
  // section's own top comment on why retaining the whole thing, not just the number, is what
  // makes an automatic rollback possible without a new signature check or backend endpoint.
  const state = loadSelfUpdateState();
  const previousManifest = state.lastAcceptedManifest ?? null;
  const lastAccepted = previousManifest?.sequence ?? 0;
  if (manifest.sequence <= lastAccepted) {
    logEvent(
      "self-update-rejected",
      `Rejected v${manifest.version}: sequence ${manifest.sequence} is not newer than the last accepted sequence ${lastAccepted} (replay or already-superseded release).`,
      "critical",
    );
    return;
  }

  selfUpdateInProgress = true;
  try {
    let installerBytes;
    try {
      installerBytes = await downloadInstaller(manifest.downloadUrl);
    } catch (err) {
      logEvent("self-update-rejected", `Rejected v${manifest.version}: download failed (${err.message}).`, "warning");
      return;
    }

    const actualSha256 = crypto.createHash("sha256").update(installerBytes).digest("hex");
    if (actualSha256 !== manifest.sha256) {
      logEvent(
        "self-update-rejected",
        `Rejected v${manifest.version}: downloaded installer's real SHA-256 (${actualSha256}) does not match the signed manifest's (${manifest.sha256}) - corrupted download or tampered file.`,
        "critical",
      );
      return;
    }

    // Persisted now, before install - anti-replay is about having accepted this manifest as
    // genuine, a separate concern from whether the install itself later succeeds (see this
    // section's own top comment on why install-success confirmation is a distinct later step).
    const acceptedManifest = {
      version: manifest.version, sha256: manifest.sha256, sequence: manifest.sequence,
      ring: manifest.ring, installer: manifest.installer,
    };
    saveSelfUpdateState({ ...state, lastAcceptedManifest: acceptedManifest });

    const tempInstallerPath = path.join(os.tmpdir(), `PulseEndpointSelfUpdate-${manifest.version}.exe`);
    fs.writeFileSync(tempInstallerPath, installerBytes);
    launchSilentInstall(tempInstallerPath, AGENT_VERSION, manifest, previousManifest);
  } finally {
    selfUpdateInProgress = false;
  }
}

async function fetchEntitlement(credentials) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), BACKEND_REQUEST_TIMEOUT_MS);
    let body;
    try {
      const res = await fetch(`${BACKEND_URL}/v1/devices/${credentials.id}/entitlement`, {
        headers: { Authorization: `Bearer ${credentials.apiKey}` },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      body = await res.json();
    } finally {
      clearTimeout(timeoutId);
    }
    // deviceCount/features are real backend-computed values (real devices.tenant_id COUNT(*),
    // real entitlements.licensed_devices seat count, real plan_features rows) - passed through
    // as-is rather than re-derived here. null/[] respectively when the backend itself couldn't
    // supply them (see handleGetEntitlement's own comments for when that happens).
    return {
      plan: body.plan,
      status: body.status,
      expiresAt: body.expiresAt,
      deviceCount: body.deviceCount ?? null,
      features: body.features ?? [],
      // This device's own real device-registry lifecycle state (see backend's schema.sql
      // comment) - always "active" in practice, since a genuinely revoked device is rejected by
      // deviceAuthMiddleware before it ever reaches this handler. Passed through as-is, not
      // hardcoded here.
      deviceStatus: body.deviceStatus ?? null,
      // Real, honest v1 of PRD Section 6.4's Warranty State Machine (backend's warranty.go) -
      // "" (falsy) from the backend means no locked baseline yet to derive it from, normalized to
      // null here so every other "not yet known" field in this object reads the same way.
      warrantyState: body.warrantyState || null,
    };
  } catch (err) {
    console.error("[telemetry] fetchEntitlement failed:", err);
    return null;
  }
}

// PRD §7's 72h offline-tolerance window, applied once per cycle to fetchEntitlement's real
// result. A fresh success (entitlement truthy) always wins and refreshes the on-disk cache - the
// device just proved it can still reach the backend right now, so there's nothing to fall back
// to. A failure falls back to entitlementCache, and distinguishes two real cases rather than
// treating every failure identically: within ENTITLEMENT_OFFLINE_TOLERANCE_MS of the last real
// success, the cached entitlement is still honestly usable (stale, but a real recent fact, not a
// guess); past it, unverified takes over - a third state, distinct from both a live status and
// the genuine "Unknown" of a device that has never once reached the backend (entitlementCache
// empty, or left over from a different device id - e.g. this machine re-registered since).
//
// Deliberately does NOT gate any functionality on the resolved status (Active/Grace/Suspended/
// etc.) - it only decides how to honestly LABEL what's known, same as entitlement.status already
// did before this existed. Actual feature-gating per status (PRD §7's "full function vs degraded
// vs blocked" behavior) stays out of scope here: there is no defined policy anywhere in this
// codebase for what should specifically degrade at Grace or block at Suspended (the one real
// feature gate that exists, isSelfHealingAllowed, is keyed on plan_features by plan tier, never
// by entitlement status) - that's a real product decision nobody has made yet, not a missing
// technical capability, so building it now would mean inventing policy rather than honestly
// reporting its absence.
function resolveEntitlementState(deviceCredentials, entitlement) {
  const now = Date.now();
  if (entitlement) {
    entitlementCache = { deviceId: deviceCredentials.id, entitlement, lastVerifiedAt: new Date(now).toISOString() };
    saveEntitlementCache(entitlementCache);
    return { ...entitlement, lastVerifiedAt: entitlementCache.lastVerifiedAt, stale: false, unverified: false };
  }
  if (entitlementCache.deviceId !== deviceCredentials.id || !entitlementCache.lastVerifiedAt) return null;
  const ageMs = now - Date.parse(entitlementCache.lastVerifiedAt);
  return {
    ...entitlementCache.entitlement,
    lastVerifiedAt: entitlementCache.lastVerifiedAt,
    stale: true,
    unverified: ageMs > ENTITLEMENT_OFFLINE_TOLERANCE_MS,
  };
}

// Builds the real hardware fingerprint backend/'s POST /v1/devices/:id/hardware-check compares
// against its stored baseline - field names/shape must match backend's own HardwareFingerprint
// struct (fingerprint.go) exactly. Deliberately narrow to identifiers that never legitimately
// change on a routine driver/BIOS update (real serials/model names only - never CPU clock speed,
// storage firmware version, or GPU driver version, which already have their own real display
// elsewhere in this app and would otherwise false-positive this on every such update). Returns
// null if this cycle's telemetry doesn't yet have the fields needed (e.g. very first poll still
// in flight) - the caller skips sending a check that cycle rather than posting a garbage/partial
// fingerprint that could get locked in as a bogus baseline.

// Picks the WiFi adapter by name pattern, never by array position - same precedent as
// extractLiveStatusFields' own firstGpu selection. Necessary, not just cautious: mergeRustData
// unconditionally replaces telemetry.network with rust's own raw adapter list whenever rust
// succeeds that cycle (confirmed live: rust's list puts "Tailscale Tunnel" first, with no
// Wi-Fi-priority sort and no virtual-adapter filtering - both of which only get-telemetry.ps1's
// own Win32_NetworkAdapter query applies). Reading network[0] positionally would grab the wrong
// adapter's MAC on most real cycles.
const WIFI_ADAPTER_NAME = /wi-?fi|wireless/i;
function findWifiMac(telemetry) {
  const nets = Array.isArray(telemetry?.network) ? telemetry.network : [];
  const wifi = nets.find((n) => n?.Name && WIFI_ADAPTER_NAME.test(n.Name));
  return wifi?.MACAddress ?? "";
}

function computeHardwareFingerprint(telemetry) {
  if (!telemetry?.system || !telemetry?.board || !telemetry?.cpu || !telemetry?.memory || !Array.isArray(telemetry?.storage) || !Array.isArray(telemetry?.gpu)) {
    return null;
  }
  const modules = Array.isArray(telemetry.memory.modules) ? telemetry.memory.modules : [];
  return {
    systemSerial: telemetry.system.IdentifyingNumber ?? "",
    systemUUID: telemetry.system.UUID ?? "",
    boardProduct: telemetry.board.Product ?? "",
    boardSerial: telemetry.board.SerialNumber ?? "",
    cpuModel: telemetry.cpu.Name ?? "",
    ramTotalCapacity: modules.reduce((sum, m) => sum + (Number(m.Capacity) || 0), 0),
    ramModuleSerials: modules.map((m) => m.SerialNumber ?? ""),
    storage: telemetry.storage.map((s) => ({
      model: s.Model ?? "",
      serial: s.SerialNumber ?? "",
      sizeBytes: Number(s.Size) || 0,
    })),
    gpuModels: telemetry.gpu.map((g) => g.Name ?? ""),
    // Added after both real devices already had locked baselines - backend's compareFingerprints
    // (checkIfBothPresent) only ever compares these once a baseline holds a real, non-empty value
    // for them, so an old baseline captured before this shipped can never read as "changed" just
    // because it's missing a field it never had. batterySerial is genuinely blank on this dev
    // machine (confirmed: Win32_PortableBattery.SerialNumber unpopulated by this OEM) - sent as
    // "" honestly, same as every other genuinely-absent field here, not fabricated.
    wifiMac: findWifiMac(telemetry),
    batterySerial: telemetry.batteryDetail?.portable?.SerialNumber ?? "",
  };
}

// fingerprintJson is the exact string signFingerprint (if it ran) hashed and signed - sent
// alongside the flat fingerprint fields as `signedPayload` rather than relied upon to be
// byte-reproducible from those fields again server-side (Go's json.Marshal field order and JS's
// object-literal order happening to match today is not something to build a signature check on -
// see the design note this was built from). The backend verifies the signature against this
// exact string and separately checks it actually matches the top-level fields, rather than
// re-deriving one from the other either direction.
async function postHardwareCheck(credentials, fingerprint, fingerprintJson, identity) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), BACKEND_REQUEST_TIMEOUT_MS);
    let body;
    try {
      const requestBody = { ...fingerprint, signedPayload: fingerprintJson };
      if (identity) {
        requestBody.signature = identity.signature;
        requestBody.signatureAlgorithm = identity.algorithm;
        // Only present on the cycle that actually created the key - see tpm_identity.rs's own
        // DeviceIdentity doc comment. Sent as real values only, never as empty-string filler.
        if (identity.publicKey) requestBody.publicKey = identity.publicKey;
        if (identity.keyAttestation) requestBody.keyAttestation = identity.keyAttestation;
      }
      const res = await fetch(`${BACKEND_URL}/v1/devices/${credentials.id}/hardware-check`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${credentials.apiKey}` },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      body = await res.json();
    } finally {
      clearTimeout(timeoutId);
    }
    return { status: body.status, mismatchedFields: body.fields ?? [] };
  } catch (err) {
    console.error("[telemetry] postHardwareCheck failed:", err);
    return null;
  }
}

// Records today's real battery-health/SSD-wear reading for AI Intel's SSD/Battery Remaining
// Life predictions - only the two specific sources the task calls for (LibreHardwareMonitor's
// own battery-health calculation, SMART's percentage_used), not derived.ts's fuller
// WMI->powercfg->LHM priority chain the frontend uses for its own live display - a simpler,
// single real source per metric is enough for a once-a-day snapshot, and keeps this file from
// having to reimplement that whole chain in JS a second time. Returns false (not throwing) on
// any failure, same graceful-degradation convention as every other real backend call here.
async function postMetricSnapshot(credentials, batteryHealthPct, ssdWearPct) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), BACKEND_REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${BACKEND_URL}/v1/devices/${credentials.id}/metric-snapshot`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${credentials.apiKey}` },
        body: JSON.stringify({ batteryHealthPct, ssdWearPct }),
        signal: controller.signal,
      });
      return res.ok;
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (err) {
    console.error("[telemetry] postMetricSnapshot failed:", err);
    return false;
  }
}

// extractLiveStatusFields pulls the fleet live-status payload from this cycle's already-collected
// telemetry - the same raw fields derived.ts already reads for the local Tauri UI, not a new
// collection path. Percentages stay independently null if their source was missing this cycle
// (e.g. a desktop with no battery). `detail` is the extra identity/health/security/temps the
// Command Centre device page needs so it can match the agent UI; omitted keys mean Unknown/—.
function numOrNull(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function strOrNull(v) {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}
// get-telemetry.ps1 runs under real Windows PowerShell 5.1 (execTelemetryScript invokes
// "powershell.exe", not pwsh) - confirmed live that its ConvertTo-Json serializes CIM DateTime
// properties as the legacy WCF/MSAJAX "/Date(1788414870000)/" wrapped-epoch-ms format, not a
// clean ISO string (which is what PowerShell 7 would produce - easy to be misled testing this
// interactively, since this session's own shell tool runs pwsh). No other DateTime-typed WMI
// field is actually read downstream today (BIOS ReleaseDate, battery ManufactureDate, etc. are
// collected but never consumed), so this is scoped to Defender's timestamps specifically rather
// than retrofitted everywhere speculatively.
function parseWcfDate(v) {
  if (typeof v !== "string") return null;
  const m = v.match(/^\/Date\((-?\d+)\)\/$/);
  if (!m) return null;
  const d = new Date(Number(m[1]));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
function putDetail(detail, key, value) {
  if (value === null || value === undefined || value === "") return;
  detail[key] = value;
}

function batteryHealthFromTelemetry(data) {
  const designedCapacity = data?.batteryDetail?.static?.DesignedCapacity;
  const fullChargedCapacity = data?.batteryDetail?.fullCharge?.FullChargedCapacity;
  if (numOrNull(designedCapacity) != null && designedCapacity > 0 && numOrNull(fullChargedCapacity) != null) {
    return Math.round((fullChargedCapacity / designedCapacity) * 100);
  }
  const report = data?.batteryReportHealth;
  if (numOrNull(report?.designCapacityMwh) != null && report.designCapacityMwh > 0 && numOrNull(report?.fullChargeCapacityMwh) != null) {
    return Math.round((report.fullChargeCapacityMwh / report.designCapacityMwh) * 100);
  }
  return numOrNull(data?.hardwareMonitor?.batteryHealthLhmPercent);
}

function securityFromTelemetry(data) {
  const tpm = data?.tpm;
  const tpmActive = tpm != null ? Boolean(tpm.IsActivated_InitialValue && tpm.IsEnabled_InitialValue) : null;
  const secureBootEnabled = typeof data?.secureBootEnabled === "boolean" ? data.secureBootEnabled : null;
  const bitlockerOn = data?.bitlockerStatus != null && String(data.bitlockerStatus).length > 0
    ? data.bitlockerStatus === "On"
    : null;
  const checks = [];
  if (tpmActive != null) checks.push(tpmActive);
  if (secureBootEnabled != null) checks.push(secureBootEnabled);
  if (bitlockerOn != null) checks.push(bitlockerOn);
  return {
    tpmActive,
    secureBootEnabled,
    bitlockerOn,
    securityHealthPct: checks.length === 0 ? null : Math.round((checks.filter(Boolean).length / checks.length) * 100),
  };
}

function extractLiveStatusFields(data) {
  const cpuPct = numOrNull(data?.cpu?.LoadPercentage);

  let ramPct = null;
  const totalKB = data?.memory?.totalKB;
  const freeKB = data?.memory?.freeKB;
  if (typeof totalKB === "number" && totalKB > 0 && typeof freeKB === "number") {
    ramPct = Math.round(((totalKB - freeKB) / totalKB) * 1000) / 10;
  }

  let diskPct = null;
  const disks = Array.isArray(data?.logicalDisks) ? data.logicalDisks : [];
  let worstDisk = null;
  for (const d of disks) {
    if (typeof d?.Size === "number" && d.Size > 0 && typeof d.FreeSpace === "number") {
      const usedPct = ((d.Size - d.FreeSpace) / d.Size) * 100;
      if (!worstDisk || usedPct > worstDisk.usedPct) worstDisk = { usedPct, disk: d };
    }
  }
  if (worstDisk) {
    diskPct = Math.round(worstDisk.usedPct * 10) / 10;
  }

  let batteryPct = null;
  const firstBattery = Array.isArray(data?.battery) ? data.battery[0] : null;
  if (firstBattery && typeof firstBattery.EstimatedChargeRemaining === "number") {
    batteryPct = firstBattery.EstimatedChargeRemaining;
  }

  const detail = {};
  putDetail(detail, "manufacturer", strOrNull(data?.system?.Vendor));
  putDetail(detail, "model", strOrNull(data?.system?.Name));
  putDetail(detail, "serial", strOrNull(data?.bios?.SerialNumber) ?? strOrNull(data?.system?.IdentifyingNumber));
  putDetail(detail, "osCaption", strOrNull(data?.osDetail?.Caption));
  // Real last-boot timestamp - get-telemetry.ps1 has computed osDetail.LastBootUpTime (and a
  // pre-formatted UptimeFormatted string) since this project's first commit, just never read
  // downstream. Sending the raw timestamp only, not UptimeFormatted - a PS-side "Xd Yh Zm" string
  // is a snapshot at collection time that only gets staler the longer this cached row sits
  // between polls, whereas the dashboard's own timeAgo() (already used elsewhere on Device 360)
  // computes "X ago" fresh on every render from this one real fact.
  putDetail(detail, "lastBootTime", parseWcfDate(data?.osDetail?.LastBootUpTime));
  putDetail(detail, "cpuName", strOrNull(data?.cpu?.Name));
  putDetail(detail, "cpuTempC", numOrNull(data?.hardwareMonitor?.cpuTempC));
  const gpuSkip = /microsoft basic display|remote display|virtual display|idd driver|parsec|spacedesk|usb display|mirage driver|indirect display/i;
  const realGpus = (Array.isArray(data?.gpu) ? data.gpu : []).filter((g) => g?.Name && !gpuSkip.test(g.Name));
  const firstGpu = realGpus.find((g) => /nvidia|geforce|quadro|rtx |radeon|arc a\d/i.test(g.Name)) || realGpus[0] || (Array.isArray(data?.gpu) ? data.gpu[0] : null);
  putDetail(detail, "gpuName", strOrNull(firstGpu?.Name));
  // gpuDriverVersion was already collected (get-telemetry.ps1's $gpu has selected DriverVersion
  // since the first commit), just never read downstream. gpuDriverDate is genuinely new
  // collection - see mergeRustData's own comment above on why the GPU merge had to become an
  // additive overlay (rust's own Win32_VideoController query has no DriverDate field) rather than
  // just adding the field to get-telemetry.ps1 alone.
  putDetail(detail, "gpuDriverVersion", strOrNull(firstGpu?.DriverVersion));
  putDetail(detail, "gpuDriverDate", parseWcfDate(firstGpu?.DriverDate));
  putDetail(detail, "gpuUtilPct", numOrNull(data?.gpuUtilization));
  putDetail(detail, "gpuTempC", numOrNull(data?.hardwareMonitor?.gpuTempC));
  putDetail(detail, "batteryHealthPct", batteryHealthFromTelemetry(data));
  // batteryCycleCount reflects only rust's own corroborated reading (see the merge logic in
  // collect() that overwrites ps.batteryDetail.cycle.CycleCount from rust's verdict, not
  // root/wmi's raw BatteryCycleCount) - null here means genuinely unsupported/unverifiable on
  // this hardware, not a real zero. batteryTemperatureC is deliberately NOT sent at all: confirmed
  // absent on this real machine via two independent sources (LibreHardwareMonitor's own sensor
  // enumeration and rust's separate Windows Battery API read) - a genuine hardware ceiling, same
  // category as this project's known fan-RPM gap, not worth wiring a field that can never be real
  // here (though another device's EC might expose it - revisit if that's ever confirmed live).
  putDetail(detail, "batteryCycleCount", numOrNull(data?.batteryDetail?.cycle?.CycleCount));
  putDetail(detail, "storageWearPct", numOrNull(data?.storageHealth?.nvme_smart_health_information_log?.percentage_used));
  // Real NVMe media-error/critical-warning signals - already sitting in data.storageHealth (the
  // full smartctl JSON get-telemetry.ps1 already collects for storageWearPct above), just not
  // previously read. NVMe has no ATA-style attribute table (no Reallocated_Sector_Ct/
  // Offline_Uncorrectable concept) - confirmed directly against a real `smartctl -a -j -d nvme`
  // run on this machine's own drive that no such fields exist anywhere in the output, not just
  // unparsed - so there's no "reallocated sectors" field to send, honestly. media_errors is
  // NVMe's own real, direct analog: the spec-defined lifetime count of unrecovered data-integrity
  // errors, sent as-is. critical_warning is the raw 5-bit NVMe health bitmask (spare capacity/
  // temperature/reliability/read-only-mode/backup-device-failure flags, NVMe Base Spec 1.4) -
  // sent as the raw integer, not decoded here, so the dashboard's display layer owns turning it
  // into human-readable status text (same "send the raw source fact, not a derived value"
  // convention as biosFirmwareUpdateAvailable above).
  putDetail(detail, "storageMediaErrors", numOrNull(data?.storageHealth?.nvme_smart_health_information_log?.media_errors));
  putDetail(detail, "storageCriticalWarning", numOrNull(data?.storageHealth?.nvme_smart_health_information_log?.critical_warning));
  const driveModels = (Array.isArray(data?.storage) ? data.storage : []).map((d) => strOrNull(d?.Model)).filter(Boolean);
  putDetail(detail, "driveModel", driveModels.length > 0 ? driveModels.join(" · ") : null);
  if (typeof totalKB === "number" && totalKB > 0) {
    putDetail(detail, "memTotalGB", Math.round((totalKB / (1024 * 1024)) * 10) / 10);
  }
  // ramSlotsUsed is a free derivation from data.memory.modules (already collected for the
  // hardware fingerprint's ramModuleSerials) - its array length is the real installed-module
  // count, nothing new to gather. ramSlotsTotal is genuinely new (Win32_PhysicalMemoryArray -
  // see get-telemetry.ps1's own comment) - the TOTAL slot count including empty ones, which
  // modules.length alone can never reveal. Both null (not 0) when data.memory.modules isn't a
  // real array this cycle - a query failure honestly reads as unknown, not "zero RAM installed".
  putDetail(detail, "ramSlotsUsed", Array.isArray(data?.memory?.modules) ? data.memory.modules.length : null);
  putDetail(detail, "ramSlotsTotal", numOrNull(data?.memory?.totalSlots));
  if (worstDisk && typeof worstDisk.disk.FreeSpace === "number") {
    putDetail(detail, "diskFreeGB", Math.round((worstDisk.disk.FreeSpace / (1024 ** 3)) * 10) / 10);
  }
  // Full per-volume breakdown - data.logicalDisks already covers every local fixed volume
  // (Win32_LogicalDisk -Filter "DriveType=3", not just C:), just never surfaced beyond the
  // single worst-disk tile above. Sent as its own real array (never collapsed to null when
  // empty) - same "an empty array is itself a meaningful signal" convention as avProductNames.
  putDetail(
    detail,
    "volumes",
    disks
      .filter((d) => typeof d?.Size === "number" && d.Size > 0 && strOrNull(d.DeviceID))
      .map((d) => ({
        letter: strOrNull(d.DeviceID),
        label: strOrNull(d.VolumeName),
        sizeGB: Math.round((d.Size / (1024 ** 3)) * 10) / 10,
        freeGB: typeof d.FreeSpace === "number" ? Math.round((d.FreeSpace / (1024 ** 3)) * 10) / 10 : null,
      })),
  );
  const sec = securityFromTelemetry(data);
  putDetail(detail, "tpmActive", sec.tpmActive);
  putDetail(detail, "secureBootEnabled", sec.secureBootEnabled);
  putDetail(detail, "bitlockerOn", sec.bitlockerOn);
  putDetail(detail, "securityHealthPct", sec.securityHealthPct);
  // Real Windows Update check (runWindowsUpdateCheck, hourly WUA search) - already computed for
  // the local Tauri UI's own cache, just not previously included in what reaches the Cloud
  // Command Center. pendingCount alone (not the derived upToDate boolean - the dashboard can
  // derive that itself, pendingCount === 0, the same "don't send a derived value alongside its
  // own source" convention every other field here already follows) plus checkedAt so a device
  // that hasn't completed its first hourly check yet reads as "not checked yet," not a false "0
  // pending."
  putDetail(detail, "windowsUpdatePendingCount", numOrNull(data?.windowsUpdate?.pendingCount));
  putDetail(detail, "windowsUpdateCheckedAt", strOrNull(data?.windowsUpdate?.checkedAt));
  // Real BIOS/firmware update check (runBiosFirmwareUpdateCheck, same hourly WUA search
  // cadence as Windows Update above) - same reasoning: already computed for the local Tauri
  // UI's own cache, just not previously included in what reaches the Cloud Command Center.
  // updateAvailable is already the real source fact itself (unlike windowsUpdate's own
  // pendingCount, there's no raw count worth sending separately here - runBiosFirmwareUpdateCheck
  // never exposes one, only whether a real System Firmware driver update was found), so it's
  // sent as-is rather than a derived boolean recomputed from something else. checkedAt follows
  // the same "not checked yet" honesty as windowsUpdateCheckedAt.
  putDetail(detail, "biosFirmwareUpdateAvailable", typeof data?.biosFirmwareUpdate?.updateAvailable === "boolean" ? data.biosFirmwareUpdate.updateAvailable : null);
  putDetail(detail, "biosFirmwareLatestVersion", strOrNull(data?.biosFirmwareUpdate?.latestVersion));
  putDetail(detail, "biosFirmwareCheckedAt", strOrNull(data?.biosFirmwareUpdate?.checkedAt));
  // Real domain-join/Azure AD-join/MDM-enrollment status (runDomainMdmCheck, dsregcmd /status),
  // same hourly cadence as Windows Update/BIOS above, same passthrough reasoning - already
  // computed locally, just not previously sent to the Cloud Command Center. All five booleans are
  // sent as their own real source facts (not collapsed into one derived "managed" flag) since a
  // device can genuinely be joined one way but not another (e.g. this real machine: Workplace
  // Joined=YES but AzureAdJoined/DomainJoined=NO) and the dashboard's own Security card is the
  // right place to show that distinction, not this passthrough layer. checkedAt follows the same
  // "not checked yet" honesty as windowsUpdateCheckedAt/biosFirmwareCheckedAt.
  putDetail(detail, "azureAdJoined", typeof data?.domainMdm?.azureAdJoined === "boolean" ? data.domainMdm.azureAdJoined : null);
  putDetail(detail, "domainJoined", typeof data?.domainMdm?.domainJoined === "boolean" ? data.domainMdm.domainJoined : null);
  putDetail(detail, "enterpriseJoined", typeof data?.domainMdm?.enterpriseJoined === "boolean" ? data.domainMdm.enterpriseJoined : null);
  putDetail(detail, "workplaceJoined", typeof data?.domainMdm?.workplaceJoined === "boolean" ? data.domainMdm.workplaceJoined : null);
  putDetail(detail, "mdmEnrolled", typeof data?.domainMdm?.mdmEnrolled === "boolean" ? data.domainMdm.mdmEnrolled : null);
  putDetail(detail, "domainMdmTenantName", strOrNull(data?.domainMdm?.tenantName));
  putDetail(detail, "domainMdmCheckedAt", strOrNull(data?.domainMdm?.checkedAt));
  // Real antivirus/Defender status - MSFT_MpComputerStatus (Windows Defender's own native API,
  // confirmed live on this machine to work unelevated, unlike TPM/BitLocker above) for the
  // real-time-protection/signature-currency/last-scan facts, plus SecurityCenter2's
  // AntiVirusProduct for the broader "what AV product(s) are actually registered" signal (the
  // same registration mechanism third-party AV uses, so this isn't Defender-only). Deliberately
  // NOT decoding SecurityCenter2's own productState bitmask - it has no Microsoft-published bit
  // layout, every public "decoder" for it is reverse-engineered and inconsistent, and it would add
  // nothing for Defender specifically since MSFT_MpComputerStatus already gives clean, documented
  // booleans for the same facts. avProductNames is sent as a real array (never a boolean) since a
  // genuinely empty array ("queried fine, nothing registered") is itself a meaningful, different
  // signal from null ("couldn't check this cycle") - putDetail only skips null/undefined/"", so
  // [] still reaches device_live_status.detail honestly.
  putDetail(detail, "defenderRealTimeProtectionEnabled", typeof data?.defenderStatus?.RealTimeProtectionEnabled === "boolean" ? data.defenderStatus.RealTimeProtectionEnabled : null);
  putDetail(detail, "defenderSignatureLastUpdated", parseWcfDate(data?.defenderStatus?.AntivirusSignatureLastUpdated));
  putDetail(detail, "defenderQuickScanAt", parseWcfDate(data?.defenderStatus?.QuickScanEndTime));
  putDetail(detail, "defenderFullScanAt", parseWcfDate(data?.defenderStatus?.FullScanEndTime));
  putDetail(
    detail,
    "avProductNames",
    Array.isArray(data?.avProducts) ? data.avProducts.map((p) => strOrNull(p?.displayName)).filter(Boolean) : null,
  );
  // Real Windows license/activation status - runWindowsLicenseCheck's own hourly check (see its
  // comment for why this moved off the per-5s get-telemetry.ps1 path: the real query takes ~42s,
  // which was blowing the whole script's 30s timeout and killing every field, not just this one).
  // licenseStatus is sent as the raw integer, not decoded here - it's a small, Microsoft-
  // documented enum (0=Unlicensed, 1=Licensed, 2=OOBGrace, 3=OOTGrace, 4=NonGenuineGrace,
  // 5=Notification, 6=ExtendedGrace), decoded client-side same as the NVMe critical_warning
  // bitmask - raw source fact from the agent, display logic in the dashboard.
  putDetail(detail, "windowsLicenseStatus", numOrNull(data?.windowsLicense?.licenseStatus));
  putDetail(detail, "windowsLicenseFamily", strOrNull(data?.windowsLicense?.licenseFamily));
  putDetail(detail, "windowsLicenseChannel", strOrNull(data?.windowsLicense?.productKeyChannel));

  return { cpuPct, ramPct, diskPct, batteryPct, detail: Object.keys(detail).length > 0 ? detail : undefined };
}

// Pushes this cycle's live telemetry to the Cloud Command Center's fleet dashboard - real,
// but optional, same degrade-to-no-op convention as every other backend call in this file:
// if backend/ isn't reachable or this device isn't enrolled yet, this simply doesn't send
// anything rather than failing collect() itself. Deliberately fire-and-forget from collect()'s
// own 5s cadence (not awaited there) - a slow/unreachable backend request must never hold up
// the next real hardware poll, the same reasoning pollLoop's own self-rescheduling already
// applies to powershell.exe's timing.
async function postLiveStatus(credentials, fields) {
  if (fields.cpuPct === null && fields.ramPct === null && fields.diskPct === null && fields.batteryPct === null && !fields.detail) {
    return false;
  }
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), BACKEND_REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${BACKEND_URL}/v1/devices/${credentials.id}/live-status`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${credentials.apiKey}` },
        body: JSON.stringify(fields),
        signal: controller.signal,
      });
      return res.ok;
    } finally {
      clearTimeout(timeoutId);
    }
  } catch {
    return false;
  }
}

// Calls ai-service's real GET /predict/:deviceId, forwarding this device's own real API key as
// the exact same Bearer credential every other backend call here already uses - ai-service holds
// no credential of its own (see its own app.py comment), it only ever relays this one request's
// token on to backend/'s GET /v1/devices/:id/metric-snapshots for that single call's lifetime.
async function fetchPrediction(credentials) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    let body;
    try {
      const res = await fetch(`${AI_SERVICE_URL}/predict/${credentials.id}`, {
        headers: { Authorization: `Bearer ${credentials.apiKey}` },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      body = await res.json();
    } finally {
      clearTimeout(timeoutId);
    }
    return { battery: body.battery, ssd: body.ssd };
  } catch (err) {
    console.error("[telemetry] fetchPrediction failed:", err);
    return null;
  }
}

// GET /v1/health needs no device credentials (no auth at all - see handleHealth's own comment
// on why) - unlike fetchEntitlement, this runs independent of whether this device is enrolled,
// since "is the backend's database actually working" is a fact worth knowing even before/
// without enrollment. Three real, distinct outcomes: true (backend reachable, query
// succeeded), false (backend reachable, query itself failed - a real HTTP 503/non-ok body),
// null (backend not reachable at all) - collapsing the last two into one "not healthy" value
// would hide the difference between "the whole service is down" and "it's up but the database
// is broken," which is exactly the distinction a real health check exists to make.
async function fetchDbHealth() {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), BACKEND_REQUEST_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(`${BACKEND_URL}/v1/health`, { signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }
    if (!res.ok) return false;
    const body = await res.json();
    return body?.status === "ok";
  } catch (err) {
    console.error("[telemetry] fetchDbHealth failed - backend unreachable:", err.message);
    return null;
  }
}

// Real names of the six Scheduled Tasks this project's own auto-start setup registers (see
// the top-level README's "Running everything completely hidden" section) - not user-configurable,
// since these are this specific product's own known task names, not arbitrary ones.
// desktopApp (PulseEndpointDesktopApp) is the Tauri frontend's own task - it replaced the
// tauri-plugin-autostart Run key entirely (see README's "Tauri desktop app's own crash recovery"
// section), so it's now the sole real mechanism for the desktop app's auto-start, same as the
// other five are for their own processes - there is no longer a separate, independent toggle for
// it (see the frontend Settings page's own comment on why "Launch on Startup (Desktop App)" was
// removed rather than kept alongside this aggregate).
// aiService (PulseEndpointAiService) launches ai-service/start-ai-service.cmd the same way the
// other background processes launch theirs - RunLevel Limited (unelevated), since it only makes
// outbound HTTP calls to backend/ and needs no WMI/TPM/BitLocker access, unlike telemetryServer.
const SCHEDULED_TASK_NAMES = {
  telemetryServer: "PulseEndpointTelemetryServer",
  commandCenter: "PulseEndpointCommandCenter",
  frontend: "PulseEndpointFrontend",
  libreHardwareMonitor: "PulseEndpointLibreHardwareMonitor",
  desktopApp: "PulseEndpointDesktopApp",
  aiService: "PulseEndpointAiService",
};

function execSchtasksQuery(taskName) {
  return new Promise((resolve) => {
    // /V (verbose) is required - confirmed directly that plain `/FO LIST` alone does not
    // include a "Scheduled Task State: Enabled/Disabled" line at all (only "Status: Ready",
    // a different field describing whether it's currently running, not whether it's enabled).
    execFile("schtasks", ["/Query", "/TN", taskName, "/V", "/FO", "LIST"], { timeout: 5000 }, (err, stdout, stderr) =>
      resolve({ err, stdout, stderr }),
    );
  });
}

// A task that genuinely isn't registered is a real, determinate "not enabled" fact (false) -
// schtasks reports this as a real failure ("ERROR: The system cannot find the file specified."),
// confirmed directly, not assumed. Anything else going wrong (schtasks.exe missing, output that
// doesn't match the expected format) is genuinely unknown (null), not silently treated as false.
async function getScheduledTaskEnabled(taskName) {
  const { err, stdout } = await execSchtasksQuery(taskName);
  if (err) {
    if (/cannot find/i.test(stdout || err.message || "")) return false;
    console.error(`[telemetry] schtasks query for "${taskName}" failed unexpectedly:`, err.message);
    return null;
  }
  const match = /Scheduled Task State:\s*(\S+)/i.exec(stdout || "");
  if (!match) {
    console.error(`[telemetry] schtasks query for "${taskName}" succeeded but output didn't match the expected format`);
    return null;
  }
  return match[1].toLowerCase() === "enabled";
}

async function getAllScheduledTaskStates() {
  const entries = await Promise.all(
    Object.entries(SCHEDULED_TASK_NAMES).map(async ([key, name]) => [key, await getScheduledTaskEnabled(name)]),
  );
  const states = Object.fromEntries(entries);
  if (!loggedScheduledTaskDiagnostics) {
    loggedScheduledTaskDiagnostics = true;
    console.log(
      "[telemetry] Scheduled Task states -",
      ...Object.entries(states).map(([key, enabled]) => `${key}=${enabled ?? "unknown"}`),
    );
  }
  return states;
}

// Real safety net, independent of execFile's/fetch's own internal timeout on each call below -
// those only guarantee the immediate child process (or HTTP request) gets killed/aborted. Caught
// live, twice, at two separate call sites in this same cycle: a child-process-adjacent call hangs
// indefinitely under this process's elevated, hidden-console context, well past its own internal
// timeout, with the callback that timeout depends on never firing - silently blocking the entire
// 60s backend cycle forever (last_seen_at frozen, no exception anywhere). First caught live via
// temporary instrumentation at the Windows Update/BIOS check (a COM surrogate process plausibly
// inheriting the same stdio handles, outliving the killed powershell.exe); a second, separate live
// hang then occurred before entitlement/heartbeat ever resolved once, most likely inside
// getAllScheduledTaskStates' own six concurrent schtasks.exe spawns. Two real, confirmed hangs at
// different call sites is evidence of a systemic class of failure, not one isolated bug - so this
// same net now covers every child-process-adjacent call in the cycle (getAllScheduledTaskStates,
// signFingerprint, postHardwareCheck), not just the one caught first. Deliberately NOT applied to
// fetchEntitlement/sendHeartbeat/fetchDbHealth - plain fetch() calls with no child process
// involved, and none has ever hung in any test today; wrapping them anyway would be speculative
// defensive coding, not evidence-based.
//
// This race doesn't care why the underlying promise never resolves - a timed-out check is logged
// clearly and treated as a real failure (null) this cycle, same as any other missed signal, never
// silently retried mid-flight. The underlying child process, if genuinely still alive, is left
// running rather than adding process-tree-killing complexity for a corner this rare.
function withTimeout(promise, timeoutMs, label) {
  let timeoutId;
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(() => {
      console.error(`[telemetry] ${label} did not complete within ${timeoutMs}ms - treating as failed this cycle, not blocking the rest of runBackendCycle.`);
      resolve(null);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

// Each margin is the same shape: comfortably past whatever internal timeout that specific call
// already has, so the normal path always gets every chance to resolve on its own first - these
// only fire if that call's own internal timeout mechanism is itself what's stuck.
// +10s past execPowerShellCommand's own 120s internal timeout on both WUA calls.
const WINDOWS_UPDATE_CHECK_TIMEOUT_MS = 130000;
// +5s past execSchtasksQuery's own 5s per-task timeout - all six run concurrently inside
// getAllScheduledTaskStates, so the aggregate ceiling is one 5s timeout, not six stacked.
const SCHEDULED_TASK_STATES_TIMEOUT_MS = 10000;
// +10s past execRustSignFingerprint's own RUST_SIGN_TIMEOUT_MS (15s).
const SIGN_FINGERPRINT_TIMEOUT_MS = 25000;
// +10s past postHardwareCheck's own BACKEND_REQUEST_TIMEOUT_MS (15s) - a plain fetch(), not a
// child-process spawn, but included per this class of hang being confirmed real in this exact
// hardware-check block (signFingerprint immediately precedes it every cycle it runs).
const POST_HARDWARE_CHECK_TIMEOUT_MS = 25000;

// Runs on BACKEND_POLL_INTERVAL_MS, not every 5s poll cycle - enrolls the device if it isn't
// already, then fetches the real entitlement and sends a heartbeat. entitlementState is only
// ever set here (collect() just reads whatever this last left it as); a failure at any step
// leaves entitlementState null rather than reusing a stale value, so the frontend can't show a
// frozen plan/status that's silently stopped being checked. dbHealthyState/scheduledTaskState
// are updated on this same slower cadence too (a database's health or a Scheduled Task's
// registration doesn't change fast enough to justify the 5s hardware-poll cadence), but unlike
// entitlement, both are computed unconditionally below - neither depends on this device being
// enrolled, so there's no reason to skip them just because enrollment hasn't happened yet.
async function runBackendCycle() {
  const dbHealthPromise = fetchDbHealth();
  const scheduledTasksPromise = withTimeout(getAllScheduledTaskStates(), SCHEDULED_TASK_STATES_TIMEOUT_MS, "getAllScheduledTaskStates");

  if (!deviceCredentials) {
    deviceCredentials = await loadOrRegisterDevice();
  }

  if (!deviceCredentials) {
    entitlementState = null;
    dbHealthyState = await dbHealthPromise;
    scheduledTaskState = await scheduledTasksPromise;
    if (lastBackendOutcome !== "unavailable") {
      lastBackendOutcome = "unavailable";
      console.warn(
        `[telemetry] Cloud Command Center not reachable at ${BACKEND_URL} - Warranty's Subscription plan/status will show sample values until it's reachable and this device is enrolled.`,
      );
    }
    return;
  }

  const [entitlement, heartbeat, dbHealthy, scheduledTasks] = await Promise.all([
    fetchEntitlement(deviceCredentials),
    sendHeartbeat(deviceCredentials),
    dbHealthPromise,
    scheduledTasksPromise,
  ]);
  entitlementState = resolveEntitlementState(deviceCredentials, entitlement);
  dbHealthyState = dbHealthy;
  scheduledTaskState = scheduledTasks;

  // PRD §9 Self-Healing v1 remote dispatch - deliberately awaited here (after, not inside, the
  // Promise.all above, so entitlement/dbHealth/scheduledTasks aren't held up by it) rather than
  // fire-and-forget: this cycle runs on a fixed interval, and completeDeviceCommand is what
  // actually clears "pending" - firing-and-forgetting would let the same still-pending command
  // get picked up and run a second time next cycle if this one hadn't reported completion yet.
  if (heartbeat?.pendingCommand) {
    try {
      await runPendingCommandIfAny(deviceCredentials, heartbeat.pendingCommand);
    } catch (err) {
      console.error("[telemetry] runPendingCommandIfAny failed:", err.message);
    }
  }

  // PRD §31 Self-Update v1 - evaluated every cycle regardless of THIS cycle's own heartbeat
  // outcome (see processPendingSelfUpdate's own comment on why the rollback deadline still needs
  // checking on a cycle where the heartbeat itself failed). Checked before looking for a NEW
  // update below, so a process still confirming (or rolling back) a just-applied one never also
  // tries to start another.
  await processPendingSelfUpdate(!!heartbeat?.ok);

  try {
    await checkAndApplySelfUpdate();
  } catch (err) {
    console.error("[telemetry] checkAndApplySelfUpdate failed:", err.message);
  }

  const outcome = entitlement ? "ok" : "unavailable";
  if (outcome !== lastBackendOutcome) {
    // Only the recovery direction is loggable here, structurally: "became unreachable" would
    // need a logEvent POST to the very backend that's just been declared unreachable, which
    // would simply fail to deliver - there's no other real place positioned to record that
    // specific transition (no watchdog process exists in this project). The reconnect is real
    // and deliverable the instant this fires, since the backend is reachable again by then.
    const wasRealOutage = lastBackendOutcome === "unavailable";
    lastBackendOutcome = outcome;
    if (outcome === "ok") {
      console.log(
        `[telemetry] Cloud Command Center reachable - entitlement: plan=${entitlement.plan} status=${entitlement.status} expiresAt=${entitlement.expiresAt}`,
      );
      if (wasRealOutage) logEvent("backend-reachable", "Cloud Command Center became reachable again.", "info");
    } else {
      console.warn(
        `[telemetry] Cloud Command Center became unreachable - Warranty's Subscription plan/status will show sample values until it's reachable again.`,
      );
    }
  }

  // Real hardware-check, on its own slower HARDWARE_CHECK_INTERVAL_MS cadence (see that
  // constant's own comment) - gated on the backend actually being reachable this cycle
  // (entitlement succeeded), same as heartbeat effectively already is. hardwareIntegrityState is
  // deliberately left untouched, not reset to null, whenever a check isn't due yet, the backend
  // is unreachable, or this one attempt's request itself fails - a single transient failure on a
  // ~5-minute cadence shouldn't flicker Hardware page's real "Clear" back to "Baseline Pending";
  // it's only ever updated here on an attempt that genuinely completed.
  if (entitlement && Date.now() - lastHardwareCheckAt >= HARDWARE_CHECK_INTERVAL_MS) {
    const fingerprint = computeHardwareFingerprint(cache.data);
    if (fingerprint) {
      lastHardwareCheckAt = Date.now();
      const fingerprintJson = JSON.stringify(fingerprint);
      const identity = await withTimeout(signFingerprint(fingerprintJson), SIGN_FINGERPRINT_TIMEOUT_MS, "signFingerprint");
      const result = await withTimeout(
        postHardwareCheck(deviceCredentials, fingerprint, fingerprintJson, identity),
        POST_HARDWARE_CHECK_TIMEOUT_MS,
        "postHardwareCheck",
      );
      if (result) {
        hardwareIntegrityState = result;
        console.log(
          `[telemetry] hardware check: status=${result.status}${result.mismatchedFields.length ? ` fields=${result.mismatchedFields.join(", ")}` : ""}` +
          (identity ? " (TPM-signed)" : " (unsigned - rust-collector/TPM unavailable this cycle)"),
        );
      }
    }
  }

  // Real once-a-day metric snapshot (AI Intel's SSD/Battery Remaining Life history) - gated on
  // the real UTC calendar date, not an elapsed-ms interval like HARDWARE_CHECK_INTERVAL_MS,
  // since "one real day" is what both this and backend's own dedup-by-day logic actually mean.
  // Only ever the two specific real sources the task calls for (see postMetricSnapshot's own
  // comment) - skipped entirely (not posted as an all-null row) when neither is available this
  // cycle, since there'd be nothing real to record.
  const today = todayUtcDateString();
  if (entitlement && (metricSnapshotState.lastSnapshotDate !== today || !snapshotPostedThisProcess)) {
    const batteryHealthPct = cache.data?.hardwareMonitor?.batteryHealthLhmPercent ?? null;
    const ssdWearPct = cache.data?.storageHealth?.nvme_smart_health_information_log?.percentage_used ?? null;
    if (batteryHealthPct != null || ssdWearPct != null) {
      const ok = await postMetricSnapshot(deviceCredentials, batteryHealthPct, ssdWearPct);
      if (ok) {
        const sameDayRetry = metricSnapshotState.lastSnapshotDate === today;
        snapshotPostedThisProcess = true;
        metricSnapshotState.lastSnapshotDate = today;
        if (sameDayRetry) {
          // Local file already claimed today, but this process still posted (backend upsert).
          // Force a prediction refresh so AI Intel isn't stuck on yesterday's fit.
          predictionState = null;
        }
        saveMetricSnapshotState();
        console.log(`[telemetry] metric snapshot recorded for ${today}: battery=${batteryHealthPct ?? "n/a"} ssd=${ssdWearPct ?? "n/a"}`);
      }
    }
  }

  // Real once-a-day prediction fetch, same cadence as the snapshot above - deliberately gated on
  // metricSnapshotState.lastSnapshotDate === today (not just its own independent day-flag).
  // Without this, a real race was possible (and did happen on this exact machine, right after a
  // fresh restart): the very first runBackendCycle tick can land before collect()'s own slower
  // 5s loop has produced any real hardwareMonitor/storageHealth data yet, so that tick's snapshot
  // post is skipped (nothing real to record) while the prediction fetch still runs and correctly
  // reports the count *as of that moment* - then, once real data arrives a few seconds later and
  // the snapshot successfully posts, the prediction is never re-fetched again that same day (its
  // own day-flag is already set), so the UI would keep showing yesterday's day-count for the
  // rest of the day even though a new real snapshot genuinely exists. Gating on the snapshot
  // having already landed today closes that race - a day where the snapshot never succeeds at
  // all simply skips the prediction refresh too (nothing new to report anyway).
  // predictionState == null covers a same-day restart: lastPredictionDate may already be today
  // while memory (and older state files with no lastPrediction) still have nothing to show.
  if (entitlement && metricSnapshotState.lastSnapshotDate === today && (metricSnapshotState.lastPredictionDate !== today || predictionState == null)) {
    const result = await fetchPrediction(deviceCredentials);
    if (result) {
      predictionState = result;
      metricSnapshotState.lastPredictionDate = today;
      metricSnapshotState.lastPrediction = result;
      saveMetricSnapshotState();
      console.log(`[telemetry] prediction updated: battery=${result.battery.status} ssd=${result.ssd.status}`);
    }
  }

  // Real Windows Update checks (software updates + BIOS/system firmware updates + domain-join/
  // MDM status + license/activation status + driver versions + fingerprint-sensor presence + TPM/
  // BitLocker fallback + disk model/serial enrichment), on their own slower
  // WINDOWS_UPDATE_CHECK_INTERVAL_MS cadence (see that constant's and each run*Check function's
  // own comments for why). Unlike the hardware-check/snapshot/prediction blocks above, this is
  // NOT gated on `entitlement` - whether this real machine has pending updates, is domain/MDM-
  // managed, is licensed, or what drivers it has is a pure local OS fact, unrelated to Cloud
  // Command Center enrollment. Run together (Promise.all) on the same shared timer - none of
  // these eight needs sub-hourly freshness, even the genuinely slow ones (license ~42s, driver
  // versions ~5.5-5.9s, TPM/BitLocker fallback ~5s each), so all piggyback on the existing cadence
  // rather than inventing new timers. Real Measure-Command breakdown that motivated this move:
  // Win32_PnPSignedDriver ~5.5-5.9s, Get-BitLockerVolume ~5.3-5.6s, Win32_Tpm ~5.0s, disk
  // model/serial enrichment ~1.3-2.2s, Win32_PnPEntity fingerprint check ~0.75-0.83s - together
  // over half of get-telemetry.ps1's own ~27s baseline against its 30s script timeout.
  if (Date.now() - lastWindowsUpdateCheckAt >= WINDOWS_UPDATE_CHECK_INTERVAL_MS) {
    lastWindowsUpdateCheckAt = Date.now();
    const [softwareResult, biosResult, domainMdmResult, licenseResult, driverVersionsResult, fingerprintResult, tpmBitlockerResult, diskEnrichmentResult] = await Promise.all([
      withTimeout(runWindowsUpdateCheck(), WINDOWS_UPDATE_CHECK_TIMEOUT_MS, "Windows Update check"),
      withTimeout(runBiosFirmwareUpdateCheck(), WINDOWS_UPDATE_CHECK_TIMEOUT_MS, "BIOS firmware update check"),
      withTimeout(runDomainMdmCheck(), WINDOWS_UPDATE_CHECK_TIMEOUT_MS, "domain/MDM status check"),
      withTimeout(runWindowsLicenseCheck(), WINDOWS_UPDATE_CHECK_TIMEOUT_MS, "Windows license check"),
      withTimeout(runDriverVersionsCheck(), WINDOWS_UPDATE_CHECK_TIMEOUT_MS, "driver versions check"),
      withTimeout(runFingerprintSensorCheck(), WINDOWS_UPDATE_CHECK_TIMEOUT_MS, "fingerprint sensor check"),
      withTimeout(runTpmBitlockerFallbackCheck(), WINDOWS_UPDATE_CHECK_TIMEOUT_MS, "TPM/BitLocker fallback check"),
      withTimeout(runDiskEnrichmentCheck(), WINDOWS_UPDATE_CHECK_TIMEOUT_MS, "disk enrichment check"),
    ]);
    if (softwareResult) {
      windowsUpdateState = softwareResult;
      console.log(`[telemetry] Windows Update check: ${softwareResult.upToDate ? "up to date" : `${softwareResult.pendingCount} pending update(s)`}`);
    }
    if (biosResult) {
      biosFirmwareUpdateState = biosResult;
      console.log(`[telemetry] BIOS firmware update check: ${biosResult.updateAvailable ? `update available (v${biosResult.latestVersion})` : "up to date"}`);
    }
    if (domainMdmResult) {
      domainMdmState = domainMdmResult;
      console.log(`[telemetry] domain/MDM status check: azureAdJoined=${domainMdmResult.azureAdJoined} domainJoined=${domainMdmResult.domainJoined} workplaceJoined=${domainMdmResult.workplaceJoined} mdmEnrolled=${domainMdmResult.mdmEnrolled}`);
    }
    if (licenseResult) {
      windowsLicenseState = licenseResult;
      console.log(`[telemetry] Windows license check: status=${licenseResult.licenseStatus} family=${licenseResult.licenseFamily} channel=${licenseResult.productKeyChannel}`);
    }
    if (driverVersionsResult) {
      driverVersionsState = driverVersionsResult;
      console.log("[telemetry] driver versions check: completed");
    }
    if (fingerprintResult) {
      fingerprintSensorState = fingerprintResult;
      console.log(`[telemetry] fingerprint sensor check: present=${fingerprintResult.present}`);
    }
    if (tpmBitlockerResult) {
      tpmBitlockerFallbackState = tpmBitlockerResult;
      console.log(`[telemetry] TPM/BitLocker fallback check: tpm=${tpmBitlockerResult.tpm ? "present" : "null"} bitlockerStatus=${tpmBitlockerResult.bitlockerStatus ?? "null"}`);
    }
    if (diskEnrichmentResult) {
      diskEnrichmentState = diskEnrichmentResult;
      console.log(`[telemetry] disk enrichment check: ${diskEnrichmentResult.length} volume(s)`);
    }
  }
}

async function backendPollLoop() {
  for (;;) {
    try {
      await runBackendCycle();
    } catch (err) {
      // Without this, a single uncaught rejection anywhere inside runBackendCycle silently and
      // PERMANENTLY kills this loop - nothing else in the process depends on it, so the process
      // itself stays alive (no crash Task Scheduler's own RestartCount/RestartInterval safety
      // net could ever react to). Real, confirmed live during this project's own remote-dispatch
      // testing: an instance sat with a "Running" status for 8+ minutes with zero outbound
      // backend network activity and near-zero CPU time, indistinguishable from healthy without
      // directly inspecting the process - exactly the failure mode this catch prevents. One
      // failed cycle is now logged and skipped, same as a missed heartbeat for any other reason.
      console.error("[telemetry] backendPollLoop: runBackendCycle failed, will retry next cycle:", err);
    }
    await new Promise((resolve) => setTimeout(resolve, BACKEND_POLL_INTERVAL_MS));
  }
}

// Re-profiled directly (Measure-Command against each real query individually, 3 consecutive
// runs, plus cross-checked against real consecutive updatedAt deltas from the live deployed
// server - 24.1s between real cycles observed directly): today's real baseline is ~27-30s, not
// the ~6-7s an older version of this comment used to claim - whatever conditions produced that
// faster reading, they don't reproduce today, and three independent measurement methods
// (standalone Measure-Command, `time` against the whole script, live production cycle deltas)
// now agree closely enough to trust. The real breakdown (before the hourly-cadence moves this
// same commit makes - see PNP_DRIVER_VERSIONS_SCRIPT/TPM_BITLOCKER_FALLBACK_SCRIPT/
// DISK_ENRICHMENT_SCRIPT/FINGERPRINT_SENSOR_SCRIPT's own comments): Win32_PnPSignedDriver
// ~5.5-5.9s, Get-BitLockerVolume ~5.3-5.6s, Win32_Tpm ~5.0s, disk model/serial enrichment
// ~1.3-2.2s, Win32_PnPEntity fingerprint check ~0.75-0.83s - over half the total, now moved off
// this path. 45s (up from 30s) is deliberate defense-in-depth on top of those moves, not a
// substitute for them - real-world WMI provider variance (a colder day, a busier machine) could
// still occasionally push even the trimmed path higher than expected.
//
// Separately confirmed via direct A/B testing: this script runs ~2-3s slower under the real
// Scheduled Task's elevated (RunLevel:Highest) context (~10-11s observed via production
// process-monitor captures) than non-elevated testing suggests (~7.85-8.17s, both against the
// dev-tree copy and the actual deployed Program Files copy). File location, WMI provider-host
// state, and rust-collector contention were all directly ruled out as the cause - the gap tracks
// elevation itself. Mechanism unconfirmed (likely per-call token/security-descriptor evaluation
// under an elevated admin token, spread across this script's ~20 Get-CimInstance calls), but the
// magnitude is small and stable, well inside the 45s timeout margin above - not worth further
// investigation.
const SCRIPT_TIMEOUT_MS = 45000;

function execTelemetryScript() {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PS_SCRIPT],
      { maxBuffer: 10 * 1024 * 1024, timeout: SCRIPT_TIMEOUT_MS },
      (err, stdout, stderr) => resolve({ err, stdout, stderr }),
    );
  });
}

// The Rust binary's own worst case is a ~200ms mandatory sleep (CPU-usage delta) plus a
// handful of WMI/registry round trips - a few seconds at most, nowhere near the PS script's
// 18-20s. 10s is a generous ceiling, not a tight one; it exists so a genuinely hung/missing
// binary can't stall collect() past what the poll loop already budgets for the PS script.
const RUST_TIMEOUT_MS = 10000;

function execRustCollector() {
  return new Promise((resolve) => {
    execFile(RUST_BINARY, [], { maxBuffer: 10 * 1024 * 1024, timeout: RUST_TIMEOUT_MS }, (err, stdout, stderr) =>
      resolve({ err, stdout, stderr }),
    );
  });
}

// A real TPM key operation (especially the very first Create+Finalize on a given machine) can
// genuinely take longer than a plain collection cycle's WMI/registry round trips - generous
// relative to that, not tight, for the same reason RUST_TIMEOUT_MS is.
const RUST_SIGN_TIMEOUT_MS = 15000;

// Separate from execRustCollector above: this mode takes real input (the fingerprint JSON to
// sign) over stdin rather than running argument-less, so it needs its own execFile call with the
// child's stdin actually written to and closed - execFile has no built-in "here's the input"
// option the way its sync sibling execFileSync does.
function execRustSignFingerprint(fingerprintJson) {
  return new Promise((resolve) => {
    const child = execFile(
      RUST_BINARY,
      ["--sign-fingerprint"],
      { maxBuffer: 10 * 1024 * 1024, timeout: RUST_SIGN_TIMEOUT_MS },
      (err, stdout, stderr) => resolve({ err, stdout, stderr }),
    );
    child.stdin.end(fingerprintJson, "utf8");
  });
}

// Real TPM-backed signature over the exact fingerprint bytes about to be posted (see
// tpm_identity.rs's own top comment for what this does and doesn't prove). Never fatal to the
// hardware-check itself - a device with no working TPM, or a cycle where rust-collector is
// unavailable (see Part 1's own escalation for that), still gets its real field-by-field tamper
// comparison; it just posts unsigned that cycle, same graceful-degrade convention as every other
// optional real signal in this file.
async function signFingerprint(fingerprintJson) {
  const { err, stdout, stderr } = await execRustSignFingerprint(fingerprintJson);
  if (err) {
    console.error(
      `[telemetry] --sign-fingerprint failed to run: ${err.message}${stderr ? ` (stderr: ${stderr.toString().trim()})` : ""} - posting this hardware-check unsigned.`,
    );
    return null;
  }
  try {
    const parsed = JSON.parse(stdout);
    if (typeof parsed.signature !== "string" || parsed.signature.length === 0) {
      console.error("[telemetry] --sign-fingerprint produced no real signature - posting this hardware-check unsigned.");
      return null;
    }
    return parsed;
  } catch (e) {
    console.error(`[telemetry] --sign-fingerprint produced unparseable output (${e.message}) - posting this hardware-check unsigned.`);
    return null;
  }
}

// get-telemetry.ps1's Confirm-SecureBootUEFI/Get-BitLockerVolume return "On"/"Off"/"Unknown"
// (BitLockerVolumeProtectionStatus.ToString()) - the frontend's bitlockerLabel check
// (`bitlockerStatus === "On"`) depends on exactly that vocabulary. The Rust binary reports
// "protected"/"unprotected"/"unknown" (its own, differently-named tri-state), so its value is
// translated to PS's vocabulary before ever reaching the merged payload - passing it through
// unmodified would make bitlockerLabel silently read "Disabled" even when actually protected.
function translateRustBitlockerStatus(status) {
  switch (status) {
    case "protected":
      return "On";
    case "unprotected":
      return "Off";
    case "unknown":
      return "Unknown";
    default:
      return null;
  }
}

// Folds whatever the Rust binary genuinely provided into the PowerShell-shaped payload the
// frontend already knows how to read - never introducing a new shape, only filling in real
// values under the field names/casing get-telemetry.ps1 already uses (PascalCase WMI-style
// where that's what the frontend expects, e.g. cpu.Name/gpu[].AdapterRAM/tpm.SpecVersion).
//
// storage is deliberately NOT touched here. PS's `storage` is Win32_DiskDrive (physical disk:
// Model/Size/InterfaceType/MediaType) and `logicalDisks` is Win32_LogicalDisk (volume:
// DeviceID/Size/FreeSpace) - the Rust binary's `storage` is filesystem/volume-level
// (name/totalSpaceBytes/availableSpaceBytes/fileSystem), which is conceptually closer to
// logicalDisks than to storage, but its `name` is the volume LABEL (often empty, confirmed on
// this dev machine), not the drive letter logicalDisks.DeviceID needs ("C:") - there is no
// field in the Rust output that safely maps to either shape without fabricating a drive
// letter. Left unmerged rather than guessed; a real DeviceID-equivalent (mount_point()) would
// need to be added to the Rust side first.
// Object.assign copies a source key's value even when that value is null - fine when Rust's
// field is guaranteed non-null (e.g. memory.freeKB, a plain u64 in the Rust struct with no
// Option wrapper), but cpu's fields are mostly `Option<T>.map(...)` in rust-collector/src/
// main.rs (NumberOfCores/Manufacturer/Name/CurrentClockSpeed all come from Option chains that
// are None on some VMs/containers where e.g. physical_core_count() can't be determined). A
// null there would silently clobber a real PS-sourced value with a worse null one. This only
// copies keys whose value is actually present, so a real PS value always survives a null Rust
// reading for the same field.
function mergeNonNull(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (value != null) target[key] = value;
  }
  return target;
}

function mergeRustData(ps, rust) {
  if (!rust) return ps;

  if (rust.cpu) mergeNonNull((ps.cpu ??= {}), rust.cpu);

  if (rust.memory) {
    mergeNonNull((ps.memory ??= {}), {
      freeKB: rust.memory.freeKB,
      usedKB: rust.memory.usedKB,
      totalKB: rust.memory.totalKB,
    });
  }

  // secureBootEnabled: identical name/shape on both sides (boolean | null) - whichever source
  // actually got a real value wins, preferring Rust's since it's been confirmed on this project
  // to not need elevation (unlike Confirm-SecureBootUEFI).
  if (rust.secureBootEnabled != null) ps.secureBootEnabled = rust.secureBootEnabled;

  const translatedBitlocker = translateRustBitlockerStatus(rust.bitlockerStatus);
  if (translatedBitlocker != null) ps.bitlockerStatus = translatedBitlocker;

  if (rust.tpm) {
    // Additive, same as cpu/memory above - spread PS's existing tpm object first so
    // PS-only fields survive, then overlay Rust's four fields on top. A previous version of
    // this replaced ps.tpm outright, which silently dropped ManufacturerVersion (no Rust
    // equivalent - see rust-collector/src/main.rs). That was a real, user-visible bug: the
    // frontend's tpmReal check only tests whether `tpm` itself is non-null, not whether each
    // individual sub-field survived, so HWComponentsSection's Firmware row kept rendering its
    // hardcoded sample fallback ("7.5.0.0") WITHOUT a SampleTag - tpmReal was still true, so
    // `sample: !tpmReal` stayed false, presenting a fabricated value as if it were real data.
    ps.tpm = {
      ...(ps.tpm ?? {}),
      IsActivated_InitialValue: rust.tpm.isActivated,
      IsEnabled_InitialValue: rust.tpm.isEnabled,
      ManufacturerIdTxt: rust.tpm.manufacturer,
      SpecVersion: rust.tpm.specVersion,
    };
  }

  if (Array.isArray(rust.gpu) && rust.gpu.length > 0) {
    // Additive overlay by Name, not a wholesale replace - same reasoning as storageHealth's own
    // overlay below. Safe here because both PS ($gpu, Win32_VideoController) and rust query the
    // identical WMI class with zero filtering on either side (unlike network, where PS excludes
    // Tailscale/virtual adapters and rust doesn't - name-matching would be unreliable there).
    // Necessary, not just cautious: rust's own Win32_VideoController struct has no DriverDate
    // field at all, so the previous wholesale `ps.gpu = rust.gpu.map(...)` silently dropped
    // DriverDate on every cycle rust succeeds - most of them - even after PS started collecting
    // it. Existing ps.gpu fields survive via the spread; only Name/AdapterRAM/DriverVersion/
    // AdapterCompatibility flip priority to rust, unchanged from before.
    const existingGpuByName = new Map((Array.isArray(ps.gpu) ? ps.gpu : []).filter(Boolean).map((g) => [g.Name, g]));
    ps.gpu = rust.gpu.map((g) => ({
      ...(existingGpuByName.get(g.name) ?? {}),
      Name: g.name,
      AdapterRAM: g.adapterRAMBytes,
      DriverVersion: g.driverVersion,
      AdapterCompatibility: g.adapterCompatibility,
    }));
  }

  if (Array.isArray(rust.network) && rust.network.length > 0) {
    ps.network = rust.network.map((n) => ({
      Name: n.name,
      MACAddress: n.macAddress,
      AdapterType: n.adapterType,
    }));
  }

  if (Array.isArray(rust.battery) && rust.battery.length > 0) {
    const rb = rust.battery[0];

    // PowerShell's `@($battery)` wraps a $null Get-CimInstance result as a ONE-ELEMENT array
    // containing null - `@($null)` is `[null]` in PowerShell, not `[]` (confirmed directly:
    // `@($null) | ConvertTo-Json -Compress` prints "[null]"). So ps.battery[0] can genuinely be
    // null even though ps.battery IS an array with length 1 - a length-only check doesn't catch
    // that, and `ps.battery[0].EstimatedChargeRemaining = ...` would throw on a null element.
    // Realistic trigger: Win32_Battery's WMI query transiently failing/timing out on a given
    // poll cycle (independent of starship-battery's own, separate Windows API call succeeding
    // on the same cycle) - the two sources can disagree cycle-to-cycle even on hardware that
    // has a real battery.
    if (rb.chargePercent != null) {
      const existingFirst = Array.isArray(ps.battery) && ps.battery[0] != null ? ps.battery[0] : {};
      const rest = Array.isArray(ps.battery) ? ps.battery.slice(1) : [];
      ps.battery = [{ ...existingFirst, EstimatedChargeRemaining: rb.chargePercent }, ...rest];
    }

    // Fills batteryDetail.static/fullCharge - the exact root/wmi-tier fields
    // getBatteryHealthPercent (src/app/lib/derived.ts) checks FIRST, before its powercfg/LHM
    // fallbacks. Rust is authoritative here whenever it has a value - overwrites an already-real
    // PS/root-wmi reading too, not just an empty gap (flipped from an earlier round, which only
    // filled this when PS's own root/wmi query for that tier came back empty - a known, real gap
    // on this dev machine, BatteryStaticData is absent here). PS is the fallback now: it's used
    // exactly as-is whenever the Rust binary fails for the cycle (rust is null, so this whole
    // block never runs) or doesn't report this specific value. Other sub-fields already on
    // ps.batteryDetail.static/.fullCharge (e.g. DeviceName, ManufactureDate) still survive via
    // the spread - only DesignedCapacity/FullChargedCapacity themselves flip priority. Wh -> mWh
    // is a genuine unit conversion (root/wmi's DesignedCapacity/FullChargedCapacity are mWh), not
    // a reinterpretation.
    ps.batteryDetail ??= {};
    if (rb.energyFullDesignWh != null) {
      ps.batteryDetail.static = { ...(ps.batteryDetail.static ?? {}), DesignedCapacity: Math.round(rb.energyFullDesignWh * 1000) };
    }
    if (rb.energyFullWh != null) {
      ps.batteryDetail.fullCharge = { ...(ps.batteryDetail.fullCharge ?? {}), FullChargedCapacity: Math.round(rb.energyFullWh * 1000) };
    }
    if (rb.temperatureC != null) {
      ps.hardwareMonitor = {
        ...(ps.hardwareMonitor ?? {}),
        batteryTemperatureC: ps.hardwareMonitor?.batteryTemperatureC ?? rb.temperatureC,
      };
    }

    // batteryDetail.cycle.CycleCount deliberately does NOT follow the "rust when present, else
    // PS" pattern above - it always takes rust's own verdict (present or null), overwriting
    // whatever root/wmi's BatteryCycleCount produced, never falling back to a WMI-only number.
    // Cross-validated live on this real machine: root/wmi's CycleCount returned "0" with no error
    // (Active: true) for a battery already at 44% of design capacity per rust's own
    // energyFullWh/energyFullDesignWh calc - a genuinely 0-cycle battery would not be that
    // degraded - while rust's own independent read of the same physical battery (a different
    // Windows API, not WMI) returned null, i.e. genuinely unsupported by this EC. That
    // corroboration gap is the real signal: root/wmi's "0" here is very likely an unpopulated-
    // firmware default, not a true reading, so this only ever surfaces a cycle count when rust's
    // own reading corroborates the concept is actually supported on this hardware.
    ps.batteryDetail.cycle = { ...(ps.batteryDetail.cycle ?? {}), CycleCount: rb.cycleCount };
  }

  // storageHealth: additive OVERLAY, not a full-object replace - unlike cpu/memory/tpm above,
  // PS/smartctl's shape here is deeply nested (nvme_smart_health_information_log.percentage_used
  // /.power_on_hours/.data_units_written, temperature.current) while Rust's is a flat
  // {healthPercent, temperatureC, powerOnHours}. Replacing wholesale the way the original TPM
  // bug did would break every consumer of the nested shape at once: getStorageWearPercent
  // (src/app/lib/derived.ts, itself read by StorageCard, an AI Intel card, AIRiskOverviewCard,
  // and useTrendHistory's trend system - confirmed via grep, all four go through this one
  // function), plus ThermalCard's ssdTempC and HWComponentsSection's "TB Written" tile reading
  // storageHealth directly.
  //
  // Rust is authoritative for the three leaves it covers whenever it has them - flipped from an
  // earlier round, which only synthesized this when ps.storageHealth was entirely null (pure
  // gap-fill). Now ps.storageHealth's existing nested objects are spread first (so
  // data_units_written and everything else PS/smartctl provides survives untouched - Rust's SMART
  // query never captures data_units_written at all, so "TB Written" still only ever comes from
  // PS regardless of this flip), then Rust's percentage_used/power_on_hours/temperature.current
  // are overlaid on top of just those specific keys. PS is the fallback: used exactly as-is
  // whenever the Rust binary fails for the cycle (rust.storageHealth is null/absent, so this
  // entire block is skipped) or doesn't have a given value.
  if (rust.storageHealth) {
    const rh = rust.storageHealth;
    ps.storageHealth = { ...(ps.storageHealth ?? {}) };
    if (rh.healthPercent != null || rh.powerOnHours != null) {
      ps.storageHealth.nvme_smart_health_information_log = {
        ...(ps.storageHealth.nvme_smart_health_information_log ?? {}),
        ...(rh.healthPercent != null ? { percentage_used: 100 - rh.healthPercent } : {}),
        ...(rh.powerOnHours != null ? { power_on_hours: rh.powerOnHours } : {}),
      };
    }
    if (rh.temperatureC != null) {
      ps.storageHealth.temperature = { ...(ps.storageHealth.temperature ?? {}), current: rh.temperatureC };
    }
  }

  return ps;
}

async function collect() {
  const [{ err, stdout, stderr }, hardwareMonitor, rustResult] = await Promise.all([
    execTelemetryScript(),
    fetchHardwareMonitor(),
    execRustCollector(),
  ]);

  if (!loggedStartupDiagnostics) {
    loggedStartupDiagnostics = true;
    (stderr || "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .forEach((line) => {
        // Lines already carrying their own "[telemetry]" tag (e.g. the smartctl elevation
        // warning) print as-is; generic "[diag]" lines get it prepended for consistency.
        if (line.includes("[telemetry]")) {
          console.log(line);
        } else if (line.includes("[diag]")) {
          console.log("[telemetry]", line);
        }
      });
  }

  // The Rust binary is additive, not required - if it's missing, crashes, times out, or emits
  // invalid JSON, rustData stays null and mergeRustData(parsed, null) is a no-op, leaving the
  // PowerShell-only payload exactly as it was before this binary existed. This is the fallback
  // safety net: nothing about the PS path changes based on whether Rust succeeded.
  //
  // Logged on every OUTCOME CHANGE (tracked via lastRustOutcome), not just once ever - a
  // one-shot "log the first cycle only" gate (what this used to be) went completely silent if
  // the binary later disappeared mid-run, which is exactly the scenario worth telling an
  // operator about. Steady-state repeats of the same outcome stay quiet either way, so this
  // doesn't spam every 5s poll.
  let rustData = null;
  let rustOutcome;
  let rustParseError = null;
  if (rustResult.err) {
    rustOutcome = "unavailable";
  } else {
    try {
      rustData = JSON.parse(rustResult.stdout);
      rustOutcome = "ok";
    } catch (e) {
      rustOutcome = "invalid-json";
      rustParseError = e;
    }
  }

  // Real streak tracking, separate from the transition-only logging below - a single "warning"
  // event fired once on the way down is a real signal, but an easy one to lose in a busy fleet's
  // event window (the same class of gap the offline-detector's own one-time event had - see
  // deviceLiveness.js's comment on the dashboard side). rust-collector stopped being purely
  // additive once TPM device-signing (hardware-check's identity key) started living inside it, so
  // a machine stuck degraded for a real length of time now needs a real, hard-to-miss escalation.
  if (rustOutcome === "ok") {
    rustUnavailableSinceMs = null;
    rustDegradedEscalated = false;
  } else if (rustUnavailableSinceMs == null) {
    rustUnavailableSinceMs = Date.now();
  }

  if (rustOutcome !== lastRustOutcome) {
    // A real transition needs a genuine prior known state, not the initial null->whatever on
    // process startup - otherwise every fresh launch would log a redundant "became available"
    // event for a thing that was never observed to be down in the first place. Same choice made
    // for LHM (lastLhmOutcome) and the backend (lastBackendOutcome) below, for consistency.
    const isRealTransition = lastRustOutcome != null;
    if (rustOutcome === "unavailable") {
      console.error(
        `[telemetry] rust-collector unavailable (${rustResult.err.message}) - falling back to PowerShell-only data for the fields it would have refined (cpu/memory/secureBoot/bitlocker/tpm/gpu/network), losing HWiNFO as a hardwareMonitor source (LibreHardwareMonitor still works independently if it's running), and losing TPM device-signing (hardware-check can no longer produce a signed baseline). Storage is never sourced from it regardless (see mergeRustData's comment).`,
      );
      if (rustResult.err.killed) console.error(`[telemetry]   killed: true (signal: ${rustResult.err.signal ?? "unknown"}) - likely exceeded the ${RUST_TIMEOUT_MS}ms timeout`);
      if (rustResult.stderr) console.error("[telemetry]   rust-collector stderr:", rustResult.stderr.toString());
      if (isRealTransition) logEvent("hwinfo-unavailable", "rust-collector became unavailable - losing hardware refinement (cpu/memory/secureBoot/bitlocker/tpm/gpu/network), HWiNFO thermal data, and TPM device-signing.", "warning");
    } else if (rustOutcome === "invalid-json") {
      console.error(`[telemetry] rust-collector produced invalid JSON (${rustParseError.message}) - falling back to PowerShell-only data.`);
    } else {
      console.log(
        "[telemetry] rust-collector produced real data - merging cpu/memory/secureBoot/bitlocker/tpm/gpu/network fields, plus hwinfo's cpuVoltage/motherboardTempC/fanRpm into hardwareMonitor, where its output is genuinely usable.",
      );
      // The binary's own honest per-field diagnostics (e.g. TPM/BitLocker access-denied vs.
      // genuinely-unsupported) go to ITS stderr on every run, success or not - surfaced here on
      // the same transition-only cadence as the summary line above.
      if (rustResult.stderr) {
        rustResult.stderr
          .toString()
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .forEach((line) => console.log(line));
      }
      if (isRealTransition && lastRustOutcome === "unavailable") logEvent("hwinfo-available", "rust-collector (HWiNFO source) became available again.", "info");
    }
    lastRustOutcome = rustOutcome;
  }

  // The hard-to-miss escalation itself - fires once per continuous streak (rustDegradedEscalated
  // guards repeats), at "critical" severity so it can't blend into a busy fleet's warning-level
  // noise the way the transition event above honestly can.
  if (rustOutcome !== "ok" && !rustDegradedEscalated && rustUnavailableSinceMs != null && Date.now() - rustUnavailableSinceMs >= RUST_DEGRADED_ESCALATION_MS) {
    rustDegradedEscalated = true;
    logEvent(
      "rust-collector-degraded",
      `rust-collector has been unavailable for over ${Math.round(RUST_DEGRADED_ESCALATION_MS / 60000)} minutes - this device has been running without CPU/memory/secureBoot/bitlocker/TPM/GPU/network refinement, HWiNFO thermal data, and TPM device-signing (hardware-check baseline cannot be cryptographically signed) for that entire time.`,
      "critical",
    );
  }

  // smartctl/powercfg write [diag] lines to stderr and can leave a non-zero $LASTEXITCODE
  // even when stdout is complete JSON. Node then sets err. Treat valid JSON as success;
  // only fail when stdout cannot be parsed (timeout/kill, or a real script crash).
  let parsed;
  try {
    parsed = stdout ? JSON.parse(stdout) : null;
  } catch {
    parsed = null;
  }
  if (!parsed) {
    cache = {
      data: cache.data,
      error: stderr?.toString() || err?.message || "collection produced invalid JSON",
      updatedAt: new Date().toISOString(),
    };
    console.error("[telemetry] collection failed:", err?.message || "invalid JSON");
    if (err?.killed) console.error(`[telemetry]   killed: true (signal: ${err.signal ?? "unknown"}) - likely exceeded the ${SCRIPT_TIMEOUT_MS}ms timeout`);
    if (stderr) console.error("[telemetry]   stderr:", stderr.toString());
    return;
  }
  try {
    parsed.hardwareMonitor = mergeHwInfoIntoHardwareMonitor(hardwareMonitor, rustData?.hwinfo);
    // HWiNFO-only facts with no LibreHardwareMonitor equivalent and no PS-side counterpart to
    // preserve - a genuinely new top-level field, not merged into hardwareMonitor's LHM-shaped
    // object, since collapsing per-core voltages into that shape's single cpuVoltage would be
    // exactly the kind of misrepresentation this was added to avoid. Direct passthrough (not
    // mergeNonNull) is correct here: there is nothing else to preserve if rust is null this cycle.
    parsed.hwinfo = rustData?.hwinfo
      ? {
          perCoreVoltages: Array.isArray(rustData.hwinfo.perCoreVoltages) ? rustData.hwinfo.perCoreVoltages : [],
          pchTempC: rustData.hwinfo.pchTempC ?? null,
          spdHubTempC: rustData.hwinfo.spdHubTempC ?? null,
        }
      : null;
    mergeRustData(parsed, rustData);
    // Read, not fetched here - runBackendCycle updates this on its own slower
    // BACKEND_POLL_INTERVAL_MS cadence (see above). null means backend/ is unreachable or this
    // device isn't enrolled yet, same graceful-degradation convention as hardwareMonitor/hwinfo.
    parsed.entitlement = entitlementState;
    parsed.dbHealthy = dbHealthyState;
    parsed.scheduledTasks = scheduledTaskState;
    parsed.hardwareIntegrity = hardwareIntegrityState;
    parsed.predictions = predictionState;
    parsed.windowsUpdate = windowsUpdateState;
    parsed.biosFirmwareUpdate = biosFirmwareUpdateState;
    parsed.domainMdm = domainMdmState;
    parsed.windowsLicense = windowsLicenseState;
    // Direct replace - get-telemetry.ps1 no longer queries either of these itself (moved to the
    // hourly cadence above), so there's nothing on the fast path to preserve.
    parsed.driverVersions = driverVersionsState;
    parsed.fingerprintSensorPresent = fingerprintSensorState?.present ?? null;
    // TPM/BitLocker: a FALLBACK only, applied AFTER mergeRustData above already ran - rust's own
    // per-cycle, already-elevated read takes priority whenever it succeeds. Only fills in from the
    // hourly PS-side check when rust hasn't supplied a value this cycle (rust unavailable, or this
    // specific field came back null from it) - see tpmBitlockerFallbackState's own comment for why
    // this exists at all instead of just trusting rust alone.
    if (parsed.tpm == null) parsed.tpm = tpmBitlockerFallbackState?.tpm ?? null;
    if (parsed.bitlockerStatus == null) parsed.bitlockerStatus = tpmBitlockerFallbackState?.bitlockerStatus ?? null;
    // Additive overlay by drive letter, not a wholesale replace - parsed.logicalDisks is still the
    // FRESH 5s-cadence array (real-time Size/FreeSpace) from get-telemetry.ps1 itself;
    // diskEnrichmentState is the hourly-cached model/serial lookup. Same "overlay by key" pattern
    // mergeRustData already uses for GPU, for the same reason: two independently-cadenced sources
    // describing the same real entities need to be joined by a stable key, not one replacing the
    // other outright.
    if (Array.isArray(parsed.logicalDisks) && Array.isArray(diskEnrichmentState)) {
      const enrichByLetter = new Map(diskEnrichmentState.map((e) => [e.letter, e]));
      parsed.logicalDisks = parsed.logicalDisks.map((d) => {
        const letterMatch = typeof d?.DeviceID === "string" ? d.DeviceID.match(/^([A-Za-z]):/) : null;
        const enrich = letterMatch ? enrichByLetter.get(letterMatch[1]) : null;
        return enrich ? { ...d, DiskModel: enrich.diskModel, DiskSerial: enrich.diskSerial } : d;
      });
    }
    cache = { data: parsed, error: null, updatedAt: new Date().toISOString() };

    // Fire-and-forget (not awaited) - see postLiveStatus's own comment on why this must never
    // hold up the next real hardware poll. deviceCredentials is read, not fetched here -
    // runBackendCycle's own registration flow (loadOrRegisterDevice) is what sets it.
    if (deviceCredentials) {
      postLiveStatus(deviceCredentials, extractLiveStatusFields(parsed)).catch(() => {});
    }
  } catch (e) {
    cache = {
      data: cache.data,
      error: `JSON parse error: ${e.message}`,
      updatedAt: new Date().toISOString(),
    };
  }
}

// setInterval(collect, POLL_INTERVAL_MS) would fire every 5s regardless of whether the
// previous collect() had finished - since a real cycle takes ~6-20s depending on WMI provider
// warm-state (re-measured directly, see SCRIPT_TIMEOUT_MS's comment), that would stack up
// multiple concurrent powershell.exe executions indefinitely. This self-reschedules only after
// the current cycle resolves, waiting out whatever's left of POLL_INTERVAL_MS (0 if the cycle
// already ran long, so it just starts the next one immediately rather than piling up).
async function pollLoop() {
  for (;;) {
    const start = Date.now();
    await collect();
    const elapsed = Date.now() - start;
    const delay = Math.max(0, POLL_INTERVAL_MS - elapsed);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}
pollLoop();
backendPollLoop();

// A bare http.createServer request listener has no built-in try/catch - a synchronous throw
// inside it is an uncaught exception that takes down the whole Node process (this collector,
// not just the one request), unlike an Express-style framework that wraps handlers by default.
// JSON.stringify(cache) is not expected to ever throw (cache is always a plain {data, error,
// updatedAt} shape built from JSON.parse'd data plus primitive overlays, never anything
// circular or a BigInt), but the cost of this try/catch is a few lines against "one malformed
// response takes down telemetry for the whole dashboard until someone notices and restarts it."
const server = createServer((req, res) => {
  try {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    const requestedHeaders = req.headers["access-control-request-headers"];
    res.setHeader("Access-Control-Allow-Headers", requestedHeaders || "Content-Type, Authorization");

    // Browser POSTs from the agent UI (Vite 5173 / Tauri) send a CORS preflight. Without this
    // OPTIONS 204, the real POST never leaves the browser — it surfaces as "Failed to fetch".
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    res.setHeader("Content-Type", "application/json");

    if (req.url === "/api/telemetry") {
      res.writeHead(200);
      res.end(JSON.stringify(cache));
      return;
    }

    // Checked BEFORE the generic /api/remote-session startsWith below, which would otherwise
    // wrongly swallow this more specific path too (it matches on prefix, not exact route).
    const endMatch = req.url?.match(/^\/api\/remote-session\/([^/]+)\/end$/);
    if (endMatch && req.method === "POST") {
      handleRemoteSessionEndProxy(endMatch[1], res);
      return;
    }

    if (req.url?.startsWith("/api/remote-session") && (req.method === "POST" || req.method === "GET")) {
      handleRemoteSessionCreate(req, res);
      return;
    }

    if (req.url === "/api/turn-credentials" && req.method === "GET") {
      handleTurnCredentialsProxy(res);
      return;
    }

    if (req.url === "/api/backend-url" && req.method === "GET") {
      handleBackendUrlProxy(res);
      return;
    }

    if (req.url === "/api/backend-url" && req.method === "POST") {
      handleBackendUrlUpdate(req, res);
      return;
    }

    if (req.url === "/api/enrollment" && req.method === "GET") {
      handleEnrollmentStatus(res);
      return;
    }

    if (req.url === "/api/agent-latest" && req.method === "GET") {
      handleAgentLatestProxy(res);
      return;
    }

    if (req.url === "/api/event-retention" && req.method === "GET") {
      handleEventRetentionProxy(res);
      return;
    }

    if (req.url === "/api/event" && req.method === "POST") {
      handleEventCreateProxy(req, res);
      return;
    }

    if (req.url?.startsWith("/api/events") && req.method === "GET") {
      handleEventsListProxy(req, res);
      return;
    }

    if (req.url === "/api/remediate" && req.method === "POST") {
      handleRemediateProxy(req, res);
      return;
    }

    if (req.url === "/api/remediation-status" && req.method === "GET") {
      handleRemediationStatusProxy(req, res);
      return;
    }

    if (req.url === "/api/high-impact/request" && req.method === "POST") {
      handleHighImpactRequestProxy(req, res);
      return;
    }

    if (req.url === "/api/high-impact/check" && req.method === "POST") {
      handleHighImpactCheckProxy(req, res);
      return;
    }

    if (req.url === "/api/support-chat" && req.method === "POST") {
      handleSupportChat(req, res);
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: "not found" }));
  } catch (e) {
    console.error("[telemetry] request handler threw:", e.message);
    try {
      res.writeHead(500);
      res.end(JSON.stringify({ error: "internal error" }));
    } catch {
      // Response may already be partially sent - nothing more we can safely do.
    }
  }
});

server.listen(PORT, () => {
  console.log(`[telemetry] serving http://localhost:${PORT}/api/telemetry (refresh every ${POLL_INTERVAL_MS / 1000}s)`);
});
