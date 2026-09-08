import { useEffect, useRef, useState } from "react";
import { loadJSON, saveJSON } from "../lib/storage";

export type CpuTelemetry = {
  Manufacturer: string;
  Name: string;
  NumberOfCores: number;
  NumberOfLogicalProcessors: number;
  MaxClockSpeed: number;
  CurrentClockSpeed: number;
  L2CacheSize: number;
  L3CacheSize: number;
  LoadPercentage: number | null;
};

export type MemoryModule = {
  Manufacturer: string;
  PartNumber: string;
  SerialNumber: string;
  Capacity: number;
  Speed: number;
  ConfiguredClockSpeed: number;
  DeviceLocator: string;
  MemoryType: number;
};

export type StorageDevice = {
  Model: string;
  SerialNumber: string;
  Size: number;
  InterfaceType: string;
  MediaType: string;
};

export type BatteryTelemetry = {
  Name: string;
  EstimatedChargeRemaining: number;
  BatteryStatus: number;
  DesignCapacity: number | null;
  FullChargeCapacity: number | null;
};

export type GpuTelemetry = {
  Name?: string;
  AdapterRAM?: number | null;
  DriverVersion?: string;
  AdapterCompatibility?: string;
  AdapterRAMUnreliable?: boolean;
};

export type NetworkAdapterTelemetry = {
  Name: string;
  MACAddress: string;
  AdapterType: string;
};

export type OsDetailTelemetry = {
  Caption: string;
  BuildNumber: string;
  Version: string;
  LastBootUpTime: string | null;
  UptimeFormatted: string | null;
  OSArchitecture: string | null;
};

export type BoardTelemetry = {
  Product: string;
  SerialNumber: string;
};

export type EnclosureTelemetry = {
  SMBIOSAssetTag: string | null;
};

export type ThermalZone = {
  InstanceName: string;
  CurrentTemperature: number;
};

export type TpmTelemetry = {
  ManufacturerIdTxt: string;
  ManufacturerVersion: string;
  SpecVersion: string;
  IsActivated_InitialValue: boolean;
  IsEnabled_InitialValue: boolean;
} | null;

// root/wmi battery classes — more reliable than Win32_Battery, but each independently
// absent on some OEMs/hardware (e.g. BatteryStaticData is missing on this dev machine).
export type BatteryDetail = {
  status: {
    Voltage: number; // millivolts
    ChargeRate: number;
    DischargeRate: number;
    RemainingCapacity: number;
    Charging: boolean;
    Discharging: boolean;
    PowerOnline: boolean;
    Critical: boolean;
  } | null;
  static: {
    DesignedCapacity: number;
    DeviceName: string;
    ManufactureDate: string | null;
  } | null;
  fullCharge: {
    FullChargedCapacity: number;
  } | null;
  cycle: {
    CycleCount: number;
  } | null;
};

// smartctl -j output — shape varies by drive/tool version; only the two paths this app
// actually reads are typed, everything else in the real payload is left unmodeled.
export type StorageHealth = {
  nvme_smart_health_information_log?: {
    percentage_used?: number;
    // Units of 1000 x 512 bytes (512,000 bytes each) per the NVMe spec - not raw bytes.
    data_units_written?: number;
  };
  temperature?: {
    current?: number;
    // The drive's own vendor-reported warning/critical points (NVMe Identify Controller's WCTEMP/
    // CCTEMP, surfaced by smartctl as op_limit_max/critical_limit_max) - a real per-device value,
    // not a guessed constant, used by getThermalRows' SSD row when present.
    op_limit_max?: number;
    critical_limit_max?: number;
  };
  // smartctl -a -j serial_number - the vendor serial (this Micron: 22163798620F), not
  // Win32_DiskDrive's NVMe NGUID (0000_0000_...EUI).
  serial_number?: string;
  // Raw smartctl firmware_version string - already the real SSD firmware version this app
  // reports elsewhere; the Drivers & Firmware card reuses it rather than a separate query.
  firmware_version?: string;
} | null;

