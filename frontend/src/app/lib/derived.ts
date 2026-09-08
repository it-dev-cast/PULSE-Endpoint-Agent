// Single-source derivations shared across the Dashboard, Hardware, and AI Intel pages.
//
// Every function here takes the raw `data`/`connected` from useTelemetry() (or, where the
// formula doesn't need raw telemetry, the already-extracted numbers) and returns the exact same
// value every card computes - so the same underlying reality is never independently
// recalculated in more than one place. If a formula ever needs to change, it changes here once.
//
// Every getter below is gated on `connected` at the point it returns a non-null value (not just
// on the presence of a field in `data`) - `data` is intentionally NOT cleared by useTelemetry()
// when the connection drops (only `connected` flips to false), so any derivation that checked
// `data?.foo != null` alone would keep showing a stale real-looking value after disconnect.
import type { TelemetrySnapshot } from "../hooks/useTelemetry";

type Snapshot = TelemetrySnapshot | null | undefined;

// ─── Battery health ───────────────────────────────────────
// WMI (root/wmi BatteryStaticData + BatteryFullChargedCapacity) -> powercfg /batteryreport ->
// LibreHardwareMonitor's Degradation Level, in that priority order. Each tier is independently
// absent on some hardware/OEM (root/wmi's BatteryStaticData is missing on the dev machine this
// was built on, which is why the powercfg and LHM fallbacks exist at all). Not averaged or
// reconciled across tiers - whichever is first available wins.
export function getBatteryHealthPercent(data: Snapshot, connected: boolean): number | null {
  const designedCapacity = data?.batteryDetail?.static?.DesignedCapacity;
  const fullChargedCapacity = data?.batteryDetail?.fullCharge?.FullChargedCapacity;
  const healthPctFromWmi =
    connected && designedCapacity != null && fullChargedCapacity != null && designedCapacity > 0
      ? Math.round((fullChargedCapacity / designedCapacity) * 100)
      : null;

  const reportHealth = data?.batteryReportHealth;
  const healthPctFromReport =
    connected && reportHealth?.designCapacityMwh != null && reportHealth?.fullChargeCapacityMwh != null && reportHealth.designCapacityMwh > 0
      ? Math.round((reportHealth.fullChargeCapacityMwh / reportHealth.designCapacityMwh) * 100)
      : null;

  const healthPctFromLhm =
    connected && data?.hardwareMonitor?.batteryHealthLhmPercent != null ? data.hardwareMonitor.batteryHealthLhmPercent : null;

  return healthPctFromWmi ?? healthPctFromReport ?? healthPctFromLhm;
}

// Remaining design capacity inverted: 44% health → 56% wear. Named so a card cannot show
// health under a "Wear" label (or the reverse) by accident.
export function getBatteryWearPercent(data: Snapshot, connected: boolean): number | null {
  const health = getBatteryHealthPercent(data, connected);
  return health != null ? 100 - health : null;
}

// Win32_Battery.EstimatedChargeRemaining — current charge, not health/wear. Null when
// disconnected or the reading is missing; callers must not substitute a sample number that
// could be mistaken for the live health % on another page.
export function getBatteryChargePercent(data: Snapshot, connected: boolean): number | null {
  const remaining = data?.battery?.[0]?.EstimatedChargeRemaining;
  return connected && remaining != null ? remaining : null;
}

// Windows' own Win32_Battery.EstimatedRunTime (the collector already normalizes Windows'
// "not currently calculable" sentinel, e.g. while charging, to null) -> LibreHardwareMonitor's
// independent remaining-time estimate, in that priority order.
export function getBatteryRemainingMinutes(data: Snapshot, connected: boolean): number | null {
  const runTimeMinutes = connected && data?.batteryRunTimeMinutes != null ? data.batteryRunTimeMinutes : null;
  const runTimeMinutesLhm =
    connected && data?.hardwareMonitor?.batteryRemainingTimeLhm != null ? data.hardwareMonitor.batteryRemainingTimeLhm : null;
  return runTimeMinutes ?? runTimeMinutesLhm;
}

// "Xh Ym" with no trailing word - callers append their own surrounding text ("remaining", etc.).
export function formatMinutesAsHM(minutes: number | null): string | null {
  return minutes != null ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : null;
}

// ─── Storage wear / health ────────────────────────────────
// SMART percentage_used (0-100, 100 = end of rated endurance) from smartctl.exe - an optional
// external tool, null whenever it's not installed or the query fails.
export function getStorageWearPercent(data: Snapshot, connected: boolean): number | null {
  return connected && data?.storageHealth?.nvme_smart_health_information_log?.percentage_used != null
    ? data.storageHealth.nvme_smart_health_information_log.percentage_used
    : null;
}

