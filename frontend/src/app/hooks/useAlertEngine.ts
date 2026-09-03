import { useCallback, useEffect, useRef, useState } from "react";
import { Battery, Cpu, HardDrive, MemoryStick, Shield, ShieldAlert, Thermometer, type LucideIcon } from "lucide-react";
import { SEVERITY_META, type AlertItem } from "../data/alerts";
import { isBatteryDischarging } from "../data/batteryStatus";
import { useTelemetry, type TelemetrySnapshot } from "./useTelemetry";
import { getBatteryHealthPercent } from "../lib/derived";
import { loadJSON, saveJSON } from "../lib/storage";
import { formatTimeLabel } from "../lib/dateTimeFormat";

const STATE_KEY = "clpa:alert-engine-state:v1";
const ALERTS_KEY = "clpa:alert-engine-alerts:v1";
const CATEGORY_PREFS_KEY = "clpa:alert-engine-category-prefs:v1";
const THRESHOLDS_KEY = "clpa:alert-thresholds:v1";
const SNOOZE_KEY = "clpa:alert-engine-snoozes:v1";
// Gates the one-time collapse-by-ruleId migration below (see migrateCollapseAlertsByRuleId) so
// it only ever runs once per real installation, not on every load.
const ALERTS_MIGRATION_KEY = "clpa:alert-engine-alerts-migrated-ruleid-dedup:v1";
const ALERTS_DROP_WARRANTY_KEY = "clpa:alert-engine-alerts-dropped-unwired-warranty:v1";

// Epoch ms a rule is suppressed until, keyed by rule id (plain string, not the RuleId union —
// this map is exposed to callers outside this module like AppContext.snoozeAlert, which only
// has a rule id it read off an AlertItem, not a value it can prove is one of the real RuleIds).
type SnoozeMap = Partial<Record<string, number>>;

export type ThresholdConfig = {
  cpuWarning: number;
  cpuCritical: number;
  memoryWarning: number;
  memoryCritical: number;
  batteryWarning: number;
  batteryCritical: number;
  cpuTempWarning: number;
  cpuTempCritical: number;
  batteryHealthWarning: number;
  batteryHealthCritical: number;
};

// Today's hardcoded values, unchanged — now the fallback when nothing's been persisted yet,
// and what "Reset to Defaults" restores. cpuTemp's 85/95°C and batteryHealth's 60/40% are the
// same kind of reasonable-starting-point defaults as the original four, editable the same way -
// 60% in particular matches the widely-cited industry rule of thumb (Apple/Dell battery service
// guidance) already disclosed elsewhere in this app (AITopPredictionsCard's battery projection)
// for when a lithium-ion battery is considered meaningfully degraded.
export const DEFAULT_THRESHOLDS: ThresholdConfig = {
  cpuWarning: 85,
  cpuCritical: 95,
  memoryWarning: 85,
  memoryCritical: 95,
  batteryWarning: 20,
  batteryCritical: 10,
  cpuTempWarning: 85,
  cpuTempCritical: 95,
  batteryHealthWarning: 60,
  batteryHealthCritical: 40,
};

// storage-free is deliberately excluded — its evaluate() always returns null (no real
// free-space field exists in the collector), so a threshold for it would control nothing real.
// warranty-expiry is also excluded - its trigger is a fixed calendar window, not a
// user-editable percentage (see its RuleDefinition's own comment below).
export type ThresholdMetric = "cpu" | "memory" | "battery" | "cpuTemp" | "batteryHealth";
const METRIC_COMPARISON: Record<ThresholdMetric, "above" | "below"> = {
  cpu: "above", memory: "above", battery: "below", cpuTemp: "above", batteryHealth: "below",
};
const METRIC_KEYS: Record<ThresholdMetric, { warning: keyof ThresholdConfig; critical: keyof ThresholdConfig }> = {
  cpu: { warning: "cpuWarning", critical: "cpuCritical" },
  memory: { warning: "memoryWarning", critical: "memoryCritical" },
  battery: { warning: "batteryWarning", critical: "batteryCritical" },
  cpuTemp: { warning: "cpuTempWarning", critical: "cpuTempCritical" },
  batteryHealth: { warning: "batteryHealthWarning", critical: "batteryHealthCritical" },
};

