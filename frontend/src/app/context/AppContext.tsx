import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Headphones } from "lucide-react";
import { toast } from "sonner";
import { type AlertItem } from "../data/alerts";
import { useAlertEngine, loadJSON, saveJSON, type RuleCategory, type ThresholdConfig, type ThresholdMetric, type LiveActiveRule } from "../hooks/useAlertEngine";
import { useTauriTraySync } from "../hooks/useTauriTraySync";
import { formatTimeLabel, setTimeFormatPref, setDateFormatPref } from "../lib/dateTimeFormat";
import { setTheme } from "../hooks/useTheme";
import { setDensity } from "../hooks/useDensity";
import { setAccentColor } from "../hooks/useAccentColor";
import { setIdleLockEnabled, setIdleLockTimeoutMinutes } from "../hooks/useIdleLock";
import { setTelemetryEnabled } from "../hooks/useTelemetry";
import { askCasterlySupport } from "../lib/supportChat";

const DESKTOP_NOTIFS_KEY = "clpa:settings:desktop-notifications:v1";
const SOUND_CRITICAL_KEY = "clpa:settings:sound-critical:v1";
const TRAY_BADGE_KEY = "clpa:settings:tray-badge-count:v1";
const SHOW_IN_TRAY_KEY = "clpa:settings:show-in-tray:v1";
const QUIET_HOURS_KEY = "clpa:settings:quiet-hours:v1";
const GROUP_SIMILAR_ALERTS_KEY = "clpa:settings:group-similar-alerts:v1";
const PRIORITY_SORTING_KEY = "clpa:settings:priority-sorting:v1";
const ORG_KEY = "clpa:settings:organization:v1";
const DEPT_KEY = "clpa:settings:department:v1";

// Minutes-since-midnight (local time), not a Date - a real, persisted, calendar-independent
// daily window, not a one-off timestamp. Off by default - suppressing real desktop notifications
// is a deliberate opt-in, not a silent default behavior change.
export type QuietHours = { enabled: boolean; startMinutes: number; endMinutes: number };
const DEFAULT_QUIET_HOURS: QuietHours = { enabled: false, startMinutes: 22 * 60, endMinutes: 7 * 60 };

// Real - only gates the OS-level desktop Notification call (see the merge effect below), per the
// actual product decision this was built to: an in-app alert still fires and is still visible on
// the Alerts page/bell badge during quiet hours, only the separate OS popup is suppressed. Does
// NOT also suppress the real critical-severity sound cue - that's a distinct real setting
// ("Sound for critical") with its own on/off control, not something quiet hours silently folds
// into.
function isWithinQuietHours(qh: QuietHours, now: Date): boolean {
  if (!qh.enabled || qh.startMinutes === qh.endMinutes) return false;
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  if (qh.startMinutes < qh.endMinutes) {
    return nowMinutes >= qh.startMinutes && nowMinutes < qh.endMinutes;
  }
  // Wraps past midnight (e.g. 10 PM - 7 AM).
  return nowMinutes >= qh.startMinutes || nowMinutes < qh.endMinutes;
}

// A short synthesized tone via Web Audio — there's no audio asset in this project, and
// fabricating one would be exactly the kind of fake-presented-as-real data this app avoids.
// This is a genuinely real (if minimal) sound cue, not a stand-in for a missing file.
function playCriticalTone() {
  try {
    const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.2, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.35);
    osc.onended = () => ctx.close();
  } catch {
    // No audio output device, autoplay policy, etc. — non-fatal, just skip the cue.
  }
}

export type ChatMessage = { who: "Customer" | "Support"; text: string };