export type WifiInfo = {
  signalPercent: string | null;
  receiveRateMbps: string | null;
  state: string | null;
  ssid: string | null;
} | null;

export type LogicalDisk = {
  DeviceID: string;
  Size: number;
  FreeSpace: number;
  VolumeName?: string | null;
  FileSystem?: string | null;
  DiskModel?: string | null;
  DiskSerial?: string | null;
};

// Win32_Battery.EstimatedRunTime, with Windows' "not currently calculable" sentinel
// (71582788) already normalized to null by the collector.
export type BatteryRunTimeMinutes = number | null;

// powercfg /batteryreport - independent of root/wmi's BatteryStaticData, which is absent
// on some OEMs. Fields are individually null if the report couldn't be generated or parsed.
export type BatteryReportHealth = {
  designCapacityMwh: number | null;
  fullChargeCapacityMwh: number | null;
};

// LibreHardwareMonitor's Remote Web Server (localhost:8085/data.json) - a separate app the
// user must install and run themselves; null whenever it's not reachable. Each sensor field
// is independently null if that specific sensor wasn't found in the tree (varies by hardware/BIOS).
export type HardwareMonitorSnapshot = {
  cpuTempC: number | null;
  gpuTempC: number | null;
  motherboardTempC: number | null;
  // Hottest DIMM SPD temp from LibreHardwareMonitor (`DIMM #N`). Distinct from motherboardTempC:
  // this machine has no Super I/O / EC board sensor, but it does expose real DIMM thermals.
  dimmTempC: number | null;
  fanRpm: number | null;
  cpuVoltage: number | null;
  batteryTemperatureC: number | null;
  // LHM's own independent battery-health calculation (converted from its "Degradation Level"
  // sensor, which is the inverse - capacity lost rather than capacity remaining).
  batteryHealthLhmPercent: number | null;
  // LHM's own independent remaining-time estimate, normalized to minutes.
  batteryRemainingTimeLhm: number | null;
  // Minimum "Distance to TjMax" (°C margin before throttling) across all CPU cores - a real,
  // hardware-reported per-core value (Intel's Digital Thermal Sensor), not derived from
  // cpuTempC above. The worst-case core, not an average - one hot core throttles the whole
  // chip regardless of the others. null when LHM doesn't expose this on this hardware.
  cpuMinDistanceToTjMaxC: number | null;
  // Hardware node Text from LHM (`/gpu-intel/0`, `/gpu-nvidia/0`, …) when WMI Name is empty.
  gpuName?: string | null;
} | null;

export type HwInfoPerCoreVoltage = { label: string; volts: number };

// HWiNFO shared-memory facts with no LibreHardwareMonitor equivalent (see
// local-agent/rust-collector/src/hwinfo.rs) - kept separate from HardwareMonitorSnapshot rather than
// folded into its cpuVoltage/motherboardTempC fields, since these are different underlying
// sensors (per-core/rail VID readings, PCH temp, SPD hub temp), not a second measurement of
// the same three facts. perCoreVoltages is an empty array (not null) when HWiNFO is reachable
// but this hardware exposes none - null propagates from the whole `hwinfo` object being null
// instead, i.e. "HWiNFO itself unavailable this cycle."
export type HwInfoSnapshot = {
  perCoreVoltages: HwInfoPerCoreVoltage[];
  pchTempC: number | null;
  spdHubTempC: number | null;
} | null;