// Simple inverse of wear % - the "health" framing used where a higher number should read as
// better (StorageCard), as opposed to wear/risk % where a higher number reads as worse.
export function storageWearToHealthPercent(wearPercent: number | null): number | null {
  return wearPercent != null ? Math.round(100 - wearPercent) : null;
}

// ─── CPU load / memory usage ──────────────────────────────
export function getCpuLoad(data: Snapshot, connected: boolean): number | null {
  return connected && data?.cpu?.LoadPercentage != null ? data.cpu.LoadPercentage : null;
}

export function getMemUsedPercent(data: Snapshot, connected: boolean): number | null {
  const totalKB = connected ? data?.memory?.totalKB : null;
  const freeKB = connected ? data?.memory?.freeKB : null;
  return totalKB != null && freeKB != null && totalKB > 0 ? Math.round(((totalKB - freeKB) / totalKB) * 100) : null;
}

// ─── Performance score ────────────────────────────────────
// Disclosed heuristic, not a validated model: 100 minus a penalty once CPU load or memory usage
// climbs past a comfortable 50% baseline, weighted equally between the two. Null (not a sample
// number) when either input is unavailable - callers decide their own sample fallback.
export function getPerformanceScore(cpuLoad: number | null, memUsedPct: number | null): number | null {
  if (cpuLoad == null || memUsedPct == null) return null;
  return Math.max(0, Math.min(100, Math.round(100 - 0.5 * Math.max(0, cpuLoad - 50) - 0.5 * Math.max(0, memUsedPct - 50))));
}

// ─── TPM status ───────────────────────────────────────────
// Win32_Tpm typically requires admin elevation and can be entirely absent on non-TPM hardware -
// `tpmReal` is false whenever the query failed or returned nothing, in which case `tpmActive`
// is null (callers supply their own sample fallback rather than this function guessing one).
export function getTpmStatus(data: Snapshot, connected: boolean): { tpmReal: boolean; tpmActive: boolean | null } {
  const tpm = data?.tpm;
  const tpmReal = connected && tpm != null;
  const tpmActive = tpmReal ? Boolean(tpm?.IsActivated_InitialValue && tpm?.IsEnabled_InitialValue) : null;
  return { tpmReal, tpmActive };
}

// Same three signals as the title-bar AT RISK / PROTECTED badge: TPM, Secure Boot, BitLocker.
// Score is the share of those signals that are actually healthy — not TPM-only (that made
// Security look "98" while the window chrome correctly said AT RISK).
export function getSecurityHealthPercent(data: Snapshot, connected: boolean): number | null {
  if (!connected) return null;
  const checks: boolean[] = [];
  const { tpmReal, tpmActive } = getTpmStatus(data, connected);
  if (tpmReal && tpmActive != null) checks.push(tpmActive);
  if (data?.secureBootEnabled != null) checks.push(data.secureBootEnabled === true);
  if (data?.bitlockerStatus != null && String(data.bitlockerStatus).length > 0) {
    checks.push(data.bitlockerStatus === "On");
  }
  if (checks.length === 0) return null;
  return Math.round((checks.filter(Boolean).length / checks.length) * 100);
}

export function getSecurityCompliance(data: Snapshot, connected: boolean): { real: boolean; ok: boolean } {
  const pct = getSecurityHealthPercent(data, connected);
  if (pct == null) return { real: false, ok: false };
  return { real: true, ok: pct === 100 };
}

export function describeSecuritySignals(data: Snapshot, connected: boolean): string {
  if (!connected) return "Agent offline";
  const parts: string[] = [];
  const { tpmReal, tpmActive } = getTpmStatus(data, connected);
  if (tpmReal && tpmActive != null) parts.push(tpmActive ? "TPM on" : "TPM off");
  if (data?.secureBootEnabled != null) parts.push(data.secureBootEnabled ? "Secure Boot on" : "Secure Boot off");
  if (data?.bitlockerStatus != null && String(data.bitlockerStatus).length > 0) {
    parts.push(data.bitlockerStatus === "On" ? "BitLocker on" : "BitLocker off");
  }
  return parts.length > 0 ? parts.join(" · ") : "No security sensors";
}


