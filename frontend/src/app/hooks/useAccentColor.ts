import { useEffect, useState } from "react";
import { loadJSON, saveJSON } from "../lib/storage";

// Real Accent Color picker - overrides --clpa-primary/--clpa-primary-rgb (styles/theme.css) at
// runtime via an inline style on <html>, which wins over the stylesheet's :root/.dark values
// per normal CSS cascade rules without needing a third theme variant. Every preset is one of
// this app's own already-established real colors (the same 6 hex values Warranty/AI Intel/
// Alerts already use for primary/accent/success/warning/critical/info-teal) - no new palette
// invented for this picker.
const ACCENT_KEY = "clpa:settings:accent-color:v1";

export const ACCENT_PRESETS = ["#3B82F6", "#8B5CF6", "#22C55E", "#F59E0B", "#EF4444", "#06B6D4"] as const;
// The first preset happens to equal the stylesheet's own default --clpa-primary - but that's
// coincidence, not "no override needed": an inline style override on <html> beats BOTH light and
// dark stylesheet rules by CSS specificity, so applying it unconditionally would pin dark mode to
// this light-tuned blue instead of its own #5B9CFF. `null` (never explicitly chosen) is tracked as
// its own state distinct from "explicitly chose the first preset", so the default case leaves
// --clpa-primary unset and lets each theme's own real value win.
const DEFAULT_ACCENT: string | null = null;

function hexToRgbTriple(hex: string): string {
  const match = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex);
  if (!match) return "59, 130, 246";
  const [, r, g, b] = match;
  return `${parseInt(r, 16)}, ${parseInt(g, 16)}, ${parseInt(b, 16)}`;
}

let currentAccent: string | null = loadJSON<string | null>(ACCENT_KEY, DEFAULT_ACCENT);
const accentListeners = new Set<(accent: string | null) => void>();

function applyAccentVars(accent: string | null) {
  if (accent == null) {
    document.documentElement.style.removeProperty("--clpa-primary");
    document.documentElement.style.removeProperty("--clpa-primary-rgb");
    return;
  }
  document.documentElement.style.setProperty("--clpa-primary", accent);
  document.documentElement.style.setProperty("--clpa-primary-rgb", hexToRgbTriple(accent));
}

applyAccentVars(currentAccent);

export function getAccentColor(): string | null {
  return currentAccent;
}

export function setAccentColor(accent: string | null): void {
  currentAccent = accent;
  saveJSON(ACCENT_KEY, accent);
  applyAccentVars(accent);
  accentListeners.forEach((listener) => listener(accent));
}

export function useAccentColor() {
  const [accent, setAccentState] = useState<string | null>(currentAccent);

  useEffect(() => {
    const handleChange = (next: string | null) => setAccentState(next);
    accentListeners.add(handleChange);
    return () => {
      accentListeners.delete(handleChange);
    };
  }, []);

  return { accent, setAccentColor: (next: string | null) => setAccentColor(next) };
}
