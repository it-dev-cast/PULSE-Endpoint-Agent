import { useEffect, useRef, useState } from "react";
import { loadJSON, saveJSON } from "../lib/storage";

// Real "Auto-lock on idle" - app-level only, deliberately not OS/Windows session control (see
// this feature's own scoping decision: locking the real Windows session is out of proportion for
// what a monitoring agent should do - this only gates this app's own window with an overlay).
//
// Idle tracking: real mousemove/mousedown/keydown/wheel/touchstart listeners on the webview's own
// `window`, resetting a last-activity timestamp - no OS-level input hooking needed for an
// app-level feature. Listening at `window` (not a specific element) also correctly treats the
// user switching to a DIFFERENT app as idle time too, with no extra window-blur handling needed:
// once focus leaves this webview, these events simply stop firing on it, which is already the
// right behavior.
//
// Timeout default: 30 minutes. NOT tied to backend/auth.go's real adminSessionDuration (checked -
// that's 12 hours, for the Command Center dashboard's own separate admin-JWT session, unrelated
// to this device agent). Settings' "Session timeout" field showing "30 minutes" elsewhere in this
// app was itself decorative before this feature (flagged Category D in the earlier feasibility
// scoping pass) - not a real constant to inherit from. 30 minutes is chosen here as this
// feature's own standalone, reasonable default (a common real-world idle-lock convention), not
// because of a false shared-constant claim.
export type IdleLockSettings = { enabled: boolean; timeoutMinutes: number };

const ENABLED_KEY = "clpa:settings:idle-lock-enabled:v1";
const TIMEOUT_KEY = "clpa:settings:idle-lock-timeout-minutes:v1";
const DEFAULT_TIMEOUT_MINUTES = 30;

// Cycled through by Settings' "Session timeout" field (the same real duration this hook actually
// enforces, not a separate decorative number) - a small fixed set rather than a free-text input,
// matching this page's existing SField "click to cycle" convention (Time Format/Date Format).
export const IDLE_TIMEOUT_PRESETS_MINUTES = [5, 15, 30, 60] as const;

let enabledState = loadJSON<boolean>(ENABLED_KEY, true);
let timeoutMinutesState = loadJSON<number>(TIMEOUT_KEY, DEFAULT_TIMEOUT_MINUTES);
const settingsListeners = new Set<(settings: IdleLockSettings) => void>();

function notifySettingsListeners() {
  const snapshot = { enabled: enabledState, timeoutMinutes: timeoutMinutesState };
  settingsListeners.forEach((listener) => listener(snapshot));
}

export function getIdleLockSettings(): IdleLockSettings {
  return { enabled: enabledState, timeoutMinutes: timeoutMinutesState };
}

export function setIdleLockEnabled(enabled: boolean): void {
  enabledState = enabled;
  saveJSON(ENABLED_KEY, enabled);
  notifySettingsListeners();
}

export function setIdleLockTimeoutMinutes(minutes: number): void {
  timeoutMinutesState = minutes;
  saveJSON(TIMEOUT_KEY, minutes);
  notifySettingsListeners();
}

// For Settings' own two controls - reactive read/write of the persisted enabled/timeout, no
// activity tracking (that only ever runs once, in useIdleLockState below, inside AppShell).
export function useIdleLockSettings() {
  const [settings, setSettings] = useState<IdleLockSettings>(getIdleLockSettings);

  useEffect(() => {
    const handleChange = (next: IdleLockSettings) => setSettings(next);
    settingsListeners.add(handleChange);
    return () => {
      settingsListeners.delete(handleChange);
    };
  }, []);

  return {
    ...settings,
    setEnabled: setIdleLockEnabled,
    setTimeoutMinutes: setIdleLockTimeoutMinutes,
  };
}

const ACTIVITY_EVENTS = ["mousemove", "mousedown", "keydown", "wheel", "touchstart"] as const;
const CHECK_INTERVAL_MS = 5000;

// The one real tracking instance - called exactly once, in AppShell, for the app's whole
// lifetime. `locked` is deliberately NOT persisted: reopening the app after it was closed while
// locked should never show a stale lock screen for no real reason - each session starts unlocked
// and only locks from real idle time observed during that session.
export function useIdleLockState() {
  const [locked, setLocked] = useState(false);
  const settings = useIdleLockSettings();
  const lastActivityRef = useRef(Date.now());
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => {
    const markActivity = () => {
      lastActivityRef.current = Date.now();
    };
    ACTIVITY_EVENTS.forEach((event) => window.addEventListener(event, markActivity, { passive: true }));
    return () => {
      ACTIVITY_EVENTS.forEach((event) => window.removeEventListener(event, markActivity));
    };
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      const current = settingsRef.current;
      if (!current.enabled) {
        // Feature turned off mid-session - a lock already showing from before that change
        // shouldn't linger with no way it could have re-armed.
        setLocked((prev) => (prev ? false : prev));
        return;
      }
      setLocked((prev) => {
        if (prev) return prev; // already locked - only an explicit unlock() clears it, not more idle time.
        const idleMs = Date.now() - lastActivityRef.current;
        return idleMs >= current.timeoutMinutes * 60 * 1000;
      });
    }, CHECK_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, []);

  const unlock = () => {
    lastActivityRef.current = Date.now();
    setLocked(false);
  };

  return { locked, unlock, enabled: settings.enabled, timeoutMinutes: settings.timeoutMinutes };
}
