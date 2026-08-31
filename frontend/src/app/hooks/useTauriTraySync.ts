import { useEffect, useRef } from "react";
import { useTelemetry } from "./useTelemetry";
import { isRunningInTauri } from "../lib/tauriRuntime";

export type TraySyncOptions = {
  // Real, already-computed unread count from AppContext's own `alerts` state - not recomputed
  // here, so this can't ever disagree with what the bell icon/Alerts page show.
  unreadCount: number;
  // Settings' real "Tray badge count" toggle - when off, 0 is sent instead of the real count
  // (an explicit, real "no badge" state, not simply skipping the sync call and leaving a stale
  // number showing in the tooltip from before the toggle was turned off).
  trayBadgeEnabled: boolean;
  // Settings' real "Show in Tray" toggle.
  showInTrayEnabled: boolean;
};

// Keeps the real system tray's tooltip, "Connection: ..." menu line, unread-count badge, and
// icon visibility in sync with this app's own actual state - never a separately-guessed or
// simulated status. A no-op outside the Tauri desktop app (see isRunningInTauri above), so this
// is safe to call unconditionally from AppProvider regardless of how the app is currently being
// run. Three independent effects (one per real fact), each only calling into Tauri when its own
// specific value actually changes - not one effect re-sending everything on every render.
export function useTauriTraySync({ unreadCount, trayBadgeEnabled, showInTrayEnabled }: TraySyncOptions) {
  const { connected } = useTelemetry();
  const lastSentConnected = useRef<boolean | null>(null);
  const lastSentCount = useRef<number | null>(null);
  const lastSentVisible = useRef<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (lastSentConnected.current === connected) return;
      if (!(await isRunningInTauri())) return;
      if (cancelled) return;
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("update_connection_status", { connected });
        lastSentConnected.current = connected;
      } catch {
        // Tray update is a best-effort convenience, not something worth surfacing a user-facing
        // error for - the dashboard itself already shows the real connection state regardless.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connected]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const effectiveCount = trayBadgeEnabled ? unreadCount : 0;
      if (lastSentCount.current === effectiveCount) return;
      if (!(await isRunningInTauri())) return;
      if (cancelled) return;
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("update_unread_count", { count: effectiveCount });
        lastSentCount.current = effectiveCount;
      } catch {
        // Best-effort - see the connection-status effect's own comment above.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [unreadCount, trayBadgeEnabled]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (lastSentVisible.current === showInTrayEnabled) return;
      if (!(await isRunningInTauri())) return;
      if (cancelled) return;
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("set_tray_visible", { visible: showInTrayEnabled });
        lastSentVisible.current = showInTrayEnabled;
      } catch {
        // Best-effort - see the connection-status effect's own comment above.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showInTrayEnabled]);
}