// backend/ (the Cloud Command Center Go service, PRD §7/§13) - a real but optional source,
// fetched by local-agent/server/telemetry-server.mjs on its own slower interval
// (BACKEND_POLL_INTERVAL_MS) and merged in here, not fetched directly by the frontend. null
// means the backend isn't reachable or this device hasn't enrolled yet - never a fake plan name.
export type EntitlementSnapshot = {
  plan: string;
  status: string;
  expiresAt: string | null;
  // Real backend.countDevicesByTenant + entitlements.licensed_devices - null when the backend
  // couldn't supply a licensed seat count (e.g. a database mid-upgrade, see the backend's own
  // ensureLicensedDevicesColumn comment), not a fabricated ratio.
  deviceCount: { used: number; licensed: number } | null;
  // Real, plan-wide feature rows from the backend's plan_features table. A feature name with no
  // entry here means "unknown for this plan", not "excluded" - callers must tell the two apart.
  features: { feature: string; included: boolean }[];
  // This device's own real device-registry lifecycle state ("active" or "revoked", see
  // backend's schema.sql comment) - null only if the backend response predates this field.
  deviceStatus: string | null;
  // Real, honest v1 of PRD §6.4's Warranty State Machine (backend's warranty.go) - "Active",
  // "Warning", or "Expired" derived live from baseline-tamper/device-identity signals and real
  // entitlement standing. null means no hardware baseline is locked yet to derive it from.
  warrantyState: "Active" | "Warning" | "Expired" | null;
  // PRD §7's real 72h offline-tolerance window (telemetry-server.mjs's resolveEntitlementState) -
  // lastVerifiedAt is when this data was last actually confirmed via a successful fetch (whether
  // this exact response is fresh or served from local-agent's on-disk cache). stale is true only
  // when today's live fetch failed and this is a cached read; unverified is true only once that
  // cached read is older than the 72h tolerance - a third, honest state distinct from both a live
  // status and the null above (which means never once verified at all, nothing to fall back to).
  lastVerifiedAt: string;
  stale: boolean;
  unverified: boolean;
} | null;

// Real backend.compareFingerprints result (Hardware page's Tamper Detection) - updated by
// telemetry-server.mjs on its own slower HARDWARE_CHECK_INTERVAL_MS cadence (~5 minutes), not
// every 5s poll. null means no real hardware check has completed yet (not enrolled, backend
// unreachable, or the very first check hasn't run) - "Baseline Pending", never a fabricated
// "Clear". "baseline-set" is this device's very first real check (nothing to compare against
// yet, so nothing can have mismatched); "match"/"mismatch" are every check after.
export type HardwareIntegritySnapshot = {
  status: "baseline-set" | "match" | "mismatch";
  mismatchedFields: string[];
} | null;

// ai-service's real per-metric regression result (AI Intel's SSD/Battery Remaining Life) -
// "insufficient-data" while fewer than minRequired (3) real days exist for that specific metric
// (daysOfHistory counts only this metric's own non-null days, independent of the other metric -
// see ai-service/app.py's evaluate_metric), "already-past-threshold" when the most recent real
// reading is already at/beyond the real degradation threshold, "stable" when the real trend
// isn't moving toward it at all (never a fabricated projection for either case), and "ok" for a
// genuine 3+ point linear regression with a real projected days-remaining + risk tier.
export type MetricPrediction =
  | { status: "insufficient-data"; daysOfHistory: number; minRequired: number }
  | { status: "already-past-threshold"; currentValue: number; daysOfHistory: number }
  | { status: "stable"; currentValue: number; daysOfHistory: number }
  | { status: "ok"; currentValue: number; daysRemaining: number; risk: "Low" | "Medium" | "High"; daysOfHistory: number };

// Updated by telemetry-server.mjs at most once per real calendar day (matching the snapshot
// cadence) - null means no real prediction has ever completed yet (not enrolled, backend/
// ai-service unreachable, or the very first day hasn't finished), read as "Collecting data (day
// 0 of 3)" everywhere this is consumed, never a fabricated projection.
export type PredictionsSnapshot = {
  battery: MetricPrediction;
  ssd: MetricPrediction;
} | null;