// ─── Risk tiers ───────────────────────────────────────────
// Simple, disclosed risk tiers applied to every real risk percentage across the AI Intel page:
// <20% Low, 20-50% Medium, >50% High - the same bucket boundaries throughout so a risk label
// means the same thing regardless of which row/card it appears on.
export function riskTier(pct: number): { label: string; color: string; bg: string; barColor: string } {
  if (pct < 20) return { label: "Low Risk", color: "var(--clpa-success)", bg: "rgba(var(--clpa-success-rgb),0.1)", barColor: "var(--clpa-success-bright)" };
  if (pct <= 50) return { label: "Medium Risk", color: "var(--clpa-warning)", bg: "rgba(var(--clpa-warning-bright-rgb),0.14)", barColor: "var(--clpa-warning-bright)" };
  return { label: "High Risk", color: "var(--clpa-critical)", bg: "rgba(var(--clpa-critical-bright-rgb),0.14)", barColor: "var(--clpa-critical-bright)" };
}

// ─── Thermal risk (real Distance to TjMax margin) ─────────
// Bucket boundaries for AITopPredictionsCard's "Thermal Risk", applied to the real minimum
// per-core throttle margin (HardwareMonitorSnapshot.cpuMinDistanceToTjMaxC): a wide safety
// margin is genuinely Low risk, a shrinking one is worth flagging as Moderate before it
// actually reaches the chip's real throttle point (margin 0), which is High.
export const THERMAL_RISK_LOW_MARGIN_C = 30; // > this many °C from TjMax: comfortably safe
export const THERMAL_RISK_MODERATE_MARGIN_C = 15; // this to LOW_MARGIN: worth watching; below: High

export function thermalRiskFromMargin(marginC: number): { label: string; color: string } {
  if (marginC > THERMAL_RISK_LOW_MARGIN_C) return { label: "Low", color: "var(--clpa-success)" };
  if (marginC >= THERMAL_RISK_MODERATE_MARGIN_C) return { label: "Moderate", color: "var(--clpa-warning)" };
  return { label: "High", color: "var(--clpa-critical)" };
}

// ─── Dashboard card status badges ──────────────────────────
// Every function below returns a real label computed from real telemetry against real, named
// thresholds - never a hardcoded decorative string. `sample: true` means there wasn't enough
// real data to compute an honest verdict (disconnected, sensor absent) - callers must render
// "Unknown" with a SampleTag in that case, never silently fall back to a "Healthy"-looking label
// (a fabricated-looking "all clear" is worse than an honest "don't know").
//
// Threshold numbers are deliberately NOT hardcoded here for CPU/memory/battery-health - callers
// pass in the live (possibly user-edited) values from useAlertEngine's ThresholdConfig, so a
// dashboard badge and the alert engine that fires real alerts from the exact same metric can
// never disagree. Storage/thermal/GPU/network have no equivalent alert-engine rule to reuse (see
// each constant's own comment for why its specific number was chosen), so they get their own
// real, named constants instead of inventing unnamed magic numbers inline.
export type Badge = { label: string; sample: boolean };

// CPU: Healthy/Warning/Critical from real load % AND real CPU temp (LibreHardwareMonitor/HWiNFO)
// - a badge is "Warning" the instant EITHER metric crosses its own warning threshold, "Critical"
// the instant either crosses critical, matching how useAlertEngine's cpu-load and cpu-temp rules
// already independently fire (two separate alerts can be active at once for the same real
// condition this badge is summarizing). Unknown only when NEITHER metric is available at all -
// one real metric is still an honest partial verdict, not nothing.
export function getCpuBadge(
  data: Snapshot,
  connected: boolean,
  loadWarning: number,
  loadCritical: number,
  tempWarning: number,
  tempCritical: number,
): Badge {
  const load = getCpuLoad(data, connected);
  const tempC = connected ? data?.hardwareMonitor?.cpuTempC ?? null : null;
  if (load == null && tempC == null) return { label: "Unknown", sample: true };
  const critical = (load != null && load > loadCritical) || (tempC != null && tempC > tempCritical);
  const warning = (load != null && load >= loadWarning) || (tempC != null && tempC >= tempWarning);
  return { label: critical ? "Critical" : warning ? "Warning" : "Healthy", sample: false };
}

// Memory: same shape as CPU's load half, reusing useAlertEngine's memory-usage thresholds and
// getMemUsedPercent's own real (total-free)/total formula - the exact number the alert engine
// evaluates, not a second independent calculation of "memory used %".
export function getMemoryBadge(data: Snapshot, connected: boolean, warning: number, critical: number): Badge {
  const pct = getMemUsedPercent(data, connected);
  if (pct == null) return { label: "Unknown", sample: true };
  return { label: pct > critical ? "Critical" : pct >= warning ? "Warning" : "Healthy", sample: false };
}

// Storage thresholds match the app's 85/95 warning/critical convention for usage %, applied
// to the fullest local volume (not only C:). Health % is a separate SMART wear signal.
export const STORAGE_USAGE_WARNING_PCT = 85;
export const STORAGE_USAGE_CRITICAL_PCT = 95;
export const STORAGE_HEALTH_WARNING_PCT = 80;
export const STORAGE_HEALTH_CRITICAL_PCT = 50;