function clampThreshold(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

// Enforces that "critical" always stays the more extreme side of "warning" for a rule's
// comparison direction (critical > warning for "above" rules like CPU/memory; critical <
// warning for "below" rules like battery) — editing one field can nudge the other rather than
// silently accepting a config where "critical" would never actually be more severe.
export function applyThresholdEdit(
  comparison: "above" | "below",
  pair: { warning: number; critical: number },
  field: "warning" | "critical",
  rawValue: number,
): { warning: number; critical: number } {
  const value = clampThreshold(rawValue);
  let { warning, critical } = pair;
  if (field === "warning") warning = value;
  else critical = value;

  if (comparison === "above") {
    if (critical <= warning) {
      if (field === "warning") critical = Math.min(100, warning + 1);
      else warning = Math.max(0, critical - 1);
    }
  } else {
    if (critical >= warning) {
      if (field === "warning") critical = Math.max(0, warning - 1);
      else warning = Math.min(100, critical + 1);
    }
  }
  return { warning, critical };
}

// The real rule categories a rule can be gated on. Matches the `category` string each rule's
// buildAlert() below actually produces — this is the only vocabulary Settings' "Alert Types"
// toggles can honestly bind to, since these are the only rules that really evaluate anything.
// BatteryHealth is deliberately its own category, separate from Battery (charge %) - they're
// independent real signals (a battery can be fully charged and badly worn, or low and healthy),
// so gating them on the same toggle would silently couple two unrelated alerts together.
// Security is its own category, not folded into an existing one - hardware tamper detection is
// a genuinely independent real signal from performance/storage/battery/warranty, same reasoning
// as BatteryHealth's own split from Battery above.
export type RuleCategory = "Performance" | "Storage" | "Battery" | "BatteryHealth" | "Warranty" | "Security";
const RULE_CATEGORY: Record<RuleId, RuleCategory> = {
  "cpu-load": "Performance",
  "memory-usage": "Performance",
  "storage-free": "Storage",
  "battery-low": "Battery",
  "cpu-temp": "Performance",
  "battery-health": "BatteryHealth",
  "warranty-expiry": "Warranty",
  "hardware-tamper": "Security",
  "battery-full": "Battery",
};
type CategoryPrefs = Record<RuleCategory, boolean>;
const DEFAULT_CATEGORY_PREFS: CategoryPrefs = {
  Performance: true, Storage: true, Battery: true, BatteryHealth: true, Warranty: true, Security: true,
};

type RuleId = "cpu-load" | "memory-usage" | "storage-free" | "battery-low" | "cpu-temp" | "battery-health" | "warranty-expiry" | "hardware-tamper" | "battery-full";
type RuleLevel = "warning" | "critical";

// Human-readable rule names for the "cleared" event message specifically - a fired alert
// already has a real, specific title from its own buildAlert(); a cleared one has no
// equivalent, so this is what fills that in ("CPU load returned to normal.", etc.).
const RULE_LABEL: Record<RuleId, string> = {
  "cpu-load": "CPU load",
  "memory-usage": "Memory usage",
  "storage-free": "Storage free space",
  "battery-low": "Battery charge",
  "cpu-temp": "CPU temperature",
  "battery-health": "Battery health",
  "warranty-expiry": "Warranty expiry",
  "hardware-tamper": "Hardware tamper detection",
  "battery-full": "Battery full charge",
};

// Real, durable event log - proxied through local-agent (which holds this device's actual API
// key; the browser never does) to the backend's events table. Best-effort: if local-agent or
// the backend is unreachable, this silently fails rather than surfacing a UI error for what's
// fundamentally a background audit trail, not the alert itself (which the rest of this file
// already handles/displays regardless of whether this persisted copy succeeds).
const EVENT_LOG_URL = "http://localhost:4317/api/event";

function postRealEvent(eventType: string, message: string, severity: "info" | "warning" | "critical") {
  fetch(EVENT_LOG_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ eventType, message, severity }),
  }).catch(() => {
    // local-agent already logs the real reason server-side (not enrolled, backend
    // unreachable) - nothing more useful to do with the error here.
  });
}

// Lucide icons are forwardRef objects, not JSON-serializable — storing AlertItem.Icon
// directly in localStorage silently corrupts it (JSON.stringify drops its non-enumerable
// internals, leaving `{}`), which crashes rendering after reload with "Element type is
// invalid". So icons are never persisted directly: a stable string key is stored instead,
// and ICON_MAP resolves it back to the real component at hydration time.
type IconKey = "cpu" | "memory" | "storage" | "battery" | "thermal" | "warranty" | "tamper";

const ICON_MAP: Record<IconKey, LucideIcon> = {
  cpu: Cpu,
  memory: MemoryStick,
  storage: HardDrive,
  battery: Battery,
  thermal: Thermometer,
  warranty: Shield,
  tamper: ShieldAlert,
};

const ICON_KEY_BY_ICON = new Map<LucideIcon, IconKey>(
  (Object.entries(ICON_MAP) as [IconKey, LucideIcon][]).map(([key, Icon]) => [Icon, key]),
);

// The JSON-safe shape written to/read from localStorage — an AlertItem with `Icon` replaced
// by its string key.
type PersistedAlert = Omit<AlertItem, "Icon"> & { iconKey: IconKey };

// General field-sanitization pass for whatever a real installation's localStorage has
// accumulated across past, possibly incompatible versions of this file (see the ruleId-dedup
// and unwired-warranty migrations above, both written for exactly that reason) - iconKey was
// already the one field validated this way (ICON_MAP[iconKey] ?? Cpu); severity and category
// get the same real treatment here, since both are read back as trusted, unvalidated strings
// otherwise. A console.warn on coercion is deliberate, not an oversight to quiet later - this
// is a real correctness gap in whatever's persisted, and should stay visible in the console
// rather than silently normalizing away evidence of it.
function hydrateAlert(persisted: PersistedAlert): AlertItem {
  const { iconKey, ...rest } = persisted;

  let severity = rest.severity;
  if (!(severity in SEVERITY_META)) {
    console.warn(
      `[useAlertEngine] persisted alert ${rest.id} has out-of-vocabulary severity ${JSON.stringify(severity)} - coercing to "info"`,
    );
    severity = "info";
  }

  let category = rest.category;
  if (!(category in DEFAULT_CATEGORY_PREFS)) {
    console.warn(
      `[useAlertEngine] persisted alert ${rest.id} has out-of-vocabulary category ${JSON.stringify(category)} - coercing to "Performance"`,
    );
    category = "Performance";
  }

  return { ...rest, severity, category, Icon: ICON_MAP[iconKey] ?? Cpu };
}

