// Generic localStorage read/write helpers, shared by useAlertEngine.ts and useTelemetry.ts.
// Extracted out of useAlertEngine.ts (which originally defined and exported these) so
// useTelemetry.ts can use the same real persistence pattern for its own settings (e.g. the
// Auto Monitoring pause flag) without creating a circular import - useAlertEngine.ts already
// imports useTelemetry itself, so the reverse import would have been circular.
export function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function saveJSON(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private-browsing/quota-exceeded — non-fatal, just skip persisting this write.
  }
}