export function bytesToGb(bytes: number | null | undefined): number | null {
  if (bytes == null || !Number.isFinite(Number(bytes))) return null;
  return Math.round((Number(bytes) / 1024 / 1024 / 1024) * 10) / 10;
}

export function logicalVolumeUsedPct(disk: { Size?: number; FreeSpace?: number } | null | undefined): number | null {
  const size = disk?.Size;
  const free = disk?.FreeSpace;
  if (size == null || size <= 0 || free == null) return null;
  return ((size - free) / size) * 100;
}

export function listLogicalVolumes(data: Snapshot, connected: boolean) {
  if (!connected || !data?.logicalDisks?.length) return [];
  return data.logicalDisks
    .filter((d) => d != null && d.Size != null && d.Size > 0)
    .slice()
    .sort((a, b) => String(a.DeviceID ?? "").localeCompare(String(b.DeviceID ?? "")));
}

export function getWorstStorageUsedPct(data: Snapshot, connected: boolean): number | null {
  let worst: number | null = null;
  for (const vol of listLogicalVolumes(data, connected)) {
    const pct = logicalVolumeUsedPct(vol);
    if (pct != null && (worst == null || pct > worst)) worst = pct;
  }
  return worst;
}

export function listPhysicalDrives(data: Snapshot, connected: boolean) {
  if (!connected || !data?.storage?.length) return [];
  return data.storage.filter((d) => d != null && (Boolean(d.Model) || d.Size != null));
}

export function listMemoryModules(data: Snapshot, connected: boolean) {
  if (!connected || !data?.memory?.modules?.length) return [];
  return data.memory.modules.filter((m) => m != null);
}

export function listBatteries(data: Snapshot, connected: boolean) {
  if (!connected || !data?.battery?.length) return [];
  return data.battery.filter((b) => b != null);
}

export function listConnectedAdapters(data: Snapshot, connected: boolean) {
  if (!connected || !data?.network?.length) return [];
  return data.network.filter(
    (n) => Boolean(n?.Name) && !/tailscale|vethernet|virtual|bluetooth|wan miniport|tunnel/i.test(n.Name ?? ""),
  );
}

const GPU_SKIP_RE =
  /microsoft basic display|remote display|virtual display|idd driver|parsec|spacedesk|usb display|mirage driver|indirect display/i;

const INTEGRATED_GPU_RE =
  /uhd graphics|iris( xe| plus)? graphics|intel\(r\) hd graphics|intel hd graphics|intel\(r\) graphics|radeon\(tm\) graphics|radeon graphics(?!\s+pro)|vega \d+|graphics \d+/i;

const ADAPTER_RAM_SENTINEL = 0xffffffff;

type GpuLike = NonNullable<TelemetrySnapshot["gpu"]>[number];

export function gpuDisplayName(
  g: { Name?: string | null; AdapterCompatibility?: string | null } | null | undefined,
  fallback?: string | null,
): string {
  const name = (g?.Name ?? "").trim();
  if (name) return name;
  const compat = (g?.AdapterCompatibility ?? "").trim();
  if (compat) return `${compat} Graphics`;
  return (fallback ?? "").trim();
}

export function isIntegratedGpu(g: GpuLike | null | undefined): boolean {
  const blob = `${g?.Name ?? ""} ${g?.AdapterCompatibility ?? ""}`;
  if (INTEGRATED_GPU_RE.test(blob)) return true;
  if (/nvidia|geforce|quadro|rtx |radeon rx|arc a\d/i.test(blob)) return false;
  return /intel/i.test(blob);
}

export function gpuVramLabel(g: GpuLike | null | undefined): { label: string; sample: boolean } {
  if (!g) return { label: "—", sample: true };
  const ram = g.AdapterRAM;
  const unreliable = g.AdapterRAMUnreliable === true || ram === 0 || ram === ADAPTER_RAM_SENTINEL;
  if (ram != null && Number.isFinite(ram) && ram > 0 && !unreliable) {
    const gb = bytesToGb(ram);
    return gb != null ? { label: `${gb} GB`, sample: false } : { label: "—", sample: true };
  }
  if (isIntegratedGpu(g)) return { label: "Shared", sample: false };
  return { label: "—", sample: true };
}