function dehydrateAlert(alert: AlertItem): PersistedAlert {
  const { Icon, ...rest } = alert;
  return { ...rest, iconKey: ICON_KEY_BY_ICON.get(Icon) ?? "cpu" };
}

// Present entries are the currently-active rule and the level it last fired at; a rule with
// no entry is inactive. This is what makes a rule fire only once per threshold crossing —
// it must go back to inactive (value drops below warning) before it can fire again.
type EngineState = Partial<Record<RuleId, RuleLevel>>;

// A rule that is, right now, actually crossing its threshold — independent of whether an
// alert was ever created for it (blocked by snooze) or still exists in whatever list a
// consumer displays (removed by dismiss). This is what lets a caller tell "this condition is
// still real and ongoing" apart from "there happens to be no visible alert for it."
export type LiveActiveRule = { ruleId: string; category: RuleCategory; level: RuleLevel };

type Thresholds = { warning: number; critical: number };

type RuleDefinition = {
  id: RuleId;
  iconKey: IconKey;
  comparison: "above" | "below";
  // Reads this rule's current warning/critical out of the live (possibly user-edited)
  // threshold config, rather than baking fixed numbers into the rule itself.
  getThresholds: (config: ThresholdConfig) => Thresholds;
  // Real margin (in this rule's own evaluate()/threshold unit - percent, °C, etc.) a value must
  // move past the warning line before a latched rule is considered genuinely cleared, not just
  // technically dipped under it for one poll - see hasClearedHysteresis's own comment. 0 for a
  // rule with no real "hovering near a noisy threshold" concern: a genuinely discrete/one-shot
  // signal (hardware-tamper, battery-full - evaluate() only ever returns its trigger value or
  // null, never a graduated range to have margin against) or a slow, non-noisy monotonic fact
  // (warranty-expiry's day count) - 0 reproduces the exact original instant-clear-on-null
  // behavior for these, which is correct for them, not a compromise.
  clearMargin: number;
  // Returns the current metric value, or null if it can't be measured right now
  // (disconnected, field missing, or — for storage-free — never available at all).
  evaluate: (data: TelemetrySnapshot | null) => number | null;
  // The optional 4th param (the same TelemetrySnapshot evaluate() just read) is unused by every
  // numeric rule below - they already fully describe themselves from level/value/thresholds -
  // but hardware-tamper needs it to report which specific fields actually mismatched, which
  // can't be encoded in a single number the way a percentage or day-count can.
  buildAlert: (level: RuleLevel, value: number, thresholds: Thresholds, data?: TelemetrySnapshot | null) => Pick<AlertItem, "severity" | "title" | "detail" | "category" | "iconColor" | "iconBg">;
};

// Fixed reminder window for warranty-expiry - see that rule's own comment for why this isn't
// user-editable the way the other rules' thresholds are.
const WARRANTY_EXPIRY_REMINDER_DAYS = 30;

