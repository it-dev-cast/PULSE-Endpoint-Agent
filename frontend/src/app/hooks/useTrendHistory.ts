import { useEffect } from "react";
import type { TelemetrySnapshot } from "./useTelemetry";
import { getBatteryHealthPercent, getStorageWearPercent } from "../lib/derived";

export type TrendPoint = { date: string; value: number };

const STORAGE_WEAR_KEY = "clpa:trend-history:storage-wear:v1";
const BATTERY_HEALTH_KEY = "clpa:trend-history:battery-health:v1";
const HEALTH_SCORE_KEY = "clpa:trend-history:health-score:v1";
const MAX_ENTRIES = 365;

function todayLocalDate(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function readHistory(key: string): TrendPoint[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is TrendPoint =>
        p && typeof p.date === "string" && typeof p.value === "number" && Number.isFinite(p.value),
    );
  } catch {
    return [];
  }
}

function writeHistory(key: string, history: TrendPoint[]) {
  try {
    localStorage.setItem(key, JSON.stringify(history));
  } catch {
    // localStorage full or unavailable (e.g. private browsing) - trend just won't persist
    // across reloads this session, not worth surfacing as an error to the user.
  }
}

// Records at most one point per calendar day (local time) per metric, and only when the
// underlying real value is actually available - a day where e.g. smartctl isn't installed
// simply isn't recorded, rather than recording a null/fabricated point.
function recordIfNeeded(key: string, value: number | null): void {
  if (value == null || !Number.isFinite(value)) return;
  const history = readHistory(key);
  const today = todayLocalDate();
  if (history.some((p) => p.date === today)) return;
  const updated = [...history, { date: today, value }];
  if (updated.length > MAX_ENTRIES) updated.splice(0, updated.length - MAX_ENTRIES);
  writeHistory(key, updated);
}

// Takes telemetry data/connected rather than calling useTelemetry() itself, so a component
// that already polls telemetry (e.g. AITopPredictionsCard) doesn't spin up a second, redundant
// poll loop just to also get trend history.
//
// `healthScore` is optional and passed in by the caller (AIHealthScoreCard) rather than derived
// here, since it's itself a blend of several sub-scores computed there - the caller is
// responsible for passing null on days its score isn't fully backed by real data (see the
// comment at that call site), so this hook never has to know that formula.
export function useTrendHistory(
  data: TelemetrySnapshot | null | undefined,
  connected: boolean,
  healthScore?: number | null,
) {
  // Shared getters (src/app/lib/derived.ts) - the exact same functions every card that shows
  // these values calls, so the recorded trend history always matches whichever number is
  // actually shown as "real" everywhere else.
  const storageWearPercent = getStorageWearPercent(data, connected);
  const batteryHealthPercent = getBatteryHealthPercent(data, connected);

  useEffect(() => {
    if (!connected) return;
    recordIfNeeded(STORAGE_WEAR_KEY, storageWearPercent);
    recordIfNeeded(BATTERY_HEALTH_KEY, batteryHealthPercent);
    recordIfNeeded(HEALTH_SCORE_KEY, healthScore ?? null);
  }, [connected, storageWearPercent, batteryHealthPercent, healthScore]);

  return {
    storageWearHistory: readHistory(STORAGE_WEAR_KEY),
    batteryHealthHistory: readHistory(BATTERY_HEALTH_KEY),
    healthScoreHistory: readHistory(HEALTH_SCORE_KEY),
    storageWearPercent,
    batteryHealthPercent,
  };
}

export type ScoreDelta = { delta: number; daysAgo: number; baselineDate: string } | null;

// Compares the most recently recorded value to the earliest value within the last 7 days (or
// the single oldest recorded value if less than 7 days of history exist yet). Null until at
// least 2 distinct days are recorded - there's nothing to compare yet with just one point.
export function computeScoreDelta(history: TrendPoint[]): ScoreDelta {
  const distinctDates = [...new Set(history.map((p) => p.date))].sort();
  if (distinctDates.length < 2) return null;

  const latestDate = distinctDates[distinctDates.length - 1];
  const latestMs = new Date(`${latestDate}T00:00:00`).getTime();
  // A full 7-days-back cutoff (not 6) - otherwise a continuously-recorded week caps out at
  // daysAgo=6 and "vs last week" (daysAgo === 7) can never actually trigger.
  const sevenDaysAgoMs = latestMs - 7 * 24 * 60 * 60 * 1000;

  const withinWindow = distinctDates.filter((d) => new Date(`${d}T00:00:00`).getTime() >= sevenDaysAgoMs);
  const baselineDate = withinWindow[0] ?? distinctDates[0];

  const latestValue = history.find((p) => p.date === latestDate)?.value;
  const baselineValue = history.find((p) => p.date === baselineDate)?.value;
  if (latestValue == null || baselineValue == null) return null;

  const daysAgo = Math.round((latestMs - new Date(`${baselineDate}T00:00:00`).getTime()) / (24 * 60 * 60 * 1000));
  return { delta: latestValue - baselineValue, daysAgo, baselineDate };
}