type AppContextValue = {
  activeScreen: string;
  navigate: (screen: string) => void;
  alerts: AlertItem[];
  unreadCount: number;
  lastSynced: string;
  acknowledgeAlert: (id: string) => void;
  markAllAlertsRead: () => void;
  dismissAlert: (id: string) => void;
  snoozeAlert: (id: string) => void;
  refreshSync: () => void;
  supportChatOpen: boolean;
  toggleSupportChat: () => void;
  setSupportChatOpen: (open: boolean) => void;
  chatMessages: ChatMessage[];
  chatBusy: boolean;
  sendChatMessage: (text: string) => void;
  clearChat: () => void;
  remoteSessionActive: boolean;
  startRemoteSession: (detail?: string) => void;
  endRemoteSession: () => void;
  performAction: (action: string, label?: string) => void;
  categoryPrefs: Record<RuleCategory, boolean>;
  setCategoryEnabled: (category: RuleCategory, enabled: boolean) => void;
  desktopNotifsEnabled: boolean;
  setDesktopNotifsEnabled: (enabled: boolean) => void;
  soundOnCriticalEnabled: boolean;
  setSoundOnCriticalEnabled: (enabled: boolean) => void;
  trayBadgeEnabled: boolean;
  setTrayBadgeEnabled: (enabled: boolean) => void;
  showInTrayEnabled: boolean;
  setShowInTrayEnabled: (enabled: boolean) => void;
  quietHours: QuietHours;
  setQuietHours: (next: QuietHours) => void;
  groupSimilarAlertsEnabled: boolean;
  setGroupSimilarAlertsEnabled: (enabled: boolean) => void;
  prioritySortingEnabled: boolean;
  setPrioritySortingEnabled: (enabled: boolean) => void;
  organization: string;
  setOrganization: (value: string) => void;
  department: string;
  setDepartment: (value: string) => void;
  resetAllSettings: () => void;
  thresholds: ThresholdConfig;
  setThresholdField: (metric: ThresholdMetric, field: "warning" | "critical", rawValue: number) => void;
  snoozedUntil: Partial<Record<string, number>>;
  // Conditions currently crossing threshold that have no visible alert for it right now —
  // because the alert was dismissed (not because the condition cleared). See dismissAlert.
  dismissedButActive: LiveActiveRule[];
};

const INITIAL_CHAT: ChatMessage[] = [];

const AppContext = createContext<AppContextValue | null>(null);