export function listDisplayGpus(data: Snapshot, connected: boolean) {
  if (!connected || !data) return [];
  const seen = new Set<string>();
  const out: NonNullable<TelemetrySnapshot["gpu"]> = [];
  const lhmName = data.hardwareMonitor?.gpuName?.trim() || "";
  for (const g of data.gpu ?? []) {
    const name = gpuDisplayName(g, lhmName);
    if (!name || GPU_SKIP_RE.test(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...g, Name: name });
  }
  if (out.length === 0 && lhmName && !GPU_SKIP_RE.test(lhmName)) {
    out.push({ Name: lhmName });
  }
  return out;
}

export function getPrimaryGpu(data: Snapshot, connected: boolean) {
  const list = listDisplayGpus(data, connected);
  const discrete = list.find((g) => /nvidia|geforce|quadro|rtx |radeon rx|arc a\d/i.test(g.Name ?? ""));
  return discrete ?? list[0] ?? null;
}

export function getMotherboardProduct(data: Snapshot, connected: boolean): string | null {
  if (!connected) return null;
  const product = data?.board?.Product?.trim();
  if (product) return product;
  const model = data?.system?.Name?.trim();
  return model || null;
}

/** ACPI MSAcpi_ThermalZoneTemperature.CurrentTemperature is tenths of Kelvin; some firmware emits Kelvin or °C. */
export function acpiCurrentTemperatureToC(raw: number | null | undefined): number | null {
  if (raw == null || !Number.isFinite(raw)) return null;
  const tenthsK = raw / 10 - 273.15;
  if (tenthsK >= 0 && tenthsK <= 125) return tenthsK;
  const kelvin = raw - 273.15;
  if (kelvin >= 0 && kelvin <= 125) return kelvin;
  if (raw >= 0 && raw <= 125) return raw;
  return null;
}

export function thermalSeverityColor(tempC: number | null, warning: number, critical: number): string {
  if (tempC == null) return "var(--clpa-track)";
  if (tempC > critical) return "var(--clpa-critical-bright)";
  if (tempC >= warning) return "var(--clpa-warning-bright)";
  return "var(--clpa-emerald)";
}

export type ThermalRow = { label: string; value: string; pct: number; color: string; sample: boolean };

function thermalTempRow(label: string, tempC: number | null, warning: number, critical: number): ThermalRow {
  return {
    label,
    value: tempC != null ? `${Math.round(tempC)}°C` : "—",
    pct: tempC != null ? Math.max(0, Math.min(100, Math.round(tempC))) : 0,
    color: thermalSeverityColor(tempC, warning, critical),
    sample: false,
  };
}

// GPU/DIMM/Motherboard have no per-device vendor threshold available in this project's telemetry
// (unlike SSD below), so these are fixed, sensor-appropriate defaults rather than CPU's own
// warning/critical reused across every sensor type - real mobile-GPU throttle points are commonly
// ~87C (80/90 leaves headroom before that), DIMM/PCH modules are conservatively rated well under
// their DDR spec max for a laptop chassis.
const GPU_TEMP_WARNING_C = 80;
const GPU_TEMP_CRITICAL_C = 90;
const DIMM_TEMP_WARNING_C = 70;
const DIMM_TEMP_CRITICAL_C = 85;
const SSD_TEMP_WARNING_C_FALLBACK = 70;
const SSD_TEMP_CRITICAL_C_FALLBACK = 80;

// smartctl surfaces the NVMe drive's own Identify Controller WCTEMP/CCTEMP fields as
// op_limit_max/critical_limit_max - a real, per-device vendor-specified threshold, not a guess.
// Falls back to a conservative static default only when a drive doesn't report them.
function ssdThermalThresholds(data: Snapshot): { warning: number; critical: number } {
  const t = data?.storageHealth?.temperature;
  return {
    warning: t?.op_limit_max ?? SSD_TEMP_WARNING_C_FALLBACK,
    critical: t?.critical_limit_max ?? SSD_TEMP_CRITICAL_C_FALLBACK,
  };
}

