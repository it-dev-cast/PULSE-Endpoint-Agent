// Real "Reset Agent" full-reset scope - every localStorage key this app actually persists,
// enumerated explicitly (not a blind localStorage.clear()) so this list stays auditable: adding a
// new persisted key elsewhere in the app doesn't silently get swept into "full reset" without a
// deliberate decision here, and this file itself is the one place to check "what does Reset Agent
// actually clear." Found via a full grep of every `"clpa:...":` key constant in src/app - see each
// hook's own file for what each key controls.
//
// Deliberately NOT included: clpa:startup:module-load-at/first-connected-at/first-real-data-at
// (useTelemetry.ts) - these aren't persistent state at all, they're per-run diagnostic timing
// stamps that already get overwritten/cleared on every real app launch regardless of Reset Agent,
// so clearing them here would be a no-op that just adds noise to this list.
export const RESET_AGENT_LOCAL_STORAGE_KEYS = [
  // Settings/preferences
  "clpa:settings:tray-badge-count:v1",
  "clpa:settings:show-in-tray:v1",
  "clpa:settings:quiet-hours:v1",
  "clpa:settings:group-similar-alerts:v1",
  "clpa:settings:priority-sorting:v1",
  "clpa:settings:desktop-notifications:v1",
  "clpa:settings:sound-critical:v1",
  "clpa:settings:accent-color:v1",
  "clpa:settings:density:v1",
  "clpa:settings:idle-lock-enabled:v1",
  "clpa:settings:idle-lock-timeout-minutes:v1",
  "clpa:settings:telemetry-enabled:v1",
  "clpa:settings:theme:v1",
  "clpa:settings:time-format:v1",
  "clpa:settings:date-format:v1",
  "clpa:settings:organization:v1",
  "clpa:settings:department:v1",
  // Alert engine - rule latch state, the alerts list itself, category toggles, thresholds,
  // snoozes, and the one-time ruleId-dedup migration flag (a fresh install should be able to
  // run that migration again cleanly if it ever somehow re-encounters the pre-migration shape,
  // rather than staying permanently gated by a flag from the device identity being reset).
  "clpa:alert-engine-state:v1",
  "clpa:alert-engine-alerts:v1",
  "clpa:alert-engine-category-prefs:v1",
  "clpa:alert-thresholds:v1",
  "clpa:alert-engine-snoozes:v1",
  "clpa:alert-engine-alerts-migrated-ruleid-dedup:v1",
  // AI Intel's local trend history (SSD/Battery Remaining Life regressions' own data points)
  "clpa:trend-history:storage-wear:v1",
  "clpa:trend-history:battery-health:v1",
  "clpa:trend-history:health-score:v1",
] as const;

export function clearResetAgentLocalStorage(): void {
  for (const key of RESET_AGENT_LOCAL_STORAGE_KEYS) {
    try {
      localStorage.removeItem(key);
    } catch {
      // Private-browsing/quota-related storage failure - non-fatal, same as every other
      // localStorage write elsewhere in this app (see lib/storage.ts's own saveJSON).
    }
  }
}