export type TelemetrySnapshot = {
  timestamp: string;
  system: { Vendor: string; Name: string; IdentifyingNumber: string; UUID: string };
  bios: { Manufacturer: string; SMBIOSBIOSVersion: string; ReleaseDate: string; SerialNumber: string };
  cpu: CpuTelemetry;
  memory: { modules: MemoryModule[]; freeKB: number; totalKB: number };
  storage: StorageDevice[];
  battery: BatteryTelemetry[];
  gpu: GpuTelemetry[];
  network: NetworkAdapterTelemetry[];
  osDetail: OsDetailTelemetry;
  board: BoardTelemetry;
  enclosure: EnclosureTelemetry;
  thermal: ThermalZone[];
  tpm: TpmTelemetry;
  batteryDetail: BatteryDetail;
  storageHealth: StorageHealth;
  gpuUtilization: number | null;
  wifi: WifiInfo;
  logicalDisks: LogicalDisk[];
  batteryRunTimeMinutes: BatteryRunTimeMinutes;
  batteryReportHealth: BatteryReportHealth;
  hardwareMonitor: HardwareMonitorSnapshot;
  hwinfo: HwInfoSnapshot;
  entitlement: EntitlementSnapshot;
  // Confirm-SecureBootUEFI - throws on legacy BIOS (non-UEFI) systems and can require elevation
  // beyond what's already guaranteed on some configurations; null covers both cases the same way.
  secureBootEnabled: boolean | null;
  // Get-BitLockerVolume's ProtectionStatus ("On"/"Off") - null if the BitLocker module isn't
  // present (e.g. Windows Home) or the query otherwise fails.
  bitlockerStatus: string | null;
  // $env:firmware_type ("UEFI" or "Legacy") - null if unset/unrecognized.
  bootMode: "UEFI" | "Legacy" | null;
  // First non-link-local IPv4 address on a Wi-Fi/Ethernet adapter - null if neither has one.
  localIp: string | null;
  // Win32_PnPSignedDriver, matched per-category against this machine's actual driver list
  // (get-telemetry.ps1) - null per category when no device on this machine matches that
  // category's pattern. BIOS/SSD firmware and GPU driver version already have real sources
  // elsewhere (bios.SMBIOSBIOSVersion, storageHealth, gpu[].DriverVersion) and aren't
  // duplicated here.
  driverVersions: {
    chipset: DriverVersionEntry;
    intelMe: DriverVersionEntry;
    wifi: DriverVersionEntry;
    audio: DriverVersionEntry;
    bluetooth: DriverVersionEntry;
  };
  // dsregcmd /status, parsed for AzureAdJoined/DomainJoined/EnterpriseJoined - null (not
  // "false") if dsregcmd is missing or its output didn't match the expected format, so
  // "genuinely not enrolled" stays distinct from "couldn't determine".
  mdmEnrollment: { azureAdJoined: boolean; domainJoined: boolean; enterpriseJoined: boolean } | null;
  // Real Win32_PnPEntity presence check (PNPClass='Biometric', name matching "Fingerprint") -
  // null only if the query itself failed, never a guess. Deliberately presence, not enrollment -
  // see get-telemetry.ps1's own comment on why real WinBio enrollment status isn't reliably
  // determinable here.
  fingerprintSensorPresent: boolean | null;
  // Real GET /v1/health result (telemetry-server.mjs's runBackendCycle, same cadence as
  // entitlement) - true (backend reachable, DB query succeeded), false (backend reachable, DB
  // query itself failed), or null (backend unreachable at all - a different fact from "false").
  dbHealthy: boolean | null;
  // Real `schtasks /Query /TN <name> /V /FO LIST` result per task, same cadence as entitlement.
  // Each is null only if the check itself couldn't determine an answer (not "not registered" -
  // that's a real `false`, since schtasks reports it as a real, determinate failure).
  scheduledTasks: {
    telemetryServer: boolean | null;
    commandCenter: boolean | null;
    frontend: boolean | null;
    libreHardwareMonitor: boolean | null;
    // The Tauri desktop app's own Scheduled Task - replaced tauri-plugin-autostart's Run key
    // entirely, so this is now the sole real signal for the desktop app's auto-start (see
    // Settings' "Launch on Startup" aggregate, which folds this in rather than exposing a
    // separate per-app toggle).
    desktopApp: boolean | null;
    // ai-service's own Scheduled Task (PulseEndpointAiService) - same real auto-start/crash-
    // recovery mechanism as the other five, added so SSD/Battery Remaining Life predictions can
    // actually accumulate without a human manually starting ai-service every session.
    aiService: boolean | null;
  } | null;
  hardwareIntegrity: HardwareIntegritySnapshot;
  predictions: PredictionsSnapshot;
  // Real Windows Update Agent search (Microsoft.Update.Session COM object, IsInstalled=0 and
  // Type='Software') - telemetry-server.mjs refreshes this at most once an hour (the search
  // itself takes ~17s, confirmed directly, far too slow for every 5s poll). null means no real
  // search has ever completed yet (WUA unreachable, the COM call failed, or the very first check
  // hasn't run) - the OS card reads this as "Unknown", never a fabricated "Up to date".
  windowsUpdate: { upToDate: boolean; pendingCount: number; checkedAt: string } | null;
  // Same Windows Update Agent search mechanism as windowsUpdate above, but Type='Driver'
  // filtered to real system-firmware entries specifically (DriverClass='Firmware', DriverModel
  // starting with "System Firmware") - confirmed directly that Dell genuinely publishes BIOS
  // updates through Windows Update this way on this machine. null means no real search has ever
  // completed yet - the Hardware page's BIOS tile reads this as "Unknown", never a fabricated
  // "Up to date".
  biosFirmwareUpdate: { updateAvailable: boolean; latestVersion: string | null; checkedAt: string } | null;
};