export function getThermalRows(data: Snapshot, connected: boolean, cpuWarning: number, cpuCritical: number): ThermalRow[] {
  if (!connected) {
    return ["CPU Temp", "GPU Temp", "SSD Temp", "Motherboard"].map((label) => thermalTempRow(label, null, cpuWarning, cpuCritical));
  }
  const hwMon = data?.hardwareMonitor;
  const cpuTempC = hwMon?.cpuTempC ?? null;
  const gpuTempC = hwMon?.gpuTempC ?? null;
  const moboTempC = hwMon?.motherboardTempC ?? null;
  const dimmTempC = hwMon?.dimmTempC ?? null;
  const ssdTempC = data?.storageHealth?.temperature?.current ?? null;
  const hasLabeled = [cpuTempC, gpuTempC, ssdTempC, moboTempC, dimmTempC].some((t) => t != null);
  if (hasLabeled) {
    const ssd = ssdThermalThresholds(data);
    return [
      thermalTempRow("CPU Temp", cpuTempC, cpuWarning, cpuCritical),
      thermalTempRow("GPU Temp", gpuTempC, GPU_TEMP_WARNING_C, GPU_TEMP_CRITICAL_C),
      thermalTempRow("SSD Temp", ssdTempC, ssd.warning, ssd.critical),
      moboTempC != null
        ? thermalTempRow("Motherboard", moboTempC, DIMM_TEMP_WARNING_C, DIMM_TEMP_CRITICAL_C)
        : thermalTempRow(dimmTempC != null ? "DIMM Temp" : "Motherboard", dimmTempC, DIMM_TEMP_WARNING_C, DIMM_TEMP_CRITICAL_C),
    ];
  }
  const zones = (data?.thermal ?? [])
    .map((zone, i) => {
      const c = acpiCurrentTemperatureToC(zone?.CurrentTemperature);
      return c == null ? null : thermalTempRow(`Zone ${i + 1}`, c, cpuWarning, cpuCritical);
    })
    .filter((row): row is ThermalRow => row != null);
  if (zones.length > 0) return zones;
  return ["CPU Temp", "GPU Temp", "SSD Temp", "Motherboard"].map((label) => thermalTempRow(label, null, cpuWarning, cpuCritical));
}

export function getStorageBadge(data: Snapshot, connected: boolean): Badge {
  const usedPct = getWorstStorageUsedPct(data, connected);
  const healthPct = storageWearToHealthPercent(getStorageWearPercent(data, connected));
  if (usedPct == null && healthPct == null) return { label: "Unknown", sample: true };
  const critical =
    (usedPct != null && usedPct > STORAGE_USAGE_CRITICAL_PCT) || (healthPct != null && healthPct < STORAGE_HEALTH_CRITICAL_PCT);
  const warning =
    (usedPct != null && usedPct >= STORAGE_USAGE_WARNING_PCT) || (healthPct != null && healthPct < STORAGE_HEALTH_WARNING_PCT);
  return { label: critical ? "Critical" : warning ? "Warning" : "Healthy", sample: false };
}

// Battery card badge: Good/Fair/Poor from real battery HEALTH % (wear/degradation via
// getBatteryHealthPercent), reusing useAlertEngine's battery-health rule's thresholds - a
// genuinely different real signal from current charge % (a battery can be fully charged and
// badly worn, or low and healthy), same distinction useAlertEngine's own battery-low vs.
// battery-health rules already draw.
export function getBatteryHealthBadge(data: Snapshot, connected: boolean, warning: number, critical: number): Badge {
  const healthPct = getBatteryHealthPercent(data, connected);
  if (healthPct == null) return { label: "Unknown", sample: true };
  return { label: healthPct < critical ? "Poor" : healthPct < warning ? "Fair" : "Good", sample: false };
}

export type OverallProtectionTier = "Healthy" | "At Risk" | "Critical";

// Title-bar badge: folds the same 3 security signals it already checked (TPM/Secure Boot/
// BitLocker) together with Battery and Storage's own existing card-level badges - not new
// thresholds, the exact same getBatteryHealthBadge/getStorageBadge every other caller uses -
// into one worst-signal-wins tier. Same principle as getThermalCardBadge (worst temp reading
// decides Critical/Warning/Normal) and the AI Health Score card (label follows the weakest
// sub-score). Security can only ever contribute "middle" (At Risk), never "worst" (Critical) -
// there is no existing precedent in this app for a security state beyond the historical binary
// PROTECTED/AT RISK, so this doesn't invent a new one just to fill the Critical cell.
export function getOverallProtectionTier(
  data: Snapshot,
  connected: boolean,
  batteryHealthWarning: number,
  batteryHealthCritical: number,
): { tier: OverallProtectionTier; anyReal: boolean } {
  const tiers: Array<"fine" | "middle" | "worst"> = [];

  const { tpmReal, tpmActive } = getTpmStatus(data, connected);
  const secureBootEnabled = connected ? data?.secureBootEnabled ?? null : null;
  const bitlockerStatus = connected ? data?.bitlockerStatus ?? null : null;
  for (const ok of [
    tpmReal ? tpmActive : null,
    secureBootEnabled,
    bitlockerStatus != null ? bitlockerStatus === "On" : null,
  ]) {
    if (ok != null) tiers.push(ok ? "fine" : "middle");
  }

  const batteryBadge = getBatteryHealthBadge(data, connected, batteryHealthWarning, batteryHealthCritical);
  if (!batteryBadge.sample) {
    tiers.push(batteryBadge.label === "Poor" ? "worst" : batteryBadge.label === "Fair" ? "middle" : "fine");
  }

  const storageBadge = getStorageBadge(data, connected);
  if (!storageBadge.sample) {
    tiers.push(storageBadge.label === "Critical" ? "worst" : storageBadge.label === "Warning" ? "middle" : "fine");
  }

  const anyReal = tiers.length > 0;
  const tier: OverallProtectionTier = tiers.includes("worst") ? "Critical" : tiers.includes("middle") ? "At Risk" : "Healthy";
  return { tier, anyReal };
}