const RULES: RuleDefinition[] = [
  {
    id: "cpu-load",
    iconKey: "cpu",
    comparison: "above",
    // 5 percentage points - CPU load is a genuinely noisy, bursty real value; a small margin
    // would still flap on ordinary moment-to-moment variance.
    clearMargin: 5,
    getThresholds: (c) => ({ warning: c.cpuWarning, critical: c.cpuCritical }),
    evaluate: (data) => data?.cpu?.LoadPercentage ?? null,
    buildAlert: (level, value, t) => ({
      severity: level === "critical" ? "critical" : "warning",
      title: `CPU load ${level === "critical" ? "critically high" : "high"} at ${Math.round(value)}%`,
      detail: `CPU load has exceeded ${level === "critical" ? t.critical : t.warning}%.`,
      category: "Performance",
      iconColor: level === "critical" ? "var(--clpa-critical)" : "var(--clpa-warning)",
      iconBg: level === "critical" ? "rgba(var(--clpa-critical-bright-rgb),0.1)" : "rgba(var(--clpa-warning-bright-rgb),0.12)",
    }),
  },
  {
    id: "memory-usage",
    iconKey: "memory",
    comparison: "above",
    // 5 percentage points - same reasoning as cpu-load's own margin above.
    clearMargin: 5,
    getThresholds: (c) => ({ warning: c.memoryWarning, critical: c.memoryCritical }),
    evaluate: (data) => {
      const total = data?.memory?.totalKB;
      const free = data?.memory?.freeKB;
      if (total == null || free == null || total <= 0) return null;
      return ((total - free) / total) * 100;
    },
    buildAlert: (level, value, t) => ({
      severity: level === "critical" ? "critical" : "warning",
      title: `Memory usage ${level === "critical" ? "critically high" : "high"} at ${Math.round(value)}%`,
      detail: `Memory usage has exceeded ${level === "critical" ? t.critical : t.warning}%.`,
      category: "Performance",
      iconColor: level === "critical" ? "var(--clpa-critical)" : "var(--clpa-warning)",
      iconBg: level === "critical" ? "rgba(var(--clpa-critical-bright-rgb),0.1)" : "rgba(var(--clpa-warning-bright-rgb),0.12)",
    }),
  },
  {
    id: "storage-free",
    iconKey: "storage",
    comparison: "below",
    clearMargin: 5,
    getThresholds: () => ({ warning: 15, critical: 5 }),
    evaluate: (data) => {
      const disks = Array.isArray(data?.logicalDisks) ? data.logicalDisks : [];
      let minFree: number | null = null;
      for (const d of disks) {
        if (d?.Size == null || d.Size <= 0 || d.FreeSpace == null) continue;
        const freePct = (d.FreeSpace / d.Size) * 100;
        if (minFree == null || freePct < minFree) minFree = freePct;
      }
      return minFree;
    },
    buildAlert: (level, value, t) => ({
      severity: level === "critical" ? "critical" : "warning",
      title: `Storage free space low at ${Math.round(value)}%`,
      detail: `At least one volume has dropped below ${level === "critical" ? t.critical : t.warning}% free.`,
      category: "Storage",
      iconColor: level === "critical" ? "var(--clpa-critical)" : "var(--clpa-warning)",
      iconBg: level === "critical" ? "rgba(var(--clpa-critical-bright-rgb),0.1)" : "rgba(var(--clpa-warning-bright-rgb),0.12)",
    }),
  },
  {
    id: "battery-low",
    iconKey: "battery",
    comparison: "below",
    // 3 percentage points - charge % moves more slowly/predictably than CPU load, so a smaller
    // margin than cpu-load/memory-usage is still enough to stop flapping right at the line.
    clearMargin: 3,
    getThresholds: (c) => ({ warning: c.batteryWarning, critical: c.batteryCritical }),
    evaluate: (data) => {
      const battery = data?.battery?.[0];
      if (!battery || !isBatteryDischarging(battery.BatteryStatus)) return null;
      return battery.EstimatedChargeRemaining ?? null;
    },
    buildAlert: (level, value, t) => ({
      severity: level === "critical" ? "critical" : "warning",
      title: `Battery ${level === "critical" ? "critically low" : "low"} at ${Math.round(value)}%`,
      detail: `Battery charge has dropped below ${level === "critical" ? t.critical : t.warning}% while discharging.`,
      category: "Battery",
      iconColor: level === "critical" ? "var(--clpa-critical)" : "var(--clpa-warning)",
      iconBg: level === "critical" ? "rgba(var(--clpa-critical-bright-rgb),0.1)" : "rgba(var(--clpa-warning-bright-rgb),0.12)",
    }),
  },
  {
    id: "cpu-temp",
    iconKey: "thermal",
    comparison: "above",
    // 5°C - real per-core thermal readings jitter a few degrees under bursty load; this is the
    // condition that actually motivated this fix (the exact "CPU temperature high" flapping
    // reported in the audit).
    clearMargin: 5,
    getThresholds: (c) => ({ warning: c.cpuTempWarning, critical: c.cpuTempCritical }),
    // Real CPU package/core temp via LibreHardwareMonitor (or HWiNFO where LHM doesn't have
    // it) - null whenever neither source is reachable or exposes a matching sensor on this
    // hardware, same graceful-degradation convention as every hardwareMonitor field.
    evaluate: (data) => data?.hardwareMonitor?.cpuTempC ?? null,
    buildAlert: (level, value, t) => ({
      severity: level === "critical" ? "critical" : "warning",
      title: `CPU temperature ${level === "critical" ? "critically high" : "high"} at ${Math.round(value)}°C`,
      detail: `CPU temperature has exceeded ${level === "critical" ? t.critical : t.warning}°C.`,
      category: "Performance",
      iconColor: level === "critical" ? "var(--clpa-critical)" : "var(--clpa-warning)",
      iconBg: level === "critical" ? "rgba(var(--clpa-critical-bright-rgb),0.1)" : "rgba(var(--clpa-warning-bright-rgb),0.12)",
    }),
  },
  {
    id: "battery-health",
    iconKey: "battery",
    comparison: "below",
    // 2 percentage points - wear/degradation changes extremely slowly (not poll-to-poll noise
    // the way load/temp do), so a small margin is enough to be correct without meaningfully
    // delaying a genuine recovery (e.g. after a baseline reset).
    clearMargin: 2,
    getThresholds: (c) => ({ warning: c.batteryHealthWarning, critical: c.batteryHealthCritical }),
    // A different real signal from battery-low above (wear/degradation, not current charge %) -
    // reuses the same shared WMI -> powercfg -> LHM-degradation priority chain every other real
    // battery-health display in this app already uses (getBatteryHealthPercent in derived.ts),
    // rather than reading one narrower source (e.g. LHM alone) that could disagree with what's
    // shown on the Hardware page for the same machine. Always evaluated regardless of charging/
    // discharging state - wear is a real fact about the battery either way, unlike charge %.
    evaluate: (data) => getBatteryHealthPercent(data, true),
    buildAlert: (level, value, t) => ({
      severity: level === "critical" ? "critical" : "warning",
      title: `Battery health ${level === "critical" ? "critically low" : "low"} at ${Math.round(value)}%`,
      detail: `Battery health has dropped below ${level === "critical" ? t.critical : t.warning}% remaining capacity.`,
      category: "BatteryHealth",
      iconColor: level === "critical" ? "var(--clpa-critical)" : "var(--clpa-warning)",
      iconBg: level === "critical" ? "rgba(var(--clpa-critical-bright-rgb),0.1)" : "rgba(var(--clpa-warning-bright-rgb),0.12)",
    }),
  },
  {
    id: "warranty-expiry",
    iconKey: "warranty",
    comparison: "below",
    // 0 - a day count is a slow, monotonic calendar fact, not a noisy poll-to-poll reading; it
    // only ever "clears" via a real renewal (a distinct event, not sensor jitter), so there's
    // nothing for a margin to guard against here.
    clearMargin: 0,
    // Not user-editable, like storage-free's fixed thresholds above - there's no reasonable
    // per-user percentage knob for a calendar reminder. WARRANTY_EXPIRY_REMINDER_DAYS days
    // remaining is "warning", already past (0 days remaining, i.e. negative) is "critical".
    getThresholds: () => ({ warning: WARRANTY_EXPIRY_REMINDER_DAYS, critical: 0 }),
    // No OEM warranty end date is collected (Dell/HP/Lenovo each need their own lookup).
    // Returning null skips the rule so another brand cannot inherit this build PC's Dell dates.
    evaluate: () => null,
    buildAlert: (level, value) => {
      const daysUntil = Math.round(value);
      const isExpired = daysUntil < 0;
      const daysAbs = Math.abs(daysUntil);
      const dayWord = daysAbs === 1 ? "day" : "days";
      return {
        severity: level === "critical" ? "critical" : "warning",
        title: isExpired ? `Warranty expired ${daysAbs} ${dayWord} ago` : `Warranty expiring in ${daysAbs} ${dayWord}`,
        detail: isExpired
          ? "This device's warranty end date has passed and has not been renewed."
          : `This device's warranty is within the ${WARRANTY_EXPIRY_REMINDER_DAYS}-day reminder window.`,
        category: "Warranty",
        iconColor: level === "critical" ? "var(--clpa-critical)" : "var(--clpa-warning)",
        iconBg: level === "critical" ? "rgba(var(--clpa-critical-bright-rgb),0.1)" : "rgba(var(--clpa-warning-bright-rgb),0.12)",
      };
    },
  },
  {
    id: "hardware-tamper",
    iconKey: "tamper",
    comparison: "above",
    // 0 - evaluate() below is a genuine discrete signal (1 or null, never a graduated range), not
    // a continuous reading that can "hover near" a threshold - a margin has nothing to apply
    // against, and would otherwise wedge this rule permanently latched (see
    // hasClearedHysteresis's own comment on why margin>0 treats a null reading as "unknown, don't
    // clear," which is wrong for a rule whose only real clear signal ever IS a null reading).
    clearMargin: 0,
    // Boolean-like trigger, same pattern as warranty-expiry's fixed calendar window above - "did
    // the real hardware fingerprint change" has no reasonable user-editable percentage, so this
    // ignores the live ThresholdConfig entirely. warning === critical (both 0) means this only
    // ever fires at "critical" - levelFor checks the critical branch first - never "warning".
    getThresholds: () => ({ warning: 0, critical: 0 }),
    // 1 the instant real backend/'s POST /v1/devices/:id/hardware-check reports "mismatch";
    // null for every other real status ("baseline-set", "match") or no data at all - never 0,
    // so a genuine match/baseline-pending/unknown state clears the rule instead of reading as
    // its own level.
    evaluate: (data) => (data?.hardwareIntegrity?.status === "mismatch" ? 1 : null),
    buildAlert: (_level, _value, _thresholds, data) => {
      const fields = data?.hardwareIntegrity?.mismatchedFields ?? [];
      const fieldList = fields.length > 0 ? fields.join(", ") : "one or more hardware identifiers";
      return {
        severity: "critical",
        title: "Hardware tamper detected",
        detail: `${fieldList} changed since this device's hardware baseline was captured - verify this is a legitimate hardware change, or reset the baseline if it is.`,
        category: "Security",
        iconColor: "var(--clpa-critical)",
        iconBg: "rgba(var(--clpa-critical-bright-rgb),0.1)",
      };
    },
  },
  {
    id: "battery-full",
    iconKey: "battery",
    comparison: "above",
    // 0 - same reasoning as hardware-tamper's own margin above: evaluate() below is a discrete
    // 1-or-null signal, not a continuous reading, so a margin>0 would wedge this permanently
    // latched instead of clearing the instant it's genuinely no longer both 100%-and-status-3.
    clearMargin: 0,
    // Boolean-like crossing, same wasActive-driven "fire once" mechanics every rule above
    // already relies on - critical fixed far out of reach (999) so this can only ever cross
    // into "warning" internally; the alert's actual severity is hardcoded to "info" in
    // buildAlert below regardless, since RuleLevel has no "info" level of its own.
    getThresholds: () => ({ warning: 0, critical: 999 }),
    // 1 only the instant the battery is both at 100% AND genuinely done charging (BatteryStatus
    // 3, "Fully Charged" - see batteryStatus.ts), not merely sitting at 100% while discharging
    // (BatteryStatus 1) moments after being unplugged from a full charge.
    evaluate: (data) => {
      const battery = data?.battery?.[0];
      if (!battery || battery.EstimatedChargeRemaining == null) return null;
      return battery.EstimatedChargeRemaining >= 100 && battery.BatteryStatus === 3 ? 1 : null;
    },
    buildAlert: () => ({
      severity: "info",
      title: "Battery fully charged",
      detail: "Battery has reached 100% and charging is complete.",
      category: "Battery",
      iconColor: "var(--clpa-primary)",
      iconBg: "rgba(var(--clpa-primary-rgb),0.1)",
    }),
  },
];