type DriverVersionEntry = { deviceName: string; version: string; date: string | null } | null;

type TelemetryState = {
  data: TelemetrySnapshot | null;
  error: string | null;
  updatedAt: string | null;
  connected: boolean;
};

export type UseTelemetryResult = TelemetryState & {
  // See hasReceivedRealData's own module-level comment - true until the first real (non-null)
  // telemetry payload has ever arrived this session, then permanently false. Not the same thing
  // as `!connected`: a later real disconnect doesn't bring this back.
  isFirstLoad: boolean;
};

const TELEMETRY_URL = "http://127.0.0.1:4317/api/telemetry";
const POLL_MS = 5000;
const FETCH_TIMEOUT_MS = 8000;
const FIRST_LOAD_GIVE_UP_MS = 10000;

// Real, persisted pause switch - the consolidated "Auto Monitoring" setting (Settings' old
// Hardware Monitoring/Performance Metrics/Telemetry Data/Auto Monitoring were four decorative
// toggles for this exact one real concept). Module-level, not per-hook-instance state, for the
// same reason telemetryWasDisconnected below is: every call site of useTelemetry() polls
// independently, so a real pause needs to stop every currently-mounted instance at once, not
// just whichever one owns the toggle that was clicked. telemetryEnabledListeners is how each
// mounted instance learns about a change immediately instead of waiting for its own next
// scheduled tick (there won't be one while paused - see poll()'s own comment below).
const TELEMETRY_ENABLED_KEY = "clpa:settings:telemetry-enabled:v1";
let telemetryEnabled = loadJSON(TELEMETRY_ENABLED_KEY, true);
const telemetryEnabledListeners = new Set<(enabled: boolean) => void>();

export function isTelemetryEnabled(): boolean {
  return telemetryEnabled;
}

// Real: actually starts/stops every currently-mounted useTelemetry() instance's own poll loop
// right away, not just a flag some future poll happens to notice.
export function setTelemetryEnabled(enabled: boolean): void {
  if (telemetryEnabled === enabled) return;
  telemetryEnabled = enabled;
  saveJSON(TELEMETRY_ENABLED_KEY, enabled);
  telemetryEnabledListeners.forEach((listener) => listener(enabled));
}

// Module-level, not per-hook-instance state: every call site of useTelemetry() polls
// independently on its own timer (see the file-level comment this hook has always had on that),
// so tracking "was this disconnected before" as component state would make every currently-
// mounted component independently detect the same reconnection and each log a duplicate event.
// A shared flag means whichever poll() callback's turn happens to run first after a real
// reconnect is the one that logs it - JS's single-threaded event loop makes the read-then-set
// below atomic with respect to every other poll() callback, so this can't double-log even
// though several are running on their own uncoordinated timers.
let telemetryWasDisconnected = false;

