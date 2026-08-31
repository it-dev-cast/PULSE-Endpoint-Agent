import { useEffect, useState } from "react";

// Real, durable event history from backend/'s events table (GET /v1/devices/{id}/events,
// proxied through local-agent's /api/events - the browser never holds this device's own API
// key). Mirrors exactly what the backend actually returns - see Event in backend/models.go.
export type EventHistoryItem = {
  id: string;
  tenantId: string;
  deviceId: string;
  eventType: string;
  message: string;
  severity: "info" | "warning" | "critical";
  createdAt: string;
};

type EventHistoryState = {
  events: EventHistoryItem[];
  loading: boolean;
  // Real, distinct from an empty events array: non-null means the fetch itself failed (not
  // enrolled, local-agent/backend unreachable) - a genuinely empty history (this device really
  // has no events yet) is a successful fetch that resolves to [], not an error.
  error: string | null;
};

const EVENTS_URL = "http://localhost:4317/api/events";
// Event history changes far less often than 5s hardware telemetry - a new event only appears
// when a real rule fires/clears or a real connection transition happens, not every poll cycle.
const POLL_MS = 15000;

export function useEventHistory(limit = 20) {
  const [state, setState] = useState<EventHistoryState>({ events: [], loading: true, error: null });

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;

    async function poll() {
      try {
        const res = await fetch(`${EVENTS_URL}?limit=${limit}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const events: EventHistoryItem[] = await res.json();
        if (!cancelled) setState({ events, loading: false, error: null });
      } catch (e) {
        if (!cancelled) {
          setState((prev) => ({ ...prev, loading: false, error: e instanceof Error ? e.message : String(e) }));
        }
      } finally {
        if (!cancelled) timer = window.setTimeout(poll, POLL_MS);
      }
    }

    poll();
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
    };
  }, [limit]);

  return state;
}