function levelFor(rule: RuleDefinition, value: number | null, thresholds: Thresholds): RuleLevel | null {
  if (value == null) return null;
  if (rule.comparison === "above") {
    if (value > thresholds.critical) return "critical";
    if (value > thresholds.warning) return "warning";
    return null;
  }
  if (value < thresholds.critical) return "critical";
  if (value < thresholds.warning) return "warning";
  return null;
}

// Whether a rule that's currently latched (nextState[rule.id] != null) should actually be
// considered cleared this poll. This is the hysteresis fix for the real runaway-alert bug: a
// value sitting right at the warning line was previously clearing (and re-arming) the instant a
// single poll read it back at/below the raw threshold, so ordinary sensor noise near a hard
// boundary produced a fresh alert on every re-crossing. Requiring it to move rule.clearMargin
// past that line first means a value merely nudging back and forth across the exact threshold
// no longer flaps the latch.
//
// rule.clearMargin === 0 rules (hardware-tamper, battery-full, warranty-expiry, storage-free)
// reproduce the exact original instant-clear-on-null behavior instead of going through the
// margin math at all - see each of their own comments for why a margin doesn't apply to them.
function hasClearedHysteresis(rule: RuleDefinition, value: number | null, thresholds: Thresholds): boolean {
  if (rule.clearMargin <= 0) {
    return levelFor(rule, value, thresholds) == null;
  }
  // A null reading (sensor/backend momentarily unavailable) is "don't know," not "resolved" -
  // unlike the margin===0 rules above, these are real continuous sensor values where null
  // genuinely means "couldn't be measured this poll," not "measured as safely clear." Clearing
  // on it would risk a false "resolved" from a transient telemetry gap rather than an actual
  // improvement in the underlying condition.
  if (value == null) return false;
  if (rule.comparison === "above") return value <= thresholds.warning - rule.clearMargin;
  return value >= thresholds.warning + rule.clearMargin;
}