// True once ANY poll (across every mounted useTelemetry() instance - see
// telemetryWasDisconnected's own comment on why this has to be module-level, not per-instance
// state) has genuinely received real data, never reset afterward for the lifetime of this page/
// process. Deliberately distinct from `connected`: the telemetry server's HTTP endpoint can
// respond 200 before its very first real collect() cycle has finished (it always serves
// whatever `cache` currently holds, even the all-null shape it starts with - see
// telemetry-server.mjs's own /api/telemetry handler), so `connected: true` alone does not mean
// real data has actually arrived yet. This is what the app's own first-load "Starting up /
// Connecting to agent..." screen gates on (see AppShell), not `connected`.
let hasReceivedRealData = false;

// Real, once-per-process-start startup-timing milestones, written to localStorage rather than
// only console.log'd - specifically so they survive being read back after a real reboot, when
// this app auto-launches (Tauri autostart) before any debugger could be attached in time to
// catch a live console line. STARTUP_MODULE_LOAD_KEY is stamped once below, the instant this
// module's top-level code runs (about as early as this app's own JS can observe "I've started"
// - close to, but necessarily slightly after, the real OS process launch time, which has to be
// measured externally via the process's own StartTime for the true end-to-end number).
const STARTUP_MODULE_LOAD_KEY = "clpa:startup:module-load-at";
const STARTUP_CONNECTED_KEY = "clpa:startup:first-connected-at";
const STARTUP_REAL_DATA_KEY = "clpa:startup:first-real-data-at";

try {
  localStorage.setItem(STARTUP_MODULE_LOAD_KEY, String(Date.now()));
  // Cleared (not left stale) on every real process start, so a reboot test reading these back
  // afterward can't mistake a previous run's timestamps for this one's.
  localStorage.removeItem(STARTUP_CONNECTED_KEY);
  localStorage.removeItem(STARTUP_REAL_DATA_KEY);
} catch {
  // localStorage unavailable (rare) - startup timing just won't be recorded this run, the rest
  // of the app is unaffected either way.
}

// Real, durable event log via local-agent's proxy - see useAlertEngine.ts's postRealEvent for
// the same pattern/reasoning (best-effort, browser never holds a device API key).
function logTelemetryReconnected() {
  fetch("http://127.0.0.1:4317/api/event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      eventType: "telemetry-reconnected",
      message: "Dashboard reconnected to the local telemetry server.",
      severity: "info",
    }),
  }).catch(() => {
    // Best-effort - see postRealEvent's own comment in useAlertEngine.ts.
  });
}

