import { useEffect, useState } from "react";
import { loadJSON, saveJSON } from "../lib/storage";

// Real View: Comfortable/Compact density switch - same shape as useTheme.ts's Light/Dark switch,
// toggling a `data-density` attribute on <html> that styles/theme.css's `[data-density="compact"]`
// block reads (--clpa-scale/--clpa-space-page/--clpa-space-row/--clpa-card-pad). Kept as its own
// hook/attribute rather than folded into the `.dark` class - Theme and Density are independent
// real settings (a user can want compact+light, or comfortable+dark), so they need independent
// toggles rather than one four-state enum masquerading as two binary settings.
export type DensityMode = "comfortable" | "compact";

const DENSITY_KEY = "clpa:settings:density:v1";

let currentDensity: DensityMode = loadJSON<DensityMode>(DENSITY_KEY, "comfortable");
const densityListeners = new Set<(density: DensityMode) => void>();

function applyDensityAttribute(density: DensityMode) {
  if (density === "compact") {
    document.documentElement.setAttribute("data-density", "compact");
  } else {
    document.documentElement.removeAttribute("data-density");
  }
}

applyDensityAttribute(currentDensity);

export function getDensity(): DensityMode {
  return currentDensity;
}

export function setDensity(density: DensityMode): void {
  currentDensity = density;
  saveJSON(DENSITY_KEY, density);
  applyDensityAttribute(density);
  densityListeners.forEach((listener) => listener(density));
}

export function useDensity() {
  const [density, setDensityState] = useState<DensityMode>(currentDensity);

  useEffect(() => {
    const handleChange = (next: DensityMode) => setDensityState(next);
    densityListeners.add(handleChange);
    return () => {
      densityListeners.delete(handleChange);
    };
  }, []);

  return {
    density,
    setDensity: (next: DensityMode) => setDensity(next),
  };
}