// Hard hex traffic-light (green / yellow / red) - not theme CSS variables, so a Fair/Poor
// health % cannot inherit the card's charge-green or resolve to the wrong token.
export const HEALTH_TRAFFIC = {
  good: { fg: "#15803D", bg: "rgba(21, 128, 61, 0.14)" },
  fair: { fg: "#CA8A04", bg: "rgba(202, 138, 4, 0.18)" },
  poor: { fg: "#DC2626", bg: "rgba(220, 38, 38, 0.14)" },
  unknown: { fg: "#64748B", bg: "transparent" },
} as const;

export type HealthTrafficBand = keyof typeof HEALTH_TRAFFIC;

export function healthTrafficBand(pct: number | null, warning: number, critical: number): HealthTrafficBand {
  if (pct == null) return "unknown";
  if (pct < critical) return "poor";
  if (pct < warning) return "fair";
  return "good";
}

export function colorForHealthPercent(pct: number | null, warning: number, critical: number): string {
  return HEALTH_TRAFFIC[healthTrafficBand(pct, warning, critical)].fg;
}

// Thermal card-level badge: the worst real reading across CPU/GPU/SSD/Motherboard, against the
// same cpuTemp warning/critical thresholds useAlertEngine's cpu-temp rule already uses - there's
// no separate established danger zone for GPU/SSD/motherboard temps in this app, and reusing the
// one real "how hot is too hot" convention already defined for CPU is a more honest choice than
// inventing three more unrelated numbers with no basis. Distinct from per-component temp rows
// (which stay individually sample-tagged per sensor) - this is only the card header's own
// single worst-of-all-sensors verdict.
export function getThermalCardBadge(data: Snapshot, connected: boolean, warning: number, critical: number): Badge {
  const hwMon = connected ? data?.hardwareMonitor : null;
  const ssdTempC = connected ? data?.storageHealth?.temperature?.current ?? null : null;
  const zoneTemps = connected
    ? (data?.thermal ?? []).map((z) => acpiCurrentTemperatureToC(z?.CurrentTemperature)).filter((t): t is number => t != null)
    : [];
  const temps = [hwMon?.cpuTempC, hwMon?.gpuTempC, hwMon?.motherboardTempC, hwMon?.dimmTempC, ssdTempC, ...zoneTemps].filter(
    (t): t is number => t != null,
  );
  if (temps.length === 0) return { label: "Unknown", sample: true };
  const worst = Math.max(...temps);
  return { label: worst > critical ? "Critical" : worst >= warning ? "Warning" : "Normal", sample: false };
}

// GPU: Healthy/Warning only (no Critical tier - a sustained high-utilization or warm GPU is
// worth flagging, but this app has no basis for a second, more severe GPU threshold the way
// CPU/memory/storage do). GPU_UTIL_WARNING_PCT matches the sustained-high-load convention this
// card's utilization bar already used before this badge was made real. Temp reuses the same
// cpuTemp warning threshold as the Thermal card badge above, for the same reason (no separate
// established GPU danger-zone number exists in this app).
export const GPU_UTIL_WARNING_PCT = 90;

export function getGpuBadge(data: Snapshot, connected: boolean, tempWarning: number): Badge {
  const util = connected && data?.gpuUtilization != null ? data.gpuUtilization : null;
  const tempC = connected ? data?.hardwareMonitor?.gpuTempC ?? null : null;
  if (util == null && tempC == null) return { label: "Unknown", sample: true };
  const warning = (util != null && util >= GPU_UTIL_WARNING_PCT) || (tempC != null && tempC >= tempWarning);
  return { label: warning ? "Warning" : "Healthy", sample: false };
}

// Network: Excellent/Good/Poor from netsh's real signal % (the only real network-quality
// measurement this collector has - see NetworkCard's own comment on why dBm was never real
// here). Bucket boundaries are a real, disclosed tiering of that one real number, not a
// fabricated score.
export const NETWORK_SIGNAL_EXCELLENT_PCT = 80;
export const NETWORK_SIGNAL_GOOD_PCT = 50;