export function useTelemetry() {
  const [state, setState] = useState<TelemetryState>({
    data: null,
    error: null,
    updatedAt: null,
    connected: false,
  });
  // Per-instance reactive mirror of the module-level telemetryEnabled flag (see its own comment
  // above) - lets THIS component re-render with the current value, even though the flag itself
  // lives outside React state so every mounted instance can share and react to one real switch.
  const [enabled, setEnabled] = useState(telemetryEnabled);
  const timer = useRef<number | null>(null);
  const [startupTimedOut, setStartupTimedOut] = useState(false);

  useEffect(() => {
    const t = window.setTimeout(() => setStartupTimedOut(true), FIRST_LOAD_GIVE_UP_MS);
    return () => window.clearTimeout(t);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      // Real pause - genuinely stops here, not just skips displaying the result. No recursive
      // reschedule below either (see the `finally` block), so this instance goes fully idle
      // until handleEnabledChange's own `poll()` call (below) restarts it - not a busy-loop
      // that keeps checking the flag every POLL_MS while paused.
      if (!telemetryEnabled) return;
      const controller = new AbortController();
      const abortTimer = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(TELEMETRY_URL, { cache: "no-store", signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        // Read-then-set with no `await` in between - atomic with respect to every other
        // poll() callback across every mounted useTelemetry() instance (see
        // telemetryWasDisconnected's own module-level comment on why this has to be shared,
        // not per-instance state, and why this specific ordering is what avoids duplicates).
        if (telemetryWasDisconnected) {
          telemetryWasDisconnected = false;
          logTelemetryReconnected();
        }
        // Real startup-timing milestones (see this block's own module-level comment) - each
        // only ever recorded once, the first time it genuinely becomes true this process start.
        try {
          if (!localStorage.getItem(STARTUP_CONNECTED_KEY)) {
            localStorage.setItem(STARTUP_CONNECTED_KEY, String(Date.now()));
            console.log(`[startup] first connected:true at ${new Date().toISOString()}`);
          }
        } catch {
          // Non-fatal - see the module-level try/catch's own comment.
        }
        if (json.data !== null) {
          if (!hasReceivedRealData) {
            hasReceivedRealData = true;
            try {
              localStorage.setItem(STARTUP_REAL_DATA_KEY, String(Date.now()));
            } catch {
              // Non-fatal - see the module-level try/catch's own comment.
            }
            console.log(`[startup] first real telemetry data at ${new Date().toISOString()}`);
          }
        }
        if (!cancelled) {
          setState({
            data: json.data,
            error: json.error,
            updatedAt: json.updatedAt,
            connected: true,
          });
        }
      } catch (e) {
        // Only the reconnect direction is loggable - logging "disconnected" would need a POST
        // to the very telemetry server just declared unreachable, which would simply fail to
        // deliver (the same structural reason backend-unreachable isn't logged either, see
        // runBackendCycle's own comment in telemetry-server.mjs).
        telemetryWasDisconnected = true;
        if (!cancelled) {
          setState((prev) => ({
            ...prev,
            connected: false,
            error: e instanceof Error ? e.message : String(e),
          }));
        }
      } finally {
        window.clearTimeout(abortTimer);
        // Also re-checks telemetryEnabled here, not just at poll()'s own top - it could have
        // been turned off while this exact fetch was still in flight; rescheduling anyway would
        // mean "paused" doesn't take effect until the in-flight request's own next tick.
        if (!cancelled && telemetryEnabled) {
          timer.current = window.setTimeout(poll, POLL_MS);
        }
      }
    }

    // Reacts to setTelemetryEnabled being called from anywhere (e.g. Settings' Auto Monitoring
    // toggle) - immediately, not on this instance's own next scheduled tick, since there won't
    // be one once paused (see poll()'s own comment above).
    function handleEnabledChange(nowEnabled: boolean) {
      setEnabled(nowEnabled);
      if (nowEnabled) {
        // Resume right away rather than waiting up to POLL_MS for a timer that was never set.
        poll();
      } else {
        // Stop for real: clear any in-flight schedule and mark disconnected so the UI doesn't
        // keep showing the last real reading as if it were still live while nothing is actually
        // being fetched anymore - the same honest "not connected" state every other real
        // disconnect in this app already renders correctly.
        if (timer.current != null) {
          window.clearTimeout(timer.current);
          timer.current = null;
        }
        if (!cancelled) setState((prev) => ({ ...prev, connected: false }));
      }
    }

    telemetryEnabledListeners.add(handleEnabledChange);
    if (telemetryEnabled) poll();

    return () => {
      cancelled = true;
      telemetryEnabledListeners.delete(handleEnabledChange);
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, []);

  // Computed fresh on every call, not its own useState - hasReceivedRealData is mutated
  // synchronously in the very setState call that then triggers this re-render, so by the time
  // this line runs again it already reflects the update; no extra state needed for it to be
  // correct on the render where it actually flips.
  //
  // telemetryEnabled is deliberately included in isFirstLoad's own condition, not just
  // !hasReceivedRealData alone: without it, a device that starts up with monitoring already
  // paused (a real, persisted choice from a previous session) would show "Starting up..."
  // forever, since hasReceivedRealData can now genuinely never become true while paused - and
  // that startup screen blocks the whole app, including the one place (Settings) a user would
  // need to reach to turn monitoring back on. Being intentionally paused is not "still loading."
  return { ...state, isFirstLoad: telemetryEnabled && !hasReceivedRealData && !startupTimedOut, telemetryEnabled: enabled };
}