// Imported (not defined here anymore) AND re-exported, so both this file's own many internal
// calls and every existing external importer (AppContext.tsx) keep working unchanged - see
// lib/storage.ts's own comment on why the real definitions live there now (useTelemetry.ts
// needed them too, and importing them from this file would have been circular).
export { loadJSON, saveJSON };

let alertSeq = 0; // Disambiguates alerts generated within the same millisecond.

// One-time cleanup for the real runaway-alert bug: before hysteresis + ruleId-dedup existed
// (see hasClearedHysteresis and the fire/update logic in the effect below), a value flapping
// near a threshold could accumulate hundreds of separate AlertItems for what was really one
// ongoing condition. This collapses whatever had already piled up under ALERTS_KEY - grouped by
// ruleId, keeping only the most recent entry per rule with occurrenceCount set to how many were
// actually collapsed - and persists the result back, so both this session's `alerts` state and
// the next load's localStorage read start from the collapsed shape. Sample/seed alerts (no
// ruleId) are left completely untouched - they were never subject to this bug. Gated behind
// ALERTS_MIGRATION_KEY via the same loadJSON/saveJSON helpers every other piece of persisted
// state in this file already uses, so this only ever runs once.
function migrateCollapseAlertsByRuleId(): PersistedAlert[] {
  const raw = loadJSON<PersistedAlert[]>(ALERTS_KEY, []);
  if (loadJSON(ALERTS_MIGRATION_KEY, false)) {
    return raw;
  }

  const occurrencesByRuleId = new Map<string, number>();
  for (const a of raw) {
    if (!a.ruleId) continue;
    occurrencesByRuleId.set(a.ruleId, (occurrencesByRuleId.get(a.ruleId) ?? 0) + 1);
  }

  // raw is already stored newest-first (see the fire logic's own `[...newAlerts, ...prev]`
  // ordering below), so the first entry encountered per ruleId is genuinely the most recent
  // real occurrence of that rule - keep it (with its occurrenceCount set to the real total),
  // drop every older duplicate for the same rule, and leave sample entries exactly where they
  // were.
  const seenRuleIds = new Set<string>();
  const collapsed: PersistedAlert[] = [];
  for (const a of raw) {
    if (!a.ruleId) {
      collapsed.push(a);
      continue;
    }
    if (seenRuleIds.has(a.ruleId)) continue;
    seenRuleIds.add(a.ruleId);
    collapsed.push({ ...a, occurrenceCount: occurrencesByRuleId.get(a.ruleId)! });
  }

  saveJSON(ALERTS_KEY, collapsed);
  saveJSON(ALERTS_MIGRATION_KEY, true);
  return collapsed;
}

