import { useEffect, useState } from "react";
import { loadJSON, saveJSON } from "../lib/storage";

// Real Light/Dark theme switch - toggles the exact same `.dark` class on <html> that
// styles/theme.css's `@custom-variant dark (&:is(.dark *))` already defines (built for the
// shadcn ui/* primitives, unused by this app's own custom CLPA pages until now). One class flip
// drives both shadcn's existing --background/--primary/etc. vars AND this app's own --clpa-*
// vars (see theme.css's CLPA token block) - so this single mechanism now actually repaints the
// whole app, not just Settings.
export type ThemeMode = "light" | "dark";

const THEME_KEY = "clpa:settings:theme:v1";

// Module-level (not component state) so setTheme() called from Settings is reflected by every
// other mounted useTheme() instance immediately - same reasoning/shape as useTelemetry.ts's own
// telemetryEnabledListeners: this hook can be called from more than one component at once, and
// none of them owns the toggle the way a single top-level provider would.
let currentTheme: ThemeMode = loadJSON<ThemeMode>(THEME_KEY, "light");
const themeListeners = new Set<(theme: ThemeMode) => void>();

function applyThemeClass(theme: ThemeMode) {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

// Applied once at module load (not deferred to the first useTheme() call) so the very first
// paint already reflects a persisted "dark" choice, instead of flashing light-then-dark.
applyThemeClass(currentTheme);

export function getTheme(): ThemeMode {
  return currentTheme;
}

export function setTheme(theme: ThemeMode): void {
  currentTheme = theme;
  saveJSON(THEME_KEY, theme);
  applyThemeClass(theme);
  themeListeners.forEach((listener) => listener(theme));
}

export function useTheme() {
  const [theme, setThemeState] = useState<ThemeMode>(currentTheme);

  useEffect(() => {
    const handleChange = (next: ThemeMode) => setThemeState(next);
    themeListeners.add(handleChange);
    return () => {
      themeListeners.delete(handleChange);
    };
  }, []);

  return {
    theme,
    setTheme: (next: ThemeMode) => setTheme(next),
    toggleTheme: () => setTheme(currentTheme === "dark" ? "light" : "dark"),
  };
}