export function getWifiLinkStatus(data: Snapshot, connected: boolean): { label: "Online" | "Offline" | "Unknown"; sample: boolean } {
  if (!connected) return { label: "Unknown", sample: true };
  const raw = data?.wifi?.state;
  if (!raw) return { label: "Unknown", sample: true };
  const state = raw.trim().toLowerCase();
  if (state === "connected") return { label: "Online", sample: false };
  return { label: "Offline", sample: false };
}

export function getDisplayNetworkAdapter(data: Snapshot, connected: boolean): { Name?: string; MACAddress?: string; AdapterType?: string } | null {
  if (!connected || !data?.network?.length) return null;
  const list = data.network;
  const wifi = list.find((n) => /wi-?fi|wireless/i.test(n.Name ?? "") && !/direct|virtual|tailscale/i.test(n.Name ?? ""));
  if (wifi) return wifi;
  const eth = list.find((n) => /ethernet/i.test(n.Name ?? "") && !/vethernet|virtual|tailscale/i.test(n.Name ?? ""));
  return eth ?? list[0] ?? null;
}

export function getNetworkBadge(data: Snapshot, connected: boolean): Badge {
  const link = getWifiLinkStatus(data, connected);
  if (link.label === "Unknown") return { label: "Unknown", sample: true };
  if (link.label === "Offline") return { label: "Offline", sample: false };
  const raw = data?.wifi?.signalPercent != null ? Number(data.wifi.signalPercent) : null;
  const signalPercent = raw != null && !Number.isNaN(raw) ? raw : null;
  if (signalPercent == null) return { label: "Online", sample: false };
  return {
    label: signalPercent > NETWORK_SIGNAL_EXCELLENT_PCT ? "Excellent" : signalPercent >= NETWORK_SIGNAL_GOOD_PCT ? "Good" : "Poor",
    sample: false,
  };
}

// Hardware Inventory card badge: Healthy only when TPM/Secure Boot/BitLocker are ALL three
// confirmed present and clean - reuses the exact same real signals and per-field "clean" meaning
// HWIntegrityCard's own TPM Attestation/Secure Boot/BitLocker rows already use (getTpmStatus,
// data.secureBootEnabled, data.bitlockerStatus === "On"), rather than an independent recomputation
// that could quietly drift from what that page shows for the same three facts. Unknown unless
// all three signals are actually available - a partial reading (e.g. TPM real but Secure Boot
// unknown) can't honestly claim "all clean", so this deliberately requires completeness rather
// than judging on whatever happens to be present the way CPU/GPU above do (those degrade
// gracefully because one real metric is still meaningful on its own; "all clean" is not
// meaningful from only two of three signals).
export function getHardwareInventoryBadge(data: Snapshot, connected: boolean): Badge {
  const { tpmReal, tpmActive } = getTpmStatus(data, connected);
  const secureBootEnabled = connected ? data?.secureBootEnabled ?? null : null;
  const bitlockerStatus = connected ? data?.bitlockerStatus ?? null : null;
  if (!tpmReal || secureBootEnabled == null || bitlockerStatus == null) return { label: "Unknown", sample: true };
  const allClean = Boolean(tpmActive) && secureBootEnabled === true && bitlockerStatus === "On";
  return { label: allClean ? "Healthy" : "Warning", sample: false };
}

// ─── Driver data completeness (NOT a freshness/currency check) ─────────────
// There is no real way to know whether any installed driver/firmware version is the latest
// available one - that would require live queries against each vendor's own update servers,
// explicitly out of scope (see HWDriversCard's own comment, and the BIOS component tile's now-
// removed "Latest" row). This only ever reports how many of the same 8 real driver/firmware
// checks HWDriversCard already makes (BIOS, chipset, Intel ME, WiFi, GPU, audio, Bluetooth, SSD
// firmware) actually returned real data on THIS machine - a genuine, honest fact ("how much do we
// know"), not a disguised freshness claim. Shared here (not recomputed independently in
// HWDistributionCard) so the two can never disagree about how many of the 8 are real.
export function getDriverDataCompleteness(data: Snapshot, connected: boolean): { realCount: number; totalCount: number } {
  const dv = connected ? data?.driverVersions : null;
  const checks = [
    connected && data?.bios?.SMBIOSBIOSVersion != null,
    Boolean(dv?.chipset),
    Boolean(dv?.intelMe),
    Boolean(dv?.wifi),
    connected && getPrimaryGpu(data, connected)?.DriverVersion != null,
    Boolean(dv?.audio),
    Boolean(dv?.bluetooth),
    connected && data?.storageHealth?.firmware_version != null,
  ];
  return { realCount: checks.filter(Boolean).length, totalCount: checks.length };
}