function migrateDropUnwiredWarrantyAlerts(alerts: PersistedAlert[]): PersistedAlert[] {
  if (loadJSON(ALERTS_DROP_WARRANTY_KEY, false)) return alerts;
  const next = alerts.filter((a) => a.ruleId !== "warranty-expiry");
  saveJSON(ALERTS_KEY, next);
  saveJSON(ALERTS_DROP_WARRANTY_KEY, true);
  const state = loadJSON<EngineState>(STATE_KEY, {});
  if (state["warranty-expiry"]) {
    const { "warranty-expiry": _dropped, ...rest } = state;
    saveJSON(STATE_KEY, rest);
  }
  return next;
}

export function useAlertEngine() {
  const { data, connected } = useTelemetry();
  const ruleStateRef = useRef<EngineState>(loadJSON(STATE_KEY, {}));
  const [alerts, setAlerts] = useState<AlertItem[]>(() =>
    migrateDropUnwiredWarrantyAlerts(migrateCollapseAlertsByRuleId()).map(hydrateAlert),
  );
  const [categoryPrefs, setCategoryPrefs] = useState<CategoryPrefs>(() => ({
    ...DEFAULT_CATEGORY_PREFS,
    ...loadJSON<Partial<CategoryPrefs>>(CATEGORY_PREFS_KEY, {}),
  }));
  const [thresholds, setThresholdsState] = useState<ThresholdConfig>(() => ({
    ...DEFAULT_THRESHOLDS,
    ...loadJSON<Partial<ThresholdConfig>>(THRESHOLDS_KEY, {}),
  }));

  const setCategoryEnabled = useCallback((category: RuleCategory, enabled: boolean) => {
    setCategoryPrefs((prev) => {
      const next = { ...prev, [category]: enabled };
      saveJSON(CATEGORY_PREFS_KEY, next);
      return next;
    });
  }, []);

  const setThresholdField = useCallback((metric: ThresholdMetric, field: "warning" | "critical", rawValue: number) => {
    setThresholdsState((prev) => {
      const keys = METRIC_KEYS[metric];
      const pair = { warning: prev[keys.warning], critical: prev[keys.critical] };
      const nextPair = applyThresholdEdit(METRIC_COMPARISON[metric], pair, field, rawValue);
      const next: ThresholdConfig = { ...prev, [keys.warning]: nextPair.warning, [keys.critical]: nextPair.critical };
      saveJSON(THRESHOLDS_KEY, next);
      return next;
    });
  }, []);

  const resetThresholds = useCallback(() => {
    setThresholdsState(DEFAULT_THRESHOLDS);
    saveJSON(THRESHOLDS_KEY, DEFAULT_THRESHOLDS);
  }, []);

  const resetCategoryPrefs = useCallback(() => {
    setCategoryPrefs(DEFAULT_CATEGORY_PREFS);
    saveJSON(CATEGORY_PREFS_KEY, DEFAULT_CATEGORY_PREFS);
  }, []);

  const [snoozedUntil, setSnoozedUntil] = useState<SnoozeMap>(() => loadJSON(SNOOZE_KEY, {}));
  // Recomputed fresh every poll — not persisted, since it's a live read of "is this crossing
  // right now," not a record of anything that happened. Lets a consumer detect a dismissed (or
  // snoozed) alert whose underlying condition never actually went away.
  const [liveActiveRules, setLiveActiveRules] = useState<LiveActiveRule[]>([]);

  // Suppresses a rule from firing new alerts until durationMs from now — not just hiding one
  // alert instance, but blocking the underlying rule itself. Returns the computed expiry so
  // the caller (a snooze toast) can state the real time rather than a fixed "24 hours" claim.
  const snoozeRule = useCallback((ruleId: string, durationMs: number) => {
    const until = Date.now() + durationMs;
    setSnoozedUntil((prev) => {
      const next = { ...prev, [ruleId]: until };
      saveJSON(SNOOZE_KEY, next);
      return next;
    });
    return until;
  }, []);

  useEffect(() => {
    // Telemetry server unreachable — don't evaluate rules or fabricate alerts from stale data.
    if (!connected) return;

    const nextState: EngineState = { ...ruleStateRef.current };
    // A rule that fires this poll - built here, applied to `alerts` in one batched setAlerts
    // below rather than per-rule, since the dedup-by-ruleId check needs to see the CURRENT
    // alerts array (including any other rule this same poll already matched against), not a
    // stale closure over whatever `alerts` was when this effect last ran.
    const fireEvents: { ruleId: RuleId; built: ReturnType<RuleDefinition["buildAlert"]>; iconKey: IconKey; timeLabel: string }[] = [];
    const liveActive: LiveActiveRule[] = [];
    let stateChanged = false;
    let nextSnoozes = snoozedUntil;
    let snoozesChanged = false;

    for (const rule of RULES) {
      if (!categoryPrefs[RULE_CATEGORY[rule.id]]) {
        // Category disabled in Settings — clear any active state so the rule fires fresh
        // (rather than staying silently latched) once the category is re-enabled.
        if (nextState[rule.id] != null) {
          delete nextState[rule.id];
          stateChanged = true;
        }
        continue;
      }

      const snoozeUntil = nextSnoozes[rule.id];
      const isSnoozed = snoozeUntil != null && Date.now() < snoozeUntil;
      if (snoozeUntil != null && !isSnoozed) {
        // Window expired — clean up rather than let stale timestamps accumulate.
        const { [rule.id]: _expired, ...rest } = nextSnoozes;
        nextSnoozes = rest;
        snoozesChanged = true;
      }

      const ruleThresholds = rule.getThresholds(thresholds);
      const value = rule.evaluate(data);
      const firingLevel = levelFor(rule, value, ruleThresholds);
      const wasLevel = nextState[rule.id];
      const wasActive = wasLevel != null;

      if (wasActive) {
        // Hysteresis: a latched rule only actually clears once the value has moved
        // rule.clearMargin past the warning line (see hasClearedHysteresis) - not the instant a
        // single poll reads it back at/below the raw threshold. This is deliberately
        // unconditional on isSnoozed, same reasoning as before this fix: it's bookkeeping ("is
        // the metric still crossing, allowing for the margin?"), not alert creation:
        if (hasClearedHysteresis(rule, value, ruleThresholds)) {
          delete nextState[rule.id];
          stateChanged = true;
          postRealEvent(`alert-cleared-${rule.id}`, `${RULE_LABEL[rule.id]} returned to normal.`, "info");
        } else {
          // Still latched - either genuinely still crossing, or within the hysteresis band
          // (dipped under the raw threshold but not yet past the real clear margin). Either way
          // this condition reads as live/active to callers like dismissedButActive, at whatever
          // level it's latched at - and never re-fires while latched, hysteresis or not, same
          // "don't re-fire until it actually clears and re-crosses" rule as before this fix.
          liveActive.push({ ruleId: rule.id, category: RULE_CATEGORY[rule.id], level: firingLevel ?? wasLevel });
        }
        continue;
      }

      if (firingLevel == null) continue;

      // Live crossing right now, regardless of snooze/dismiss/anything else — this is what
      // lets a caller notice "the alert for this is gone, but the condition never went away."
      liveActive.push({ ruleId: rule.id, category: RULE_CATEGORY[rule.id], level: firingLevel });

      if (isSnoozed) {
        // Suppress firing entirely while snoozed — don't queue it up, and don't mark the
        // rule active either, so it fires fresh (not a backlog) once the window expires and
        // the metric is still crossing on a later poll.
        continue;
      }

      nextState[rule.id] = firingLevel;
      stateChanged = true;
      const built = rule.buildAlert(firingLevel, value as number, ruleThresholds, data);
      fireEvents.push({
        ruleId: rule.id,
        built,
        iconKey: rule.iconKey,
        timeLabel: formatTimeLabel(new Date()),
      });
      postRealEvent(`alert-fired-${rule.id}`, built.title, built.severity);
    }

    if (stateChanged) {
      ruleStateRef.current = nextState;
      saveJSON(STATE_KEY, nextState);
    }

    if (snoozesChanged) {
      setSnoozedUntil(nextSnoozes);
      saveJSON(SNOOZE_KEY, nextSnoozes);
    }

    setLiveActiveRules(liveActive);

    if (fireEvents.length > 0) {
      setAlerts((prev) => {
        let next = prev;
        for (const fe of fireEvents) {
          const existingIdx = next.findIndex((a) => a.ruleId === fe.ruleId);
          if (existingIdx !== -1) {
            // Real dedup: this exact condition already has an open alert (never dismissed) -
            // update it in place (latest severity/title/detail, bumped time, re-marked unread,
            // occurrence count incremented) instead of appending a visually-duplicate card. This
            // is the actual fix for the runaway-alert bug: a value flapping across a threshold
            // now grows one alert's count instead of spawning a new AlertItem every re-crossing.
            const existing = next[existingIdx];
            // A rule re-firing after its alert was already resolved (acknowledged/snoozed) is
            // genuinely a new incident for response-time purposes, not a continuation of the old
            // one - restart createdAt and clear resolvedAt so AAlertHistoryCard's real "Avg
            // response" stat measures THIS occurrence's time-to-respond, not a stale span left
            // over from before it was ever resolved the first time. A rule bumping while its
            // alert is still open (never resolved) keeps its original createdAt untouched.
            const wasResolved = existing.unread === false;
            const updated: AlertItem = {
              ...existing,
              ...fe.built,
              time: fe.timeLabel,
              unread: true,
              occurrenceCount: existing.occurrenceCount + 1,
              createdAt: wasResolved ? Date.now() : existing.createdAt,
              resolvedAt: wasResolved ? undefined : existing.resolvedAt,
            };
            next = [updated, ...next.slice(0, existingIdx), ...next.slice(existingIdx + 1)];
          } else {
            alertSeq += 1;
            const created: AlertItem = {
              ...fe.built,
              id: `real-${fe.ruleId}-${Date.now()}-${alertSeq}`,
              ruleId: fe.ruleId,
              time: fe.timeLabel,
              unread: true,
              source: "real",
              Icon: ICON_MAP[fe.iconKey],
              occurrenceCount: 1,
              createdAt: Date.now(),
            };
            next = [created, ...next];
          }
        }
        saveJSON(ALERTS_KEY, next.map(dehydrateAlert));
        return next;
      });
    }
  }, [data, connected, categoryPrefs, thresholds, snoozedUntil]);

  return { alerts, categoryPrefs, setCategoryEnabled, thresholds, setThresholdField, resetThresholds, resetCategoryPrefs, snoozedUntil, snoozeRule, liveActiveRules };
}