function formatSyncTime(date = new Date()) {
  return `Today ${formatTimeLabel(date)}`;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [activeScreen, setActiveScreen] = useState("dashboard");
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [lastSynced, setLastSynced] = useState(() => formatSyncTime());
  const [supportChatOpen, setSupportChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(INITIAL_CHAT);
  const [chatBusy, setChatBusy] = useState(false);
  const [remoteSessionActive, setRemoteSessionActive] = useState(false);
  const chatMessagesRef = useRef<ChatMessage[]>(INITIAL_CHAT);
  const chatGenRef = useRef(0);

  // Merge in any real, threshold-fired alerts from the engine (including ones restored from
  // localStorage on mount) without disturbing existing acknowledge/dismiss/snooze state for
  // alerts already merged in.
  const { alerts: engineAlerts, categoryPrefs, setCategoryEnabled, thresholds, setThresholdField, resetThresholds, resetCategoryPrefs, snoozedUntil, snoozeRule, liveActiveRules } = useAlertEngine();
  const [desktopNotifsEnabled, setDesktopNotifsEnabledState] = useState(() => loadJSON(DESKTOP_NOTIFS_KEY, false));
  const [soundOnCriticalEnabled, setSoundOnCriticalEnabledState] = useState(() => loadJSON(SOUND_CRITICAL_KEY, true));
  const [trayBadgeEnabled, setTrayBadgeEnabledState] = useState(() => loadJSON(TRAY_BADGE_KEY, true));
  const [showInTrayEnabled, setShowInTrayEnabledState] = useState(() => loadJSON(SHOW_IN_TRAY_KEY, true));
  const [quietHours, setQuietHoursState] = useState<QuietHours>(() => loadJSON(QUIET_HOURS_KEY, DEFAULT_QUIET_HOURS));
  const [groupSimilarAlertsEnabled, setGroupSimilarAlertsEnabledState] = useState(() => loadJSON(GROUP_SIMILAR_ALERTS_KEY, false));
  const [prioritySortingEnabled, setPrioritySortingEnabledState] = useState(() => loadJSON(PRIORITY_SORTING_KEY, false));
  const [organization, setOrganizationState] = useState(() => loadJSON(ORG_KEY, ""));
  const [department, setDepartmentState] = useState(() => loadJSON(DEPT_KEY, ""));

  useEffect(() => {
    if (engineAlerts.length === 0) return;
    setAlerts((prev) => {
      const live = prev.filter((a) => a.source !== "sample");
      const prevById = new Map(live.map((a) => [a.id, a]));
      // Brand-new alerts (id never seen before - including one whose id WAS seen but is no
      // longer in `prev` because the user dismissed it, which correctly reads as "fresh" again
      // here) and existing ones the engine just bumped (matched by id, occurrenceCount grew -
      // see useAlertEngine's own dedup-by-ruleId fire logic) both surface to the top and both
      // notify; an id present with an unchanged occurrenceCount means nothing actually happened
      // to it this round.
      const surfaced: AlertItem[] = [];
      const changedIds = new Set<string>();

      for (const a of engineAlerts) {
        const existing = prevById.get(a.id);
        if (!existing || existing.occurrenceCount !== a.occurrenceCount) {
          surfaced.push(a);
          if (existing) changedIds.add(a.id);
        }
      }

      if (surfaced.length === 0) return live.length === prev.length ? prev : live;

      const suppressOsNotification = isWithinQuietHours(quietHours, new Date());
      surfaced.forEach((a) => {
        if (desktopNotifsEnabled && !suppressOsNotification && typeof Notification !== "undefined" && Notification.permission === "granted") {
          new Notification(a.title, { body: a.detail });
        }
        if (soundOnCriticalEnabled && a.severity === "critical") {
          playCriticalTone();
        }
      });

      const rest = live.filter((a) => !changedIds.has(a.id));
      return [...surfaced, ...rest];
    });
  }, [engineAlerts, desktopNotifsEnabled, soundOnCriticalEnabled, quietHours]);

  const setDesktopNotifsEnabled = useCallback((enabled: boolean) => {
    setDesktopNotifsEnabledState(enabled);
    saveJSON(DESKTOP_NOTIFS_KEY, enabled);
    if (enabled && typeof Notification !== "undefined" && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }, []);

  const setSoundOnCriticalEnabled = useCallback((enabled: boolean) => {
    setSoundOnCriticalEnabledState(enabled);
    saveJSON(SOUND_CRITICAL_KEY, enabled);
  }, []);

  const setTrayBadgeEnabled = useCallback((enabled: boolean) => {
    setTrayBadgeEnabledState(enabled);
    saveJSON(TRAY_BADGE_KEY, enabled);
  }, []);

  const setShowInTrayEnabled = useCallback((enabled: boolean) => {
    setShowInTrayEnabledState(enabled);
    saveJSON(SHOW_IN_TRAY_KEY, enabled);
  }, []);

  const setQuietHours = useCallback((next: QuietHours) => {
    setQuietHoursState(next);
    saveJSON(QUIET_HOURS_KEY, next);
  }, []);

  const setGroupSimilarAlertsEnabled = useCallback((enabled: boolean) => {
    setGroupSimilarAlertsEnabledState(enabled);
    saveJSON(GROUP_SIMILAR_ALERTS_KEY, enabled);
  }, []);

  const setPrioritySortingEnabled = useCallback((enabled: boolean) => {
    setPrioritySortingEnabledState(enabled);
    saveJSON(PRIORITY_SORTING_KEY, enabled);
  }, []);

  const setOrganization = useCallback((value: string) => {
    setOrganizationState(value);
    saveJSON(ORG_KEY, value);
  }, []);

  const setDepartment = useCallback((value: string) => {
    setDepartmentState(value);
    saveJSON(DEPT_KEY, value);
  }, []);

  const resetAllSettings = useCallback(() => {
    resetThresholds();
    resetCategoryPrefs();
    setDesktopNotifsEnabled(false);
    setSoundOnCriticalEnabled(true);
    setTrayBadgeEnabled(true);
    setShowInTrayEnabled(true);
    setQuietHours(DEFAULT_QUIET_HOURS);
    setGroupSimilarAlertsEnabled(false);
    setPrioritySortingEnabled(false);
    setOrganization("");
    setDepartment("");
    setTheme("light");
    setDensity("comfortable");
    setAccentColor(null);
    setIdleLockEnabled(true);
    setIdleLockTimeoutMinutes(30);
    setTimeFormatPref("12h");
    setDateFormatPref("DD MMM YYYY");
    setTelemetryEnabled(true);
    toast.success("Settings restored to defaults");
    window.setTimeout(() => window.location.reload(), 400);
  }, [
    resetThresholds,
    resetCategoryPrefs,
    setDesktopNotifsEnabled,
    setSoundOnCriticalEnabled,
    setTrayBadgeEnabled,
    setShowInTrayEnabled,
    setQuietHours,
    setGroupSimilarAlertsEnabled,
    setPrioritySortingEnabled,
    setOrganization,
    setDepartment,
  ]);

  const unreadCount = useMemo(() => alerts.filter((a) => a.unread).length, [alerts]);

  // Keeps the real Tauri system tray's tooltip/menu/unread-badge/visibility in sync with this
  // exact app's own live state - a genuine no-op when not running inside the Tauri-packaged app
  // (plain browser dev/preview). Placed after unreadCount is computed above, not before, since
  // it needs that real value, not a separately-guessed count.
  useTauriTraySync({ unreadCount, trayBadgeEnabled, showInTrayEnabled });

  // A rule can be live-crossing with nothing in `alerts` for it for two reasons: it's
  // currently snoozed (a deliberate, already-visible suppression — see the snooze banner) or
  // its alert was dismissed while the condition kept going. Only the second is a silent gap.
  const dismissedButActive = useMemo(() => {
    const now = Date.now();
    return liveActiveRules.filter((r) => {
      const snoozeUntil = snoozedUntil[r.ruleId];
      const isSnoozed = snoozeUntil != null && snoozeUntil > now;
      if (isSnoozed) return false;
      return !alerts.some((a) => a.ruleId === r.ruleId);
    });
  }, [liveActiveRules, snoozedUntil, alerts]);

  const navigate = useCallback((screen: string) => {
    setActiveScreen(screen);
  }, []);

  const refreshSync = useCallback(() => {
    setLastSynced(formatSyncTime());
    toast.success("Data refreshed");
  }, []);

  const acknowledgeAlert = useCallback((id: string) => {
    // resolvedAt: a.resolvedAt ?? Date.now() - real resolution timestamp for AAlertHistoryCard's
    // avg-response stat, set once and preserved on any later no-op re-acknowledge rather than
    // drifting forward.
    setAlerts((prev) => prev.map((a) => (a.id === id ? { ...a, unread: false, resolvedAt: a.resolvedAt ?? Date.now() } : a)));
    toast.success("Alert acknowledged");
  }, []);

  const markAllAlertsRead = useCallback(() => {
    const now = Date.now();
    setAlerts((prev) => prev.map((a) => ({ ...a, unread: false, resolvedAt: a.resolvedAt ?? now })));
    toast.success("All alerts marked as read");
  }, []);

  const dismissAlert = useCallback(
    (id: string) => {
      const target = alerts.find((a) => a.id === id);
      const stillActive = target?.ruleId
        ? liveActiveRules.some((r) => r.ruleId === target.ruleId) &&
          !(snoozedUntil[target.ruleId] != null && snoozedUntil[target.ruleId]! > Date.now())
        : false;

      setAlerts((prev) => prev.filter((a) => a.id !== id));

      if (stillActive) {
        // The condition is still crossing threshold — per useAlertEngine's "don't re-fire
        // until it drops back below and re-crosses" rule, nothing new will appear for this
        // until that actually happens, so don't imply the system will flag it again soon.
        toast("Alert dismissed — condition is still active; you won't see a new alert until it clears and re-crosses the threshold");
      } else {
        toast("Alert dismissed");
      }
    },
    [alerts, liveActiveRules, snoozedUntil],
  );

  const snoozeAlert = useCallback(
    (id: string) => {
      setAlerts((prev) => {
        const target = prev.find((a) => a.id === id);
        if (target?.ruleId) {
          // Real alert — actually suppress its rule from firing again, and say so honestly.
          const until = snoozeRule(target.ruleId, 24 * 60 * 60 * 1000);
          const untilLabel = formatTimeLabel(new Date(until));
          toast.success(`Snoozed — this rule won't re-alert until ${untilLabel}`);
        } else {
          // Sample alert — there's no real rule behind it to suppress, so don't claim a
          // duration that isn't backed by anything.
          toast.success("Alert marked as read");
        }
        // Same real resolution timestamp as acknowledgeAlert above - snoozing is a genuine
        // resolution path too (see AAlertHistoryCard's "Resolved" filter, which is just !unread).
        return prev.map((a) => (a.id === id ? { ...a, unread: false, resolvedAt: a.resolvedAt ?? Date.now() } : a));
      });
    },
    [snoozeRule],
  );

  const toggleSupportChat = useCallback(() => {
    setSupportChatOpen((prev) => !prev);
  }, []);

  const sendChatMessage = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (chatBusy) return;
    const gen = chatGenRef.current;
    const history = chatMessagesRef.current;
    const nextUser: ChatMessage = { who: "Customer", text: trimmed };
    chatMessagesRef.current = [...history, nextUser];
    setChatMessages(chatMessagesRef.current);
    setChatBusy(true);
    void askCasterlySupport(trimmed, history)
      .then((reply) => {
        if (chatGenRef.current !== gen) return;
        chatMessagesRef.current = [...chatMessagesRef.current, { who: "Support", text: reply }];
        setChatMessages(chatMessagesRef.current);
      })
      .catch((err: unknown) => {
        if (chatGenRef.current !== gen) return;
        const message = err instanceof Error ? err.message : "Ollama did not reply.";
        chatMessagesRef.current = [...chatMessagesRef.current, { who: "Support", text: message }];
        setChatMessages(chatMessagesRef.current);
      })
      .finally(() => {
        if (chatGenRef.current === gen) setChatBusy(false);
      });
  }, [chatBusy]);

  const clearChat = useCallback(() => {
    chatGenRef.current += 1;
    chatMessagesRef.current = [];
    setChatMessages([]);
    setChatBusy(false);
  }, []);

  const startRemoteSession = useCallback((detail?: string) => {
    setRemoteSessionActive(true);
    toast.success("Remote assist requested — Command Centre can Join now");
    const now = Date.now();
    setAlerts((prev) => {
      const next: AlertItem = {
        id: "remote-session-active",
        severity: "info",
        title: "Remote assist requested",
        detail: detail || "Command Centre has been notified. An operator can join from Remote Assist.",
        category: "Remote",
        time: formatTimeLabel(new Date(now)),
        unread: true,
        Icon: Headphones,
        iconColor: "var(--clpa-info-blue)",
        iconBg: "rgba(var(--clpa-primary-rgb),0.1)",
        source: "real",
        occurrenceCount: 1,
        createdAt: now,
      };
      return [next, ...prev.filter((a) => a.id !== "remote-session-active")];
    });
  }, []);

  const endRemoteSession = useCallback(() => {
    setRemoteSessionActive((was) => {
      if (!was) return false;
      toast("Remote session ended");
      setAlerts((prev) => prev.map((a) => (
        a.id === "remote-session-active" && a.unread
          ? { ...a, unread: false, resolvedAt: a.resolvedAt ?? Date.now() }
          : a
      )));
      return false;
    });
  }, []);

  const performAction = useCallback(
    (action: string) => {
      if (action === "start-remote-session") {
        startRemoteSession();
        return;
      }
      if (action === "end-remote-session") {
        endRemoteSession();
        return;
      }
      if (action === "manage-alert-rules") {
        navigate("settings");
        return;
      }
      if (action === "settings-reset") {
        resetAllSettings();
        return;
      }
      if (action === "user-menu") {
        setSupportChatOpen(true);
      }
    },
    [endRemoteSession, navigate, startRemoteSession, resetAllSettings],
  );

  useEffect(() => {
    const id = window.setInterval(() => {
      setLastSynced(formatSyncTime());
    }, 30000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <AppContext.Provider
      value={{
        activeScreen,
        navigate,
        alerts,
        unreadCount,
        lastSynced,
        acknowledgeAlert,
        markAllAlertsRead,
        dismissAlert,
        snoozeAlert,
        refreshSync,
        supportChatOpen,
        toggleSupportChat,
        setSupportChatOpen,
        chatMessages,
        chatBusy,
        sendChatMessage,
        clearChat,
        remoteSessionActive,
        startRemoteSession,
        endRemoteSession,
        performAction,
        categoryPrefs,
        setCategoryEnabled,
        desktopNotifsEnabled,
        setDesktopNotifsEnabled,
        soundOnCriticalEnabled,
        setSoundOnCriticalEnabled,
        trayBadgeEnabled,
        setTrayBadgeEnabled,
        showInTrayEnabled,
        setShowInTrayEnabled,
        quietHours,
        setQuietHours,
        groupSimilarAlertsEnabled,
        setGroupSimilarAlertsEnabled,
        prioritySortingEnabled,
        setPrioritySortingEnabled,
        organization,
        setOrganization,
        department,
        setDepartment,
        resetAllSettings,
        thresholds,
        setThresholdField,
        snoozedUntil,
        dismissedButActive,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}
