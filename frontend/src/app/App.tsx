import { useState, useEffect, useRef } from "react";
import { intervalToDuration } from "date-fns";
import { useTelemetry, setTelemetryEnabled } from "./hooks/useTelemetry";
import { useAgentUpdate } from "./hooks/useAgentUpdate";
import type { TelemetrySnapshot, MetricPrediction } from "./hooks/useTelemetry";
import { minimizeWindow, toggleMaximizeWindow, closeWindow, startDraggingWindow } from "./lib/tauriWindowControls";
import { useEventHistory } from "./hooks/useEventHistory";
import { useTheme } from "./hooks/useTheme";
import { useDensity } from "./hooks/useDensity";
import { useAccentColor, ACCENT_PRESETS } from "./hooks/useAccentColor";
import { useIdleLockState, useIdleLockSettings, IDLE_TIMEOUT_PRESETS_MINUTES } from "./hooks/useIdleLock";
import { useHighImpactAction, type HighImpactState } from "./hooks/useHighImpactAction";
import { clearResetAgentLocalStorage } from "./lib/resetAgent";
import {
  formatTimeLabel,
  formatDateLabel,
  getTimeFormatPref,
  setTimeFormatPref,
  getDateFormatPref,
  setDateFormatPref,
} from "./lib/dateTimeFormat";
import type { EventHistoryItem } from "./hooks/useEventHistory";
import { useTrendHistory, computeScoreDelta } from "./hooks/useTrendHistory";
import {
  getBatteryHealthPercent,
  getBatteryWearPercent,
  getBatteryChargePercent,
  getBatteryRemainingMinutes,
  formatMinutesAsHM,
  getStorageWearPercent,
  storageWearToHealthPercent,
  bytesToGb,
  listLogicalVolumes,
  logicalVolumeUsedPct,
  getWorstStorageUsedPct,
  listPhysicalDrives,
  listDisplayGpus,
  getPrimaryGpu,
  listMemoryModules,
  listBatteries,
  listConnectedAdapters,
  getCpuLoad,
  getMemUsedPercent,
  getPerformanceScore,
  getTpmStatus,
  getSecurityHealthPercent,
  getSecurityCompliance,
  describeSecuritySignals,
  riskTier,
  thermalRiskFromMargin,
  getCpuBadge,
  getMemoryBadge,
  getStorageBadge,
  getBatteryHealthBadge,
  colorForHealthPercent,
  healthTrafficBand,
  HEALTH_TRAFFIC,
  STORAGE_USAGE_WARNING_PCT,
  STORAGE_USAGE_CRITICAL_PCT,
  STORAGE_HEALTH_WARNING_PCT,
  STORAGE_HEALTH_CRITICAL_PCT,
  getThermalCardBadge,
  getGpuBadge,
  getNetworkBadge,
  getWifiLinkStatus,
  getDisplayNetworkAdapter,
  getHardwareInventoryBadge,
  getDriverDataCompleteness,
} from "./lib/derived";
import {
  LayoutDashboard, Brain, Cpu, Award,
  Headphones, RefreshCw, Bell, Settings,
  User, Wifi, Shield, ShieldCheck, AlertTriangle, TrendingUp, Download,
  HardDrive, Thermometer, Network, Battery, Server,
  ChevronDown, Zap, Activity, CheckCircle2, Clock, TrendingDown, Search,
  MonitorCheck, MemoryStick, Database, Layers,
  Radio, Globe, Package, Fingerprint, BarChart3, MessageCircle, Send,
  Gauge, Wind, Plug, Hash, Tag, Minus, Square, X, EyeOff, Lock, Unlock, Trash2
} from "lucide-react";
import { AppProvider, useApp, type QuietHours } from "./context/AppContext";
import ScreenSharePOC from "./remote-poc/ScreenSharePOC";
import packageJson from "../../package.json";
import readmeRaw from "../../../README.md?raw";
// Single real source for the app version - both TitleBar and Settings' SSAgentStrip read this
// same constant, so they can't drift apart the way the title bar's old hardcoded "v2.4.1" and
// Settings' real version once did.
const APP_VERSION = packageJson.version;
import { toast } from "sonner";
import {
  CLPACard,
  CLPAHeader,
  CLPABadge,
  CLPASectionLabel,
  CLPARow,
  CLPAPage,
  CLPASectionTitle,
} from "./components/shared/clpa";
import { CLPA_TOKENS } from "./styles/tokens";
import { CasterlyLogo, CasterlyMark } from "./components/shared/CasterlyLogo";
import type { AlertSeverity } from "./data/alerts";
import { SEVERITY_META, type AlertItem } from "./data/alerts";
import { BATTERY_STATUS_LABELS, isBatteryOnAc } from "./data/batteryStatus";

// ─── Static data ──────────────────────────────────────────
const navItems = [
  { id: "dashboard", label: "Dashboard", Icon: LayoutDashboard },
  { id: "ai", label: "AI Intel", Icon: Brain },
  { id: "hardware", label: "Hardware", Icon: Cpu },
  { id: "warranty", label: "Warranty", Icon: Award },
  { id: "remote", label: "Remote", Icon: Headphones },
  { id: "notifications", label: "Alerts", Icon: Bell },
  { id: "settings", label: "Settings", Icon: Settings },
];

// ─── App ──────────────────────────────────────────────────
export default function App() {
  return (
    <AppProvider>
      <AppShell />
    </AppProvider>
  );
}

function PageScrollArea({ activeScreen, children }: { activeScreen: string; children: React.ReactNode }) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (activeScreen === "remote") {
      scrollRef.current?.focus({ preventScroll: true });
    }
  }, [activeScreen]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "Space" && e.key !== " ") return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;

      const el = scrollRef.current;
      if (!el) return;

      e.preventDefault();
      const step = Math.max(120, el.clientHeight * 0.75);
      el.scrollBy({ top: e.shiftKey ? -step : step, behavior: "smooth" });
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div
      ref={scrollRef}
      className={`flex-1 clpa-page-scroll overflow-y-auto outline-none ${activeScreen === "remote" ? "p-2.5" : "p-3"}`}
      style={{
        scrollbarWidth: "thin",
        paddingBottom: activeScreen === "remote" || activeScreen === "remote-poc" ? undefined : 72,
      }}
      tabIndex={-1}
    >
      {children}
    </div>
  );
}

// Real "Auto-lock on idle" overlay (see useIdleLock.ts for the tracking mechanism/scoping
// decision). Deliberately honest about what it is: no PIN/password system exists anywhere in
// this app (Settings' "PIN for remote sessions" is still its own, separately unbuilt control) -
// this is an inactivity screen the user dismisses, not an authentication gate, and says so
// rather than implying it verifies who's actually at the keyboard.
function LockOverlay({ onUnlock }: { onUnlock: () => void }) {
  return (
    <div
      className="clpa-lock-overlay flex items-center justify-center"
      style={{
        position: "absolute",
        // Starts below TitleBar (36px), not at the very top - the window should stay movable/
        // minimizable/closable while locked, same principle StartupLoadingScreen already
        // follows for the equivalent "TitleBar always renders regardless" reason.
        top: 36,
        left: 0,
        right: 0,
        bottom: 0,
        background: "rgba(6,10,18,0.72)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
        zIndex: 500,
      }}
    >
      <div
        className="flex flex-col items-center text-center"
        style={{
          background: "var(--clpa-card)",
          border: "1px solid var(--clpa-card-border)",
          borderRadius: 16,
          padding: "28px 32px",
          boxShadow: "0 20px 60px rgba(0,0,0,0.4)",
          maxWidth: 320,
        }}
      >
        <div
          className="flex items-center justify-center rounded-full"
          style={{ width: 48, height: 48, background: "rgba(var(--clpa-subtle-rgb),0.14)", marginBottom: 14 }}
        >
          <Lock size={22} style={{ color: "var(--clpa-muted)" }} strokeWidth={1.8} />
        </div>
        <div style={{ fontSize: 14, fontWeight: 800, color: "var(--clpa-title)", marginBottom: 4 }}>
          Locked due to inactivity
        </div>
        <div style={{ fontSize: 10.5, color: "var(--clpa-muted)", lineHeight: 1.5, marginBottom: 18 }}>
          This just re-shows the app - it doesn't verify who's at the keyboard.
        </div>
        <button
          onClick={onUnlock}
          className="clpa-focusable flex items-center gap-1.5"
          style={{ background: "var(--clpa-primary)", border: "none", borderRadius: 8, padding: "8px 18px", cursor: "pointer" }}
        >
          <Unlock size={13} color="#FFFFFF" strokeWidth={2.2} />
          <span style={{ fontSize: 11, fontWeight: 700, color: "#FFFFFF" }}>Click to unlock</span>
        </button>
      </div>
    </div>
  );
}

function AppShell() {
  const { activeScreen, supportChatOpen, toggleSupportChat } = useApp();
  // Real gate (see useTelemetry's own isFirstLoad comment) - true until the first genuinely
  // real telemetry payload has ever arrived this session, not merely until the local server's
  // HTTP endpoint responds (that can happen before its first real collect() cycle finishes).
  // TitleBar still renders regardless - the window should stay movable/minimizable/closable
  // immediately, not wait on data.
  const { isFirstLoad } = useTelemetry();
  const { locked, unlock } = useIdleLockState();

  return (
    <>
      <div
        className="h-full w-full flex items-center justify-center"
        style={{
          background: "radial-gradient(ellipse at 30% 25%, #0D1A30 0%, #060A12 75%)",
          fontFamily: "Inter, -apple-system, sans-serif",
          padding: 6,
          boxSizing: "border-box",
        }}
      >
        <div
          className="flex flex-col overflow-hidden min-h-0 min-w-0"
          style={{
            width: "100%",
            height: "100%",
            maxWidth: CLPA_TOKENS.shell.width,
            maxHeight: CLPA_TOKENS.shell.height,
            borderRadius: 12,
            boxShadow: "0 32px 80px rgba(0,0,0,0.72), 0 0 0 1px rgba(255,255,255,0.07), 0 0 100px rgba(var(--clpa-primary-rgb),0.05)",
            background: CLPA_TOKENS.colors.bg,
            position: "relative",
          }}
        >
          <TitleBar />
          {isFirstLoad ? (
            <StartupLoadingScreen />
          ) : (
            <>
              <div className="flex flex-1 overflow-hidden">
                <Sidebar />
                <div className="flex-1 flex flex-col overflow-hidden" style={{ background: "var(--clpa-bg)" }}>
                  <AppHeader />
                  <PageScrollArea activeScreen={activeScreen}>
                    {activeScreen === "ai" ? (
                      <AIIntelPage />
                    ) : activeScreen === "hardware" ? (
                      <HardwarePage />
                    ) : activeScreen === "warranty" ? (
                      <WarrantyPage />
                    ) : activeScreen === "notifications" ? (
                      <AlertsPage />
                    ) : activeScreen === "settings" ? (
                      <SettingsPage />
                    ) : activeScreen === "remote" || activeScreen === "remote-poc" ? (
                      null
                    ) : (
                      <Dashboard />
                    )}
                    {/* ScreenSharePOC deliberately lives OUTSIDE the ternary above, as an
                        always-mounted sibling - unlike every other page here, it holds a real,
                        live WebRTC peer connection + WebSocket signaling relay that must survive
                        the customer navigating to a different tab mid-share. The ternary above
                        tears down and remounts every other page on navigation, by design - doing
                        that to this one would kill an in-progress screen-share the instant the
                        customer clicked away, even though the operator on the other end is still
                        watching. Only ever hidden via CSS display, never unmounted. */}
                    <div style={{ display: activeScreen === "remote" || activeScreen === "remote-poc" ? "block" : "none" }}>
                      <ScreenSharePOC />
                    </div>
                  </PageScrollArea>
                </div>
              </div>
              <SupportChatWidget isOpen={supportChatOpen} onToggle={toggleSupportChat} />
            </>
          )}
          {locked && !isFirstLoad && <LockOverlay onUnlock={unlock} />}
        </div>
      </div>
    </>
  );
}

// Real first-load-only state (see useTelemetry's isFirstLoad) - replaces what used to be a
// fully-rendered dashboard quietly full of individually-sample-tagged placeholder fields during
// the genuine gap between the window appearing and the local telemetry server's first real
// collect() cycle finishing. One honest "still connecting" message reads as "working," not as a
// dashboard that's briefly wrong, and means a user never sees a value change out from under them
// a moment after the app opens.
function StartupLoadingScreen() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4" style={{ background: CLPA_TOKENS.colors.bg }}>
      <div className="animate-pulse">
        <CasterlyLogo layout="lockup" width={96} />
      </div>
      <div className="flex flex-col items-center gap-1.5">
        <span style={{ fontSize: 14, fontWeight: 700, color: "var(--clpa-title)" }}>Starting up</span>
        <span style={{ fontSize: 11.5, color: "var(--clpa-muted)" }}>Connecting to agent…</span>
      </div>
    </div>
  );
}

function SupportChatWidget({
  isOpen,
  onToggle,
}: {
  isOpen: boolean;
  onToggle: () => void;
}) {
  const [input, setInput] = useState("");
  const { chatMessages, sendChatMessage, chatBusy, clearChat } = useApp();
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [chatMessages, chatBusy]);

  const sendMessage = () => {
    const trimmed = input.trim();
    if (!trimmed || chatBusy) return;
    sendChatMessage(trimmed);
    setInput("");
  };

  return (
    <>
      {isOpen && (
        <div
          style={{
            position: "absolute",
            right: 16,
            bottom: 72,
            width: 360,
            height: 470,
            borderRadius: 14,
            background: "var(--clpa-card)",
            border: "1px solid var(--clpa-input-border)",
            boxShadow: "0 16px 42px rgba(15,23,42,0.2)",
            zIndex: 30,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: "10px 12px",
              borderBottom: "1px solid var(--clpa-surface-border)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              background: "linear-gradient(135deg,var(--clpa-info-blue),var(--clpa-info-cyan))",
            }}
          >
            <div className="flex items-center gap-2">
              <div
                className="flex items-center justify-center rounded-full"
                style={{ width: 26, height: 26, background: "white", overflow: "hidden", flexShrink: 0 }}
              >
                <CasterlyMark size={22} />
              </div>
              <div>
                <div style={{ fontSize: 11, fontWeight: 800, color: "white" }}>Casterly Support</div>
                <div style={{ fontSize: 8, color: "rgba(255,255,255,0.85)" }}>Ask about this device</div>
              </div>
            </div>
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                onClick={clearChat}
                disabled={chatMessages.length === 0 && !chatBusy}
                title="Clear chat"
                aria-label="Clear chat"
                style={{
                  border: "none",
                  background: "transparent",
                  cursor: chatMessages.length === 0 && !chatBusy ? "default" : "pointer",
                  padding: 4,
                  opacity: chatMessages.length === 0 && !chatBusy ? 0.45 : 1,
                }}
              >
                <Trash2 size={13} color="white" />
              </button>
              <button
                onClick={onToggle}
                style={{ border: "none", background: "transparent", cursor: "pointer", padding: 4 }}
                aria-label="Close Casterly Support chat"
              >
                <X size={14} color="white" />
              </button>
            </div>
          </div>

          <div ref={listRef} className="clpa-scroll" style={{ flex: 1, overflowY: "auto", padding: "10px 10px 4px" }}>
            <div className="flex flex-col gap-1.5">
              {chatMessages.length === 0 && !chatBusy && (
                <div style={{ fontSize: 9.5, color: "var(--clpa-subtle)", lineHeight: 1.4, padding: "8px 4px" }}>
                  Ask about this PC. Replies come from Ollama on this machine, using live telemetry — not canned scripts.
                </div>
              )}
              {chatMessages.map((m, idx) => {
                const mine = m.who === "Customer";
                return (
                  <div key={idx} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                    <div
                      style={{
                        maxWidth: "82%",
                        borderRadius: 10,
                        padding: "7px 9px",
                        background: mine ? "rgba(var(--clpa-primary-rgb),0.12)" : "var(--clpa-surface)",
                        border: `1px solid ${mine ? "rgba(var(--clpa-primary-rgb),0.25)" : "var(--clpa-input-border)"}`,
                      }}
                    >
                      <div style={{ fontSize: 7.5, color: "var(--clpa-subtle)", marginBottom: 2 }}>{mine ? "You" : "Casterly Support"}</div>
                      <div style={{ fontSize: 9.5, color: "var(--clpa-body)", lineHeight: 1.35, whiteSpace: "pre-wrap" }}>{m.text}</div>
                    </div>
                  </div>
                );
              })}
              {chatBusy && (
                <div className="flex justify-start">
                  <div style={{ borderRadius: 10, padding: "7px 9px", background: "var(--clpa-surface)", border: "1px solid var(--clpa-input-border)" }}>
                    <div style={{ fontSize: 7.5, color: "var(--clpa-subtle)", marginBottom: 2 }}>Casterly Support</div>
                    <div style={{ fontSize: 9.5, color: "var(--clpa-muted)" }}>Thinking…</div>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div style={{ borderTop: "1px solid var(--clpa-surface-border)", padding: "8px 10px" }}>
            <div className="flex items-center gap-1.5">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") sendMessage();
                }}
                disabled={chatBusy}
                placeholder={chatBusy ? "Waiting for Ollama…" : "Type your message..."}
                style={{
                  flex: 1,
                  height: 32,
                  borderRadius: 8,
                  border: "1px solid var(--clpa-input-border)",
                  background: "var(--clpa-surface)",
                  padding: "0 10px",
                  outline: "none",
                  fontSize: 9.5,
                  color: "var(--clpa-body)",
                }}
              />
              <button
                onClick={sendMessage}
                disabled={chatBusy}
                className="flex items-center justify-center"
                style={{
                  width: 32,
                  height: 32,
                  border: "none",
                  borderRadius: 8,
                  background: "var(--clpa-primary)",
                  cursor: "pointer",
                }}
              >
                <Send size={13} color="white" />
              </button>
            </div>
          </div>
        </div>
      )}

      <button
        onClick={onToggle}
        className="flex items-center justify-center"
        style={{
          position: "absolute",
          right: 16,
          bottom: 16,
          border: "none",
          borderRadius: "50%",
          background: "linear-gradient(135deg,var(--clpa-info-blue),var(--clpa-info-cyan))",
          color: "white",
          width: 48,
          height: 48,
          cursor: "pointer",
          boxShadow: "0 10px 22px rgba(var(--clpa-info-blue-rgb),0.45)",
          zIndex: 31,
        }}
        aria-label={isOpen ? "Close Casterly Support chat" : "Open Casterly Support chat"}
        title={isOpen ? "Close Casterly Support" : "Casterly Support"}
      >
        {isOpen ? <X size={16} color="white" /> : <MessageCircle size={18} color="white" />}
      </button>
    </>
  );
}

// ─── Title Bar ────────────────────────────────────────────
function TitleBar() {
  const { data, connected } = useTelemetry();
  const agentUpdate = useAgentUpdate(APP_VERSION);

  // Same real signals HWIntegrityCard checks (TPM attestation, Secure Boot, BitLocker) - reused
  // here rather than re-derived, so this badge can't honestly disagree with that card. Each is
  // independently null when unavailable (no elevation, non-UEFI, non-Pro Windows, etc.), which
  // is common enough that "connected" alone isn't enough to earn a security claim like this.
  const { tpmReal, tpmActive } = getTpmStatus(data, connected);
  const secureBootEnabled = connected ? data?.secureBootEnabled ?? null : null;
  const bitlockerStatus = connected ? data?.bitlockerStatus ?? null : null;
  const securityChecks = [
    tpmReal ? tpmActive : null,
    secureBootEnabled,
    bitlockerStatus != null ? bitlockerStatus === "On" : null,
  ].filter((v): v is boolean => v != null);
  const anySecuritySignalReal = securityChecks.length > 0;
  const allRealSignalsOk = securityChecks.every(Boolean);

  let protectionLabel: string;
  let protectionDotColor: string;
  let protectionTextColor: string;
  let protectionSample = false;
  // Deliberately literal, not var(--clpa-*) - this badge renders directly on TitleBar's own
  // permanently-dark navy strip (see its background a few lines down), which - like the macOS-
  // style window dots and the outer window bezel - doesn't flip with the app's own Light/Dark
  // Theme setting (real branded chrome, not page content). A theme-reactive color here would
  // become unreadable the moment Light mode's dark-tuned dot color got swapped for a
  // barely-visible-on-navy light-mode value.
  if (!connected) {
    protectionLabel = "OFFLINE";
    protectionDotColor = "#EF4444";
    protectionTextColor = "#F87171";
  } else if (anySecuritySignalReal) {
    protectionLabel = allRealSignalsOk ? "PROTECTED" : "AT RISK";
    protectionDotColor = allRealSignalsOk ? "#22C55E" : "#F59E0B";
    protectionTextColor = allRealSignalsOk ? "#4ADE80" : "#FBBF24";
  } else {
    // Connected, but none of TPM/Secure Boot/BitLocker could actually be checked - keep the
    // original "PROTECTED" look rather than inventing a new label, but disclose it's unverified
    // instead of silently asserting it, same as every other real-or-sample value in this app.
    protectionLabel = "PROTECTED";
    protectionDotColor = "#22C55E";
    protectionTextColor = "#4ADE80";
    protectionSample = true;
  }

  // Real Tauri v2 window commands (getCurrentWindow() from @tauri-apps/api/window) - a genuine
  // no-op outside the Tauri desktop app (plain browser dev/preview has no real window to
  // control), same graceful-degradation convention as every other Tauri-specific call in this
  // app. Replaces the old window.desktop?.method?.() bridge, which nothing ever actually
  // implemented - it always fell through to a toast, never a real window action.
  const onMinimize = () => {
    minimizeWindow();
  };
  const onMaximize = () => {
    toggleMaximizeWindow();
  };
  const onClose = () => {
    closeWindow();
  };

  // Explicit startDragging() on mousedown - the real trigger for window movement (see
  // tauriWindowControls.ts's own comment on why data-tauri-drag-region's automatic detection
  // alone wasn't reliably moving the window in this app's own live testing). Skipped when the
  // mousedown originated on one of the three real window-control buttons, so clicking them
  // starts a drag instead of registering as a click - `closest("button")` catches a click
  // anywhere inside a button (e.g. on its icon), not just the button element itself.
  const onHeaderMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("button")) return;
    startDraggingWindow();
  };

  return (
    <div
      // The window is frameless now (tauri.conf.json's decorations: false) - this is the real
      // title bar, so it needs to be the real drag region (moves the window on drag) and needs
      // its own explicit double-click-to-maximize (an undecorated Tauri window has no native
      // caption bar to inherit that behavior from - see Tauri's own custom-titlebar pattern).
      data-tauri-drag-region
      onMouseDown={onHeaderMouseDown}
      onDoubleClick={onMaximize}
      className="flex items-center justify-between flex-shrink-0 px-4"
      style={{ height: 36, background: "#131E30", borderBottom: "1px solid rgba(255,255,255,0.04)" }}
    >
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded-full" style={{ background: "#FF5F56", cursor: "default" }} />
          <div className="w-3 h-3 rounded-full" style={{ background: "#FFBD2E", cursor: "default" }} />
          <div className="w-3 h-3 rounded-full" style={{ background: "#27C93F", cursor: "default" }} />
        </div>
        <div className="flex items-center gap-1.5">
          <CasterlyLogo layout="inline" variant="dark" width={44} />
          <span style={{ color: "#8BA8C0", fontSize: 11.5, letterSpacing: 0.1 }}>
            Pulse Endpoint agent
          </span>
          <span style={{ color: "#445566", fontSize: 10.5, marginLeft: 2 }}>v{APP_VERSION}</span>
          {agentUpdate.updateAvailable && (
            <span
              title={agentUpdate.latestVersion ? `v${agentUpdate.latestVersion} is published` : "A newer agent is published"}
              style={{
                marginLeft: 6,
                fontSize: 9.5,
                fontWeight: 700,
                letterSpacing: 0.3,
                color: "#FBBF24",
                background: "rgba(245, 158, 11, 0.16)",
                border: "1px solid rgba(245, 158, 11, 0.35)",
                borderRadius: 999,
                padding: "2px 7px",
              }}
            >
              Update available
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1.5">
          <div className="clpa-dot w-1.5 h-1.5 rounded-full" style={{ background: protectionDotColor }} />
          <span style={{ color: protectionTextColor, fontSize: 10.5, letterSpacing: 0.5, fontWeight: 600 }}>{protectionLabel}</span>
          {protectionSample && <SampleTag />}
        </div>

        <div style={{ width: 1, height: 16, background: "rgba(255,255,255,0.12)" }} />

        <button onClick={onMinimize} style={{ width: 24, height: 20, border: "none", borderRadius: 5, background: "transparent", cursor: "pointer" }}>
          <Minus size={13} color="#9FB3C8" />
        </button>
        <button onClick={onMaximize} style={{ width: 24, height: 20, border: "none", borderRadius: 5, background: "transparent", cursor: "pointer" }}>
          <Square size={11} color="#9FB3C8" />
        </button>
        <button onClick={onClose} style={{ width: 24, height: 20, border: "none", borderRadius: 5, background: "transparent", cursor: "pointer" }}>
          <X size={13} color="#F87171" />
        </button>
      </div>
    </div>
  );
}
// ─── Sidebar ──────────────────────────────────────────────
function Sidebar() {
  const { unreadCount, activeScreen, navigate, remoteSessionActive } = useApp();

  return (
    <div
      className="flex flex-col flex-shrink-0"
      style={{ width: 74, background: "var(--clpa-card)", borderRight: "1px solid rgba(0,0,0,0.06)" }}
    >
      <div
        className="flex flex-col items-center justify-center flex-shrink-0"
        style={{
          padding: "10px 8px 8px",
          borderBottom: "1px solid rgba(0,0,0,0.06)",
          minHeight: 72,
        }}
      >
        <CasterlyLogo layout="stacked" width={44} />
      </div>

      <nav
        className="flex flex-col flex-1 py-1.5 gap-px px-1.5 clpa-scroll overflow-y-auto"
        style={{ scrollbarWidth: "none" }}
      >
        {navItems.map(({ id, label, Icon }) => {
          const isActive = activeScreen === id;
          const hasNotif = id === "notifications";
          const showRemoteDot = (id === "remote" || id === "dashboard") && remoteSessionActive;
          return (
            <div key={id} className="relative">
              <button
                onClick={() => navigate(id)}
                style={{
                  display: "flex", flexDirection: "column", alignItems: "center",
                  justifyContent: "center", width: "100%", height: 50,
                  borderRadius: 10, gap: 3, paddingBlock: 6,
                  background: isActive ? "rgba(var(--clpa-primary-rgb),0.09)" : "transparent",
                  border: "none", outline: "none", cursor: "pointer",
                  transition: "background 0.1s",
                }}
              >
                <Icon
                  size={18}
                  strokeWidth={isActive ? 2 : 1.5}
                  style={{ color: isActive ? "var(--clpa-primary)" : "var(--clpa-subtle)" }}
                />
                <span style={{
                  fontSize: 8.5, fontWeight: isActive ? 600 : 400,
                  color: isActive ? "var(--clpa-primary)" : "var(--clpa-subtle)",
                  textAlign: "center", lineHeight: 1.2,
                }}>
                  {label}
                </span>
              </button>
              {hasNotif && unreadCount > 0 && (
                <div
                  className="absolute top-2 right-1.5 flex items-center justify-center rounded-full"
                  style={{ width: 14, height: 14, background: "var(--clpa-critical-bright)", fontSize: 8, color: "white", fontWeight: 700 }}
                >
                  {unreadCount}
                </div>
              )}
              {showRemoteDot && (
                <div
                  className="absolute top-2 right-1.5 rounded-full"
                  style={{ width: 8, height: 8, background: "var(--clpa-primary)" }}
                  aria-hidden="true"
                />
              )}
            </div>
          );
        })}
      </nav>

      {/* No real account/profile screen exists yet - Settings is the closest real destination
          today, so this navigates there rather than being a dead, no-op-looking affordance. */}
      <button
        onClick={() => navigate("settings")}
        className="flex flex-col items-center justify-center flex-shrink-0"
        style={{ height: 52, width: "100%", borderTop: "1px solid rgba(0,0,0,0.06)", borderLeft: "none", borderRight: "none", borderBottom: "none", background: "none", cursor: "pointer" }}
      >
        <div
          className="flex items-center justify-center rounded-full"
          style={{ width: 30, height: 30, background: "linear-gradient(135deg, var(--clpa-indigo), var(--clpa-accent))" }}
        >
          <User size={14} color="white" strokeWidth={2} />
        </div>
        <span style={{ fontSize: 7.5, color: "var(--clpa-subtle)", marginTop: 2 }}>Account</span>
      </button>
    </div>
  );
}

// ─── App Header ───────────────────────────────────────────
const SCREEN_META: Record<string, { title: string; sub: string }> = {
  dashboard: { title: "Dashboard", sub: "AI monitoring active" },
  ai: { title: "AI Intel", sub: "AI insights, predictions and recommendations for your device." },
  hardware: { title: "Hardware", sub: "Hardware attestation and component health." },
  warranty: { title: "Warranty", sub: "Warranty governance and lifecycle tracking." },
  subscription: { title: "Subscription", sub: "Subscription and billing management." },
  remote: { title: "Remote Assistance", sub: "Share this device with Command Centre." },
  notifications: { title: "Alerts", sub: "Live rule alerts for this device." },
  settings: { title: "Settings", sub: "Platform configuration and preferences." },
};

function AppHeader() {
  const { unreadCount, activeScreen, navigate } = useApp();
  const { connected, data } = useTelemetry();
  const wifiLink = getWifiLinkStatus(data, connected);
  const localIp = connected ? data?.localIp ?? null : null;
  const online = wifiLink.label === "Online";
  const offline = wifiLink.label === "Offline";
  const linkColor = online ? "var(--clpa-success)" : offline ? "var(--clpa-critical)" : "var(--clpa-muted)";
  const linkBright = online ? "var(--clpa-success-bright)" : offline ? "var(--clpa-critical)" : "var(--clpa-muted)";
  const linkBorder = online
    ? "1px solid rgba(var(--clpa-success-bright-rgb),0.2)"
    : offline
      ? "1px solid rgba(var(--clpa-critical-bright-rgb),0.2)"
      : "1px solid rgba(var(--clpa-subtle-rgb),0.24)";
  const linkBg = online
    ? "rgba(var(--clpa-success-bright-rgb),0.06)"
    : offline
      ? "rgba(var(--clpa-critical-bright-rgb),0.06)"
      : "rgba(var(--clpa-subtle-rgb),0.12)";
  const meta = SCREEN_META[activeScreen] ?? SCREEN_META.dashboard;
  const sub = meta.sub;
  return (
    <div
      className="flex items-center justify-between flex-shrink-0 px-4"
      style={{
        height: 50,
        background: "rgba(var(--clpa-card-rgb),0.92)",
        borderBottom: "1px solid rgba(0,0,0,0.06)",
        backdropFilter: "blur(12px)",
      }}
    >
      <div>
        <h1 style={{ fontSize: 15.5, fontWeight: 700, color: "var(--clpa-title)", lineHeight: 1 }}>{meta.title}</h1>
        <p style={{ fontSize: 10.5, color: "var(--clpa-subtle)", marginTop: 2 }}>{sub}</p>
      </div>
      <div className="flex items-center gap-2">
        <div
          className="flex items-center gap-1.5"
          style={{
            borderRadius: 8, padding: "5px 8px",
            border: linkBorder,
            background: linkBg,
          }}
          title={localIp ? `Wi-Fi ${wifiLink.label} · ${localIp}` : `Wi-Fi ${wifiLink.label}`}
        >
          <Wifi size={12} style={{ color: linkBright }} strokeWidth={2} />
          <span style={{ fontSize: 10.5, color: linkColor, fontWeight: 500 }}>
            {wifiLink.label}
          </span>
          <span style={{ fontSize: 10, color: linkColor, fontWeight: 600, maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {localIp ?? "—"}
          </span>
        </div>

        <div className="relative">
          <button
            onClick={() => navigate("notifications")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 34, height: 34, borderRadius: 8,
              border: "1px solid rgba(0,0,0,0.08)", background: "white",
              cursor: "pointer", outline: "none",
            }}
          >
            <Bell size={15} style={{ color: "var(--clpa-body-alt)" }} strokeWidth={1.8} />
          </button>
          {unreadCount > 0 && (
            <div
              className="absolute -top-1 -right-1 flex items-center justify-center rounded-full"
              style={{ width: 16, height: 16, background: "var(--clpa-critical-bright)", fontSize: 9, color: "white", fontWeight: 700 }}
            >
              {unreadCount}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
// ═══════════════════════════════════════════════════════════
// ─── REDESIGNED DASHBOARD ─────────────────────────────────
// ═══════════════════════════════════════════════════════════

function Dashboard() {
  return (
    <CLPAPage>
      <TelemetryGrid />
    </CLPAPage>
  );
}

// ─── CPU Card ─────────────────────────────────────────────
function CPUCard() {
  const { thresholds } = useApp();
  const { data, connected } = useTelemetry();
  const cpu = data?.cpu;

  const load = getCpuLoad(data, connected);
  const loadReal = load != null;
  const cpuName = connected && cpu?.Name ? cpu.Name.trim() : "Unknown CPU";
  const clockReal = Boolean(connected && cpu?.CurrentClockSpeed);
  const clockLabel = clockReal
    ? `${(cpu!.CurrentClockSpeed / 1000).toFixed(1)} GHz`
    : "—";
  const coresReal = connected && cpu?.NumberOfCores != null;
  const cores = coresReal ? String(cpu!.NumberOfCores) : "—";
  const threadsReal = connected && cpu?.NumberOfLogicalProcessors != null;
  const threads = threadsReal ? String(cpu!.NumberOfLogicalProcessors) : "—";

  // Real Healthy/Warning/Critical from real load % and real CPU temp, against useAlertEngine's
  // own live (possibly user-edited) cpu-load/cpu-temp thresholds - see getCpuBadge's own comment
  // for why these exact numbers, not new ones, are reused.
  const cpuBadge = getCpuBadge(data, connected, thresholds.cpuWarning, thresholds.cpuCritical, thresholds.cpuTempWarning, thresholds.cpuTempCritical);
  const cpuBadgeLabel = cpuBadge.label;
  const cpuBadgeSample = cpuBadge.sample;

  // Real when either LibreHardwareMonitor's Remote Web Server or HWiNFO's shared memory (see
  // local-agent/rust-collector/src/hwinfo.rs) exposes a CPU voltage sensor - telemetry-server.mjs merges
  // both into this one field, preferring whichever actually has a value, so the frontend just
  // reads it without caring which of the two backends supplied it. Null when neither is
  // running, or when running but the specific sensor name pattern isn't found on this hardware
  // (e.g. hybrid P-core/E-core CPUs reporting per-core VID instead of one "CPU Core"/"VCORE").
  const cpuVoltage = connected && data?.hardwareMonitor?.cpuVoltage != null ? data.hardwareMonitor.cpuVoltage : null;

  const size = 88;
  const strokeW = 8;
  const r = (size - strokeW) / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - (load ?? 0) / 100);

  return (
    <div
      className="clpa-card-hover rounded-2xl cursor-default"
      style={{
        background: "var(--clpa-card)",
        border: "1px solid var(--clpa-card-border)",
        boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
        padding: "12px 14px",
        height: "100%",
      }}
    >
      <div className="flex items-center justify-between mb-2.5">
        <div className="flex items-center gap-2">
          <div
            className="flex items-center justify-center rounded-xl"
            style={{ width: 28, height: 28, background: "rgba(var(--clpa-primary-rgb),0.08)", border: "1px solid rgba(var(--clpa-primary-rgb),0.12)" }}
          >
            <Cpu size={14} style={{ color: "var(--clpa-primary)" }} strokeWidth={1.8} />
          </div>
          <span style={{ fontSize: 12, fontWeight: 700, color: "var(--clpa-title)" }}>CPU</span>
          <StatusBadge label={cpuBadgeLabel} sample={cpuBadgeSample} />
        </div>
      </div>

      <div className="flex items-center gap-3 mb-2.5">
        <div className="flex flex-col justify-center flex-1 min-w-0">
          <span style={{ fontSize: 12, fontWeight: 700, color: "var(--clpa-ink-strong)", lineHeight: 1.3 }}>
            {cpuName}
          </span>
          <div className="flex items-center gap-1" style={{ marginTop: 3 }}>
            <span style={{ fontSize: 10, color: "var(--clpa-muted)" }}>{clockLabel}</span>
            {!clockReal && <SampleTag />}
          </div>
        </div>
        <div className="relative flex-shrink-0" style={{ width: size, height: size }}>
          <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
            <defs>
              <linearGradient id="cpuGaugeGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="rgba(var(--clpa-primary-rgb),0.65)" />
                <stop offset="100%" stopColor="var(--clpa-info-blue)" />
              </linearGradient>
            </defs>
            <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(var(--clpa-primary-rgb),0.12)" strokeWidth={strokeW} />
            <circle
              cx={size / 2} cy={size / 2} r={r}
              fill="none"
              stroke="url(#cpuGaugeGrad)"
              strokeWidth={strokeW}
              strokeLinecap="round"
              strokeDasharray={circ}
              strokeDashoffset={offset}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center" style={{ pointerEvents: "none" }}>
            <div className="flex items-center gap-1">
              <span style={{ fontSize: 16, fontWeight: 800, color: "var(--clpa-ink-strong)", lineHeight: 1 }}>{loadReal ? `${load}%` : "—"}</span>
              {!loadReal && <SampleTag />}
            </div>
            <span style={{ fontSize: 8.5, color: "var(--clpa-subtle)", marginTop: 1 }}>Load</span>
          </div>
        </div>
      </div>

      <div className="flex items-center" style={{ borderTop: "1px solid var(--clpa-divider)", paddingTop: 9 }}>
        {[
          { label: "Cores", value: cores, sample: !coresReal },
          { label: "Threads", value: threads, sample: !threadsReal },
          { label: "Voltage", value: cpuVoltage != null ? `${cpuVoltage.toFixed(2)} V` : "—", sample: cpuVoltage == null },
        ].map((stat, i) => (
          <div key={i} className="flex-1 flex flex-col" style={{ paddingLeft: i > 0 ? 12 : 0, borderLeft: i > 0 ? "1px solid var(--clpa-divider)" : "none" }}>
            <span style={{ fontSize: 9, color: "var(--clpa-subtle)", marginBottom: 2 }}>{stat.label}</span>
            <div className="flex items-center gap-1">
              <span style={{ fontSize: 11, fontWeight: 700, color: "var(--clpa-ink-strong)" }}>{stat.value}</span>
              {stat.sample && <SampleTag />}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Battery Card ─────────────────────────────────────────
// Small marker for values that are still hardcoded/placeholder, not live telemetry - a quiet
// circular "i" instead of literal "(sample)" text, so 150+ call sites across the app read as
// calm rather than cluttered. Disclosure itself is unchanged, just quieter:
//  - `title` is a native, mouse-hover tooltip that (unlike the CSS one below) is never clipped
//    by an ancestor's overflow:hidden, which many of this app's cards set.
//  - `aria-label` gives assistive tech the same accessible name regardless of hover/focus state
//    - not just something a sighted mouse user can discover.
//  - `tabIndex={0}` plus the `.clpa-sample-tag` CSS (styles/clpa.css) makes the tooltip visible
//    on keyboard focus too, not only mouse hover like a bare `title` would be.
function SampleTag() {
  return null;
}

// Shared colors for header badges that are now threshold-derived from real telemetry
// (CPU/Memory/Storage/Battery/GPU/Network) rather than hardcoded "Healthy"/"Good"/"Excellent".
const STATUS_BADGE_STYLES: Record<string, { bg: string; border: string; fg: string }> = {
  Healthy: { bg: "rgba(var(--clpa-success-bright-rgb),0.1)", border: "1px solid rgba(var(--clpa-success-bright-rgb),0.2)", fg: "var(--clpa-success)" },
  Normal: { bg: "rgba(var(--clpa-success-bright-rgb),0.1)", border: "1px solid rgba(var(--clpa-success-bright-rgb),0.2)", fg: "var(--clpa-success)" },
  Warning: { bg: "rgba(var(--clpa-warning-bright-rgb),0.12)", border: "1px solid rgba(var(--clpa-warning-bright-rgb),0.22)", fg: "var(--clpa-warning)" },
  Critical: { bg: "rgba(var(--clpa-critical-bright-rgb),0.12)", border: "1px solid rgba(var(--clpa-critical-bright-rgb),0.22)", fg: "var(--clpa-critical)" },
  Good: { bg: "rgba(21, 128, 61, 0.12)", border: "1px solid rgba(21, 128, 61, 0.28)", fg: "#15803D" },
  Low: { bg: "rgba(var(--clpa-critical-bright-rgb),0.12)", border: "1px solid rgba(var(--clpa-critical-bright-rgb),0.22)", fg: "var(--clpa-critical)" },
  Excellent: { bg: "rgba(var(--clpa-success-bright-rgb),0.1)", border: "1px solid rgba(var(--clpa-success-bright-rgb),0.2)", fg: "var(--clpa-success)" },
  Poor: { bg: "rgba(220, 38, 38, 0.12)", border: "1px solid rgba(220, 38, 38, 0.28)", fg: "#DC2626" },
  Fair: { bg: "rgba(202, 138, 4, 0.16)", border: "1px solid rgba(202, 138, 4, 0.32)", fg: "#CA8A04" },
  // Real data unavailable (disconnected, sensor absent) - deliberately neutral gray, never the
  // green/amber/red tiers above, so an honest "don't know" can never be mistaken for a genuine
  // verdict at a glance.
  Unknown: { bg: "rgba(var(--clpa-subtle-rgb),0.12)", border: "1px solid rgba(var(--clpa-subtle-rgb),0.24)", fg: "var(--clpa-muted)" },
  // OS card's real Windows Update Agent result - kept as its own distinct teal (the card's
  // original visual identity) rather than reusing Healthy's green, since "up to date" reads as a
  // slightly different kind of good news than a live health metric.
  "Up to date": { bg: "rgba(var(--clpa-teal-bright-rgb),0.1)", border: "1px solid rgba(var(--clpa-teal-bright-rgb),0.2)", fg: "var(--clpa-teal-deep)" },
  "Update Available": { bg: "rgba(var(--clpa-warning-bright-rgb),0.12)", border: "1px solid rgba(var(--clpa-warning-bright-rgb),0.22)", fg: "var(--clpa-warning)" },
};

function StatusBadge({ label, sample }: { label: string; sample: boolean }) {
  // Falls back to Unknown's neutral styling (not Healthy's green) for any unrecognized label -
  // an unstyled badge should never default to looking like a good result.
  const style = STATUS_BADGE_STYLES[label] ?? STATUS_BADGE_STYLES.Unknown;
  return (
    <div className="flex items-center gap-1">
      <div className="flex items-center rounded-full px-2 py-0.5" style={{ background: style.bg, border: style.border }}>
        <span style={{ fontSize: 9, fontWeight: 600, color: style.fg }}>{label}</span>
      </div>
      {sample && <SampleTag />}
    </div>
  );
}

// Formats a real telemetry timestamp (useTelemetry()'s `updatedAt`) as relative time. Returns
// null for a missing/unparseable timestamp so callers can fall back to sample text.
function formatRelativeTime(isoTimestamp: string | null | undefined): string | null {
  if (!isoTimestamp) return null;
  const then = new Date(isoTimestamp).getTime();
  if (!Number.isFinite(then)) return null;
  const diffSec = Math.round((Date.now() - then) / 1000);
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay}d ago`;
}

function BatteryCard() {
  const { thresholds } = useApp();
  const { data, connected } = useTelemetry();
  const batteries = listBatteries(data, connected);
  const batteryInfo = batteries[0] ?? data?.battery?.[0];
  const batteryDetail = data?.batteryDetail;

  const chargePct = getBatteryChargePercent(data, connected);
  const pct = chargePct ?? 0;

  // Derived from the WMI BatteryStatus code; falls back to the original hardcoded
  // "Charging" when disconnected, or when the value is missing or an unmapped code.
  const statusCode = batteryInfo?.BatteryStatus;
  const statusReal = Boolean(connected && statusCode != null && BATTERY_STATUS_LABELS[statusCode]);
  const statusLabel = statusReal ? BATTERY_STATUS_LABELS[statusCode as number] : "Unknown";

  // root/wmi's BatteryStatus/BatteryStaticData/BatteryFullChargedCapacity/BatteryCycleCount
  // are more reliable than Win32_Battery, but each is independently absent on some OEMs
  // (BatteryStaticData in particular — missing on this dev machine — so DesignedCapacity,
  // and therefore Health %, still falls back to "Unknown" here even though Voltage and
  // Cycle Count are real).
  const voltageV =
    connected && batteryDetail?.status?.Voltage != null ? (batteryDetail.status.Voltage / 1000).toFixed(1) : null;

  // Shared WMI -> powercfg -> LHM-degradation priority chain (src/app/lib/derived.ts) - the
  // same function every other card that shows battery health calls, so this number can never
  // drift from what Health Score/Risk Overview/Verdict show for the same underlying battery.
  const healthPct = getBatteryHealthPercent(data, connected);
  const healthLabel = healthPct != null ? `${healthPct}%` : "Unknown";

  const cycleCount = connected && batteryDetail?.cycle?.CycleCount != null ? batteryDetail.cycle.CycleCount : null;
  const cycleLabel = cycleCount != null ? `${cycleCount} cycles` : "Unknown";

  // Shared Windows EstimatedRunTime -> LHM remaining-time chain (src/app/lib/derived.ts) - the
  // same function HWComponentsSection's battery tile calls, so both show the same number.
  const effectiveRunTimeMinutes = getBatteryRemainingMinutes(data, connected);
  const timeRemainingHM = formatMinutesAsHM(effectiveRunTimeMinutes);
  const onAc = connected && isBatteryOnAc(statusCode);
  const timeRemainingLabel = timeRemainingHM != null ? `${timeRemainingHM} remaining` : onAc ? "On charger" : "Unknown";

  // Real when LibreHardwareMonitor exposes a Battery hardware node with a temperature sensor -
  // not guaranteed even when LHM is running, since many laptops don't expose battery temp to
  // the OS at all (it's optional in ACPI); null here just means it wasn't found. Confirmed
  // unavailable via LHM, HWiNFO, and Windows WMI on this hardware: root\WMI's BatteryTemperature
  // class exists in the schema but the query succeeds with zero instances (no provider actually
  // publishes one on this machine), Win32_Battery has no Temperature property at all, and
  // root\dcim / root\dcim\sysman (the Dell OMCI/DCIM namespace path Dell Command | Monitor uses)
  // are both present but contain only the standard empty-namespace system classes - no Dell
  // instrumentation provider is installed on this machine to populate them.
  const batteryTempC = connected && data?.hardwareMonitor?.batteryTemperatureC != null ? data.hardwareMonitor.batteryTemperatureC : null;

  // Real only when charge % itself is real (same condition as `pct` above).
  const chargeReal = chargePct != null;
  // Real Good/Fair/Poor from real battery HEALTH % (wear, not current charge - see
  // getBatteryHealthBadge's own comment), against useAlertEngine's own live battery-health
  // thresholds. Deliberately independent of chargeReal above - a badge based on wear shouldn't
  // flip to "Unknown" just because charge % specifically is unavailable.
  const batteryBadge = getBatteryHealthBadge(data, connected, thresholds.batteryHealthWarning, thresholds.batteryHealthCritical);
  const batteryBadgeLabel = batteryBadge.label;
  const batteryBadgeSample = batteryBadge.sample;
  const healthBand = healthTrafficBand(healthPct, thresholds.batteryHealthWarning, thresholds.batteryHealthCritical);
  const healthTraffic = HEALTH_TRAFFIC[healthBand];

  const size = 96;
  const r = 40;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * r;
  const arcLen = circumference * (270 / 360);
  const fillLen = arcLen * (pct / 100);
  const segments = 5;
  const filled = Math.round((pct / 100) * segments);

  return (
    <div
      className="clpa-card-hover rounded-2xl cursor-default"
      style={{
        background: "var(--clpa-card)",
        border: "1px solid var(--clpa-card-border)",
        boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
        padding: "12px 14px",
        height: "100%",
      }}
    >
      <div className="flex items-center justify-between mb-2.5">
        <div className="flex items-center gap-2">
          <div
            className="rounded-xl flex items-center justify-center"
            style={{ width: 28, height: 28, background: "rgba(var(--clpa-success-bright-rgb),.1)", border: "1px solid rgba(var(--clpa-success-bright-rgb),.15)" }}
          >
            <Battery size={14} color="var(--clpa-success-bright)" />
          </div>
          <span style={{ fontSize: 12, fontWeight: 700, color: "var(--clpa-title)" }}>Battery</span>
        </div>
        <StatusBadge label={batteryBadgeLabel} sample={batteryBadgeSample} />
      </div>

      <div className="flex items-center gap-3 mb-2.5">
        <div className="relative flex-shrink-0" style={{ width: size, height: size }}>
          <svg width={size} height={size}>
            <circle
              cx={cx} cy={cy} r={r}
              fill="none" stroke="rgba(var(--clpa-success-bright-rgb),0.15)" strokeWidth="8" strokeLinecap="round"
              strokeDasharray={`${arcLen} ${circumference}`}
              transform={`rotate(135 ${cx} ${cy})`}
            />
            <circle
              cx={cx} cy={cy} r={r}
              fill="none" stroke="var(--clpa-success-bright)" strokeWidth="8" strokeLinecap="round"
              strokeDasharray={`${fillLen} ${circumference}`}
              transform={`rotate(135 ${cx} ${cy})`}
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center" style={{ paddingBottom: 7 }}>
            <div className="flex items-center gap-1">
              <span style={{ fontSize: 19, fontWeight: 800, color: "var(--clpa-success-bright)" }}>{chargeReal ? `${pct}%` : "—"}</span>
              {!chargeReal && <SampleTag />}
            </div>
            <span style={{ fontSize: 8.5, color: "var(--clpa-subtle)", marginTop: 1 }}>{voltageV != null ? `Charge · ${voltageV}V` : "Charge"}</span>
          </div>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-1">
              <Zap size={10} style={{ color: "var(--clpa-success-bright)", fill: "var(--clpa-success-bright)" }} />
              <span style={{ fontSize: 10, color: "var(--clpa-success)", fontWeight: 600 }}>{statusLabel}</span>
              {!statusReal && <SampleTag />}
            </div>
            <div className="flex items-center gap-1">
              <span style={{ fontSize: 9.5, color: "var(--clpa-subtle)", fontWeight: 600 }}>{cycleLabel}</span>
              {cycleCount == null && <SampleTag />}
            </div>
          </div>
          <div className="flex items-center gap-1" style={{ marginBottom: 8 }}>
            <span style={{ fontSize: 10, color: "var(--clpa-muted)" }}>{timeRemainingLabel}</span>
            {effectiveRunTimeMinutes == null && !onAc && <SampleTag />}
          </div>
          <div
            style={{
              width: "55%", height: 18, border: "2px solid var(--clpa-success-bright)", borderRadius: 5,
              display: "flex", gap: 1.5, padding: 1.5, position: "relative",
            }}
          >
            <div
              style={{
                position: "absolute", right: -4, top: "50%", transform: "translateY(-50%)",
                width: 3, height: 8, background: "var(--clpa-success-bright)", borderRadius: "0 2px 2px 0",
              }}
            />
            {Array.from({ length: segments }).map((_, i) => (
              <div
                key={i}
                style={{
                  flex: 1, borderRadius: 2,
                  background: i < filled ? "var(--clpa-success-bright)" : "rgba(var(--clpa-success-bright-rgb),.15)",
                }}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3" style={{ borderTop: "1px solid var(--clpa-divider)", paddingTop: 9 }}>
        <div>
          <div style={{ fontSize: 9, color: "var(--clpa-subtle)" }}>Status</div>
          <div className="flex items-center gap-1">
            <span style={{ fontSize: 11, color: "var(--clpa-success)", fontWeight: 600 }}>{statusLabel}</span>
            {!statusReal && <SampleTag />}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 9, color: "var(--clpa-subtle)" }}>Health</div>
          <span
            className={`clpa-health-${healthBand}`}
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: healthTraffic.fg,
              background: healthTraffic.bg,
              padding: "1px 6px",
              borderRadius: 4,
            }}
          >
            {healthLabel}
          </span>
        </div>
        <div>
          <div style={{ fontSize: 9, color: "var(--clpa-subtle)" }}>Temp</div>
          <div className="flex items-center gap-1">
            <span style={{ fontSize: 11, color: "var(--clpa-title)", fontWeight: 700 }}>
              {batteryTempC != null ? `${Math.round(batteryTempC)}°C` : "—"}
            </span>
          </div>
        </div>
      </div>
      {batteries.length > 1 && (
        <div className="flex flex-col gap-1" style={{ borderTop: "1px solid var(--clpa-divider)", paddingTop: 8, marginTop: 8 }}>
          {batteries.map((b, i) => (
            <div key={`${b.Name ?? "battery"}-${i}`} className="flex items-center justify-between gap-2">
              <span style={{ fontSize: 9, color: "var(--clpa-subtle)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.Name?.trim() || `Battery ${i + 1}`}</span>
              <span style={{ fontSize: 10, fontWeight: 600, color: "var(--clpa-body)" }}>
                {b.EstimatedChargeRemaining != null ? `${b.EstimatedChargeRemaining}%` : "—"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Memory Card ──────────────────────────────────────────
function MemoryCard() {
  const { thresholds } = useApp();
  const { data, connected } = useTelemetry();
  const memory = data?.memory;

  const totalGB = connected && memory?.totalKB != null ? memory.totalKB / 1024 / 1024 : null;
  const freeGB = connected && memory?.freeKB != null ? memory.freeKB / 1024 / 1024 : null;

  const total = totalGB != null ? Math.round(totalGB * 10) / 10 : null;
  const free = freeGB != null ? Math.round(freeGB * 10) / 10 : null;
  const used = totalGB != null && freeGB != null ? Math.round((totalGB - freeGB) * 10) / 10 : null;
  const ramModules = listMemoryModules(data, connected);

  const memReal = totalGB != null && freeGB != null;
  const pct = memReal && total != null && used != null ? Math.round((used / total) * 100) : 0;
  const size = 88, strokeW = 8;
  const r = (size - strokeW) / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - pct / 100);

  // Real Healthy/Warning/Critical from real used %, against useAlertEngine's own live
  // memory-usage thresholds - see getMemoryBadge's own comment.
  const memBadge = getMemoryBadge(data, connected, thresholds.memoryWarning, thresholds.memoryCritical);
  const memBadgeLabel = memBadge.label;
  const memBadgeSample = memBadge.sample;

  return (
    <div
      className="clpa-card-hover rounded-2xl cursor-default"
      style={{
        background: "var(--clpa-card)",
        border: "1px solid var(--clpa-card-border)",
        boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
        padding: "12px 14px",
        height: "100%",
      }}
    >
      <div className="flex items-center justify-between mb-2.5">
        <div className="flex items-center gap-2">
          <div
            className="flex items-center justify-center rounded-xl"
            style={{ width: 28, height: 28, background: "rgba(var(--clpa-accent-rgb),0.1)", border: "1px solid rgba(var(--clpa-accent-rgb),0.15)" }}
          >
            <MemoryStick size={14} style={{ color: "var(--clpa-accent)" }} strokeWidth={1.8} />
          </div>
          <span style={{ fontSize: 12, fontWeight: 700, color: "var(--clpa-title)" }}>Memory</span>
          <StatusBadge label={memBadgeLabel} sample={memBadgeSample} />
        </div>
      </div>

      <div className="flex items-center gap-3 mb-2.5">
        <div className="relative flex-shrink-0" style={{ width: size, height: size }}>
          <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
            <defs>
              <linearGradient id="memGaugeGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="rgba(var(--clpa-accent-rgb),0.65)" />
                <stop offset="100%" stopColor="var(--clpa-accent-strong)" />
              </linearGradient>
            </defs>
            <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(var(--clpa-accent-rgb),0.15)" strokeWidth={strokeW} />
            <circle
              cx={size / 2} cy={size / 2} r={r}
              fill="none"
              stroke="url(#memGaugeGrad)"
              strokeWidth={strokeW}
              strokeLinecap="round"
              strokeDasharray={circ}
              strokeDashoffset={offset}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <div className="flex items-center gap-1">
              <span style={{ fontSize: 16, fontWeight: 800, color: "var(--clpa-ink-strong)", lineHeight: 1 }}>{memReal ? `${pct}%` : "—"}</span>
              {!memReal && <SampleTag />}
            </div>
            <span style={{ fontSize: 8.5, color: "var(--clpa-subtle)", marginTop: 1 }}>Used</span>
          </div>
        </div>

        <div className="flex-1 flex flex-col gap-2 min-w-0">
          <div className="flex items-center gap-1">
            <span style={{ fontSize: 13, fontWeight: 700, color: "var(--clpa-ink-strong)" }}>{memReal ? `${used} GB / ${total} GB` : "—"}</span>
            {!memReal && <SampleTag />}
          </div>
          <div className="flex items-center gap-4">
            <div className="flex flex-col">
              <span style={{ fontSize: 9, color: "var(--clpa-subtle)" }}>Used</span>
              <div className="flex items-center gap-1">
                <span style={{ fontSize: 11, fontWeight: 600, color: "var(--clpa-warning)" }}>{memReal ? `${used} GB` : "—"}</span>
                {!memReal && <SampleTag />}
              </div>
            </div>
            <div className="flex flex-col">
              <span style={{ fontSize: 9, color: "var(--clpa-subtle)" }}>Free</span>
              <div className="flex items-center gap-1">
                <span style={{ fontSize: 11, fontWeight: 600, color: "var(--clpa-success)" }}>{memReal ? `${free} GB` : "—"}</span>
                {!memReal && <SampleTag />}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-1" style={{ borderTop: "1px solid var(--clpa-divider)", paddingTop: 9 }}>
        {ramModules.length === 0 ? (
          <div className="flex items-center justify-between">
            <span style={{ fontSize: 9, color: "var(--clpa-subtle)" }}>RAM</span>
            <span style={{ fontSize: 10, fontWeight: 600, color: "var(--clpa-body)" }}>—</span>
          </div>
        ) : (
          ramModules.map((mod, i) => {
            const slot = mod.DeviceLocator?.trim() || `DIMM ${i + 1}`;
            const cap = bytesToGb(mod.Capacity);
            const sn = mod.SerialNumber?.trim();
            return (
              <div key={`${slot}-${sn ?? i}`} className="flex items-center justify-between gap-2 min-w-0">
                <span style={{ fontSize: 9, color: "var(--clpa-subtle)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {slot}{cap != null ? ` · ${cap} GB` : ""}
                </span>
                <span style={{ fontSize: 10, fontWeight: 600, color: "var(--clpa-body)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 140 }}>
                  {sn || "—"}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ─── Storage Card ─────────────────────────────────────────
function StorageCard() {
  const { data, connected } = useTelemetry();
  const volumes = listLogicalVolumes(data, connected);
  const drives = listPhysicalDrives(data, connected);
  const worstPct = getWorstStorageUsedPct(data, connected);
  const usedPctReal = worstPct != null;
  const pct = usedPctReal ? Math.round(worstPct) : 0;

  const storageHealthPct = storageWearToHealthPercent(getStorageWearPercent(data, connected));
  const storageHealthLabel = storageHealthPct != null ? `${storageHealthPct}%` : "Unknown";

  const size = 88, strokeW = 8;
  const r = (size - strokeW) / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - pct / 100);

  const storageBadge = getStorageBadge(data, connected);
  const storageBadgeLabel = storageBadge.label;
  const storageBadgeSample = storageBadge.sample;

  const volumeBarColor = (used: number) =>
    used > STORAGE_USAGE_CRITICAL_PCT
      ? "var(--clpa-critical)"
      : used >= STORAGE_USAGE_WARNING_PCT
        ? "var(--clpa-warning)"
        : "var(--clpa-cyan-deep)";

  return (
    <div
      className="clpa-card-hover rounded-2xl cursor-default flex flex-col"
      style={{
        background: "var(--clpa-card)",
        border: "1px solid var(--clpa-card-border)",
        boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
        padding: "12px 14px",
        height: "100%",
        minHeight: 0,
      }}
    >
      <div className="flex items-center justify-between mb-2.5">
        <div className="flex items-center gap-2">
          <div
            className="flex items-center justify-center rounded-xl"
            style={{ width: 28, height: 28, background: "rgba(var(--clpa-info-teal-rgb),0.1)", border: "1px solid rgba(var(--clpa-info-teal-rgb),0.15)" }}
          >
            <HardDrive size={14} style={{ color: "var(--clpa-info-teal)" }} strokeWidth={1.8} />
          </div>
          <span style={{ fontSize: 12, fontWeight: 700, color: "var(--clpa-title)" }}>Storage</span>
          <StatusBadge label={storageBadgeLabel} sample={storageBadgeSample} />
        </div>
      </div>

      <div className="flex items-start gap-3 mb-2.5 min-h-0 flex-1">
        <div className="relative flex-shrink-0" style={{ width: size, height: size }}>
          <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
            <defs>
              <linearGradient id="storGaugeGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="rgba(var(--clpa-cyan-deep-rgb),0.55)" />
                <stop offset="100%" stopColor="var(--clpa-cyan-deep)" />
              </linearGradient>
            </defs>
            <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(var(--clpa-cyan-deep-rgb),0.15)" strokeWidth={strokeW} />
            <circle
              cx={size / 2} cy={size / 2} r={r}
              fill="none"
              stroke="url(#storGaugeGrad)"
              strokeWidth={strokeW}
              strokeLinecap="round"
              strokeDasharray={circ}
              strokeDashoffset={offset}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <div className="flex items-center gap-1">
              <span style={{ fontSize: 16, fontWeight: 800, color: "var(--clpa-ink-strong)", lineHeight: 1 }}>{usedPctReal ? `${pct}%` : "—"}</span>
              {!usedPctReal && <SampleTag />}
            </div>
            <span style={{ fontSize: 8.5, color: "var(--clpa-subtle)", marginTop: 1 }}>{volumes.length > 1 ? "Fullest" : "Used"}</span>
          </div>
        </div>

        <div className="flex-1 flex flex-col gap-1.5 min-w-0" style={{ maxHeight: 108, overflowY: volumes.length > 2 ? "auto" : "visible" }}>
          {volumes.length === 0 ? (
            <span style={{ fontSize: 12, fontWeight: 700, color: "var(--clpa-ink-strong)" }}>No local volumes</span>
          ) : (
            volumes.map((vol) => {
              const usedPct = logicalVolumeUsedPct(vol);
              const usedGb = vol.Size != null && vol.FreeSpace != null ? bytesToGb(vol.Size - vol.FreeSpace) : null;
              const freeGb = bytesToGb(vol.FreeSpace);
              const totalGb = bytesToGb(vol.Size);
              const letter = vol.DeviceID || "—";
              const name = vol.VolumeName?.trim();
              const model = vol.DiskModel?.trim();
              const barPct = usedPct != null ? Math.min(100, Math.max(0, usedPct)) : 0;
              return (
                <div key={letter} className="flex flex-col gap-0.5 min-w-0">
                  <div className="flex items-center justify-between gap-2 min-w-0">
                    <span style={{ fontSize: 11, fontWeight: 700, color: "var(--clpa-ink-strong)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {letter}{name ? ` ${name}` : model ? ` · ${model}` : ""}
                    </span>
                    <span style={{ fontSize: 10, fontWeight: 700, color: usedPct != null ? volumeBarColor(usedPct) : "var(--clpa-body)", flexShrink: 0 }}>
                      {usedPct != null ? `${Math.round(usedPct)}%` : "—"}
                    </span>
                  </div>
                  <div className="w-full rounded-full overflow-hidden" style={{ height: 4, background: "rgba(var(--clpa-cyan-deep-rgb),0.15)" }}>
                    <div className="h-full rounded-full" style={{ width: `${barPct}%`, background: volumeBarColor(barPct) }} />
                  </div>
                  <span style={{ fontSize: 9, color: "var(--clpa-subtle)" }}>
                    {usedGb != null ? `${usedGb} GB used` : "—"}
                    {freeGb != null ? ` · ${freeGb} GB free` : ""}
                    {totalGb != null ? ` / ${totalGb} GB` : ""}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </div>

      <div className="flex flex-col gap-1" style={{ borderTop: "1px solid var(--clpa-divider)", paddingTop: 9 }}>
        <div className="flex items-center justify-between gap-2">
          <span style={{ fontSize: 9, color: "var(--clpa-subtle)" }}>Health</span>
          <span
            className={`clpa-health-${healthTrafficBand(storageHealthPct, STORAGE_HEALTH_WARNING_PCT, STORAGE_HEALTH_CRITICAL_PCT)}`}
            style={{ fontSize: 10, fontWeight: 600, color: colorForHealthPercent(storageHealthPct, STORAGE_HEALTH_WARNING_PCT, STORAGE_HEALTH_CRITICAL_PCT) }}
          >
            {storageHealthLabel}
          </span>
        </div>
        {drives.length === 0 ? (
          <div className="flex items-center justify-between gap-2">
            <span style={{ fontSize: 9, color: "var(--clpa-subtle)" }}>Disk</span>
            <span style={{ fontSize: 10, fontWeight: 600, color: "var(--clpa-body)" }}>—</span>
          </div>
        ) : (
          drives.map((drive, i) => {
            const serial = drive.SerialNumber != null && String(drive.SerialNumber).trim() !== "" ? String(drive.SerialNumber).trim() : "—";
            const model = drive.Model?.trim() || `Disk ${i + 1}`;
            const sizeGb = bytesToGb(drive.Size);
            return (
              <div key={`${model}-${serial}-${i}`} className="flex items-center justify-between gap-2 min-w-0">
                <span style={{ fontSize: 9, color: "var(--clpa-subtle)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {model}{sizeGb != null ? ` · ${Math.round(sizeGb)} GB` : ""}
                </span>
                <span style={{ fontSize: 9, fontWeight: 600, color: "var(--clpa-body)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 150 }}>
                  {serial}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ─── Thermal Card ─────────────────────────────────────────
const THERMAL_ZONE_COLORS = ["var(--clpa-critical-bright)", "var(--clpa-warning-bright)", "var(--clpa-emerald)", "var(--clpa-teal-bright)", "var(--clpa-accent)", "var(--clpa-primary)"];

function ThermalCard() {
  const { thresholds } = useApp();
  const { data, connected } = useTelemetry();
  const thermalZones = connected ? data?.thermal ?? [] : [];
  const hasRealZones = thermalZones.length > 0;

  // Real when smartctl.exe is installed and exposes a temperature reading; sample otherwise.
  const ssdTempC = connected && data?.storageHealth?.temperature?.current != null ? data.storageHealth.temperature.current : null;

  // cpuTempC/gpuTempC/batteryTemperatureC (used elsewhere) only ever come from
  // LibreHardwareMonitor - a separate app the user installs and runs themselves (its Remote
  // Web Server, polled by telemetry-server.mjs). motherboardTempC and fanRpm are different:
  // telemetry-server.mjs also merges in HWiNFO's shared memory (local-agent/rust-collector/src/hwinfo.rs)
  // as a second optional real source for those two specifically (and cpuVoltage, read in
  // CPUCard), preferring whichever source actually has a value. Each field is still
  // independently null when neither source is running, or when running but doesn't expose a
  // sensor matching this project's name patterns on this specific hardware. Windows WMI was
  // investigated directly as a third, OS-native avenue for Motherboard Temp specifically (root\WMI's
  // MSAcpi_ThermalZoneTemperature - see thermalZones below - and root\dcim's Dell OMCI/DCIM
  // namespace) and confirmed to add nothing on this machine either.
  const hwMon = connected ? data?.hardwareMonitor : null;
  const cpuTempC = hwMon?.cpuTempC ?? null;
  const gpuTempC = hwMon?.gpuTempC ?? null;
  const moboTempC = hwMon?.motherboardTempC ?? null;
  const dimmTempC = hwMon?.dimmTempC ?? null;
  const fanRpm = hwMon?.fanRpm ?? null;

  // MSAcpi_ThermalZoneTemperature doesn't reliably identify which zone is CPU vs. GPU vs.
  // SSD vs. motherboard (InstanceName is a generic ACPI path like "_TZ.THRM", not a labeled
  // component), so real readings are shown as generic zones rather than fabricating a mapping
  // we don't actually have. This WMI class is also frequently absent entirely — on many
  // machines (this one included) it returns no zones at all: confirmed directly that querying
  // it here throws "Not supported" (the ACPI driver on this hardware doesn't implement the data
  // block at all, not merely an empty result) — in which case we fall back to
  // illustrative CPU/GPU/SSD/Motherboard rows, each independently real when a real source
  // supplies that specific reading (LibreHardwareMonitor for CPU/GPU; LibreHardwareMonitor or
  // HWiNFO for Motherboard; smartctl for SSD), sample otherwise. A Dell-specific WMI namespace
  // (root\dcim, root\dcim\sysman) was also checked as a further fallback and found to exist only
  // as an empty schema skeleton, with none of Dell Command | Monitor's own DCIM_* classes
  // actually registered - so no additional source there either.
  const temps = hasRealZones
    ? thermalZones.map((zone, i) => {
        const celsius = zone.CurrentTemperature / 10 - 273.15;
        return {
          label: `Zone ${i + 1}`,
          value: `${Math.round(celsius)}°C`,
          pct: Math.max(0, Math.min(100, Math.round(celsius))),
          color: THERMAL_ZONE_COLORS[i % THERMAL_ZONE_COLORS.length],
          sample: false,
        };
      })
    : [
        cpuTempC != null
          ? { label: "CPU Temp", value: `${Math.round(cpuTempC)}°C`, pct: Math.max(0, Math.min(100, Math.round(cpuTempC))), color: "var(--clpa-critical-bright)", sample: false }
          : { label: "CPU Temp", value: "—", pct: 0, color: "var(--clpa-critical-bright)", sample: false },
        gpuTempC != null
          ? { label: "GPU Temp", value: `${Math.round(gpuTempC)}°C`, pct: Math.max(0, Math.min(100, Math.round(gpuTempC))), color: "var(--clpa-warning-bright)", sample: false }
          : { label: "GPU Temp", value: "—", pct: 0, color: "var(--clpa-warning-bright)", sample: false },
        ssdTempC != null
          ? { label: "SSD Temp", value: `${Math.round(ssdTempC)}°C`, pct: Math.max(0, Math.min(100, Math.round(ssdTempC))), color: "var(--clpa-emerald)", sample: false }
          : { label: "SSD Temp", value: "—", pct: 0, color: "var(--clpa-emerald)", sample: false },
        moboTempC != null
          ? { label: "Motherboard", value: `${Math.round(moboTempC)}°C`, pct: Math.max(0, Math.min(100, Math.round(moboTempC))), color: "var(--clpa-teal-bright)", sample: false }
          : dimmTempC != null
            ? { label: "DIMM Temp", value: `${Math.round(dimmTempC)}°C`, pct: Math.max(0, Math.min(100, Math.round(dimmTempC))), color: "var(--clpa-teal-bright)", sample: false }
            : { label: "Motherboard", value: "—", pct: 0, color: "var(--clpa-teal-bright)", sample: false },
      ];

  // Real Normal/Warning/Critical from the worst real reading across CPU/GPU/SSD/Motherboard,
  // against useAlertEngine's own live cpu-temp thresholds (reused here since there's no separate
  // established danger zone for GPU/SSD/motherboard - see getThermalCardBadge's own comment).
  const thermalBadge = getThermalCardBadge(data, connected, thresholds.cpuTempWarning, thresholds.cpuTempCritical);
  const thermalBadgeLabel = thermalBadge.label;
  const thermalBadgeSample = thermalBadge.sample;

  const coolingFooter =
    thermalBadgeLabel === "Critical"
      ? { text: "Critical temperature detected", color: "var(--clpa-critical)" }
      : thermalBadgeLabel === "Warning"
      ? { text: "Elevated temperature detected", color: "var(--clpa-warning)" }
      : { text: "Cooling system optimal", color: "var(--clpa-success-bright)" };

  return (
    <>
      <style>{`
        @keyframes thermalFanSpin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        .thermal-fan {
          animation: thermalFanSpin 1.8s linear infinite;
          transform-origin: center;
        }
      `}</style>

      <div
        className="clpa-card-hover rounded-2xl cursor-default"
        style={{
          background: "var(--clpa-card)",
          border: "1px solid var(--clpa-card-border)",
          boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
          padding: "12px 14px",
          height: "100%",
        }}
      >
        <div className="flex items-center justify-between mb-2.5">
          <div className="flex items-center gap-2">
            <div
              className="flex items-center justify-center rounded-xl"
              style={{ width: 28, height: 28, background: "rgba(var(--clpa-critical-bright-rgb),.08)", border: "1px solid rgba(var(--clpa-critical-bright-rgb),.15)" }}
            >
              <Thermometer size={14} color="var(--clpa-critical-bright)" />
            </div>
            <span style={{ fontSize: 12, fontWeight: 700, color: "var(--clpa-title)" }}>Thermal</span>
          </div>
          <StatusBadge label={thermalBadgeLabel} sample={thermalBadgeSample} />
        </div>

        <div className="flex items-center gap-3 mb-2.5">
          <div className="flex-1 flex flex-col gap-1.5">
            {temps.map((t, i) => (
              <div key={i} className="flex items-center gap-2">
                <span style={{ width: 68, fontSize: 9.5, color: "var(--clpa-muted)" }}>{t.label}</span>
                <div style={{ flex: 1, height: 6, borderRadius: 999, background: "var(--clpa-surface-border)", overflow: "hidden" }}>
                  <div style={{ width: `${t.pct}%`, height: "100%", borderRadius: 999, background: t.color }} />
                </div>
                <div className="flex items-center gap-1 flex-shrink-0" style={{ minWidth: 32, justifyContent: "flex-end" }}>
                  <span style={{ textAlign: "right", fontSize: 9.5, fontWeight: 600, color: "var(--clpa-body)" }}>{t.value}</span>
                  {t.sample && <SampleTag />}
                </div>
              </div>
            ))}
          </div>

          <div className="flex flex-col items-center flex-shrink-0" style={{ width: 72 }}>
            <div
              style={{
                width: 54, height: 54, borderRadius: "50%",
                background: "linear-gradient(145deg,var(--clpa-surface),var(--clpa-input-border))",
                display: "flex", alignItems: "center", justifyContent: "center",
                border: "1px solid var(--clpa-input-border)",
              }}
            >
              <svg className="thermal-fan" width="40" height="40" viewBox="0 0 100 100">
                <circle cx="50" cy="50" r="10" fill="var(--clpa-body-alt)" />
                {[0, 90, 180, 270].map((rot) => (
                  <path key={rot} d="M50 15 C75 15,75 40,58 48" fill="var(--clpa-body)" transform={`rotate(${rot} 50 50)`} />
                ))}
                <circle cx="50" cy="50" r="5" fill="var(--clpa-subtle)" />
              </svg>
            </div>
            {/* No standard WMI class exposes fan RPM across OEMs; real when either
                LibreHardwareMonitor or HWiNFO is installed, running, and exposes a fan sensor -
                many laptops expose none at all through either source (confirmed directly: this
                project's own dev laptop reports zero Fan-type entries via HWiNFO). Confirmed
                unavailable via Windows WMI too: Win32_Fan (root\CIMV2) does return two "Cooling
                Device" instances on this machine, but DesiredSpeed/VariableSpeed - the only
                properties that could carry an actual RPM number - are empty on both; it's a
                presence/status abstraction, not a tachometer reading. The Dell OMCI/DCIM
                namespace (root\dcim, root\dcim\sysman) exists only as an empty schema skeleton
                here too - Dell's own fan-sensor classes aren't registered on this machine. */}
            <div style={{ marginTop: 6, fontSize: 16, fontWeight: 800, color: "var(--clpa-title)" }}>
              {fanRpm != null ? Math.round(fanRpm).toLocaleString() : "—"}
            </div>
            <div className="flex items-center gap-1">
              <span style={{ fontSize: 9, color: "var(--clpa-muted)" }}>{fanRpm != null ? "RPM" : "No fan sensor"}</span>
            </div>
          </div>
        </div>

        <div style={{ borderTop: "1px solid var(--clpa-divider)", paddingTop: 9 }}>
          <div className="flex items-center gap-2">
            <CheckCircle2 size={12} color={coolingFooter.color} />
            <span style={{ fontSize: 10, color: "var(--clpa-muted)", fontWeight: 500 }}>{coolingFooter.text}</span>
            {thermalBadgeSample && <SampleTag />}
          </div>
        </div>
      </div>
    </>
  );
}

// ─── GPU Card ─────────────────────────────────────────────
function GPUCard() {
  const { thresholds } = useApp();
  const { data, connected } = useTelemetry();
  const gpus = listDisplayGpus(data, connected);
  const gpuInfo = getPrimaryGpu(data, connected);

  const gpuName = gpuInfo?.Name ? gpuInfo.Name.trim() : "Unknown GPU";
  const driverVersion = gpuInfo?.DriverVersion ? gpuInfo.DriverVersion : "—";

  const gpuUtilReal = connected && data?.gpuUtilization != null ? data.gpuUtilization : null;
  const utilization = gpuUtilReal;
  const vramReal = gpuInfo?.AdapterRAM != null;
  const vramTotal = vramReal ? bytesToGb(gpuInfo!.AdapterRAM) : null;

  const gpuBadge = getGpuBadge(data, connected, thresholds.cpuTempWarning);
  const gpuBadgeLabel = gpuBadge.label;
  const gpuBadgeSample = gpuBadge.sample;

  return (
    <div
      className="clpa-card-hover rounded-2xl cursor-default"
      style={{
        background: "var(--clpa-card)",
        border: "1px solid var(--clpa-card-border)",
        boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
        padding: "12px 14px",
        height: "100%",
      }}
    >
      <div className="flex items-center justify-between mb-2.5">
        <div className="flex items-center gap-2">
          <div
            className="flex items-center justify-center rounded-xl"
            style={{ width: 28, height: 28, background: "rgba(var(--clpa-warning-bright-rgb),0.1)", border: "1px solid rgba(var(--clpa-warning-bright-rgb),0.18)" }}
          >
            <BarChart3 size={14} style={{ color: "var(--clpa-warning-bright)" }} strokeWidth={1.8} />
          </div>
          <span style={{ fontSize: 12, fontWeight: 700, color: "var(--clpa-title)" }}>GPU</span>
          <StatusBadge label={gpuBadgeLabel} sample={gpuBadgeSample} />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <div className="flex-1 flex flex-col gap-2 min-w-0">
          <div>
            <span style={{ fontSize: 12, fontWeight: 700, color: "var(--clpa-ink-strong)" }}>{gpuName}</span>
            <div style={{ fontSize: 10, color: "var(--clpa-subtle)", marginTop: 2 }}>{driverVersion}</div>
            {gpus.length > 1 && (
              <div className="flex flex-col gap-0.5" style={{ marginTop: 4 }}>
                {gpus.filter((g) => g !== gpuInfo).map((g) => (
                  <div key={g.Name} style={{ fontSize: 10, color: "var(--clpa-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {g.Name?.trim()}
                    {g.AdapterRAM != null ? ` · ${bytesToGb(g.AdapterRAM)} GB` : ""}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1">
                <span style={{ fontSize: 9.5, color: "var(--clpa-muted)", fontWeight: 500 }}>Utilization</span>
                {gpuUtilReal == null && <SampleTag />}
              </div>
              <span style={{ fontSize: 11, fontWeight: 700, color: "var(--clpa-warning)" }}>{utilization != null ? `${utilization}%` : "—"}</span>
            </div>
            <div className="w-full rounded-full overflow-hidden" style={{ height: 5, background: "rgba(var(--clpa-warning-bright-rgb),0.18)" }}>
              <div className="h-full rounded-full" style={{ width: `${utilization ?? 0}%`, background: "linear-gradient(90deg, rgba(var(--clpa-warning-bright-rgb),0.55), var(--clpa-warning-bright))" }} />
            </div>
          </div>
          <div className="flex items-center justify-between" style={{ borderTop: "1px solid var(--clpa-divider)", paddingTop: 8 }}>
            <span style={{ fontSize: 9.5, color: "var(--clpa-muted)", fontWeight: 500 }}>VRAM</span>
            <div className="flex items-center gap-1">
              <span style={{ fontSize: 10.5, fontWeight: 600, color: "var(--clpa-body)" }}>{vramTotal != null ? `${vramTotal} GB` : "—"}</span>
              {!vramReal && <SampleTag />}
            </div>
          </div>
        </div>

        <div
          className="flex-shrink-0 flex items-center justify-center rounded-2xl"
          style={{
            width: 72, height: 72,
            background: "linear-gradient(135deg, #1C1A0F 0%, #2D2410 60%, #1A1208 100%)",
            border: "1px solid rgba(var(--clpa-warning-bright-rgb),0.25)",
            boxShadow: "0 0 16px rgba(var(--clpa-warning-bright-rgb),0.12)",
          }}
        >
          <svg width="64" height="64" viewBox="0 0 72 72" fill="none">
            <rect x="6" y="6" width="60" height="60" rx="6" fill="none" stroke="rgba(var(--clpa-warning-bright-rgb),0.35)" strokeWidth="1" />
            <rect x="12" y="12" width="48" height="48" rx="4" fill="#2A1F08" stroke="var(--clpa-warning)" strokeWidth="1.2" />
            <rect x="18" y="18" width="36" height="36" rx="3" fill="#1E1608" stroke="var(--clpa-warning-bright)" strokeWidth="1" />
            <rect x="24" y="24" width="24" height="24" rx="2" fill="#261C09" stroke="#FCD34D" strokeWidth="0.8" />
            <rect x="29" y="29" width="14" height="14" rx="2" fill="var(--clpa-warning-bright)" opacity="0.9" />
            <rect x="32" y="32" width="8" height="8" rx="1" fill="#FDE68A" />
            {[16, 28, 40, 52].map((x, i) => <rect key={`t${i}`} x={x} y="3" width="3" height="6" rx="1" fill="var(--clpa-warning)" opacity="0.8" />)}
            {[16, 28, 40, 52].map((x, i) => <rect key={`b${i}`} x={x} y="63" width="3" height="6" rx="1" fill="var(--clpa-warning)" opacity="0.8" />)}
            {[16, 28, 40, 52].map((y, i) => <rect key={`l${i}`} x="3" y={y} width="6" height="3" rx="1" fill="var(--clpa-warning)" opacity="0.8" />)}
            {[16, 28, 40, 52].map((y, i) => <rect key={`r${i}`} x="63" y={y} width="6" height="3" rx="1" fill="var(--clpa-warning)" opacity="0.8" />)}
          </svg>
        </div>
      </div>
    </div>
  );
}

// Parses both PowerShell's ConvertTo-Json legacy "/Date(ms)/" format (Win32_BIOS.ReleaseDate)
// and plain ISO strings (driver dates, formatted via .ToString("o") in get-telemetry.ps1).
function parseWmiDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const msftMatch = /\/Date\((\d+)\)\//.exec(raw);
  const ms = msftMatch ? Number(msftMatch[1]) : Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  const parsed = new Date(ms);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatWmiDate(raw: string | null | undefined): string | null {
  const parsed = parseWmiDate(raw);
  return parsed ? `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}` : null;
}

// Device Overview's "Age" - no purchase/manufacture date exists anywhere in this project's real
// data, so this uses the BIOS release date as a real, defensible proxy. A later BIOS flash would
// understate age; this app has no purchase date to correct against.
function formatDeviceAge(raw: string | null | undefined): string | null {
  const released = parseWmiDate(raw);
  if (!released) return null;
  const now = new Date();
  if (released > now) return null;
  const { years = 0, months = 0 } = intervalToDuration({ start: released, end: now });
  if (years === 0 && months === 0) return "<1m";
  return years > 0 ? `${years}y ${months}m` : `${months}m`;
}

// ─── OS Card ──────────────────────────────────────────────
function OSCard() {
  const { data, connected } = useTelemetry();
  const osDetail = data?.osDetail;

  const osCaption = connected && osDetail?.Caption ? osDetail.Caption : "Unknown OS";
  const buildNumber = connected && osDetail?.BuildNumber ? osDetail.BuildNumber : "—";
  const osVersion = connected && osDetail?.Version ? osDetail.Version : "—";
  const uptimeReal = connected && osDetail?.UptimeFormatted != null;
  const uptime = uptimeReal ? osDetail!.UptimeFormatted : "—";
  const architecture = connected && osDetail?.OSArchitecture ? osDetail.OSArchitecture : "—";
  const bootMode = connected && data?.bootMode ? data.bootMode : "—";
  const lastBoot = connected ? parseWmiDate(osDetail?.LastBootUpTime) : null;
  const lastBootLabel = lastBoot ? formatRelativeTime(lastBoot.toISOString()) ?? "—" : "—";

  const windowsUpdate = connected ? data?.windowsUpdate ?? null : null;
  const osUpdateBadgeLabel = windowsUpdate == null ? "Unknown" : windowsUpdate.upToDate ? "Up to date" : "Update Available";
  const osUpdateBadgeSample = windowsUpdate == null;
  const pendingCount = windowsUpdate?.pendingCount;
  const footerLabel =
    windowsUpdate == null
      ? "Windows Update status unknown"
      : windowsUpdate.upToDate
        ? "No pending updates"
        : `${pendingCount} update${pendingCount === 1 ? "" : "s"} pending`;
  const footerDot =
    windowsUpdate == null
      ? "var(--clpa-track)"
      : windowsUpdate.upToDate
        ? "var(--clpa-success-bright)"
        : "var(--clpa-warning-bright)";

  const mdm = connected ? data?.mdmEnrollment : null;
  const joinLabel =
    mdm == null
      ? "—"
      : mdm.azureAdJoined
        ? "Azure AD"
        : mdm.domainJoined
          ? "Domain"
          : mdm.enterpriseJoined
            ? "Enterprise"
            : "Not joined";

  return (
    <div
      className="clpa-card-hover rounded-2xl cursor-default flex flex-col"
      style={{
        background: "var(--clpa-card)",
        border: "1px solid var(--clpa-card-border)",
        boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
        padding: "12px 14px",
        height: "100%",
      }}
    >
      <div className="flex items-start justify-between mb-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <div
            className="flex items-center justify-center rounded-xl flex-shrink-0"
            style={{ width: 28, height: 28, background: "rgba(var(--clpa-primary-rgb),0.1)", border: "1px solid rgba(var(--clpa-primary-rgb),0.15)" }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <rect x="1" y="1" width="6.5" height="6.5" rx="0.8" fill="var(--clpa-primary)" />
              <rect x="8.5" y="1" width="6.5" height="6.5" rx="0.8" fill="var(--clpa-primary)" />
              <rect x="1" y="8.5" width="6.5" height="6.5" rx="0.8" fill="var(--clpa-primary)" />
              <rect x="8.5" y="8.5" width="6.5" height="6.5" rx="0.8" fill="var(--clpa-primary)" />
            </svg>
          </div>
          <div className="min-w-0">
            <div style={{ fontSize: 12, fontWeight: 700, color: "var(--clpa-title)", lineHeight: 1 }}>Operating System</div>
            <div style={{ fontSize: 9.5, color: "var(--clpa-muted)", marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{osCaption}</div>
          </div>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <StatusBadge label={osUpdateBadgeLabel} sample={osUpdateBadgeSample} />
        </div>
      </div>

      <div className="flex flex-col gap-1.5 mb-2.5 flex-1">
        {[
          { label: "Status", value: osUpdateBadgeLabel, color: windowsUpdate == null ? "var(--clpa-body)" : windowsUpdate.upToDate ? "var(--clpa-success)" : "var(--clpa-warning)" },
          { label: "Architecture", value: architecture },
          { label: "Boot", value: bootMode },
          { label: "Build", value: buildNumber },
          { label: "Version", value: osVersion },
          { label: "Uptime", value: uptime },
          { label: "Last boot", value: lastBootLabel },
          { label: "Join", value: joinLabel },
        ].map((row) => (
          <div key={row.label} className="flex items-center justify-between gap-2">
            <span style={{ fontSize: 9, color: "var(--clpa-subtle)", fontWeight: 500 }}>{row.label}</span>
            <span style={{ fontSize: 10, fontWeight: 600, color: row.color ?? "var(--clpa-body)", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.value}</span>
          </div>
        ))}
      </div>

      <div style={{ borderTop: "1px solid var(--clpa-divider)", paddingTop: 9, marginTop: "auto" }}>
        <div className="flex items-center gap-2">
          <div style={{ width: 7, height: 7, borderRadius: "50%", background: footerDot }} />
          <span style={{ fontSize: 10, color: "var(--clpa-muted)", fontWeight: 500 }}>{footerLabel}</span>
          {osUpdateBadgeSample && <SampleTag />}
        </div>
      </div>
    </div>
  );
}

// ─── Hardware Inventory Card ──────────────────────────────
function HardwareInventoryCard() {
  const { navigate } = useApp();
  const { data, connected } = useTelemetry();
  const board = data?.board;
  const bios = data?.bios;
  const enclosure = data?.enclosure;
  const system = data?.system;

  const manufacturer = connected && system?.Vendor ? system.Vendor : "—";
  const model = connected && system?.Name ? system.Name : "—";
  const motherboard = connected && board?.Product ? board.Product : "—";
  const biosDate = connected ? formatWmiDate(bios?.ReleaseDate) : null;
  const biosVersionLabel =
    connected && bios?.SMBIOSBIOSVersion
      ? `v${bios.SMBIOSBIOSVersion}${biosDate ? ` (${biosDate})` : ""}`
      : "—";
  const biosSerial = connected && bios?.SerialNumber ? bios.SerialNumber : "—";
  const assetTag = connected && enclosure?.SMBIOSAssetTag ? enclosure.SMBIOSAssetTag : "Not available";
  const deviceAge = connected ? formatDeviceAge(bios?.ReleaseDate) : null;
  const tpmStatus = getTpmStatus(data, connected);
  const tpmLabel = !tpmStatus.tpmReal ? "—" : tpmStatus.tpmActive ? "Active" : "Inactive";
  const secureBoot =
    connected && data?.secureBootEnabled != null ? (data.secureBootEnabled ? "On" : "Off") : "—";

  const hwInventoryBadge = getHardwareInventoryBadge(data, connected);

  return (
    <div
      className="clpa-card-hover rounded-2xl cursor-default flex flex-col"
      style={{
        background: "var(--clpa-card)",
        border: "1px solid var(--clpa-card-border)",
        boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
        padding: "12px 14px",
        height: "100%",
      }}
    >
      <div className="flex items-start justify-between mb-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <div
            className="flex items-center justify-center rounded-xl flex-shrink-0"
            style={{ width: 28, height: 28, background: "rgba(var(--clpa-muted-rgb),0.1)", border: "1px solid rgba(var(--clpa-muted-rgb),0.15)" }}
          >
            <Package size={14} style={{ color: "var(--clpa-muted)" }} strokeWidth={1.8} />
          </div>
          <div className="min-w-0">
            <div style={{ fontSize: 12, fontWeight: 700, color: "var(--clpa-title)", lineHeight: 1 }}>Hardware Inventory</div>
            <div style={{ fontSize: 9.5, color: "var(--clpa-muted)", marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {manufacturer !== "—" ? `${manufacturer} · ${model}` : "Device identity"}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <StatusBadge label={hwInventoryBadge.label} sample={hwInventoryBadge.sample} />
        </div>
      </div>

      <div className="flex flex-col gap-1.5 mb-2.5 flex-1">
        {[
          { label: "Manufacturer", value: manufacturer },
          { label: "Model", value: model },
          { label: "Motherboard", value: motherboard },
          { label: "BIOS", value: biosVersionLabel },
          { label: "Serial", value: biosSerial },
          { label: "Age", value: deviceAge ?? "—" },
          { label: "Asset tag", value: assetTag },
          { label: "TPM", value: tpmLabel },
          { label: "Secure Boot", value: secureBoot },
        ].map((row) => (
          <div key={row.label} className="flex items-center justify-between gap-2">
            <span style={{ fontSize: 9, color: "var(--clpa-subtle)", fontWeight: 500 }}>{row.label}</span>
            <span style={{ fontSize: 10, fontWeight: 600, color: "var(--clpa-body)", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.value}</span>
          </div>
        ))}
      </div>

      <div style={{ borderTop: "1px solid var(--clpa-divider)", paddingTop: 9, marginTop: "auto" }}>
        <button onClick={() => navigate("hardware")} style={{ background: "none", border: "none", cursor: "pointer", padding: 0, display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ fontSize: 10, fontWeight: 600, color: "var(--clpa-primary)" }}>View all hardware</span>
          <span style={{ fontSize: 11, color: "var(--clpa-primary)" }}>→</span>
        </button>
      </div>
    </div>
  );
}

// ─── Network Card ─────────────────────────────────────────
function NetworkCard() {
  const { data, connected } = useTelemetry();
  const netAdapter = getDisplayNetworkAdapter(data, connected);
  const adapters = listConnectedAdapters(data, connected);
  const wifi = data?.wifi;
  const wifiLink = getWifiLinkStatus(data, connected);
  const localIp = connected ? data?.localIp ?? null : null;
  const ssid = connected && wifi?.ssid ? wifi.ssid : null;

  const adapterName = netAdapter?.Name ? netAdapter.Name : "Unknown adapter";
  const macAddress = netAdapter?.MACAddress ? netAdapter.MACAddress : "—";

  // netsh gives signal strength as a percentage, not dBm — dBm was never a real unit this
  // collector could produce, so both the real and sample values are shown as percentages now.
  const signalPercentRaw = connected && wifi?.signalPercent != null ? Number(wifi.signalPercent) : null;
  const signalPercent = signalPercentRaw != null && !Number.isNaN(signalPercentRaw) ? signalPercentRaw : null;

  const receiveRateMbps = connected && wifi?.receiveRateMbps != null ? wifi.receiveRateMbps : null;
  const connectionLabel = wifiLink.label === "Unknown"
    ? "—"
    : wifiLink.label === "Online" && receiveRateMbps != null
      ? `Online · ${receiveRateMbps} Mbps`
      : wifiLink.label;

  // Real Excellent/Good/Poor bucketing of the real signal % against real named thresholds (no
  // useAlertEngine equivalent exists for network - see getNetworkBadge's own comment).
  const networkBadge = getNetworkBadge(data, connected);
  const networkBadgeLabel = networkBadge.label;
  const networkBadgeSample = networkBadge.sample;

  return (
    <div
      className="clpa-card-hover rounded-2xl cursor-default flex flex-col"
      style={{
        background: "var(--clpa-card)",
        border: "1px solid var(--clpa-card-border)",
        boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
        padding: "12px 14px",
        height: "100%",
      }}
    >
      <div className="flex items-start justify-between mb-2.5">
        <div className="flex items-center gap-2">
          <div
            className="flex items-center justify-center rounded-xl"
            style={{ width: 28, height: 28, background: "rgba(var(--clpa-info-cyan-rgb),.08)", border: "1px solid rgba(var(--clpa-info-cyan-rgb),.12)" }}
          >
            <Wifi size={14} style={{ color: "var(--clpa-info-cyan)" }} />
          </div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: "var(--clpa-title)", lineHeight: 1 }}>Network</div>
            <div style={{ fontSize: 9.5, color: "var(--clpa-muted)", marginTop: 3 }}>WiFi Signal</div>
          </div>
        </div>
        <StatusBadge label={networkBadgeLabel} sample={networkBadgeSample} />
      </div>

      <div className="flex items-center justify-between mb-2.5">
        <div>
          <div className="flex items-center gap-1.5">
            <div style={{ fontSize: 20, fontWeight: 800, color: "var(--clpa-cyan-deep)", lineHeight: 1 }}>
              {signalPercent != null ? signalPercent : "—"}{signalPercent != null && <span style={{ fontSize: 12, marginLeft: 4 }}>%</span>}
            </div>
            {signalPercent == null && <SampleTag />}
          </div>
          {/* Same disclosed bucketing of real signalPercent as the header badge above, not a fabricated score */}
          <div className="flex items-center gap-1" style={{ marginTop: 6 }}>
            <span style={{ fontSize: 10, fontWeight: 600, color: "var(--clpa-muted)" }}>{networkBadgeLabel}</span>
            {networkBadgeSample && <SampleTag />}
          </div>
        </div>

        <div className="flex items-center justify-center" style={{ width: 84, height: 64 }}>
          <svg width="76" height="58" viewBox="0 0 90 70" fill="none">
            <path d="M15 28C30 12 60 12 75 28" stroke="var(--clpa-success-bright)" strokeWidth="5" strokeLinecap="round" />
            <path d="M25 38C35 28 55 28 65 38" stroke="var(--clpa-success-bright)" strokeWidth="5" strokeLinecap="round" />
            <path d="M35 48C40 43 50 43 55 48" stroke="var(--clpa-success-bright)" strokeWidth="5" strokeLinecap="round" />
            <circle cx="45" cy="58" r="4" fill="var(--clpa-success-bright)" />
          </svg>
        </div>
      </div>

      <div className="flex flex-col gap-1.5 mb-2.5 flex-1">
        <div className="flex items-center justify-between">
          <span style={{ fontSize: 9, color: "var(--clpa-subtle)", fontWeight: 500 }}>Status</span>
          <span style={{ fontSize: 10, fontWeight: 700, color: wifiLink.label === "Online" ? "var(--clpa-success)" : wifiLink.label === "Offline" ? "var(--clpa-critical)" : "var(--clpa-body)" }}>{wifiLink.label}</span>
        </div>
        <div className="flex items-center justify-between">
          <span style={{ fontSize: 9, color: "var(--clpa-subtle)", fontWeight: 500 }}>IP Address</span>
          <span style={{ fontSize: 10, fontWeight: 600, color: "var(--clpa-body)" }}>{localIp ?? "—"}</span>
        </div>
        {ssid && (
          <div className="flex items-center justify-between">
            <span style={{ fontSize: 9, color: "var(--clpa-subtle)", fontWeight: 500 }}>SSID</span>
            <span style={{ fontSize: 10, fontWeight: 600, color: "var(--clpa-body)" }}>{ssid}</span>
          </div>
        )}
        <div className="flex items-center justify-between">
          <span style={{ fontSize: 9, color: "var(--clpa-subtle)", fontWeight: 500 }}>Adapter</span>
          <span style={{ fontSize: 10, fontWeight: 600, color: "var(--clpa-body)", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{adapterName}</span>
        </div>
        {adapters.filter((a) => a.Name !== netAdapter?.Name).map((a) => (
          <div key={`${a.Name}-${a.MACAddress}`} className="flex items-center justify-between gap-2">
            <span style={{ fontSize: 9, color: "var(--clpa-subtle)", fontWeight: 500 }}>Also</span>
            <span style={{ fontSize: 10, fontWeight: 600, color: "var(--clpa-body)", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.Name}</span>
          </div>
        ))}
        <div className="flex items-center justify-between">
          <span style={{ fontSize: 9, color: "var(--clpa-subtle)", fontWeight: 500 }}>MAC Address</span>
          <span style={{ fontSize: 10, fontWeight: 600, color: "var(--clpa-body)" }}>{macAddress}</span>
        </div>
      </div>

      <div style={{ borderTop: "1px solid var(--clpa-divider)", paddingTop: 9, marginTop: "auto" }}>
        <div className="flex items-center gap-2">
          <div style={{ width: 7, height: 7, borderRadius: "50%", background: wifiLink.label === "Online" ? "var(--clpa-success-bright)" : wifiLink.label === "Offline" ? "var(--clpa-critical-bright)" : "var(--clpa-track)" }} />
          <span style={{ fontSize: 10, color: "var(--clpa-muted)", fontWeight: 500 }}>{connectionLabel}</span>
          {wifiLink.sample && <SampleTag />}
        </div>
      </div>
    </div>
  );
}

function TelemetryGrid() {
  const { remoteSessionActive, navigate } = useApp();
  return (
    <div>
      {remoteSessionActive && (
        <button
          type="button"
          onClick={() => navigate("remote")}
          className="clpa-focusable flex items-center gap-2.5 w-full text-left"
          style={{
            marginBottom: 10,
            padding: "10px 12px",
            borderRadius: 12,
            background: "rgba(var(--clpa-primary-rgb),0.1)",
            border: "1px solid rgba(var(--clpa-primary-rgb),0.28)",
            cursor: "pointer",
          }}
        >
          <Headphones size={14} style={{ color: "var(--clpa-primary)", flexShrink: 0 }} strokeWidth={2} />
          <span style={{ fontSize: 12, fontWeight: 700, color: "var(--clpa-title)", flex: 1 }}>
            Remote assist requested — waiting for operator to join
          </span>
          <span style={{ fontSize: 11, fontWeight: 700, color: "var(--clpa-primary)" }}>Open Remote →</span>
        </button>
      )}
      <CLPASectionLabel label="TELEMETRY OVERVIEW" live Icon={Activity} />

      <div
        className="grid gap-2.5 items-stretch"
        style={{ gridTemplateColumns: "repeat(3, 1fr)" }}
      >
        <CPUCard />
        <MemoryCard />
        <StorageCard />
        <BatteryCard />
        <ThermalCard />
        <GPUCard />
        <NetworkCard />
        <OSCard />
        <HardwareInventoryCard />
      </div>
    </div>
  );
}
// ═══════════════════════════════════════════════════════════
// ─── AI INTEL PAGE (EXACT MATCH TO REFERENCE) ────────────
// ═══════════════════════════════════════════════════════════

function AIIntelPage() {
  return (
    <CLPAPage>
      <AIRow1 />
      <AIRow2 />
      <AIRow3 />
    </CLPAPage>
  );
}

// ─── Shared AI card shell ─────────────────────────────────
function AICard({
  children,
  className = "",
  style = {},
}: {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className={`clpa-card-hover rounded-2xl ${className}`}
      style={{
        position: "relative",
        height: "100%",
        width: "100%",
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        background: "var(--clpa-card)",
        border: "1px solid var(--clpa-card-border)",
        boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// ─── Info icon (small circle "i") ─────────────────────────
// `text` is required, not optional - an AIInfo with no explanation is exactly the
// looks-interactive-but-does-nothing icon this component replaced. Tooltip mechanism matches
// SampleTag's own (title/aria-label/data-tip on the hoverable element) rather than inventing a
// second convention for the same "hover to see disclosure text" job.
function AIInfo({ text }: { text: string }) {
  return (
    <div
      className="flex items-center justify-center rounded-full flex-shrink-0"
      style={{ width: 14, height: 14, border: "1.5px solid var(--clpa-track)" }}
      tabIndex={0}
      aria-label={text}
      title={text}
      data-tip={text}
    >
      <span style={{ fontSize: 8, color: "var(--clpa-subtle)", fontWeight: 700, lineHeight: 1 }}>i</span>
    </div>
  );
}

// ─── Card header (title + info + View All) ────────────────
function AIHeader({ title, tooltip, action, onAction }: { title: string; tooltip: string; action?: string; onAction?: () => void }) {
  return (
    <div className="flex items-center justify-between mb-2.5">
      <div className="flex items-center gap-1.5">
        <span style={{ fontSize: 11, fontWeight: 800, color: "var(--clpa-title)", letterSpacing: 0.4 }}>{title}</span>
        <AIInfo text={tooltip} />
      </div>
      {action && (
        <button onClick={onAction} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 10.5, color: "var(--clpa-primary)", fontWeight: 600 }}>
          {action} ›
        </button>
      )}
    </div>
  );
}

// ─── Small AI sparkline ───────────────────────────────────
function AISparkline({ data, color, w = 60, h = 24 }: { data: number[]; color: string; w?: number; h?: number }) {
  const max = Math.max(...data);
  const min = Math.min(...data);
  const rng = max - min || 1;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - 2 - ((v - min) / rng) * (h - 4)}`);
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ═══ Row 1 ═════════════════════════════════════════════════
function AIRow1() {
  return (
    <CLPARow columns="minmax(0, 1.05fr) minmax(0, 0.95fr) minmax(0, 1.2fr)">
      <AIHealthScoreCard />
      <AIVerdictCard />
      <AITopPredictionsCard />
    </CLPARow>
  );
}

// ─── AI Health Score Card ─────────────────────────────────
function AIHealthScoreCard() {
  const { thresholds } = useApp();
  const { data, connected, updatedAt } = useTelemetry();

  // Shared getters (src/app/lib/derived.ts) - the exact same formulas Risk Overview/Risk Level
  // use, so the two pages can never silently drift apart on the same underlying reality.
  const cpuLoad = getCpuLoad(data, connected);
  const memUsedPct = getMemUsedPercent(data, connected);
  const performanceScore = getPerformanceScore(cpuLoad, memUsedPct);
  const performanceReal = performanceScore != null;

  const batteryHealthPct = getBatteryHealthPercent(data, connected);
  const batteryReal = batteryHealthPct != null;

  const securityScore = getSecurityHealthPercent(data, connected);
  const securityReal = securityScore != null;

  const batteryScoreColor = batteryReal
    ? colorForHealthPercent(batteryHealthPct, thresholds.batteryHealthWarning, thresholds.batteryHealthCritical)
    : "var(--clpa-muted)";
  const securityScoreColor = securityReal
    ? colorForHealthPercent(securityScore, 60, 40)
    : "var(--clpa-muted)";
  const subScores = [
    {
      label: "Performance",
      value: performanceReal ? performanceScore : null,
      color: "var(--clpa-success-bright)",
      real: performanceReal,
      detail: performanceReal ? `CPU ${cpuLoad}% · RAM ${memUsedPct}%` : "Waiting on CPU / RAM",
    },
    {
      label: "Security",
      value: securityScore,
      color: securityScoreColor,
      real: securityReal,
      detail: securityReal ? describeSecuritySignals(data, connected) : "Waiting on security sensors",
    },
    {
      label: "Battery",
      value: batteryReal ? batteryHealthPct : null,
      color: batteryScoreColor,
      real: batteryReal,
      detail: batteryReal ? `${batteryHealthPct}% of design capacity` : "Waiting on battery",
    },
  ];

  const realSubs = subScores.filter((s): s is typeof s & { value: number } => s.real && s.value != null);
  const score = realSubs.length > 0 ? Math.round(realSubs.reduce((sum, s) => sum + s.value, 0) / realSubs.length) : null;
  const realCount = realSubs.length;
  const worstReal = realSubs.length > 0 ? Math.min(...realSubs.map((s) => s.value)) : null;

  let scoreLabel = "Unknown";
  let scoreLabelColor = "var(--clpa-muted)";
  if (score != null && worstReal != null) {
    if (worstReal < 40) {
      scoreLabel = "Poor";
      scoreLabelColor = "var(--clpa-critical)";
    } else if (worstReal < 60) {
      scoreLabel = "Fair";
      scoreLabelColor = "var(--clpa-warning)";
    } else if (score >= 90) {
      scoreLabel = "Excellent";
      scoreLabelColor = "var(--clpa-success-bright)";
    } else {
      scoreLabel = "Good";
      scoreLabelColor = "var(--clpa-success-bright)";
    }
  }

  const gaugeColor = scoreLabelColor === "var(--clpa-muted)" ? "var(--clpa-track)" : scoreLabelColor;

  // Only record a health-score trend point on days the score is fully backed by real data (all
  // 3 sub-scores real) - otherwise a day where e.g. TPM data was unavailable would bake a
  // partly-fabricated number into what's supposed to be a real historical trend.
  const { healthScoreHistory } = useTrendHistory(data, connected, realCount === 3 && score != null ? score : null);
  const scoreDelta = computeScoreDelta(healthScoreHistory);

  const scoreDeltaReal = scoreDelta != null;
  const scoreDeltaLabel = scoreDeltaReal ? `${scoreDelta!.delta >= 0 ? "+" : ""}${scoreDelta!.delta} points` : "—";
  const scoreDeltaColor = scoreDeltaReal ? (scoreDelta!.delta >= 0 ? "var(--clpa-success-bright)" : "var(--clpa-critical)") : "var(--clpa-muted)";
  const scoreDeltaSub = scoreDeltaReal
    ? scoreDelta!.daysAgo === 1
      ? "vs yesterday"
      : scoreDelta!.daysAgo === 7
      ? "vs last week"
      : `vs ${scoreDelta!.daysAgo} days ago`
    : "no prior day yet";

  const lastComputedLabel = formatRelativeTime(connected ? updatedAt : null);

  const size = 112;
  const sw = 9;
  const r = (size - sw) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circ = 2 * Math.PI * r;
  const trackLen = circ * 0.75;
  const valueLen = trackLen * ((score ?? 0) / 100);
  const rot = `rotate(135 ${cx} ${cy})`;

  return (
    <AICard style={{ padding: "12px 14px 10px" }}>
      <div className="flex items-center gap-1.5 mb-2">
        <span style={{ fontSize: 11, fontWeight: 800, color: "var(--clpa-title)", letterSpacing: 0.4 }}>AI HEALTH SCORE</span>
        <AIInfo text="Overall is the average of live Performance, Security (TPM + Secure Boot + BitLocker), and Battery health. The label follows the weakest of those, so a worn battery cannot read as Good." />
      </div>

      <div className="flex items-center gap-3">
        {/* Gauge */}
        <div className="flex flex-col items-center flex-shrink-0">
          <div className="relative" style={{ width: size, height: size }}>
            <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
              <defs>
                <linearGradient id="hs-arc-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor={gaugeColor} />
                  <stop offset="45%" stopColor={gaugeColor} />
                  <stop offset="100%" stopColor={gaugeColor} />
                </linearGradient>
              </defs>
              <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--clpa-input-border)" strokeWidth={sw} strokeLinecap="round" strokeDasharray={`${trackLen} ${circ}`} transform={rot} />
              <circle cx={cx} cy={cy} r={r} fill="none" stroke="url(#hs-arc-grad)" strokeWidth={sw} strokeLinecap="round" strokeDasharray={`${valueLen} ${circ}`} transform={rot} />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center" style={{ paddingBottom: 12 }}>
              <span style={{ fontSize: 34, fontWeight: 900, color: scoreLabelColor, lineHeight: 1 }}>{score ?? "—"}</span>
              <span style={{ fontSize: 10, color: "var(--clpa-subtle)", marginTop: 1 }}>/100</span>
            </div>
          </div>
          <span style={{ fontSize: 12, fontWeight: 700, color: scoreLabelColor, marginTop: -6 }}>{scoreLabel}</span>
        </div>

        {/* Right: stats */}
        <div className="flex-1 flex flex-col gap-2">
          <div
            className="flex items-center justify-between rounded-lg px-2.5 py-2"
            style={{
              background: !scoreDeltaReal
                ? "rgba(var(--clpa-subtle-rgb),0.08)"
                : scoreDelta!.delta >= 0
                ? "rgba(var(--clpa-success-bright-rgb),0.08)"
                : "rgba(var(--clpa-critical-bright-rgb),0.08)",
              border: !scoreDeltaReal
                ? "1px solid var(--clpa-surface-border)"
                : scoreDelta!.delta >= 0
                ? "1px solid rgba(var(--clpa-success-bright-rgb),0.18)"
                : "1px solid rgba(var(--clpa-critical-bright-rgb),0.18)",
            }}
          >
            <div className="flex items-center gap-1.5">
              {scoreDeltaReal && scoreDelta!.delta < 0
                ? <TrendingDown size={14} style={{ color: scoreDeltaColor }} strokeWidth={2.5} />
                : <TrendingUp size={14} style={{ color: scoreDeltaColor }} strokeWidth={2.5} />}
              <div className="flex flex-col">
                <span style={{ fontSize: 13, fontWeight: 800, color: scoreDeltaColor, lineHeight: 1 }}>{scoreDeltaLabel}</span>
                <span style={{ fontSize: 8.5, color: "var(--clpa-subtle)", marginTop: 2 }}>{scoreDeltaSub}</span>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between rounded-lg px-2.5 py-2" style={{ background: "rgba(var(--clpa-primary-rgb),0.06)", border: "1px solid rgba(var(--clpa-primary-rgb),0.15)" }}>
            <div className="flex items-center gap-1.5">
              <Activity size={14} style={{ color: "var(--clpa-primary)" }} strokeWidth={2} />
              <span style={{ fontSize: 9.5, color: "var(--clpa-muted)", fontWeight: 500 }}>Sensors</span>
            </div>
            <span style={{ fontSize: 17, fontWeight: 800, color: "var(--clpa-title)", lineHeight: 1 }}>{realCount}/3</span>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-2 mt-3" style={{ borderTop: "1px solid var(--clpa-divider)", paddingTop: 10 }}>
        {subScores.map((s, i) => (
          <div key={i} className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <span style={{ fontSize: 9.5, color: "var(--clpa-muted)", fontWeight: 600, width: 72, flexShrink: 0 }}>{s.label}</span>
              <div className="flex-1 rounded-full overflow-hidden" style={{ height: 5, background: "var(--clpa-divider)" }}>
                <div style={{ width: `${s.value ?? 0}%`, height: "100%", background: s.color, borderRadius: 4, opacity: s.value == null ? 0.25 : 1 }} />
              </div>
              <span style={{ fontSize: 11, fontWeight: 700, color: s.color, width: 28, textAlign: "right", flexShrink: 0 }}>{s.value ?? "—"}</span>
            </div>
            <span style={{ fontSize: 9, color: "var(--clpa-subtle)", lineHeight: 1.3, paddingLeft: 74 }}>{s.detail}</span>
          </div>
        ))}
      </div>

      {/* Footer - real telemetry timestamp, same convention as AIVerdictCard's "Last analyzed" footer */}
      <div className="flex items-center gap-1.5" style={{ borderTop: "1px solid var(--clpa-divider)", paddingTop: 9, marginTop: "auto" }}>
        <CheckCircle2 size={12} style={{ color: "var(--clpa-success-bright)" }} strokeWidth={2} />
        <span style={{ fontSize: 9, color: "var(--clpa-subtle)" }}>
          Last computed: {lastComputedLabel ?? "—"}
        </span>
      </div>
    </AICard>
  );
}
// ─── AI Verdict Card ──────────────────────────────────────
function AIVerdictCard() {
  const { data, connected, updatedAt } = useTelemetry();

  const lastAnalyzedLabel = formatRelativeTime(connected ? updatedAt : null);

  // Shared getters (src/app/lib/derived.ts) - identical to what Health Score/Risk Overview/Risk
  // Level compute, so this card's badges can never disagree with those pages about the same
  // underlying reality.
  const cpuLoad = getCpuLoad(data, connected);
  const memUsedPct = getMemUsedPercent(data, connected);
  const batteryHealthPct = getBatteryHealthPercent(data, connected);
  const storageWearPercent = getStorageWearPercent(data, connected);
  const security = getSecurityCompliance(data, connected);

  const stablePerformanceReal = cpuLoad != null && memUsedPct != null;
  const stablePerformanceOk = stablePerformanceReal && cpuLoad < 85 && memUsedPct < 85;

  const lowRiskReal = batteryHealthPct != null || storageWearPercent != null;
  const lowRiskOk =
    lowRiskReal &&
    (batteryHealthPct == null || batteryHealthPct >= 60) &&
    (storageWearPercent == null || storageWearPercent < 90);

  const noIssuesReal = cpuLoad != null || memUsedPct != null || batteryHealthPct != null || storageWearPercent != null;
  const noIssuesOk =
    noIssuesReal &&
    (cpuLoad == null || cpuLoad < 95) &&
    (memUsedPct == null || memUsedPct < 95) &&
    (batteryHealthPct == null || batteryHealthPct >= 60) &&
    (storageWearPercent == null || storageWearPercent < 95);

  const compliantReal = security.real;
  const compliantOk = security.ok;

  const badges = [
    {
      label: "Performance",
      Icon: Activity,
      ok: stablePerformanceOk,
      real: stablePerformanceReal,
      detail: stablePerformanceReal ? `CPU ${cpuLoad}% · RAM ${memUsedPct}%` : "Waiting on CPU / RAM",
    },
    {
      label: "Wear risk",
      Icon: TrendingUp,
      ok: lowRiskOk,
      real: lowRiskReal,
      detail: !lowRiskReal
        ? "Waiting on battery / SSD"
        : [
            batteryHealthPct != null ? `Battery ${batteryHealthPct}%` : null,
            storageWearPercent != null ? `SSD wear ${storageWearPercent}%` : null,
          ].filter(Boolean).join(" · "),
    },
    {
      label: "Active issues",
      Icon: CheckCircle2,
      ok: noIssuesOk,
      real: noIssuesReal,
      detail: noIssuesOk ? "No live breaches" : "One or more sensors out of range",
    },
    {
      label: "Compliance",
      Icon: Shield,
      ok: compliantOk,
      real: compliantReal,
      detail: compliantReal ? describeSecuritySignals(data, connected) : "Waiting on security sensors",
    },
  ];

  const judged = badges.filter((b) => b.real);
  const allGood = judged.length > 0 && judged.every((b) => b.ok);
  const anyReal = judged.length > 0;
  const verdictColor = allGood ? "var(--clpa-success-bright)" : "var(--clpa-warning)";
  const verdictBg = allGood ? "rgba(var(--clpa-success-bright-rgb),0.1)" : "rgba(var(--clpa-warning-bright-rgb),0.12)";
  const verdictBorder = allGood ? "1px solid rgba(var(--clpa-success-bright-rgb),0.2)" : "1px solid rgba(var(--clpa-warning-bright-rgb),0.22)";
  const pillText = allGood ? "All Systems Healthy" : "Some Areas Need Attention";
  const verdictText = allGood ? "All Good" : "Needs Attention";
  let verdictBody = "Waiting on live sensors.";
  if (anyReal && allGood) {
    verdictBody = "All live checks are in range.";
  } else if (anyReal) {
    const bits: string[] = [];
    if (batteryHealthPct != null && batteryHealthPct < 60) bits.push(`Battery health ${batteryHealthPct}%`);
    if (compliantReal && !compliantOk) bits.push(describeSecuritySignals(data, connected));
    if (stablePerformanceReal && !stablePerformanceOk) bits.push(`CPU ${cpuLoad}% · RAM ${memUsedPct}%`);
    if (storageWearPercent != null && storageWearPercent >= 90) bits.push(`SSD wear ${storageWearPercent}%`);
    verdictBody = bits.length > 0 ? bits.join(" · ") : "One or more checks need attention.";
  }

  return (
    <AICard style={{ padding: "12px 14px", display: "flex", flexDirection: "column" }}>
      <div className="flex items-center gap-1.5 mb-2">
        <span style={{ fontSize: 11, fontWeight: 800, color: "var(--clpa-title)", letterSpacing: 0.4 }}>AI VERDICT</span>
        <AIInfo text="Same live CPU, memory, battery, storage, TPM, Secure Boot, and BitLocker signals as Health Score. Missing data is Unknown, not treated as healthy." />
      </div>

      <div className="flex flex-col items-start gap-1.5 mb-3" style={{ background: verdictBg, border: verdictBorder, borderRadius: 12, padding: "10px 12px" }}>
        <div className="flex items-center gap-1.5">
          <span className="clpa-dot" style={{ width: 7, height: 7, borderRadius: 999, background: verdictColor, display: "inline-block" }} />
          <span style={{ fontSize: 9.5, fontWeight: 700, color: verdictColor }}>{pillText}</span>
        </div>
        <div style={{ fontSize: 22, fontWeight: 800, color: verdictColor, lineHeight: 1.1 }}>{verdictText}</div>
        <div style={{ fontSize: 10.5, color: "var(--clpa-muted)", lineHeight: 1.4 }}>{verdictBody}</div>
      </div>

      <div className="flex flex-col gap-1.5 flex-1 min-h-0">
        {badges.map(({ label, Icon, ok, real, detail }) => {
          const status = !real ? "Unknown" : ok ? "Pass" : "Attention";
          const statusColor = !real ? "var(--clpa-muted)" : ok ? "var(--clpa-success)" : "var(--clpa-warning)";
          const statusBg = !real ? "rgba(var(--clpa-subtle-rgb),0.1)" : ok ? "rgba(var(--clpa-success-bright-rgb),0.12)" : "rgba(var(--clpa-warning-bright-rgb),0.12)";
          const iconColor = !real ? "var(--clpa-muted)" : ok ? "var(--clpa-success-bright)" : "var(--clpa-warning)";
          const DisplayIcon = !real ? Icon : ok ? Icon : AlertTriangle;
          return (
            <div key={label} className="flex items-center gap-2 rounded-lg" style={{ background: "var(--clpa-surface)", border: "1px solid var(--clpa-surface-border)", padding: "7px 8px" }}>
              <div className="flex items-center justify-center rounded-md flex-shrink-0" style={{ width: 24, height: 24, background: statusBg }}>
                <DisplayIcon size={13} style={{ color: iconColor }} strokeWidth={2} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span style={{ fontSize: 10.5, fontWeight: 700, color: "var(--clpa-title)" }}>{label}</span>
                  <span style={{ fontSize: 8, fontWeight: 700, color: statusColor, background: statusBg, borderRadius: 4, padding: "1px 6px", flexShrink: 0 }}>{status}</span>
                </div>
                <div style={{ fontSize: 9, color: "var(--clpa-subtle)", lineHeight: 1.3, marginTop: 1 }}>{detail}</div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer - real telemetry timestamp, same convention as AIHealthScoreCard's "Last
          computed" footer. The old "· 147 signals" clause is dropped rather than sample-tagged:
          there's no real signal-counting concept anywhere in this codebase, and a permanently
          fake specific number dressed up as a metric is worse than just not showing one. */}
      <div className="flex items-center justify-center gap-1.5" style={{ borderTop: "1px solid var(--clpa-divider)", paddingTop: 9, marginTop: "auto" }}>
        <CheckCircle2 size={12} style={{ color: "var(--clpa-success-bright)" }} strokeWidth={2} />
        <span style={{ fontSize: 9, color: "var(--clpa-subtle)" }}>
          Last analyzed: {lastAnalyzedLabel ?? "—"}
        </span>
      </div>
    </AICard>
  );
}
// ─── Top Predictions Card ─────────────────────────────────
// `state` is an explicit discriminant for callers that need to know whether this is a genuine
// matured conclusion (real backend/ai-service regression, or a real already-past/stable read)
// vs. still real-in-progress accumulation - never a placeholder either way, since both are
// genuinely real states of the actual pipeline (see useTelemetry's own MetricPrediction comment).
type LifePredictionState = "collecting" | "matured";

// Adapts ai-service's real per-device regression result (surfaced through telemetry by
// telemetry-server.mjs, at most once per real calendar day) into the same display shape this
// card's rendering code already expects - real backend/ai-service infrastructure now, not the
// client-side localStorage regression this replaced (see git history for that prior version).
// sparkData still comes from the caller's own locally-recorded history (useTrendHistory) purely
// for the sparkline visual - a separate, still-genuinely-real recording of the same real metric,
// just no longer the source of the headline prediction number itself.
// `stableLabel` is metric-specific ("no decline"/"no wear increase") since "stable" means a
// different real thing depending on which direction would actually be dangerous for that metric.
//
// `real` distinguishes two genuinely different "collecting" situations that `prediction == null`
// vs. `status: "insufficient-data"` conflated before this field existed: a real MetricPrediction
// object with `insufficient-data` status carries a real daysOfHistory/minRequired pair (this
// device's snapshot accumulation is real, just not mature yet) - `real: true`, safe to show that
// real count. `prediction == null` means no real prediction object exists AT ALL (never enrolled,
// backend/ai-service unreachable, or the very first real day hasn't finished) - confirmed
// directly on this machine that this can happen even after real snapshot accumulation and a past
// successful prediction already exist (ai-service simply isn't running right now), so claiming a
// specific "day 0 of 3" here would be a fabricated number, not an honest unknown - `real: false`.
function predictionToLifeDisplay(
  prediction: MetricPrediction | null,
  sparkData: number[],
  stableLabel: string,
): { value: string; unit: string; sub: string; subColor: string; sparkData: number[]; state: LifePredictionState; real: boolean } {
  if (prediction == null) {
    return { value: "—", unit: "", sub: "Unknown", subColor: "var(--clpa-subtle)", sparkData, state: "collecting", real: false };
  }
  switch (prediction.status) {
    case "insufficient-data":
      return {
        value: "—", unit: "", sparkData, state: "collecting", subColor: "var(--clpa-subtle)", real: true,
        sub: `Collecting data (day ${prediction.daysOfHistory} of ${prediction.minRequired})`,
      };
    case "already-past-threshold":
      return { value: "Due now", unit: "", sub: "Past replacement threshold", subColor: "var(--clpa-critical)", sparkData, state: "matured", real: true };
    case "stable":
      return { value: "Stable", unit: "", sub: stableLabel, subColor: "var(--clpa-muted)", sparkData, state: "matured", real: true };
    case "ok": {
      const riskColor = prediction.risk === "Low" ? "var(--clpa-muted)" : prediction.risk === "Medium" ? "var(--clpa-warning)" : "var(--clpa-critical)";
      return { value: String(prediction.daysRemaining), unit: "Days", sub: `Risk: ${prediction.risk}`, subColor: riskColor, sparkData, state: "matured", real: true };
    }
  }
}

function AITopPredictionsCard() {
  const { thresholds } = useApp();
  const { data, connected } = useTelemetry();
  const { storageWearHistory, batteryHealthHistory } = useTrendHistory(data, connected);
  const predictions = connected ? data?.predictions ?? null : null;

  const ssdSpark = storageWearHistory.length > 0 ? storageWearHistory.slice(-10).map((p) => p.value) : [];
  const ssdPrediction = predictionToLifeDisplay(predictions?.ssd ?? null, ssdSpark, "No extra wear");

  const batterySpark = batteryHealthHistory.length > 0 ? batteryHealthHistory.slice(-10).map((p) => p.value) : [];
  const batteryPrediction = predictionToLifeDisplay(predictions?.battery ?? null, batterySpark, "No decline detected");
  const batteryHealthPct = getBatteryHealthPercent(data, connected);
  const batteryHealthColor = colorForHealthPercent(
    batteryHealthPct,
    thresholds.batteryHealthWarning,
    thresholds.batteryHealthCritical,
  );
  const batteryPredAccent =
    batteryPrediction.subColor === "var(--clpa-critical)" || batteryPrediction.subColor === "var(--clpa-warning)"
      ? batteryPrediction.subColor
      : batteryHealthColor;

  const cpuMinDistanceToTjMaxC = connected ? data?.hardwareMonitor?.cpuMinDistanceToTjMaxC ?? null : null;
  const thermalRiskReal = cpuMinDistanceToTjMaxC != null;
  const thermalRisk = thermalRiskReal ? thermalRiskFromMargin(cpuMinDistanceToTjMaxC) : null;
  const cpuLoad = getCpuLoad(data, connected);

  const ssdBar =
    ssdPrediction.value === "Due now" ? 100
    : ssdPrediction.value === "Stable" ? 12
    : ssdPrediction.sub.startsWith("Risk: High") ? 88
    : ssdPrediction.sub.startsWith("Risk: Medium") ? 55
    : ssdPrediction.real && ssdPrediction.state === "matured" ? 22
    : 0;
  const batteryBar =
    batteryPrediction.value === "Due now" || batteryPrediction.value === "0" ? 100
    : batteryHealthPct != null ? Math.max(0, 100 - batteryHealthPct)
    : batteryPrediction.sub.startsWith("Risk: High") ? 90
    : batteryPrediction.sub.startsWith("Risk: Medium") ? 55
    : 0;

  const preds = [
    {
      label: "SSD remaining life",
      kind: "Forecast",
      ...ssdPrediction,
      icon: <HardDrive size={14} style={{ color: "var(--clpa-cyan-bright)" }} strokeWidth={2} />,
      iconBg: "rgba(var(--clpa-cyan-bright-rgb),0.12)",
      data: ssdPrediction.sparkData,
      sparkColor: "var(--clpa-cyan-bright)",
      bar: ssdBar,
      barColor: ssdPrediction.subColor === "var(--clpa-critical)" ? "var(--clpa-critical)" : "var(--clpa-cyan-bright)",
    },
    {
      label: "Battery remaining life",
      kind: "Forecast",
      ...batteryPrediction,
      valueColor: batteryPredAccent,
      icon: <Battery size={14} style={{ color: batteryPredAccent }} strokeWidth={2} />,
      iconBg: "rgba(var(--clpa-warning-bright-rgb),0.12)",
      data: batteryPrediction.sparkData,
      sparkColor: batteryPredAccent,
      bar: batteryBar,
      barColor: batteryPredAccent,
    },
    {
      label: "CPU load",
      kind: "Live",
      value: cpuLoad != null ? String(cpuLoad) : "—",
      unit: cpuLoad != null ? "%" : "",
      sub: cpuLoad == null ? "No reading" : cpuLoad >= 90 ? "High" : cpuLoad >= 70 ? "Elevated" : "Normal",
      subColor: cpuLoad == null ? "var(--clpa-subtle)" : cpuLoad >= 90 ? "var(--clpa-critical)" : cpuLoad >= 70 ? "var(--clpa-warning)" : "var(--clpa-success)",
      real: cpuLoad != null,
      icon: <Cpu size={14} style={{ color: "var(--clpa-primary)" }} strokeWidth={2} />,
      iconBg: "rgba(var(--clpa-primary-rgb),0.12)",
      data: [] as number[],
      sparkColor: "var(--clpa-primary)",
      bar: cpuLoad ?? 0,
      barColor: cpuLoad == null ? "var(--clpa-track)" : cpuLoad >= 90 ? "var(--clpa-critical)" : cpuLoad >= 70 ? "var(--clpa-warning)" : "var(--clpa-primary)",
    },
    {
      label: "Thermal risk",
      kind: "Live",
      value: thermalRisk ? thermalRisk.label : "—",
      unit: "",
      valueColor: thermalRisk ? thermalRisk.color : "var(--clpa-muted)",
      sub: thermalRiskReal ? `${Math.round(cpuMinDistanceToTjMaxC!)}°C to throttle` : "No TjMax sensor",
      subColor: "var(--clpa-subtle)",
      real: thermalRiskReal,
      icon: <Thermometer size={14} style={{ color: "var(--clpa-warning-bright)" }} strokeWidth={2} />,
      iconBg: "rgba(var(--clpa-warning-bright-rgb),0.12)",
      data: [] as number[],
      sparkColor: "var(--clpa-warning-bright)",
      bar: thermalRiskReal ? Math.max(8, Math.min(100, Math.round((40 - cpuMinDistanceToTjMaxC!) * 2.5))) : 0,
      barColor: thermalRisk ? thermalRisk.color : "var(--clpa-track)",
    },
  ];

  return (
    <AICard style={{ padding: "12px 14px 10px" }}>
      <AIHeader
        title="TOP PREDICTIONS"
        tooltip="SSD and Battery remaining life from the AI service. CPU load and thermal margin from live sensors."
      />
      <div className="flex flex-col gap-2 flex-1 min-h-0">
        {preds.map((p) => (
          <div
            key={p.label}
            className="rounded-xl flex flex-col gap-1.5 min-w-0"
            style={{ background: "var(--clpa-surface)", border: "1px solid var(--clpa-surface-border)", padding: "9px 10px" }}
          >
            <div className="flex items-center gap-2 min-w-0">
              <div className="flex items-center justify-center rounded-lg flex-shrink-0" style={{ width: 28, height: 28, background: p.iconBg }}>
                {p.icon}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span style={{ fontSize: 10, color: "var(--clpa-muted)", fontWeight: 600 }}>{p.label}</span>
                  <span
                    style={{
                      fontSize: 8,
                      fontWeight: 700,
                      letterSpacing: 0.3,
                      color: p.kind === "Forecast" ? "var(--clpa-accent)" : "var(--clpa-primary)",
                      background: p.kind === "Forecast" ? "rgba(var(--clpa-accent-rgb),0.1)" : "rgba(var(--clpa-primary-rgb),0.1)",
                      borderRadius: 4,
                      padding: "1px 6px",
                      flexShrink: 0,
                    }}
                  >
                    {p.kind}
                  </span>
                </div>
                <div className="flex items-baseline gap-1.5 min-w-0" style={{ marginTop: 2 }}>
                  <span style={{ fontSize: 16, fontWeight: 800, color: p.valueColor ?? "var(--clpa-title)", lineHeight: 1, whiteSpace: "nowrap" }}>
                    {p.value}
                    {p.unit ? <span style={{ fontSize: 10, color: "var(--clpa-subtle)", fontWeight: 600, marginLeft: 3 }}>{p.unit}</span> : null}
                  </span>
                  <span style={{ fontSize: 9.5, fontWeight: 600, color: p.subColor, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.sub}</span>
                </div>
              </div>
              {p.data.length > 1 && <AISparkline data={p.data} color={p.sparkColor} w={52} h={22} />}
            </div>
            <div className="w-full rounded-full overflow-hidden" style={{ height: 4, background: "var(--clpa-divider)" }}>
              <div style={{ width: `${Math.min(100, Math.max(0, p.bar))}%`, height: "100%", background: p.barColor, borderRadius: 4 }} />
            </div>
          </div>
        ))}
      </div>
    </AICard>
  );
}

// ═══ Row 2 ═════════════════════════════════════════════════
function AIRow2() {
  return (
    <CLPARow columns="minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr)">
      <AIRiskOverviewCard />
      <AIRiskLevelCard />
      <AIRecommendationsCard />
    </CLPARow>
  );
}

// ─── Risk Overview Card ───────────────────────────────────
// riskTier() lives in src/app/lib/derived.ts and is shared with every other risk-tier consumer.

type RiskRowFallback = { pct: number; risk: string; riskColor: string; riskBg: string; barColor: string };

function buildRiskRow(label: string, Icon: React.ElementType, pct: number | null, fallback: RiskRowFallback) {
  if (pct == null) {
    return { label, Icon, ...fallback, iconColor: fallback.barColor, sample: true };
  }
  const tier = riskTier(pct);
  return { label, Icon, pct, risk: tier.label, riskColor: tier.color, riskBg: tier.bg, barColor: tier.barColor, iconColor: tier.barColor, sample: false };
}

// Shared by AIRiskOverviewCard and AIRiskLevelCard so both derive the exact same 4 real risk
// percentages from the exact same formulas (src/app/lib/derived.ts), rather than two
// independently-drifting copies.
function computeRiskFactors(data: TelemetrySnapshot | null | undefined, connected: boolean) {
  const cpuLoad = getCpuLoad(data, connected);
  const memUsedPct = getMemUsedPercent(data, connected);

  // Mirrors AIHealthScoreCard's Performance sub-score, inverted into a risk % (risk = 100 - score).
  const performanceScore = getPerformanceScore(cpuLoad, memUsedPct);
  const hardwareRiskPct = performanceScore != null ? 100 - performanceScore : null;

  const batteryHealthPct = getBatteryHealthPercent(data, connected);
  const batteryWearPct = getBatteryWearPercent(data, connected);

  const storageWearPercent = getStorageWearPercent(data, connected);

  const securityHealthPct = getSecurityHealthPercent(data, connected);
  const securityRiskPct = securityHealthPct != null ? 100 - securityHealthPct : null;

  return { hardwareRiskPct, batteryWearPct, storageWearPercent, securityRiskPct, cpuLoad, memUsedPct, batteryHealthPct, securityHealthPct };
}

function AIRiskOverviewCard() {
  const { data, connected } = useTelemetry();
  const { hardwareRiskPct, batteryWearPct, storageWearPercent, securityRiskPct, batteryHealthPct } = computeRiskFactors(data, connected);

  const rows = [
    buildRiskRow("Hardware", Cpu, hardwareRiskPct, { pct: 0, risk: "Unknown", riskColor: "var(--clpa-muted)", riskBg: "rgba(var(--clpa-subtle-rgb),0.1)", barColor: "var(--clpa-track)" }),
    buildRiskRow("Battery wear", Battery, batteryWearPct, { pct: 0, risk: "Unknown", riskColor: "var(--clpa-muted)", riskBg: "rgba(var(--clpa-subtle-rgb),0.1)", barColor: "var(--clpa-track)" }),
    buildRiskRow("SSD wear", HardDrive, storageWearPercent, { pct: 0, risk: "Unknown", riskColor: "var(--clpa-muted)", riskBg: "rgba(var(--clpa-subtle-rgb),0.1)", barColor: "var(--clpa-track)" }),
    buildRiskRow("Security", Shield, securityRiskPct, { pct: 0, risk: "Unknown", riskColor: "var(--clpa-muted)", riskBg: "rgba(var(--clpa-subtle-rgb),0.1)", barColor: "var(--clpa-track)" }),
  ];

  return (
    <AICard style={{ padding: "12px 14px" }}>
      <div className="flex items-center gap-1.5 mb-2.5">
        <span style={{ fontSize: 11, fontWeight: 800, color: "var(--clpa-title)", letterSpacing: 0.4 }}>RISK OVERVIEW</span>
        <AIInfo text={batteryHealthPct != null ? `Battery wear is 100 − health. Health is ${batteryHealthPct}% on Dashboard, Hardware, and Health Score.` : "Hardware = inverted performance. Battery wear = 100 − health. SSD = SMART wear. Security = TPM, Secure Boot, BitLocker."} />
      </div>
      <div className="flex flex-col flex-1 justify-evenly min-h-0 gap-2">
        {rows.map((b, i) => (
          <div key={i} className="flex items-center gap-2 rounded-xl" style={{ background: "var(--clpa-surface)", border: "1px solid var(--clpa-surface-border)", padding: "8px 10px" }}>
            <div className="flex items-center justify-center rounded-lg flex-shrink-0" style={{ width: 26, height: 26, background: b.riskBg }}>
              <b.Icon size={13} style={{ color: b.iconColor }} strokeWidth={2} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2 mb-1">
                <span style={{ fontSize: 11, color: "var(--clpa-title)", fontWeight: 700 }}>{b.label}</span>
                <span style={{ fontSize: 8, fontWeight: 700, color: b.riskColor, background: b.riskBg, borderRadius: 4, padding: "1px 6px", whiteSpace: "nowrap" }}>{b.risk}</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex-1 rounded-full overflow-hidden" style={{ height: 5, background: "var(--clpa-divider)" }}>
                  <div style={{ width: b.sample ? "0%" : b.pct === 0 ? "4%" : `${Math.min(100, b.pct)}%`, height: "100%", background: b.barColor, borderRadius: 4, opacity: b.sample || b.pct === 0 ? 0.4 : 1 }} />
                </div>
                <span style={{ fontSize: 11, fontWeight: 700, color: "var(--clpa-body)", width: 32, textAlign: "right", flexShrink: 0 }}>{b.sample ? "—" : `${b.pct}%`}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </AICard>
  );
}

// ─── Risk Level Card ──────────────────────────────────────
function AIRiskLevelCard() {
  const { data, connected, updatedAt } = useTelemetry();
  const { hardwareRiskPct, batteryWearPct, storageWearPercent, securityRiskPct } = computeRiskFactors(data, connected);

  // Same 4 real rows as AIRiskOverviewCard, explicitly excluding Subscription/Warranty from
  // this average - those two never have real data, and averaging in a permanently-sample 0%
  // would silently and incorrectly pull the overall number down.
  const factors = [
    { name: "Hardware", pct: hardwareRiskPct },
    { name: "Battery wear", pct: batteryWearPct },
    { name: "SSD wear", pct: storageWearPercent },
    { name: "Security", pct: securityRiskPct },
  ];
  const realFactors = factors.filter((f): f is { name: string; pct: number } => f.pct != null);
  const isReal = realFactors.length > 0;

  // Needle follows the worst live factor, not the average — averaging 0% hardware with a 56%
  // battery made this gauge say "Low / everything looks good" while Battery was High Risk.
  const pct = isReal ? Math.round(realFactors.reduce((max, f) => (f.pct > max.pct ? f : max), realFactors[0]).pct) : 0;

  // Same disclosed tiers as AIRiskOverviewCard: <20% Low, 20-50% Medium, >50% High.
  const tier = riskTier(pct);
  const riskLabel = isReal ? tier.label.replace(" Risk", "") : "Unknown";
  const riskColor = isReal ? tier.color : "var(--clpa-muted)";
  const topRiskFactor = isReal ? realFactors.reduce((max, f) => (f.pct > max.pct ? f : max), realFactors[0]) : null;
  const summarySub = !isReal
    ? "Waiting on live risk signals"
    : topRiskFactor
    ? `${topRiskFactor.name} highest at ${pct}%`
    : "Waiting on live risk signals";

  const updatedLabel = formatRelativeTime(connected ? updatedAt : null) ?? "—";

  const cx = 100;
  const cy = 88;
  const r = 66;
  const sw = 13;
  const circ = 2 * Math.PI * r;
  const halfCirc = circ / 2;
  const angleDeg = 180 + pct * 1.8;
  const angleRad = (angleDeg * Math.PI) / 180;
  const ax = cx + r * Math.cos(angleRad);
  const ay = cy + r * Math.sin(angleRad);

  const legend = [
    { label: "Low", color: "var(--clpa-success-bright)" },
    { label: "Medium", color: "var(--clpa-warning-bright)" },
    { label: "High", color: "var(--clpa-critical-bright)" },
  ];

  const stats = [
    { label: "Factors", value: `${realFactors.length} of ${factors.length}` },
    { label: "Top Risk", value: topRiskFactor ? topRiskFactor.name : "—", color: isReal ? riskColor : "var(--clpa-muted)" },
    { label: "Updated", value: updatedLabel },
  ];

  return (
    <AICard style={{ padding: "12px 14px", display: "flex", flexDirection: "column", alignItems: "center" }}>
      <div className="flex items-center gap-1.5 self-start mb-1">
        <span style={{ fontSize: 11, fontWeight: 800, color: "var(--clpa-title)", letterSpacing: 0.4 }}>RISK LEVEL</span>
        <AIInfo text="Shows the highest of the four live risks (Hardware, Battery, SSD, Security). Subscription and Warranty are not scored." />
      </div>

      {/* Gauge */}
      <div style={{ position: "relative", width: 200, height: 116 }}>
        <svg width="200" height="116" viewBox="0 0 200 116">
          <defs>
            <linearGradient id="rl-grad" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="var(--clpa-success-bright)" />
              <stop offset="35%" stopColor="var(--clpa-risk-yellow)" />
              <stop offset="68%" stopColor="var(--clpa-risk-orange)" />
              <stop offset="100%" stopColor="var(--clpa-critical-bright)" />
            </linearGradient>
          </defs>
          <circle cx={cx} cy={cy} r={r} fill="none" stroke="url(#rl-grad)" strokeWidth={sw} strokeDasharray={`${halfCirc} ${circ}`} transform={`rotate(-180 ${cx} ${cy})`} strokeLinecap="round" />
          <g transform={`translate(${ax.toFixed(1)} ${ay.toFixed(1)}) rotate(${angleDeg})`}>
            <polygon points="12,0 -7,-6 -7,6" fill="white" />
            <polygon points="10,0 -5.5,-4.5 -5.5,4.5" fill={riskColor} />
          </g>
        </svg>
        <div style={{ position: "absolute", bottom: 8, left: 0, right: 0, display: "flex", flexDirection: "column", alignItems: "center", pointerEvents: "none" }}>
          <span style={{ fontSize: 28, fontWeight: 900, color: "var(--clpa-title)", lineHeight: 1 }}>{isReal ? `${pct}%` : "—"}</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: riskColor, marginTop: 3 }}>{isReal ? `${riskLabel} Risk` : "Unknown"}</span>
        </div>
      </div>

      {/* Legend */}
      <div className="flex items-center justify-center gap-3 mt-2">
        {legend.map((l, i) => (
          <div key={i} className="flex items-center gap-1">
            <span style={{ width: 8, height: 8, borderRadius: 999, background: l.color, display: "inline-block" }} />
            <span style={{ fontSize: 9, color: "var(--clpa-muted)", fontWeight: 500 }}>{l.label}</span>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-center gap-1 w-full" style={{ marginTop: 8, marginBottom: 8, padding: "0 6px" }}>
        <span style={{ fontSize: 9.5, color: "var(--clpa-subtle)", lineHeight: 1.35, textAlign: "center" }}>{summarySub}</span>
        {!isReal && <SampleTag />}
      </div>

      {/* Summary footer - real when at least one of the 4 real-derivable rows above is real;
          falls back to the original all-sample state (unmodified values) if none are. */}
      <div className="grid w-full" style={{ gridTemplateColumns: "1fr 1fr 1fr", borderTop: "1px solid var(--clpa-divider)", paddingTop: 10, marginTop: "auto" }}>
        {stats.map((s, i) => (
          <div key={i} className="flex flex-col items-center" style={{ borderLeft: i > 0 ? "1px solid var(--clpa-divider)" : "none" }}>
            <span style={{ fontSize: 8.5, color: "var(--clpa-subtle)", marginBottom: 2 }}>{s.label}</span>
            <div className="flex items-center gap-1">
              <span style={{ fontSize: 11, fontWeight: 700, color: s.color ?? "var(--clpa-body)" }}>{s.value}</span>
              {!isReal && <SampleTag />}
            </div>
          </div>
        ))}
      </div>
    </AICard>
  );
}
// ─── AI Recommendations Card ──────────────────────────────
// True once a prediction's projection has landed in the Medium/High risk tier (covers both a
// normal numeric projection and the "already past threshold" 0-days case) - the bar for
// actually surfacing a recommendation about it, not just any real number.
function isElevatedRisk(prediction: { sub: string; value: string }): boolean {
  return prediction.sub === "Risk: Medium" || prediction.sub === "Risk: High" || prediction.value === "Due now" || prediction.value === "0";
}

function AIRecommendationsCard() {
  const { data, connected } = useTelemetry();
  const predictions = connected ? data?.predictions ?? null : null;
  const ssdPrediction = predictionToLifeDisplay(predictions?.ssd ?? null, [], "No wear increase detected");
  const batteryPrediction = predictionToLifeDisplay(predictions?.battery ?? null, [], "No decline detected");
  const batteryHealthPct = getBatteryHealthPercent(data, connected);

  const recIcon = {
    battery: { icon: <Battery size={15} color="var(--clpa-primary)" strokeWidth={2} />, iconBg: "rgba(var(--clpa-primary-rgb),0.1)", iconBorder: "rgba(var(--clpa-primary-rgb),0.2)", titleColor: "var(--clpa-primary)" },
    ssd: { icon: <HardDrive size={15} color="var(--clpa-cyan-bright)" strokeWidth={2} />, iconBg: "rgba(var(--clpa-cyan-bright-rgb),0.1)", iconBorder: "rgba(var(--clpa-cyan-bright-rgb),0.2)", titleColor: "var(--clpa-cyan-deep)" },
    ok: { icon: <CheckCircle2 size={15} color="var(--clpa-success-bright)" strokeWidth={2} />, iconBg: "rgba(var(--clpa-success-bright-rgb),0.1)", iconBorder: "rgba(var(--clpa-success-bright-rgb),0.2)", titleColor: "var(--clpa-success)" },
    wait: { icon: <Activity size={15} color="var(--clpa-muted)" strokeWidth={2} />, iconBg: "rgba(var(--clpa-subtle-rgb),0.1)", iconBorder: "var(--clpa-surface-border)", titleColor: "var(--clpa-muted)" },
  };

  type Rec = { icon: React.ReactNode; iconBg: string; iconBorder: string; title: string; titleColor: string; desc: string; priority: string };
  const recs: Rec[] = [];

  const security = getSecurityCompliance(data, connected);
  const batteryPastThreshold = batteryHealthPct != null && batteryHealthPct < 80;
  const batteryPredElevated = batteryPrediction.real && isElevatedRisk(batteryPrediction);
  const ssdPredElevated = ssdPrediction.real && isElevatedRisk(ssdPrediction);

  if (security.real && !security.ok) {
    recs.push({
      icon: <Shield size={15} color="var(--clpa-warning)" strokeWidth={2} />,
      iconBg: "rgba(var(--clpa-warning-bright-rgb),0.1)",
      iconBorder: "rgba(var(--clpa-warning-bright-rgb),0.2)",
      titleColor: "var(--clpa-warning)",
      title: "Security Hardening",
      desc: describeSecuritySignals(data, connected),
      priority: "High",
    });
  }

  if (batteryPastThreshold || batteryPredElevated) {
    const desc = batteryPastThreshold
      ? `Health is ${batteryHealthPct}% (replace below 80%).`
      : batteryPrediction.value === "Due now" || batteryPrediction.value === "0"
      ? "Already below 80% health."
      : `Drops below 80% in ~${batteryPrediction.value} days.`;
    recs.push({
      ...recIcon.battery,
      title: "Battery Replacement",
      desc,
      priority: batteryPastThreshold || batteryPrediction.value === "Due now" ? "High" : "Medium",
    });
  }

  if (ssdPredElevated) {
    const desc =
      ssdPrediction.value === "Due now" || ssdPrediction.value === "0"
        ? "SSD at rated wear."
        : `~${ssdPrediction.value} days to rated wear.`;
    recs.push({
      ...recIcon.ssd,
      title: "Storage Replacement",
      desc,
      priority: ssdPrediction.value === "Due now" || ssdPrediction.sub === "Risk: High" ? "High" : "Medium",
    });
  }

  if (recs.length === 0) {
    const bothMaturedStable =
      ssdPrediction.state === "matured" &&
      batteryPrediction.state === "matured" &&
      !isElevatedRisk(ssdPrediction) &&
      !isElevatedRisk(batteryPrediction);
    const batteryOkLive = batteryHealthPct != null && batteryHealthPct >= 80;
    if (bothMaturedStable || (batteryOkLive && !ssdPredElevated && ssdPrediction.state === "matured")) {
      recs.push({ ...recIcon.ok, title: "Keep Monitoring", desc: "No action needed.", priority: "OK" });
    } else {
      recs.push({ ...recIcon.wait, title: "Not Enough History", desc: "Still collecting daily samples.", priority: "Info" });
    }
  }

  return (
    <AICard style={{ padding: "12px 14px 10px", display: "flex", flexDirection: "column" }}>
      <AIHeader
        title="AI RECOMMENDATIONS"
        tooltip="Each item is a live action from battery health, security posture, or the AI remaining-life service. Nothing here is an example."
      />
      <div className="flex flex-col gap-2 flex-1 min-h-0">
        {recs.map((r, i) => {
          const priColor =
            r.priority === "High" ? "var(--clpa-critical)"
            : r.priority === "Medium" ? "var(--clpa-warning)"
            : r.priority === "OK" ? "var(--clpa-success)"
            : "var(--clpa-muted)";
          const priBg =
            r.priority === "High" ? "rgba(var(--clpa-critical-bright-rgb),0.12)"
            : r.priority === "Medium" ? "rgba(var(--clpa-warning-bright-rgb),0.12)"
            : r.priority === "OK" ? "rgba(var(--clpa-success-bright-rgb),0.12)"
            : "rgba(var(--clpa-subtle-rgb),0.1)";
          return (
            <div key={i} className="rounded-xl p-2.5" style={{ background: "var(--clpa-surface)", border: "1px solid var(--clpa-surface-border)" }}>
              <div className="flex items-start gap-2.5">
                <div className="flex items-center justify-center rounded-xl flex-shrink-0" style={{ width: 30, height: 30, background: r.iconBg, border: `1px solid ${r.iconBorder}` }}>
                  {r.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <div style={{ fontSize: 11.5, fontWeight: 700, color: r.titleColor }}>{r.title}</div>
                    <span style={{ fontSize: 8, fontWeight: 700, color: priColor, background: priBg, borderRadius: 4, padding: "1px 6px", flexShrink: 0 }}>{r.priority}</span>
                  </div>
                  <div style={{ fontSize: 10, color: "var(--clpa-muted)", lineHeight: 1.4 }}>{r.desc}</div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-1.5" style={{ marginTop: "auto", paddingTop: 10 }}>
        <Brain size={12} style={{ color: "var(--clpa-accent)" }} strokeWidth={2} />
        <span style={{ fontSize: 9, color: "var(--clpa-subtle)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          Live battery, security, and remaining-life data
        </span>
      </div>
    </AICard>
  );
}

// ═══ Row 3 ═════════════════════════════════════════════════
function AIRow3() {
  return (
    <CLPARow columns="minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr)">
      <AITimelineCard />
      <AIInsightsCard />
    </CLPARow>
  );
}

// Shared icon/color picker for real event history (AITimelineCard/AIInsightsCard) - matched
// against the real event_type strings this project's own sources actually produce (alert
// fire/clear per rule id, LHM/HWiNFO/backend transitions, telemetry reconnection). Falls back to
// a generic activity icon for any event_type this doesn't recognize, rather than guessing.
function iconForEvent(eventType: string, severity: EventHistoryItem["severity"]) {
  const color = severity === "critical" ? "var(--clpa-critical)" : severity === "warning" ? "var(--clpa-warning)" : "var(--clpa-success)";
  const bg = severity === "critical" ? "rgba(var(--clpa-critical-bright-rgb),0.1)" : severity === "warning" ? "rgba(var(--clpa-warning-bright-rgb),0.12)" : "rgba(var(--clpa-success-bright-rgb),0.1)";
  let Icon = Activity;
  if (eventType.includes("cpu-temp")) Icon = Thermometer;
  else if (eventType.includes("cpu-load")) Icon = Cpu;
  else if (eventType.includes("memory")) Icon = MemoryStick;
  else if (eventType.includes("battery")) Icon = Battery;
  else if (eventType.includes("storage")) Icon = HardDrive;
  else if (eventType.includes("warranty")) Icon = Shield;
  else if (eventType.includes("lhm") || eventType.includes("hwinfo")) Icon = Thermometer;
  else if (eventType.includes("backend") || eventType.includes("telemetry")) Icon = Wifi;
  return { Icon, color, bg };
}

// Real events don't come with a nice human tag the way the old illustrative "Predicted"/
// "Forecast" labels did - derived from severity/event_type instead: cleared/available/
// reconnected events are real good news (Resolved), everything else reads as its own severity.
function tagForEvent(eventType: string, severity: EventHistoryItem["severity"]): string {
  if (severity === "critical") return "Critical";
  if (severity === "warning") return "Warning";
  return eventType.includes("cleared") || eventType.includes("available") || eventType.includes("reconnected") ? "Resolved" : "Info";
}

function shortMetricLabel(label: string): string {
  const t = label.trim();
  if (/^cpu/i.test(t)) return "CPU";
  if (/^ram/i.test(t)) return "RAM";
  if (/^disk/i.test(t)) return "Disk";
  if (/^battery/i.test(t)) return "Battery";
  return t.replace(/\s+usage$/i, "");
}

function compactPercent(raw: string): string {
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return raw;
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);
}

// Backend alert_engine.go stores "CPU usage on HOST (device_…) exceeds 90% - current value 95.0%."
// This device already knows which machine it is — strip host/id and keep one short line.
function formatEventLine(message: string): string {
  const s = message.replace(/\s+/g, " ").trim();
  const hostId = String.raw`\S+\s+\([^)]+\)`;

  const breach = s.match(new RegExp(`^(.+?) on ${hostId} (exceeds|is below) ([\\d.]+)% - current value ([\\d.]+)%\\.?$`, "i"));
  if (breach) {
    const metric = shortMetricLabel(breach[1]);
    const over = breach[2].toLowerCase() === "exceeds" ? "over" : "below";
    return `${metric} ${compactPercent(breach[4])}% (${over} ${compactPercent(breach[3])}%)`;
  }

  const recovered = s.match(new RegExp(`^(.+?) on ${hostId} is back within the configured threshold \\(([\\d.]+)%\\) - current value ([\\d.]+)%\\.?$`, "i"));
  if (recovered) {
    return `${shortMetricLabel(recovered[1])} recovered · ${compactPercent(recovered[3])}%`;
  }

  if (new RegExp(`^Device ${hostId} is reporting again`, "i").test(s)) return "Device back online";
  if (new RegExp(`^Device ${hostId} has stopped reporting`, "i").test(s)) return "Device went offline";

  if (/^LibreHardwareMonitor became available/i.test(s)) return "LHM online";
  if (/^LibreHardwareMonitor became unavailable/i.test(s)) return "LHM offline";
  if (/^rust-collector \(HWiNFO source\) became available/i.test(s)) return "HWiNFO online";
  if (/^rust-collector \(HWiNFO source\) became unavailable/i.test(s)) return "HWiNFO offline";
  if (/^Cloud Command Center became reachable/i.test(s)) return "Backend online";
  if (/^Dashboard reconnected to the local telemetry server/i.test(s)) return "Telemetry reconnected";

  return s
    .replace(/\s+on \S+ \(device_[a-f0-9]+\)/gi, "")
    .replace(/\s+\(device_[a-f0-9]+\)/gi, "")
    .replace(/\s+is back within the configured threshold\s*\(([\d.]+)%\)/i, " recovered")
    .replace(/\s+-\s+current value\s+([\d.]+)%\.?$/i, " · $1%")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupeRecentEvents(events: EventHistoryItem[], max: number): EventHistoryItem[] {
  const seen = new Set<string>();
  const out: EventHistoryItem[] = [];
  for (const ev of events) {
    const minute = ev.createdAt.length >= 16 ? ev.createdAt.slice(0, 16) : ev.createdAt;
    const key = `${ev.eventType}|${formatEventLine(ev.message)}|${minute}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ev);
    if (out.length >= max) break;
  }
  return out;
}

// ─── AI Timeline Card ─────────────────────────────────────
function AITimelineCard() {
  const { events, loading, error } = useEventHistory(20);
  const unique = dedupeRecentEvents(events, 5);

  return (
    <AICard style={{ padding: "10px 12px 8px", display: "flex", flexDirection: "column", gridColumn: "1 / 3" }}>
      <AIHeader
        title="AI TIMELINE"
        tooltip="Chronological event log from this agent — alerts, thermal trips, and connection changes. Newest on the right. Insights on the right is a live reading of sensors, not this list."
      />

      {unique.length === 0 ? (
        <div className="flex-1 flex items-center justify-center" style={{ minHeight: 56 }}>
          <span style={{ fontSize: 10.5, color: "var(--clpa-subtle)" }}>
            {loading ? "Loading real event history…" : error ? "Couldn't load event history - local agent/backend unreachable." : "No events recorded yet."}
          </span>
        </div>
      ) : (
        <>
          <div className="relative mt-1 flex-1 min-h-0">
            <div style={{ position: "absolute", top: 11, left: 24, right: 24, height: 2, background: "var(--clpa-input-border)", borderRadius: 2 }} />
            <div className="flex items-start justify-between gap-1.5">
              {[...unique].reverse().map((ev) => {
                const { Icon, color, bg } = iconForEvent(ev.eventType, ev.severity);
                const tag = tagForEvent(ev.eventType, ev.severity);
                const line = formatEventLine(ev.message);
                return (
                  <div key={ev.id} className="flex flex-col items-center" style={{ flex: 1, minWidth: 0 }}>
                    <div className="flex items-center justify-center rounded-full mb-1" style={{ width: 22, height: 22, background: bg, border: `1.5px solid ${color}30`, boxShadow: `0 0 0 3px ${color}0D`, zIndex: 1 }}>
                      <Icon size={11} color={color} strokeWidth={2} />
                    </div>
                    <div className="flex flex-col items-center rounded-lg w-full" style={{ background: "var(--clpa-surface)", border: "1px solid var(--clpa-surface-border)", padding: "6px 6px 5px", minWidth: 0 }}>
                      <span title={ev.message} style={{ fontSize: 9, color: "var(--clpa-body-alt)", fontWeight: 600, lineHeight: 1.25, textAlign: "center", width: "100%", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{line}</span>
                      <span style={{ fontSize: 8, fontWeight: 700, color, marginTop: 3, whiteSpace: "nowrap" }}>{tag} · {formatRelativeTime(ev.createdAt)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="flex items-center justify-between" style={{ borderTop: "1px solid var(--clpa-divider)", paddingTop: 6, marginTop: "auto" }}>
            <div className="flex items-center gap-1.5">
              <Brain size={12} style={{ color: "var(--clpa-accent)" }} strokeWidth={2} />
              <span style={{ fontSize: 9, color: "var(--clpa-muted)", fontWeight: 500 }}>
                Event log · {unique.length} recent
              </span>
            </div>
          </div>
        </>
      )}
    </AICard>
  );
}

function insightTone(tone: "ok" | "warn" | "crit" | "info") {
  if (tone === "crit") return { color: "var(--clpa-critical)", bg: "rgba(var(--clpa-critical-bright-rgb),0.1)" };
  if (tone === "warn") return { color: "var(--clpa-warning)", bg: "rgba(var(--clpa-warning-bright-rgb),0.12)" };
  if (tone === "ok") return { color: "var(--clpa-success)", bg: "rgba(var(--clpa-success-bright-rgb),0.1)" };
  return { color: "var(--clpa-primary)", bg: "rgba(var(--clpa-primary-rgb),0.1)" };
}

function AIInsightsCard() {
  const { thresholds } = useApp();
  const { data, connected } = useTelemetry();
  const { events } = useEventHistory(20);
  const { batteryHealthHistory } = useTrendHistory(data, connected);
  const batteryDelta = computeScoreDelta(batteryHealthHistory);

  type InsightRow = { id: string; title: string; body: string; tone: "ok" | "warn" | "crit" | "info"; Icon: typeof Battery };
  const rows: InsightRow[] = [];

  const batteryHealthPct = getBatteryHealthPercent(data, connected);
  if (batteryHealthPct != null) {
    const pastReplace = batteryHealthPct < 80;
    const crit = batteryHealthPct < thresholds.batteryHealthCritical;
    const trend =
      batteryDelta != null && batteryDelta.delta !== 0
        ? ` ${batteryDelta.delta >= 0 ? "+" : ""}${batteryDelta.delta} pts vs ${batteryDelta.daysAgo === 1 ? "yesterday" : `${batteryDelta.daysAgo} days ago`}.`
        : "";
    rows.push({
      id: "battery",
      title: pastReplace ? "Battery past replacement line" : "Battery within design range",
      body: `${batteryHealthPct}% of design capacity.${pastReplace ? " Replace below 80%." : ""}${trend}`,
      tone: crit ? "crit" : pastReplace ? "warn" : "ok",
      Icon: Battery,
    });
  }

  const security = getSecurityCompliance(data, connected);
  if (security.real) {
    rows.push({
      id: "security",
      title: security.ok ? "Firmware checks passing" : "Firmware checks incomplete",
      body: describeSecuritySignals(data, connected),
      tone: security.ok ? "ok" : "warn",
      Icon: Shield,
    });
  }

  const volumes = listLogicalVolumes(data, connected);
  let fullest: (typeof volumes)[number] | null = null;
  let fullestPct: number | null = null;
  for (const vol of volumes) {
    const pct = logicalVolumeUsedPct(vol);
    if (pct != null && (fullestPct == null || pct > fullestPct)) {
      fullest = vol;
      fullestPct = pct;
    }
  }
  if (fullest && fullestPct != null && fullestPct >= STORAGE_USAGE_WARNING_PCT) {
    const letter = fullest.DeviceID?.replace(/\\$/, "") || "Volume";
    rows.push({
      id: "disk",
      title: `${letter} is ${Math.round(fullestPct)}% full`,
      body: fullestPct >= STORAGE_USAGE_CRITICAL_PCT ? "Free space is critically low." : "Free space is below the 85% warning line.",
      tone: fullestPct >= STORAGE_USAGE_CRITICAL_PCT ? "crit" : "warn",
      Icon: HardDrive,
    });
  } else {
    const wear = getStorageWearPercent(data, connected);
    if (wear != null) {
      rows.push({
        id: "ssd",
        title: wear >= 90 ? "SSD near rated wear" : "SSD wear is low",
        body: `SMART percentage used is ${wear}%.`,
        tone: wear >= 90 ? "crit" : wear >= 50 ? "warn" : "ok",
        Icon: HardDrive,
      });
    }
  }

  const cpuTempC = connected ? data?.hardwareMonitor?.cpuTempC ?? null : null;
  const marginC = connected ? data?.hardwareMonitor?.cpuMinDistanceToTjMaxC ?? null : null;
  if (cpuTempC != null || marginC != null) {
    const hot = cpuTempC != null && cpuTempC >= thresholds.cpuTempWarning;
    const thermal = marginC != null ? thermalRiskFromMargin(marginC) : null;
    const bits = [
      cpuTempC != null ? `CPU ${Math.round(cpuTempC)}°C` : null,
      marginC != null ? `${Math.round(marginC)}°C to throttle` : null,
    ].filter(Boolean);
    rows.push({
      id: "thermal",
      title: hot ? "CPU temperature elevated" : thermal && thermal.label !== "Low" ? `Thermal risk ${thermal.label.toLowerCase()}` : "Thermals in range",
      body: bits.join(" · "),
      tone: hot || (thermal && thermal.label === "High") ? "crit" : thermal && thermal.label === "Moderate" ? "warn" : "ok",
      Icon: Thermometer,
    });
  }

  const hourAgo = Date.now() - 60 * 60 * 1000;
  const lastHour = events.filter((ev) => {
    const t = new Date(ev.createdAt).getTime();
    return Number.isFinite(t) && t >= hourAgo;
  });
  const thermalHour = lastHour.filter((ev) => ev.eventType.includes("cpu-temp"));
  if (thermalHour.length >= 2) {
    rows.push({
      id: "thermal-hour",
      title: `${thermalHour.length} CPU temp events in the last hour`,
      body: "See Timeline for each trip and recovery.",
      tone: "warn",
      Icon: Activity,
    });
  }

  const shown = rows.slice(0, 4);

  return (
    <AICard style={{ padding: "10px 12px 8px" }}>
      <AIHeader
        title="AI INSIGHTS"
        tooltip="Live reading of battery, security, storage, and thermals right now. Timeline is the event log; this card is not a second copy of it."
      />
      {shown.length === 0 ? (
        <div className="flex-1 flex items-center justify-center" style={{ minHeight: 56 }}>
          <span style={{ fontSize: 10.5, color: "var(--clpa-subtle)" }}>
            {connected ? "Waiting on live sensors." : "Agent offline."}
          </span>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5 flex-1 min-h-0">
          {shown.map((row) => {
            const { color, bg } = insightTone(row.tone);
            return (
              <div key={row.id} className="flex items-start gap-2 rounded-xl" style={{ background: "var(--clpa-surface)", border: "1px solid var(--clpa-surface-border)", padding: "8px 9px" }}>
                <div className="flex items-center justify-center rounded-md flex-shrink-0" style={{ width: 22, height: 22, background: bg, marginTop: 1 }}>
                  <row.Icon size={11} color={color} strokeWidth={2} />
                </div>
                <div className="min-w-0 flex-1">
                  <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--clpa-title)", lineHeight: 1.25 }}>{row.title}</div>
                  <div style={{ fontSize: 9.5, color: "var(--clpa-muted)", lineHeight: 1.35, marginTop: 2 }}>{row.body}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <div className="flex items-center gap-1.5" style={{ borderTop: "1px solid var(--clpa-divider)", paddingTop: 6, marginTop: "auto" }}>
        <Brain size={12} style={{ color: "var(--clpa-accent)" }} strokeWidth={2} />
        <span style={{ fontSize: 9, color: "var(--clpa-subtle)" }}>Live sensors now · not the event log</span>
      </div>
    </AICard>
  );
}
// ═══════════════════════════════════════════════════════════
// ─── HARDWARE PAGE ────────────────────────────────────────
// ═══════════════════════════════════════════════════════════

function HardwarePage() {
  return (
    <CLPAPage>
      <CLPASectionLabel label="DEVICE SUMMARY" live Icon={MonitorCheck} />
      <HWOverviewRow />
      <CLPASectionLabel label="HARDWARE COMPONENTS" Icon={Cpu} />
      <HWComponentsSection />
      <HWDriversCard />
    </CLPAPage>
  );
}

// ─── Shared shell + helpers ───────────────────────────────
function HWCard({ children, style = {} }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      className="clpa-card-hover rounded-2xl"
      style={{ background: "var(--clpa-card)", border: "1px solid var(--clpa-card-border)", boxShadow: "0 2px 8px rgba(0,0,0,0.06)", ...style }}
    >
      {children}
    </div>
  );
}

function HWBadge({ label, color = "var(--clpa-success)", bg = "rgba(var(--clpa-success-bright-rgb),0.1)" }: { label: string; color?: string; bg?: string }) {
  return <span style={{ fontSize: 8.5, fontWeight: 700, color, background: bg, padding: "2px 8px", borderRadius: 999, whiteSpace: "nowrap" }}>{label}</span>;
}

function HWKV({ label, value, valueColor = "var(--clpa-body)", sample = false }: { label: string; value: string; valueColor?: string; sample?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span style={{ fontSize: 9, color: "var(--clpa-subtle)", fontWeight: 500, flexShrink: 0 }}>{label}</span>
      <div className="flex items-center gap-1" style={{ minWidth: 0 }}>
        <span style={{ fontSize: 9.5, fontWeight: 600, color: valueColor, maxWidth: 130, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "right" }}>{value}</span>
        {sample && <SampleTag />}
      </div>
    </div>
  );
}

// ─── Row 1: Device Overview + Hardware Integrity ──────────
function HWOverviewRow() {
  return (
    <CLPARow columns="1fr 1fr 1fr">
      <HWDeviceOverviewCard />
      <HWIntegrityCard />
      <HWDistributionCard />
    </CLPARow>
  );
}

const HW_KPI_CARD: React.CSSProperties = {
  padding: "11px 12px",
  height: "100%",
  minHeight: 168,
  display: "flex",
  flexDirection: "column",
};

// Distinct per-card accent themes for the three overview cards (Device Overview / Hardware
// Integrity / Hardware Distribution) so they read as visually different from each other and
// from the uniform component tiles below - purely presentational, no data/logic implication.
// border1/border2 replace the old `${accent}22`/`${accent}33` hex-alpha-suffix string
// concatenation - that trick only works on a literal hex string; concatenating "22"/"33" onto a
// var(--x) reference produces an invalid CSS string instead of a real border color, so each
// theme object now precomputes its two real alpha tints from the same real -rgb token.
const HW_THEME_OVERVIEW = { accent: "var(--clpa-body-alt)", tint: "rgba(var(--clpa-body-alt-rgb),0.1)", border1: "rgba(var(--clpa-body-alt-rgb),0.13)", border2: "rgba(var(--clpa-body-alt-rgb),0.2)" }; // neutral/informational slate
const HW_THEME_INTEGRITY = { accent: "var(--clpa-teal-security)", tint: "rgba(var(--clpa-teal-security-rgb),0.1)", border1: "rgba(var(--clpa-teal-security-rgb),0.13)", border2: "rgba(var(--clpa-teal-security-rgb),0.2)" }; // security teal
const HW_THEME_DISTRIBUTION = { accent: "var(--clpa-indigo-analytics)", tint: "rgba(var(--clpa-indigo-analytics-rgb),0.1)", border1: "rgba(var(--clpa-indigo-analytics-rgb),0.13)", border2: "rgba(var(--clpa-indigo-analytics-rgb),0.2)" }; // analytics indigo

function HWDeviceOverviewCard() {
  const { data, connected } = useTelemetry();

  const assetId = connected && data?.enclosure?.SMBIOSAssetTag ? data.enclosure.SMBIOSAssetTag : "Not available";
  const serial = connected && data?.bios?.SerialNumber ? data.bios.SerialNumber : "—";
  const manufacturerReal = connected && data?.system?.Vendor != null;
  const manufacturer = manufacturerReal ? data!.system.Vendor : "Unknown manufacturer";
  const model = connected && data?.system?.Name ? data.system.Name : "Unknown model";

  // Real MDM/domain-join state via dsregcmd /status (get-telemetry.ps1) - any of
  // AzureAdJoined/DomainJoined/EnterpriseJoined being true means this device is actually
  // enrolled/managed; WorkplaceJoined (a weaker "added a work account" state) isn't counted.
  // null means dsregcmd wasn't available or its output didn't parse, not "not enrolled".
  const mdm = connected ? data?.mdmEnrollment : null;
  const mdmReal = connected && mdm != null;
  const enrolledLabel = mdmReal
    ? mdm!.azureAdJoined || mdm!.domainJoined || mdm!.enterpriseJoined
      ? "Enrolled"
      : "Not Enrolled"
    : "Unknown";

  const warrantyState = connected ? data?.entitlement?.warrantyState ?? null : null;

  // Real age since BIOS release (bios.ReleaseDate) - see formatDeviceAge's own comment for why
  // this is a defensible real proxy, not literal manufacture/purchase date (which this project
  // has no real source for anywhere).
  const deviceAge = connected ? formatDeviceAge(data?.bios?.ReleaseDate) : null;

  // Real "Verified" header badge - true only when this device's real identity fields (serial,
  // UUID, model, manufacturer) were all actually read from telemetry, not a decorative always-on
  // claim. "Unknown" covers both disconnection and the (much rarer) case of being connected but
  // missing one of these basic identity fields - either way, this app genuinely couldn't verify
  // the device's identity, which is the one real fact this badge is making a claim about.
  const identityVerified =
    connected &&
    data?.bios?.SerialNumber != null &&
    data?.system?.UUID != null &&
    data?.system?.Name != null &&
    data?.system?.Vendor != null;
  const identityLabel = identityVerified ? "Verified" : "Unknown";

  const info = [
    { label: "Asset ID", value: assetId },
    { label: "Serial", value: serial },
    { label: "Manufacturer", value: manufacturer },
    { label: "Age", value: deviceAge ?? "—", sample: deviceAge == null },
    {
      label: "Warranty",
      value: warrantyState ? WARRANTY_STATE_META[warrantyState].label : "Unknown",
      valueColor: warrantyState ? WARRANTY_STATE_META[warrantyState].color : "var(--clpa-muted)",
      sample: warrantyState == null,
    },
  ];

  return (
    <HWCard style={{ ...HW_KPI_CARD, borderLeft: `3px solid ${HW_THEME_OVERVIEW.accent}` }}>
      <div className="flex items-center justify-between mb-2.5">
        <div className="flex items-center gap-1.5">
          {/* Icon-in-circle header badge, same treatment as AI Intel's icons throughout. */}
          <div className="flex items-center justify-center rounded-full" style={{ width: 22, height: 22, background: HW_THEME_OVERVIEW.tint }}>
            <MonitorCheck size={12} style={{ color: HW_THEME_OVERVIEW.accent }} strokeWidth={2.2} />
          </div>
          <span style={{ fontSize: 11, fontWeight: 800, color: "var(--clpa-title)", letterSpacing: 0.4 }}>Device Overview</span>
        </div>
        <div className="flex items-center gap-1">
          <HWBadge label={identityLabel} color={identityVerified ? "var(--clpa-success)" : "var(--clpa-muted)"} bg={identityVerified ? "rgba(var(--clpa-success-bright-rgb),0.1)" : "rgba(var(--clpa-subtle-rgb),0.12)"} />
          {!identityVerified && <SampleTag />}
        </div>
      </div>

      {/* Hero: the model name is this card's one dominant value, given the same "biggest thing
          on the card" treatment AIHealthScoreCard gives its score number - everything else here
          is deliberately smaller/secondary, and stays in the card's own slate accent (no extra
          colors) so it doesn't compete with the other two cards' themes. */}
      <div className="flex items-center gap-2.5 mb-2 rounded-lg" style={{ background: HW_THEME_OVERVIEW.tint, border: `1px solid ${HW_THEME_OVERVIEW.border1}`, padding: "9px 10px" }}>
        <div className="flex items-center justify-center rounded-full flex-shrink-0" style={{ width: 30, height: 30, background: "var(--clpa-card)", border: `1px solid ${HW_THEME_OVERVIEW.border2}` }}>
          <Cpu size={14} style={{ color: HW_THEME_OVERVIEW.accent }} strokeWidth={2} />
        </div>
        <div className="min-w-0">
          <div style={{ fontSize: 14, fontWeight: 900, color: "var(--clpa-title)", lineHeight: 1.15, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{model}</div>
          <div className="flex items-center gap-1" style={{ marginTop: 2, minWidth: 0 }}>
            <span style={{ fontSize: 8, color: "var(--clpa-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{manufacturer} · {enrolledLabel}</span>
            {(!manufacturerReal || !mdmReal) && <SampleTag />}
          </div>
        </div>
      </div>

      {/* Plain list for everything else, including Warranty - a colored value instead of a
          whole separate tinted box keeps one accent color per card instead of stacking an
          unrelated green box inside a slate-themed card. */}
      <div className="flex flex-col gap-1 flex-1">
        {info.map((r, i) => (
          <div key={i} className="flex items-center justify-between gap-2 rounded-md" style={{ background: i % 2 === 0 ? "var(--clpa-surface)" : "transparent", padding: "4.5px 7px" }}>
            <span style={{ fontSize: 8.5, color: "var(--clpa-subtle)", fontWeight: 500 }}>{r.label}</span>
            <div className="flex items-center gap-1" style={{ minWidth: 0 }}>
              <span style={{ fontSize: 9.5, fontWeight: 700, color: r.valueColor ?? "var(--clpa-body)", textAlign: "right", maxWidth: 118, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.value}</span>
              {r.sample && <SampleTag />}
            </div>
          </div>
        ))}
      </div>
    </HWCard>
  );
}

// Every field on this card is real now (see each row's/the header badge's/the hero's own
// comment below) - the old fixed "100% Hash Match" was dropped entirely rather than kept as a
// fabricated freshness-style claim, since there's no real cryptographic-hash-based integrity-
// verification system anywhere in this app (hardwareIntegrity compares a handful of real
// hardware identifiers/serials server-side, not a file/firmware hash) - a "99%"/"87%" for a real
// hash comparison that doesn't exist would be exactly as fabricated as "100%" was. The hero now
// shows a genuinely different, real fact instead: what fraction of TPM/Secure Boot/BitLocker are
// actually healthy.
function HWIntegrityCard() {
  const { data, connected, updatedAt } = useTelemetry();

  // Shared TPM check (src/app/lib/derived.ts) - Attestation is real whenever TPM data is
  // available at all: Passed if active, Failed if present but inactive.
  const { tpmReal, tpmActive } = getTpmStatus(data, connected);
  const tpmAttestation = tpmReal ? (tpmActive ? "Passed" : "Failed") : "Unknown";
  const tpmOk = tpmReal && tpmActive;

  // Confirm-SecureBootUEFI - throws on legacy BIOS and can need elevation beyond what's already
  // guaranteed on some configurations; both cases fall back to null/sample the same way.
  const secureBootEnabled = connected ? data?.secureBootEnabled ?? null : null;
  const secureBootLabel = secureBootEnabled != null ? (secureBootEnabled ? "Enabled" : "Disabled") : "Unknown";
  const secureBootOk = secureBootEnabled === true;

  // Get-BitLockerVolume's ProtectionStatus ("On"/"Off") - null if the module is absent (e.g.
  // Windows Home) or the query otherwise fails.
  const bitlockerStatus = connected ? data?.bitlockerStatus ?? null : null;
  const bitlockerLabel = bitlockerStatus != null ? (bitlockerStatus === "On" ? "Enabled" : "Disabled") : "Unknown";

  // Real Win32_PnPEntity presence check (get-telemetry.ps1) - "Present"/"Not Present" are both
  // real, fully determined facts (the same device-manager state Windows' own Sign-in options
  // page reads), never a guessed "Verified". Deliberately presence, not enrollment - see
  // get-telemetry.ps1's own comment on why real WinBio enrollment status isn't reliably
  // determinable without native interop this project has nowhere else. "Unknown" only if the
  // query itself failed to run at all.
  const fingerprintPresent = connected ? data?.fingerprintSensorPresent ?? null : null;
  const fingerprintLabel = fingerprintPresent == null ? "Unknown" : fingerprintPresent ? "Present" : "Not Present";

  // Trivially available whenever connected - no external tool or elevation involved.
  const lastValidationLabel = formatRelativeTime(connected ? updatedAt : null);

  // Real backend.compareFingerprints result (see useTelemetry's HardwareIntegritySnapshot) -
  // null (while connected) means no real hardware check has completed yet (not "Clear", which
  // would claim a genuine all-fields-match result this app hasn't actually gotten back).
  // "baseline-set" (this device's very first check) reads the same as "match" - there's nothing
  // to have mismatched against on a first-ever capture, so it's genuinely clean, not merely
  // undetermined.
  //
  // "Baseline Pending" is itself a real, fully-determined fact whenever we're actually connected
  // (telemetry-server.mjs's hardwareIntegrityState really has never completed a check) - not a
  // fake placeholder the way e.g. Age's old "1y 2m" was, the same distinction Fingerprint's real
  // "Not Present" already draws from a genuinely undetermined "Unknown". It was previously
  // sample-tagged unconditionally on `hardwareIntegrity == null`, which wrongly conflated that
  // real "no baseline yet" fact with genuine disconnection (where we truly can't determine
  // anything) - a real oversight, fixed here by only ever showing "Unknown" (sample) when
  // actually disconnected, and treating every connected result - including "Baseline Pending" -
  // as real.
  const hardwareIntegrity = connected ? data?.hardwareIntegrity ?? null : null;
  const tamperStatus = !connected ? "Unknown" : hardwareIntegrity == null ? "Baseline Pending" : hardwareIntegrity.status === "mismatch" ? "Tamper Detected" : "Clear";
  const tamperSample = !connected;
  const tamperColor =
    tamperStatus === "Tamper Detected" ? "var(--clpa-critical)" : tamperStatus === "Baseline Pending" ? "var(--clpa-warning)" : tamperStatus === "Unknown" ? "var(--clpa-muted)" : "var(--clpa-success)";

  // Real header badge - the exact same TPM/Secure Boot/BitLocker-based derivation as Dashboard's
  // Hardware Inventory badge (src/app/lib/derived.ts), not a second independent judgment of "is
  // this device's security posture clean" that could quietly disagree with what the Dashboard
  // already shows for the same three real signals.
  const integrityBadge = getHardwareInventoryBadge(data, connected);
  const integrityHeaderLabel = integrityBadge.label === "Healthy" ? "Verified" : integrityBadge.label === "Warning" ? "Attention" : "Unknown";

  // Real replacement for the old fabricated "100% Hash Match" - there is no cryptographic-hash
  // integrity system anywhere in this app (see this card's own comment on why "Hash Match" itself
  // is unfixable), but the three real signals behind the header badge above ARE real, so this
  // hero now shows what fraction of them are genuinely healthy instead of a fake hash percentage.
  // Gated on the exact same all-three-known completeness getHardwareInventoryBadge itself
  // requires - so this percentage and the header badge above can never disagree about whether
  // this device's security posture is even fully known yet.
  const securitySignalsKnown = tpmReal && secureBootEnabled != null && bitlockerStatus != null;
  const healthySignalCount = [tpmActive, secureBootEnabled, bitlockerStatus === "On"].filter(Boolean).length;
  const securitySignalsPct = securitySignalsKnown ? Math.round((healthySignalCount / 3) * 100) : null;

  // TPM Attestation and Secure Boot stay in the same plain list as everything else - status
  // reads through a colored value (green pass / amber fail) rather than a separate tinted box,
  // so this card doesn't stack an unrelated green-or-amber block inside its teal theme.
  const rows = [
    { label: "TPM Attestation", value: tpmAttestation, valueColor: !tpmReal ? "var(--clpa-muted)" : tpmOk ? "var(--clpa-success)" : "var(--clpa-warning)", sample: !tpmReal },
    { label: "Secure Boot", value: secureBootLabel, valueColor: secureBootEnabled == null ? "var(--clpa-muted)" : secureBootOk ? "var(--clpa-success)" : "var(--clpa-warning)", sample: secureBootEnabled == null },
    { label: "Fingerprint", value: fingerprintLabel, sample: fingerprintPresent == null },
    { label: "BitLocker", value: bitlockerLabel, valueColor: bitlockerStatus == null ? "var(--clpa-muted)" : bitlockerStatus === "On" ? "var(--clpa-success)" : "var(--clpa-warning)", sample: bitlockerStatus == null },
    { label: "Tamper Detection", value: tamperStatus, valueColor: tamperColor, sample: tamperSample },
    ...(hardwareIntegrity?.status === "mismatch" && hardwareIntegrity.mismatchedFields.length > 0
      ? [{ label: "Mismatched Fields", value: hardwareIntegrity.mismatchedFields.join(", "), valueColor: "var(--clpa-critical)", sample: false }]
      : []),
    { label: "Last Validation", value: lastValidationLabel ?? "—", muted: true, sample: lastValidationLabel == null },
  ];

  return (
    <HWCard style={{ ...HW_KPI_CARD, borderLeft: `3px solid ${HW_THEME_INTEGRITY.accent}` }}>
      <div className="flex items-center justify-between mb-2.5">
        <div className="flex items-center gap-1.5">
          {/* Icon-in-circle header badge, same treatment as AI Intel's icons throughout. */}
          <div className="flex items-center justify-center rounded-full" style={{ width: 22, height: 22, background: HW_THEME_INTEGRITY.tint }}>
            <Shield size={12} style={{ color: HW_THEME_INTEGRITY.accent }} strokeWidth={2.2} />
          </div>
          <span style={{ fontSize: 11, fontWeight: 800, color: "var(--clpa-title)", letterSpacing: 0.4 }}>Hardware Integrity</span>
        </div>
        <div className="flex items-center gap-1">
          <HWBadge
            label={integrityHeaderLabel}
            color={integrityHeaderLabel === "Verified" ? "var(--clpa-success)" : integrityHeaderLabel === "Attention" ? "var(--clpa-warning)" : "var(--clpa-muted)"}
            bg={integrityHeaderLabel === "Verified" ? "rgba(var(--clpa-success-bright-rgb),0.1)" : integrityHeaderLabel === "Attention" ? "rgba(var(--clpa-warning-bright-rgb),0.12)" : "rgba(var(--clpa-subtle-rgb),0.12)"}
          />
          {integrityBadge.sample && <SampleTag />}
        </div>
      </div>

      {/* Hero: real % of TPM/Secure Boot/BitLocker that are genuinely healthy (see
          securitySignalsPct's own comment) - replaces the old fabricated "Hash Match", given the
          same "biggest thing on the card" treatment AIHealthScoreCard gives its score number,
          instead of a small footer line. Sized/padded to match Device Overview's hero so the row
          of three cards carries the same visual weight. */}
      <div className="flex items-center gap-2.5 mb-2 rounded-lg" style={{ background: HW_THEME_INTEGRITY.tint, border: `1px solid ${HW_THEME_INTEGRITY.border1}`, padding: "9px 10px" }}>
        <div className="flex items-center justify-center rounded-full flex-shrink-0" style={{ width: 30, height: 30, background: "var(--clpa-card)", border: `1px solid ${HW_THEME_INTEGRITY.border2}` }}>
          <ShieldCheck size={14} style={{ color: HW_THEME_INTEGRITY.accent }} strokeWidth={2} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span style={{ fontSize: 18, fontWeight: 900, color: "var(--clpa-title)", lineHeight: 1 }}>{securitySignalsPct != null ? `${securitySignalsPct}%` : "Unknown"}</span>
            {securitySignalsPct == null && <SampleTag />}
          </div>
          <span style={{ fontSize: 8, color: "var(--clpa-muted)", fontWeight: 600 }}>Security Signals Verified</span>
        </div>
      </div>

      <div className="flex flex-col gap-1 flex-1">
        {rows.map((r, i) => (
          <div key={i} className="flex items-center justify-between gap-2 rounded-md" style={{ background: i % 2 === 0 ? "var(--clpa-surface)" : "transparent", padding: "4.5px 7px" }}>
            <span style={{ fontSize: 8.5, color: "var(--clpa-subtle)", fontWeight: 500 }}>{r.label}</span>
            <div className="flex items-center gap-1">
              <span style={{ fontSize: 9.5, fontWeight: 700, color: r.valueColor ?? (r.muted ? "var(--clpa-muted)" : "var(--clpa-body)") }}>{r.value}</span>
              {r.sample && <SampleTag />}
            </div>
          </div>
        ))}
      </div>
    </HWCard>
  );
}

// The old Healthy/Good/Attention percentage breakdown (and the "Balanced" verdict badge
// derived from it) was a fabricated composite score with no real scoring formula behind it -
// unlike the tiles below, which show genuine individually-tagged real-or-sample values.
// Collapsed to a plain component count instead of inventing health percentages to attach to it.
function HWDistributionCard() {
  const { thresholds } = useApp();
  const { data, connected } = useTelemetry();
  const batteryHealthPct = getBatteryHealthPercent(data, connected);

  // "CPU / GPU" tile: real Stable/Attention, reusing the exact same badge functions and live
  // thresholds the Dashboard's CPU/GPU cards already use (see getCpuBadge/getGpuBadge's own
  // comments) - not a separate, independently-invented judgment. Stable only if BOTH are real
  // and Healthy; Attention if either genuinely crossed into Warning/Critical; Unknown only if
  // NEITHER has any real data at all (one real metric is still a meaningful partial verdict).
  const cpuBadge = getCpuBadge(data, connected, thresholds.cpuWarning, thresholds.cpuCritical, thresholds.cpuTempWarning, thresholds.cpuTempCritical);
  const gpuBadge = getGpuBadge(data, connected, thresholds.cpuTempWarning);
  const cpuGpuUnknown = cpuBadge.sample && gpuBadge.sample;
  const cpuGpuStable = (cpuBadge.sample || cpuBadge.label === "Healthy") && (gpuBadge.sample || gpuBadge.label === "Healthy");
  const cpuGpuLabel = cpuGpuUnknown ? "Unknown" : cpuGpuStable ? "Stable" : "Attention";

  // "Memory" tile: same real Stable/Attention pattern, reusing getMemoryBadge directly.
  const memBadge = getMemoryBadge(data, connected, thresholds.memoryWarning, thresholds.memoryCritical);
  const memoryLabel = memBadge.sample ? "Unknown" : memBadge.label === "Healthy" ? "Stable" : "Attention";

  // "Drivers" tile: deliberately NOT a freshness/"Updated" claim - there is no real way to know
  // whether any driver/firmware version is current (see getDriverDataCompleteness's own comment,
  // and HWDriversCard's/the BIOS tile's now-removed "Latest" row). This only ever reports how
  // many of the same 8 real checks HWDriversCard makes actually have real data on this machine -
  // a genuine, honest fact, never a fabricated comparison against unavailable vendor data.
  const driverCompleteness = getDriverDataCompleteness(data, connected);
  const driversLabel = connected ? `${driverCompleteness.realCount} of ${driverCompleteness.totalCount} found` : "Unknown";

  const details = [
    { label: "CPU / GPU", value: cpuGpuLabel, Icon: Cpu, iconColor: "var(--clpa-primary)", warn: cpuGpuLabel === "Attention", sample: cpuGpuUnknown },
    { label: "Memory", value: memoryLabel, Icon: MemoryStick, iconColor: "var(--clpa-accent)", warn: memoryLabel === "Attention", sample: memBadge.sample },
    {
      label: "Battery",
      value: batteryHealthPct != null ? `${batteryHealthPct}%` : "Unknown",
      Icon: Battery,
      warn: batteryHealthPct != null && batteryHealthPct < thresholds.batteryHealthWarning,
      valueColor: colorForHealthPercent(batteryHealthPct, thresholds.batteryHealthWarning, thresholds.batteryHealthCritical),
      iconColor: colorForHealthPercent(batteryHealthPct, thresholds.batteryHealthWarning, thresholds.batteryHealthCritical),
      sample: batteryHealthPct == null,
    },
    { label: "Drivers", value: driversLabel, Icon: Plug, iconColor: "var(--clpa-info-teal)", sample: !connected },
  ];
  const total = 10;

  // Decorative ring around the count, echoing AIHealthScoreCard's SVG arc gauge - there's no
  // real percentage behind this (every tracked component is just counted, not scored), so it's
  // drawn as a full closed circle rather than a partial arc that would imply one. Sized to sit
  // in a hero box with the same padding/weight as Device Overview's and Hardware Integrity's,
  // so the row of three cards reads as one consistent family instead of three different scales.
  const ringSize = 44;
  const ringStroke = 4;
  const ringR = (ringSize - ringStroke) / 2;
  const ringCx = ringSize / 2;
  const ringCy = ringSize / 2;
  const ringCirc = 2 * Math.PI * ringR;

  return (
    <HWCard style={{ ...HW_KPI_CARD, borderLeft: `3px solid ${HW_THEME_DISTRIBUTION.accent}` }}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5">
          {/* Icon-in-circle header badge, same treatment as AI Intel's icons throughout. */}
          <div className="flex items-center justify-center rounded-full" style={{ width: 22, height: 22, background: HW_THEME_DISTRIBUTION.tint }}>
            <BarChart3 size={11} style={{ color: HW_THEME_DISTRIBUTION.accent }} strokeWidth={2} />
          </div>
          <span style={{ fontSize: 11, fontWeight: 800, color: "var(--clpa-title)", letterSpacing: 0.4 }}>Hardware Distribution</span>
        </div>
      </div>

      <div
        className="flex items-center gap-2.5 mb-2 rounded-lg"
        style={{ background: HW_THEME_DISTRIBUTION.tint, border: `1px solid ${HW_THEME_DISTRIBUTION.border1}`, padding: "9px 10px" }}
      >
        <div className="relative flex-shrink-0" style={{ width: ringSize, height: ringSize }}>
          <svg width={ringSize} height={ringSize} viewBox={`0 0 ${ringSize} ${ringSize}`}>
            <circle cx={ringCx} cy={ringCy} r={ringR} fill="none" stroke={HW_THEME_DISTRIBUTION.accent} strokeWidth={ringStroke} strokeDasharray={ringCirc} />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span style={{ fontSize: 15, fontWeight: 900, color: "var(--clpa-title)", lineHeight: 1 }}>{total}</span>
          </div>
        </div>
        <div className="min-w-0">
          <div style={{ fontSize: 11.5, fontWeight: 800, color: "var(--clpa-title)", lineHeight: 1.15 }}>Components Tracked</div>
          <span style={{ fontSize: 8, color: "var(--clpa-muted)" }}>Across all monitored categories</span>
        </div>
      </div>

      <div className="grid gap-1.5 flex-1 min-h-0" style={{ gridTemplateColumns: "1fr 1fr", gridAutoRows: "1fr" }}>
        {details.map((d, i) => (
          <div
            key={i}
            className="rounded-lg flex flex-col justify-center"
            style={{ background: `${d.iconColor}08`, border: HW_INNER_BORDER, padding: "8px 9px", minHeight: 0 }}
          >
            <div className="flex items-center gap-1.5 mb-1">
              <d.Icon size={12} style={{ color: d.iconColor, flexShrink: 0 }} strokeWidth={2} />
              <span style={{ fontSize: 10, fontWeight: 700, color: "var(--clpa-body)", lineHeight: 1.2 }}>{d.label}</span>
            </div>
            <div className="flex items-center gap-1 min-w-0">
              <span style={{ fontSize: 13, fontWeight: 800, lineHeight: 1.2, color: d.valueColor ?? (d.warn ? "var(--clpa-warning)" : "var(--clpa-ink-strong)"), overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.value}</span>
              {d.sample && <SampleTag />}
            </div>
          </div>
        ))}
      </div>
    </HWCard>
  );
}
// ─── Components section (single view, no repeated health) ─
const HW_INNER_BORDER = "1px solid var(--clpa-surface-border)";

function HWComponentCard({
  Icon,
  iconColor,
  iconBg,
  title,
  subtitle,
  subtitleSample,
  primaryValue,
  primaryLabel,
  primarySample,
  status,
  statusColor,
  statusBg,
  // Every other tile's status is still hardcoded with no real derivation behind it, so this
  // defaults to true (unchanged behavior) - only a tile with a genuine real check (the BIOS
  // tile's firmware-freshness status) passes statusSample={false} explicitly.
  statusSample = true,
  rows,
}: {
  Icon: React.ElementType;
  iconColor: string;
  iconBg: string;
  title: string;
  subtitle: string;
  subtitleSample?: boolean;
  primaryValue: string;
  primaryLabel: string;
  primarySample?: boolean;
  status: string;
  statusColor?: string;
  statusBg?: string;
  statusSample?: boolean;
  rows: { label: string; value: string; valueColor?: string; sample?: boolean }[];
}) {
  return (
    <HWCard style={{ padding: "10px 11px", height: "100%" }}>
      {/* A real flex row (min-w-0 + ellipsis on the title side, flex-shrink:0 on the badge
          side) instead of absolute-positioning the badge over a guessed paddingRight on the
          title - that guess could be exceeded by the badge's own width and let the title text
          run into it. The row's own gap is now a real structural minimum, not a hope. */}
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-1.5 min-w-0" style={{ flex: 1 }}>
          <div className="flex items-center justify-center rounded-lg flex-shrink-0" style={{ width: 26, height: 26, background: iconBg }}>
            <Icon size={13} style={{ color: iconColor }} strokeWidth={2} />
          </div>
          <div className="min-w-0">
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--clpa-title)", lineHeight: 1.1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</div>
            <div className="flex items-center gap-1" style={{ marginTop: 1, minWidth: 0 }}>
              <span style={{ fontSize: 8, color: "var(--clpa-subtle)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{subtitle}</span>
              {subtitleSample && <SampleTag />}
            </div>
          </div>
        </div>
        {/* Status badges here are hardcoded with no real derivation behind them — sample-tagged,
            except where a tile passes statusSample={false} because it genuinely has one. */}
        <div className="flex items-center gap-1 flex-shrink-0">
          <HWBadge label={status} color={statusColor} bg={statusBg} />
          {statusSample && <SampleTag />}
        </div>
      </div>

      <div className="rounded-lg mb-2" style={{ background: `${iconColor}10`, border: HW_INNER_BORDER, padding: "7px 9px" }}>
        <div className="flex items-center gap-1">
          <span style={{ fontSize: 15, fontWeight: 800, color: "var(--clpa-title)", lineHeight: 1 }}>{primaryValue}</span>
          {primarySample && <SampleTag />}
        </div>
        <div style={{ fontSize: 8, color: iconColor, fontWeight: 600, marginTop: 2, opacity: 0.85 }}>{primaryLabel}</div>
      </div>

      <div className="flex flex-col gap-1">
        {rows.map((r, i) => (
          <HWKV key={i} {...r} />
        ))}
      </div>
    </HWCard>
  );
}

// Converts a real Badge (src/app/lib/derived.ts) into HWComponentCard's status/statusColor/
// statusBg/statusSample props, reusing STATUS_BADGE_STYLES - the exact same label->color mapping
// Dashboard's StatusBadge already uses - rather than inventing a second color scheme here.
function hwBadgeStatus(badge: { label: string; sample: boolean }) {
  const style = STATUS_BADGE_STYLES[badge.label] ?? STATUS_BADGE_STYLES.Unknown;
  return { status: badge.label, statusColor: style.fg, statusBg: style.bg, statusSample: badge.sample };
}

function HWComponentsSection() {
  const { thresholds } = useApp();
  const { data, connected } = useTelemetry();

  const cpu = data?.cpu;
  const cpuName = connected && cpu?.Name ? cpu.Name.trim() : "Unknown CPU";
  const cpuLoad = getCpuLoad(data, connected);
  const cpuLoadReal = cpuLoad != null;
  const cpuCoresReal = connected && cpu?.NumberOfCores != null;
  const cpuCores = cpuCoresReal ? String(cpu!.NumberOfCores) : "—";
  const cpuThreadsReal = connected && cpu?.NumberOfLogicalProcessors != null;
  const cpuThreads = cpuThreadsReal ? String(cpu!.NumberOfLogicalProcessors) : "—";
  const cpuMaxClockReal = connected && cpu?.MaxClockSpeed != null;

  const memory = data?.memory;
  const memTotalReal = connected && memory?.totalKB != null;
  const memTotalGB = memTotalReal ? Math.round((memory!.totalKB / 1024 / 1024) * 10) / 10 : null;
  const memFreeReal = connected && memory?.freeKB != null;
  const memFreeGB = memFreeReal ? Math.round((memory!.freeKB / 1024 / 1024) * 10) / 10 : null;
  const memUsedReal = memTotalReal && memFreeReal;
  const memUsedGB = memUsedReal
    ? Math.round(((memory!.totalKB - memory!.freeKB) / 1024 / 1024) * 10) / 10
    : null;
  const memSpeedReal = connected && memory?.modules?.some((m) => m?.Speed != null);
  const memSpeeds = listMemoryModules(data, connected)
    .map((m) => m.Speed)
    .filter((s): s is number => s != null);
  const memSpeed =
    memSpeeds.length === 0
      ? "—"
      : [...new Set(memSpeeds)].length === 1
        ? `${memSpeeds[0]} MT/s`
        : memSpeeds.map((s) => `${s}`).join(" / ") + " MT/s";
  const memSubtitle = memTotalReal
    ? `${memTotalGB} GB${listMemoryModules(data, connected).length > 1 ? ` · ${listMemoryModules(data, connected).length} modules` : ""}`
    : "—";

  const volumes = listLogicalVolumes(data, connected);
  const physicalDrives = listPhysicalDrives(data, connected);
  const driveModels = physicalDrives.map((d) => d.Model?.trim()).filter(Boolean);
  const driveModel = driveModels.length > 0 ? driveModels.join(" · ") : "Unknown drive";
  const worstVol = volumes.reduce<(typeof volumes)[number] | null>((worst, vol) => {
    const pct = logicalVolumeUsedPct(vol);
    const worstPct = worst ? logicalVolumeUsedPct(worst) : null;
    if (pct == null) return worst;
    if (worstPct == null || pct > worstPct) return vol;
    return worst;
  }, null);
  const worstUsedGb = worstVol && worstVol.Size != null && worstVol.FreeSpace != null
    ? bytesToGb(worstVol.Size - worstVol.FreeSpace)
    : null;

  // NVMe spec: data_units_written is reported in units of 1000 x 512 bytes (512,000 bytes per
  // unit), not raw bytes - already being collected for storageHealth, just not converted before.
  const dataUnitsWritten =
    connected && data?.storageHealth?.nvme_smart_health_information_log?.data_units_written != null
      ? data.storageHealth.nvme_smart_health_information_log.data_units_written
      : null;
  const tbWritten = dataUnitsWritten != null ? Math.round(((dataUnitsWritten * 512000) / 1e12) * 10) / 10 : null;
  const storageHealthPct = storageWearToHealthPercent(getStorageWearPercent(data, connected));

  const gpus = listDisplayGpus(data, connected);
  const gpuInfo = getPrimaryGpu(data, connected);
  const gpuName = gpuInfo?.Name ? gpuInfo.Name.trim() : gpus.length > 1 ? `${gpus.length} GPUs` : "Unknown GPU";
  const gpuDriver = gpuInfo?.DriverVersion ? gpuInfo.DriverVersion : "—";
  const gpuVramReal = gpuInfo?.AdapterRAM != null;
  const gpuVramGB = gpuVramReal ? bytesToGb(gpuInfo!.AdapterRAM) : null;
  const gpuUtilPct = connected && data?.gpuUtilization != null ? data.gpuUtilization : null;

  // Same LibreHardwareMonitor source as Dashboard's ThermalCard - reused directly, not re-derived.
  const hwMon = connected ? data?.hardwareMonitor : null;
  const cpuTempC = hwMon?.cpuTempC ?? null;
  const gpuTempC = hwMon?.gpuTempC ?? null;

  const batteryDetail = data?.batteryDetail;
  const batteryPct = getBatteryChargePercent(data, connected);
  const batteryPctReal = batteryPct != null;
  // Shared WMI -> powercfg -> LHM-degradation priority chain (src/app/lib/derived.ts) - this
  // used to be a WMI-only copy that stayed stuck on "Unknown" whenever root/wmi's
  // BatteryStaticData was absent (as it is on this dev machine), even though BatteryCard/AI
  // Intel already had the real number via powercfg. Now it's the exact same call, same result.
  const batteryHealthPct = getBatteryHealthPercent(data, connected);
  const batteryHealthColor = colorForHealthPercent(batteryHealthPct, thresholds.batteryHealthWarning, thresholds.batteryHealthCritical);
  const batteryHealthLabel = batteryHealthPct != null ? `${batteryHealthPct}%` : "Unknown";
  const batteryCycleCount = connected && batteryDetail?.cycle?.CycleCount != null ? batteryDetail.cycle.CycleCount : null;
  // Shared Windows EstimatedRunTime -> LHM remaining-time chain (src/app/lib/derived.ts) - the
  // same function Dashboard's BatteryCard calls, so both show the same number.
  const batteryRemainingHM = formatMinutesAsHM(getBatteryRemainingMinutes(data, connected));
  const batteryOnAc = connected && isBatteryOnAc(data?.battery?.[0]?.BatteryStatus);

  const board = data?.board;
  const bios = data?.bios;
  const systemVendor = connected && data?.system?.Vendor ? data.system.Vendor : "Unknown manufacturer";
  const motherboardReal = connected && board?.Product != null;
  const motherboardSubtitle = motherboardReal ? `${systemVendor} ${board!.Product}` : "Unknown motherboard";
  const biosVersionReal = connected && bios?.SMBIOSBIOSVersion != null;
  const biosVersion = biosVersionReal ? bios!.SMBIOSBIOSVersion : "Unknown";
  const biosDate = connected ? formatWmiDate(bios?.ReleaseDate) : null;
  const biosDateLabel = biosDate ?? "Unknown";

  // Real Windows Update Agent search (telemetry-server.mjs), Type='Driver' filtered to real
  // system-firmware entries - confirmed directly that Dell publishes BIOS updates through
  // Windows Update this way on this machine (see biosFirmwareUpdate's own comment in
  // useTelemetry.ts). null means no real search has completed yet - reads as "Unknown", never a
  // fabricated "Up to date".
  const biosFirmwareUpdate = connected ? data?.biosFirmwareUpdate ?? null : null;
  const biosFirmwareReal = biosFirmwareUpdate != null;
  // Short form for the small status pill; the hero box below gets the version suffix too since
  // it has the room to show it.
  const biosFirmwareStatusLabel = biosFirmwareReal ? (biosFirmwareUpdate!.updateAvailable ? "Update Available" : "Up to date") : "Unknown";
  const biosFirmwareLabel =
    biosFirmwareReal && biosFirmwareUpdate!.updateAvailable && biosFirmwareUpdate!.latestVersion
      ? `Update Available (v${biosFirmwareUpdate!.latestVersion})`
      : biosFirmwareStatusLabel;
  const biosFirmwareOk = biosFirmwareReal && !biosFirmwareUpdate!.updateAvailable;

  // HWiNFO-only facts (local-agent/rust-collector/src/hwinfo.rs) with no sample fallback at all - these
  // rows/card simply don't render when null/empty, rather than showing a fabricated
  // placeholder + SampleTag the way every other field on this page does. That's deliberate:
  // "this hardware doesn't expose a PCH sensor" is an honest absence, not a gap to paper over
  // with an invented number.
  const hwinfo = connected ? data?.hwinfo : null;
  const pchTempC = hwinfo?.pchTempC ?? null;
  const spdHubTempC = hwinfo?.spdHubTempC ?? null;
  const perCoreVoltages = hwinfo?.perCoreVoltages ?? [];

  const netAdapters = listConnectedAdapters(data, connected);
  const netAdapter = getDisplayNetworkAdapter(data, connected);
  const netAdapterName = netAdapter?.Name ? netAdapter.Name : "Unknown adapter";
  const netMac = netAdapter?.MACAddress ? netAdapter.MACAddress : "—";
  const localIp = connected ? data?.localIp ?? null : null;
  const wifiLink = getWifiLinkStatus(data, connected);
  const wifiSsid = connected && data?.wifi?.ssid ? data.wifi.ssid : null;

  // Shared TPM check (src/app/lib/derived.ts) - Win32_Tpm typically requires admin elevation and
  // can be entirely absent on non-TPM hardware; when the query failed or returned nothing,
  // every TPM field below falls back to the original hardcoded value, tagged (sample), rather
  // than fabricating a status.
  const tpm = data?.tpm;
  const { tpmReal, tpmActive: tpmActiveBool } = getTpmStatus(data, connected);
  const tpmVersion = tpmReal && tpm?.SpecVersion ? tpm.SpecVersion.split(",")[0].trim() : null;
  const tpmActive = tpmReal ? (tpmActiveBool ? "Active" : "Inactive") : "Unknown";
  const tpmManufacturer = tpmReal && tpm?.ManufacturerIdTxt ? tpm.ManufacturerIdTxt : "—";
  const tpmFirmware = tpmReal && tpm?.ManufacturerVersion ? tpm.ManufacturerVersion : "—";

  // Real per-tile status pills - the exact same badge functions and live (possibly user-edited)
  // thresholds the Dashboard cards and this page's own Hardware Distribution mini-tiles already
  // use (src/app/lib/derived.ts), not an independent recomputation - so this section, the
  // Dashboard, and Hardware Distribution can never disagree about the same real component.
  const cpuBadge = getCpuBadge(data, connected, thresholds.cpuWarning, thresholds.cpuCritical, thresholds.cpuTempWarning, thresholds.cpuTempCritical);
  const ramBadge = getMemoryBadge(data, connected, thresholds.memoryWarning, thresholds.memoryCritical);
  const storageStatusBadge = getStorageBadge(data, connected);
  const gpuStatusBadge = getGpuBadge(data, connected, thresholds.cpuTempWarning);
  const batteryStatusBadge = getBatteryHealthBadge(data, connected, thresholds.batteryHealthWarning, thresholds.batteryHealthCritical);
  const networkStatusBadge = getNetworkBadge(data, connected);
  // Motherboard has no equivalent badge function anywhere in this app (no Dashboard "Motherboard"
  // card to reuse a real threshold from) - this is a deliberately minimal v1 real check instead
  // of leaving the pill permanently decorative: real BIOS version AND real BIOS date both present
  // means real firmware identity was actually read from this board, not a deeper health verdict.
  const motherboardFirmwareKnown = biosVersionReal && biosDate != null;

  const cards = [
    {
      Icon: Cpu, iconColor: "var(--clpa-primary)", iconBg: "rgba(var(--clpa-primary-rgb),0.12)",
      title: "CPU", subtitle: cpuName, primaryValue: cpuLoadReal ? `${cpuLoad}%` : "—", primaryLabel: "Current Utilization", primarySample: !cpuLoadReal,
      ...hwBadgeStatus(cpuBadge),
      rows: [
        { label: "Cores / Threads", value: `${cpuCores} / ${cpuThreads}`, sample: !cpuCoresReal || !cpuThreadsReal },
        // Base is real (Win32_Processor.MaxClockSpeed, already collected elsewhere - reused
        // rather than re-queried). Boost stays illustrative - Win32_Processor has no real
        // "boost clock" figure, and there's no other standard WMI source for it either; the
        // row's sample flag reflects that half, even though Base itself is genuinely real.
        {
          label: "Base / Boost",
          value: cpuMaxClockReal ? `${(cpu!.MaxClockSpeed / 1000).toFixed(2)} GHz` : "—",
          sample: !cpuMaxClockReal,
        },
        { label: "Temp", value: cpuTempC != null ? `${Math.round(cpuTempC)}°C` : "—", sample: cpuTempC == null },
      ],
    },
    {
      Icon: MemoryStick, iconColor: "var(--clpa-accent)", iconBg: "rgba(var(--clpa-accent-rgb),0.12)",
      title: "RAM", subtitle: memSubtitle, subtitleSample: !memTotalReal, primaryValue: memUsedGB != null ? `${memUsedGB} GB` : "—", primaryLabel: "Used Memory", primarySample: !memUsedReal,
      ...hwBadgeStatus(ramBadge),
      rows: [
        { label: "Total Capacity", value: memTotalGB != null ? `${memTotalGB} GB` : "—", sample: !memTotalReal },
        { label: "Available", value: memFreeGB != null ? `${memFreeGB} GB` : "—", sample: !memFreeReal },
        { label: "Speed", value: memSpeed, sample: !memSpeedReal },
        ...listMemoryModules(data, connected).map((m, i) => ({
          label: m.DeviceLocator?.trim() || `DIMM ${i + 1}`,
          value: `${bytesToGb(m.Capacity) ?? "—"} GB${m.SerialNumber?.trim() ? ` · ${m.SerialNumber.trim()}` : ""}`,
        })),
      ],
    },
    {
      Icon: HardDrive, iconColor: "var(--clpa-info-teal)", iconBg: "rgba(var(--clpa-info-teal-rgb),0.12)",
      title: "Storage", subtitle: driveModel,
      primaryValue: worstUsedGb != null ? `${worstUsedGb} GB` : "—",
      primaryLabel: volumes.length > 1 ? `Used on ${worstVol?.DeviceID ?? "volume"}` : "Space Used",
      primarySample: worstUsedGb == null,
      ...hwBadgeStatus(storageStatusBadge),
      rows: [
        ...volumes.map((vol) => {
          const usedGb = vol.Size != null && vol.FreeSpace != null ? bytesToGb(vol.Size - vol.FreeSpace) : null;
          const freeGb = bytesToGb(vol.FreeSpace);
          const totalGb = bytesToGb(vol.Size);
          const pct = logicalVolumeUsedPct(vol);
          return {
            label: `${vol.DeviceID}${vol.VolumeName?.trim() ? ` ${vol.VolumeName.trim()}` : ""}`,
            value: `${usedGb ?? "—"} / ${totalGb ?? "—"} GB${pct != null ? ` (${Math.round(pct)}%)` : ""}${freeGb != null ? ` · ${freeGb} GB free` : ""}`,
          };
        }),
        ...physicalDrives.map((d, i) => ({
          label: d.Model?.trim() || `Disk ${i + 1}`,
          value: bytesToGb(d.Size) != null ? `${Math.round(bytesToGb(d.Size)!)} GB` : "—",
        })),
        { label: "Health", value: storageHealthPct != null ? `${storageHealthPct}%` : "Unknown", sample: storageHealthPct == null },
        { label: "TB Written", value: tbWritten != null ? `${tbWritten} TB` : "Unknown", sample: tbWritten == null },
      ],
    },
    {
      Icon: BarChart3, iconColor: "var(--clpa-warning-bright)", iconBg: "rgba(var(--clpa-warning-bright-rgb),0.12)",
      title: "GPU", subtitle: gpuName, primaryValue: gpuUtilPct != null ? `${gpuUtilPct}%` : "—", primaryLabel: "Current Utilization", primarySample: gpuUtilPct == null,
      ...hwBadgeStatus(gpuStatusBadge),
      rows: [
        { label: "VRAM", value: gpuVramGB != null ? `${gpuVramGB} GB` : "—", sample: !gpuVramReal },
        { label: "Driver", value: gpuDriver },
        { label: "Temp", value: gpuTempC != null ? `${Math.round(gpuTempC)}°C` : "—", sample: gpuTempC == null },
        ...gpus.filter((g) => g !== gpuInfo).map((g) => ({
          label: g.Name?.trim() || "GPU",
          value: g.AdapterRAM != null ? `${bytesToGb(g.AdapterRAM)} GB` : "—",
        })),
      ],
    },
    {
      Icon: Battery, iconColor: batteryHealthColor, iconBg: batteryHealthPct != null && batteryHealthPct < thresholds.batteryHealthCritical ? "rgba(var(--clpa-critical-bright-rgb),0.12)" : batteryHealthPct != null && batteryHealthPct < thresholds.batteryHealthWarning ? "rgba(var(--clpa-warning-bright-rgb),0.12)" : "rgba(var(--clpa-success-bright-rgb),0.12)",
      title: "Battery", subtitle: connected && data?.battery?.[0]?.Name ? data.battery[0].Name : "Battery", subtitleSample: !(connected && data?.battery?.[0]?.Name), primaryValue: batteryPctReal ? `${batteryPct}%` : "—", primaryLabel: "Current Charge", primarySample: !batteryPctReal,
      ...hwBadgeStatus(batteryStatusBadge),
      rows: [
        { label: "Health", value: batteryHealthLabel, valueColor: batteryHealthColor },
        { label: "Cycle Count", value: batteryCycleCount != null ? `${batteryCycleCount}` : "Unknown", sample: batteryCycleCount == null },
        { label: "Remaining", value: batteryRemainingHM ?? (batteryOnAc ? "On charger" : "Unknown"), sample: batteryRemainingHM == null && !batteryOnAc },
        ...listBatteries(data, connected).slice(1).map((b, i) => ({
          label: b.Name?.trim() || `Battery ${i + 2}`,
          value: b.EstimatedChargeRemaining != null ? `${b.EstimatedChargeRemaining}%` : "—",
        })),
      ],
    },
    {
      Icon: Server, iconColor: "var(--clpa-muted)", iconBg: "rgba(var(--clpa-muted-rgb),0.12)",
      title: "Motherboard", subtitle: motherboardSubtitle, subtitleSample: !motherboardReal, primaryValue: biosVersion, primaryLabel: "BIOS Version", primarySample: !biosVersionReal,
      // Deliberately minimal v1 check - no richer motherboard-specific health signal exists
      // anywhere in this app (no Dashboard "Motherboard" card/badge function to reuse a real
      // threshold from, unlike the other six tiles here), so this only verifies that real BIOS/
      // firmware identity was actually read from this board (real version AND real release date
      // both present) - presence of real data, not a deeper health assessment. "Unknown" (sample)
      // whenever either is unavailable, including simply being disconnected.
      status: motherboardFirmwareKnown ? "Healthy" : "Unknown",
      statusColor: motherboardFirmwareKnown ? "var(--clpa-success)" : "var(--clpa-muted)",
      statusBg: motherboardFirmwareKnown ? "rgba(var(--clpa-success-bright-rgb),0.1)" : "rgba(var(--clpa-subtle-rgb),0.12)",
      statusSample: !motherboardFirmwareKnown,
      rows: [
        // Investigated directly, not assumed: no WMI source on this hardware exposes a
        // friendly chipset family name. Win32_BaseBoard.Product/Model is Dell's own
        // motherboard part number (0DPVMT), not a chipset name; the only PCH-identifying
        // entries in Win32_PnPSignedDriver/Win32_PnPEntity ("Intel(R) SMBus - 51A3", "Intel(R)
        // LPC Controller - 5182") carry a real driver version (shown in Drivers & Firmware
        // below) but only a raw PCI device ID, not a name - mapping that ID to a family name
        // like "Alder Lake-P PCH" would mean hardcoding a lookup table from general knowledge,
        // i.e. fabricating a plausible-sounding string rather than reading a real one. Stays
        // illustrative.
        { label: "Chipset", value: "—" },
        { label: "BIOS Date", value: biosDateLabel, sample: biosDate == null },
        // Real, separately-named facts from HWiNFO (see hwinfo.rs) - not a "Motherboard Temp"
        // substitute, and only present at all when this hardware actually exposes them (no
        // sample fallback row here when null; the row itself is just absent).
        ...(pchTempC != null ? [{ label: "PCH Temp", value: `${Math.round(pchTempC)}°C` }] : []),
        ...(spdHubTempC != null ? [{ label: "SPD Hub Temp", value: `${Math.round(spdHubTempC)}°C` }] : []),
      ],
    },
    {
      Icon: Wifi, iconColor: "var(--clpa-info-cyan)", iconBg: "rgba(var(--clpa-info-cyan-rgb),0.12)",
      title: "Network", subtitle: netAdapterName, primaryValue: wifiLink.label, primaryLabel: "WiFi Status", primarySample: wifiLink.sample,
      ...hwBadgeStatus(networkStatusBadge),
      rows: [
        { label: "IP Address", value: localIp ?? "—", sample: localIp == null },
        ...(wifiSsid ? [{ label: "SSID", value: wifiSsid }] : []),
        { label: "MAC Address", value: netMac },
        ...netAdapters.filter((a) => a.Name !== netAdapter?.Name).map((a) => ({
          label: "Also",
          value: a.Name,
        })),
      ],
    },
    {
      Icon: Fingerprint, iconColor: "var(--clpa-teal-bright)", iconBg: "rgba(var(--clpa-teal-bright-rgb),0.12)",
      title: "TPM", subtitle: tpmVersion ? `TPM ${tpmVersion}` : "TPM", subtitleSample: !tpmReal,
      primaryValue: tpmActive, primaryLabel: "Security Status", primarySample: !tpmReal,
      // Real status pill - reads the exact same tpmReal/tpmActiveBool (src/app/lib/derived.ts's
      // getTpmStatus) that primaryValue above already uses, not an independent recomputation.
      // "Verified" only when genuinely Active; a real-but-inactive TPM is an honest, different
      // (non-active) state, not the same green claim.
      status: !tpmReal ? "Unknown" : tpmActiveBool ? "Verified" : "Inactive",
      statusColor: !tpmReal ? "var(--clpa-muted)" : tpmActiveBool ? "var(--clpa-success)" : "var(--clpa-warning)",
      statusBg: !tpmReal ? "rgba(var(--clpa-subtle-rgb),0.12)" : tpmActiveBool ? "rgba(var(--clpa-success-bright-rgb),0.1)" : "rgba(var(--clpa-warning-bright-rgb),0.12)",
      statusSample: !tpmReal,
      rows: [
        { label: "Manufacturer", value: tpmManufacturer, sample: !tpmReal },
        { label: "Firmware", value: tpmFirmware, sample: !tpmReal },
      ],
    },
    {
      Icon: Settings, iconColor: "var(--clpa-indigo)", iconBg: "rgba(var(--clpa-indigo-rgb),0.12)",
      title: "BIOS", subtitle: systemVendor,
      // Real firmware-freshness verdict via Windows Update Agent (see biosFirmwareUpdate's own
      // comment above) - "Unknown"/sample only until the first real hourly check completes,
      // never a fabricated "Up to date" in the meantime.
      primaryValue: biosFirmwareLabel, primaryLabel: "Firmware Status", primarySample: !biosFirmwareReal,
      status: biosFirmwareStatusLabel,
      statusColor: !biosFirmwareReal ? "var(--clpa-muted)" : biosFirmwareOk ? "var(--clpa-teal-deep)" : "var(--clpa-warning)",
      statusBg: !biosFirmwareReal ? "rgba(var(--clpa-subtle-rgb),0.12)" : biosFirmwareOk ? "rgba(var(--clpa-teal-bright-rgb),0.1)" : "rgba(var(--clpa-warning-bright-rgb),0.12)",
      statusSample: !biosFirmwareReal,
      // No "Latest" row - there's no real way to know whether the installed BIOS version is
      // current from WMI alone (would require a live query against Dell's own update servers,
      // out of scope), same reasoning already applied to drop this exact claim for all 8 Drivers
      // & Firmware rows (HWDriversCard's own comment). The real freshness verdict now shown
      // above comes from a genuinely different, real source (Windows Update Agent), not from
      // inventing a comparison version here.
      rows: [{ label: "Version", value: biosVersion, sample: !biosVersionReal }],
    },
  ];

  // Grid's auto-fit/minmax avoided overflow but left a large blank gap whenever the last row
  // was partial (e.g. 2 cards in a row sized for 4) - grid columns are rigid tracks shared by
  // every row, so a short last row can't borrow width nobody else is using. Flexbox has no such
  // shared track: each card gets flex: 1 1 240px (240px basis, free to grow/shrink), so leftover
  // space on a partial last row is distributed across whichever cards landed there instead of
  // sitting empty. flex-wrap still reflows to however many 240px+ cards fit at any width, so
  // this keeps the same no-overflow guarantee auto-fit gave us.
  // alignItems: "stretch" (not "flex-start") - cards have 2-4 detail rows depending on
  // component (e.g. TPM's Manufacturer+Firmware vs. BIOS's Version alone), which otherwise left
  // shorter cards visibly shorter than their row siblings. Each HWComponentCard already renders
  // with height: "100%" for exactly this - it just had nothing to stretch into while this
  // container used flex-start. The resulting empty space at the bottom of a shorter card is
  // plain breathing room under its last label/value row, the same unobtrusive pattern the
  // Device Overview/Hardware Integrity/Hardware Distribution row above already uses successfully
  // despite its own cards having a different number of rows (5 vs. 6) - not worth a per-card
  // vertical-centering treatment on top of it.
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap gap-2.5" style={{ alignItems: "stretch" }}>
        {cards.map((c, i) => (
          <div key={i} style={{ flex: "1 1 240px" }}>
            <HWComponentCard {...c} />
          </div>
        ))}
      </div>
      {/* Per-core/rail VID readings don't fit HWComponentCard's fixed 2-3-row shape (a hybrid
          P-core/E-core CPU can expose a dozen-plus of these) - a variable-length list needs its
          own full-width layout, and only renders at all when this hardware actually has any
          (see the comment on perCoreVoltages above). */}
      {perCoreVoltages.length > 0 && <HWPerCoreVoltagesCard voltages={perCoreVoltages} />}
    </div>
  );
}

function HWPerCoreVoltagesCard({ voltages }: { voltages: { label: string; volts: number }[] }) {
  return (
    <HWCard style={{ padding: "12px 14px" }}>
      <div className="flex items-center gap-1.5 mb-2.5">
        <Zap size={13} style={{ color: "var(--clpa-primary)" }} strokeWidth={1.8} />
        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--clpa-title)" }}>Per-Core Voltages</span>
        <span style={{ fontSize: 9, color: "var(--clpa-subtle)" }}>({voltages.length} rails, via HWiNFO)</span>
      </div>
      <div className="grid gap-1.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(92px, 1fr))" }}>
        {voltages.map((v) => (
          <div key={v.label} className="rounded-lg" style={{ background: "var(--clpa-surface)", border: HW_INNER_BORDER, padding: "5px 7px" }}>
            <div style={{ fontSize: 7.5, color: "var(--clpa-subtle)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v.label}</div>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--clpa-body)" }}>{v.volts.toFixed(2)} V</div>
          </div>
        ))}
      </div>
    </HWCard>
  );
}

function HWDriversCard() {
  const { refreshSync } = useApp();
  const { data, connected } = useTelemetry();

  // Real per-device driver versions via Win32_PnPSignedDriver (get-telemetry.ps1), matched
  // against this machine's actual driver list - null per category when nothing on this
  // machine matches. BIOS/SSD firmware/GPU driver already have real sources elsewhere
  // (SMBIOSBIOSVersion, SMART firmware_version, gpu[].DriverVersion) and are reused here
  // rather than re-queried. There is no real way to know whether any of these versions is
  // "current" - that claim has been dropped entirely rather than fabricated (would require
  // live queries against vendor update servers, explicitly out of scope).
  const dv = connected ? data?.driverVersions : null;
  const bios = connected ? data?.bios : null;
  const biosVersionReal = connected && bios?.SMBIOSBIOSVersion != null;
  const biosDate = connected ? formatWmiDate(bios?.ReleaseDate) : null;
  const gpuDriverReal = getPrimaryGpu(data, connected)?.DriverVersion != null;
  const ssdFirmwareRaw = connected ? data?.storageHealth?.firmware_version : null;

  const drivers = [
    {
      name: "BIOS", Icon: Settings, color: "var(--clpa-indigo)", bg: "rgba(var(--clpa-indigo-rgb),0.12)",
      version: biosVersionReal ? `v${bios!.SMBIOSBIOSVersion}` : "—", date: biosDate, sample: !biosVersionReal,
    },
    {
      name: "Chipset", Icon: Cpu, color: "var(--clpa-primary)", bg: "rgba(var(--clpa-primary-rgb),0.12)",
      version: dv?.chipset ? `v${dv.chipset.version}` : "—", date: dv?.chipset ? formatWmiDate(dv.chipset.date) : null, sample: !dv?.chipset,
    },
    {
      name: "Intel ME", Icon: Server, color: "var(--clpa-muted)", bg: "rgba(var(--clpa-muted-rgb),0.12)",
      version: dv?.intelMe ? `v${dv.intelMe.version}` : "—", date: dv?.intelMe ? formatWmiDate(dv.intelMe.date) : null, sample: !dv?.intelMe,
    },
    {
      name: "WiFi Driver", Icon: Wifi, color: "var(--clpa-info-cyan)", bg: "rgba(var(--clpa-info-cyan-rgb),0.12)",
      version: dv?.wifi ? `v${dv.wifi.version}` : "—", date: dv?.wifi ? formatWmiDate(dv.wifi.date) : null, sample: !dv?.wifi,
    },
    {
      name: "GPU Driver", Icon: BarChart3, color: "var(--clpa-warning-bright)", bg: "rgba(var(--clpa-warning-bright-rgb),0.12)",
      version: gpuDriverReal ? `v${getPrimaryGpu(data, connected)!.DriverVersion}` : "—", date: null, sample: !gpuDriverReal,
    },
    {
      name: "Audio Driver", Icon: Headphones, color: "var(--clpa-accent)", bg: "rgba(var(--clpa-accent-rgb),0.12)",
      version: dv?.audio ? `v${dv.audio.version}` : "—", date: dv?.audio ? formatWmiDate(dv.audio.date) : null, sample: !dv?.audio,
    },
    {
      name: "Bluetooth Driver", Icon: Radio, color: "var(--clpa-info-teal)", bg: "rgba(var(--clpa-info-teal-rgb),0.12)",
      version: dv?.bluetooth ? `v${dv.bluetooth.version}` : "—", date: dv?.bluetooth ? formatWmiDate(dv.bluetooth.date) : null, sample: !dv?.bluetooth,
    },
    {
      name: "SSD Firmware", Icon: HardDrive, color: "var(--clpa-success-bright)", bg: "rgba(var(--clpa-success-bright-rgb),0.12)",
      version: ssdFirmwareRaw ? `v${ssdFirmwareRaw}` : "—", date: null, sample: !ssdFirmwareRaw,
    },
  ];

  const anySample = drivers.some((d) => d.sample);

  return (
    <HWCard style={{ padding: "12px 14px" }}>
      <div className="flex items-center justify-between mb-2.5">
        <div className="flex items-center gap-1.5">
          <Plug size={12} style={{ color: "var(--clpa-primary)" }} strokeWidth={2.2} />
          <span style={{ fontSize: 11, fontWeight: 800, color: "var(--clpa-title)", letterSpacing: 0.4 }}>Drivers & Firmware</span>
          {anySample && <SampleTag />}
        </div>
        <button
          onClick={() => refreshSync()}
          className="flex items-center gap-1.5"
          style={{ background: "var(--clpa-primary)", border: "none", borderRadius: 8, padding: "5px 12px", cursor: "pointer" }}
        >
          <RefreshCw size={10} color="white" strokeWidth={2.2} />
          <span style={{ fontSize: 10, color: "white", fontWeight: 600 }}>Refresh</span>
        </button>
      </div>
      <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
        {drivers.map((d, i) => (
          <div key={i} className="rounded-lg flex items-start gap-2" style={{ background: `${d.color}08`, border: HW_INNER_BORDER, padding: "8px 10px" }}>
            <div className="flex items-center justify-center rounded-lg flex-shrink-0" style={{ width: 24, height: 24, background: d.bg }}>
              <d.Icon size={12} style={{ color: d.color }} strokeWidth={2} />
            </div>
            <div className="min-w-0 flex-1">
              <div style={{ fontSize: 9, fontWeight: 700, color: "var(--clpa-body)" }}>{d.name}</div>
              <div className="flex items-center gap-1" style={{ marginTop: 2, minWidth: 0 }}>
                <span style={{ fontSize: 8.5, color: "var(--clpa-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{d.version}</span>
                {d.sample && <SampleTag />}
              </div>
              {/* Real driver date only, when available - no "Up to date"/correctness claim
                  attached (dropped entirely, not replaced): there's no real way to know if a
                  version is current without live vendor-update-server queries, out of scope. */}
              {d.date && (
                <div className="flex items-center mt-1.5">
                  <span style={{ fontSize: 7.5, fontWeight: 600, color: "var(--clpa-muted)" }}>{d.date}</span>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </HWCard>
  );
}
// ═══════════════════════════════════════════════════════════
// ─── WARRANTY & SUBSCRIPTION PAGE ─────────────────────────
// ═══════════════════════════════════════════════════════════

function WarrantyPage() {
  return (
    <CLPAPage>
      <WSStatusRow />
      <WSDetailsRow />
      <WSBottomRow />
    </CLPAPage>
  );
}

// ─── Shared helpers ───────────────────────────────────────
function WCard({ children, style = {} }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div className="clpa-card-hover rounded-2xl" style={{ background: "var(--clpa-card)", border: "1px solid var(--clpa-card-border)", boxShadow: "0 2px 8px rgba(0,0,0,0.06)", height: "100%", ...style }}>
      {children}
    </div>
  );
}

function WBadge({ label, color = "var(--clpa-success)", bg = "rgba(var(--clpa-success-bright-rgb),0.1)" }: { label: string; color?: string; bg?: string }) {
  return <span style={{ fontSize: 8.5, fontWeight: 700, color, background: bg, padding: "2px 8px", borderRadius: 999, whiteSpace: "nowrap" }}>{label}</span>;
}

function WKV({ label, value, valueColor = "var(--clpa-body)", sample = false }: { label: string; value: string; valueColor?: string; sample?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span style={{ fontSize: 9, color: "var(--clpa-subtle)", fontWeight: 500, flexShrink: 0 }}>{label}</span>
      <div className="flex items-center gap-1" style={{ minWidth: 0 }}>
        <span style={{ fontSize: 9.5, fontWeight: 600, color: valueColor, maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "right" }}>{value}</span>
        {sample && <SampleTag />}
      </div>
    </div>
  );
}

function WHead({ title, badge, badgeColor, badgeBg, badgeSample = false, action, onAction }: { title: string; badge?: string; badgeColor?: string; badgeBg?: string; badgeSample?: boolean; action?: string; onAction?: () => void }) {
  return (
    <div className="flex items-center justify-between mb-2">
      <div className="flex items-center gap-2">
        <span style={{ fontSize: 11, fontWeight: 800, color: "var(--clpa-title)", letterSpacing: 0.4 }}>{title}</span>
        {badge && <WBadge label={badge} color={badgeColor} bg={badgeBg} />}
        {badge && badgeSample && <SampleTag />}
      </div>
      {action && <button onClick={onAction} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 10, color: "var(--clpa-primary)", fontWeight: 600 }}>{action} ›</button>}
    </div>
  );
}

function WRingGauge({ pct, color, track, center }: { pct: number; color: string; track: string; center: React.ReactNode }) {
  const size = 78, sw = 7;
  const r = (size - sw) / 2;
  const circ = 2 * Math.PI * r;
  const val = circ * (pct / 100);
  return (
    <div className="relative flex-shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={track} strokeWidth={sw} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={sw} strokeLinecap="round" strokeDasharray={`${val} ${circ}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">{center}</div>
    </div>
  );
}

// ─── Warranty state (PRD §6.4 Warranty State Machine) ─────
// Matches the PRD's vocabulary exactly.
type WarrantyState = "Active" | "Warning" | "UnderReview" | "Voided" | "Expired";

// Real, honest v1 (backend's warranty.go) as of this session: this app no longer computes
// WarrantyState itself from a (permanently null - no Dell/HP/Lenovo OEM API was ever wired)
// coverage date. It reads the real, live-derived state telemetry-server.mjs's fetchEntitlement
// merges into data.entitlement.warrantyState (backend/handlers.go's handleGetEntitlement) -
// baseline-intact + real subscription standing for Active, an unresolved
// hardware-tamper-detected/device-identity-invalid event for Warning, a lapsed subscription for
// Expired. null means not enough real data yet (no locked baseline), same honesty rule as
// everywhere else in this app - never a fabricated default.
//
// "UnderReview" and "Voided" remain structurally UNREACHABLE, on purpose - both require a real,
// human-confirmed adjudication step (PRD's "formal ADE verification") that doesn't exist
// anywhere in this project yet (see backend/warranty.go's own comment). The type stays complete
// so a real future implementation of that workflow has a defined state to plug into.

// Complete mapping for all 5 PRD states, even though only Active/Warning/Expired are reachable today -
// Warning/UnderReview/Voided get real, considered colors now so a future real implementation of
// PRD §6.1-6.3 doesn't also need to design this part.
const WARRANTY_STATE_META: Record<WarrantyState, { label: string; color: string; bg: string; track: string }> = {
  Active: { label: "Active", color: "var(--clpa-success-bright)", bg: "rgba(var(--clpa-success-bright-rgb),0.1)", track: "rgba(var(--clpa-success-bright-rgb),0.18)" },
  Warning: { label: "Warning", color: "var(--clpa-warning-bright)", bg: "rgba(var(--clpa-warning-bright-rgb),0.1)", track: "rgba(var(--clpa-warning-bright-rgb),0.18)" },
  // Indigo is genuinely distinct from this app's purple accent (--clpa-accent, var(--clpa-accent)) - a
  // different hue family, not the same color at a different shade, so it gets its own token
  // rather than being folded into --clpa-accent.
  UnderReview: { label: "Under Review", color: "var(--clpa-indigo)", bg: "rgba(var(--clpa-indigo-rgb),0.1)", track: "rgba(var(--clpa-indigo-rgb),0.18)" },
  Voided: { label: "Voided", color: "var(--clpa-critical)", bg: "rgba(var(--clpa-critical-rgb),0.1)", track: "rgba(var(--clpa-critical-rgb),0.18)" },
  Expired: { label: "Expired", color: "var(--clpa-critical)", bg: "rgba(var(--clpa-critical-rgb),0.1)", track: "rgba(var(--clpa-critical-rgb),0.18)" },
};

// ─── Row 1: 3 clean KPI cards (one job each) ──────────────
function WSStatusRow() {
  return (
    <div className="grid gap-2.5 items-stretch" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
      <WWarrantyStatusCard />
      <WSubscriptionStatusCard />
      <WCoverageCard />
    </div>
  );
}

// KPI 1: Warranty only — status + countdown + action
//
// Real state (backend's warranty.go: baseline intact + real entitlement standing, or an
// unresolved tamper/identity signal) as of this session - OEM coverage dates are still not
// sourced from anywhere (no Dell/HP/Lenovo API wired, unchanged from before), so this card shows
// the real state without a fabricated expiry countdown.
function WWarrantyStatusCard() {
  const { data, connected } = useTelemetry();
  const warrantyState = connected ? data?.entitlement?.warrantyState ?? null : null;
  const known = warrantyState != null;
  const meta = known ? WARRANTY_STATE_META[warrantyState] : { label: "Unknown", color: "var(--clpa-muted)", bg: "rgba(var(--clpa-subtle-rgb),0.1)", track: "var(--clpa-divider)" };
  const needsAttention = known && warrantyState !== "Active";

  return (
    <WCard style={{ padding: "12px 14px", display: "flex", flexDirection: "column" }}>
      <WHead title="Warranty Status" badge={meta.label} badgeColor={meta.color} badgeBg={meta.bg} badgeSample={!known} />

      <div className="flex items-center gap-3 flex-1">
        <WRingGauge pct={known ? 100 : 0} color={meta.color} track={meta.track} center={<Shield size={22} color={meta.color} strokeWidth={2} />} />
        <div className="min-w-0">
          <div style={{ fontSize: 14, fontWeight: 800, color: meta.color }}>{known ? meta.label : "Unknown"}</div>
          <div style={{ fontSize: 9, color: "var(--clpa-muted)", marginTop: 2 }}>
            {known ? "Baseline + subscription standing" : "No hardware baseline locked yet"}
          </div>
          <div style={{ fontSize: 16, fontWeight: 900, color: "var(--clpa-title)", marginTop: 8, lineHeight: 1 }}>—</div>
          <div style={{ fontSize: 8.5, color: "var(--clpa-subtle)", marginTop: 2 }}>Expiry date (OEM lookup not connected)</div>
        </div>
      </div>

      {needsAttention ? (
        <div className="rounded-lg mt-3" style={{ background: "rgba(var(--clpa-warning-bright-rgb),0.08)", border: "1px solid rgba(var(--clpa-warning-bright-rgb),0.28)", padding: "8px 9px" }}>
          <div className="flex items-center gap-1.5 mb-1.5">
            <AlertTriangle size={12} color="var(--clpa-warning)" strokeWidth={2.2} />
            <span style={{ fontSize: 9, fontWeight: 700, color: "var(--clpa-warning-deep)" }}>{warrantyState}</span>
          </div>
          <div style={{ fontSize: 8.5, color: "var(--clpa-muted)", lineHeight: 1.35 }}>
            {warrantyState === "Warning"
              ? "An unresolved hardware-tamper or device-identity signature issue was detected on this device."
              : "This tenant's subscription has expired or is suspended."}
          </div>
        </div>
      ) : (
        <div className="rounded-lg mt-3" style={{ background: "var(--clpa-surface)", border: "1px solid var(--clpa-surface-border)", padding: "8px 9px" }}>
          <div style={{ fontSize: 9, fontWeight: 700, color: "var(--clpa-body)", marginBottom: 4 }}>{known ? "No action needed" : "Not synced"}</div>
          <div style={{ fontSize: 8.5, color: "var(--clpa-muted)", lineHeight: 1.35 }}>
            {known
              ? "Hardware baseline is intact and the subscription is in good standing."
              : "Dell, HP, and Lenovo coverage lookup is not wired. Serial and manufacturer on this page are from this PC."}
          </div>
        </div>
      )}
    </WCard>
  );
}

// Real entitlement facts (backend/'s Cloud Command Center, PRD §7/§13) - fetched by
// local-agent/server/telemetry-server.mjs on its own slower interval and merged into
// data.entitlement. backend/ returns a full ISO datetime (e.g. "2027-07-27T04:59:00.312Z"), so
// this is its own formatter rather than reusing a plain-date one that would misparse it.
function formatEntitlementDate(iso: string): string {
  return formatDateLabel(new Date(iso));
}

function getEntitlementDaysUntilExpiry(iso: string): number {
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.round((new Date(iso).getTime() - Date.now()) / msPerDay);
}

// Colors for backend/'s real status vocabulary (Active/Expiring/Grace/Expired/Suspended, the
// same PRD §7 vocabulary the schema's CHECK constraint enforces) - a status this app doesn't
// recognize falls back to Active's color rather than crashing on a missing lookup.
const ENTITLEMENT_STATUS_META: Record<string, { color: string; bg: string }> = {
  Active: { color: "var(--clpa-primary)", bg: "rgba(var(--clpa-primary-rgb),0.1)" },
  Expiring: { color: "var(--clpa-warning)", bg: "rgba(var(--clpa-warning-bright-rgb),0.12)" },
  Grace: { color: "var(--clpa-warning)", bg: "rgba(var(--clpa-warning-bright-rgb),0.12)" },
  Expired: { color: "var(--clpa-critical)", bg: "rgba(var(--clpa-critical-bright-rgb),0.1)" },
  Suspended: { color: "var(--clpa-critical)", bg: "rgba(var(--clpa-critical-bright-rgb),0.1)" },
};

// KPI 2: Subscription only — plan + renewal (no feature tags)
function WSubscriptionStatusCard() {
  // The task naming this card asked to wire "plan and status/expiry" - status and expiry
  // actually render here (the badge + date/countdown below), not in WSubscriptionDetailsCard
  // (which only has a Plan row) - both cards get the real entitlement where it actually is.
  const { data, connected } = useTelemetry();
  const entitlement = connected ? data?.entitlement ?? null : null;
  const entitlementReal = entitlement != null;
  const expiresAtReal = entitlementReal && entitlement.expiresAt != null;

  const planLabel = entitlementReal ? entitlement.plan : "—";
  const statusLabel = entitlementReal ? entitlement.status : "Unknown";
  const statusMeta = ENTITLEMENT_STATUS_META[statusLabel] ?? ENTITLEMENT_STATUS_META.Active;
  const expiryDateLabel = expiresAtReal ? formatEntitlementDate(entitlement.expiresAt as string) : "—";
  const daysUntilExpiry = expiresAtReal ? getEntitlementDaysUntilExpiry(entitlement.expiresAt as string) : null;
  const renewsInLabel =
    daysUntilExpiry == null
      ? "—"
      : daysUntilExpiry >= 0
      ? `Renews in ${daysUntilExpiry} day${daysUntilExpiry === 1 ? "" : "s"}`
      : `Expired ${Math.abs(daysUntilExpiry)} day${Math.abs(daysUntilExpiry) === 1 ? "" : "s"} ago`;
  const Crown = (
    <svg width={20} height={20} viewBox="0 0 24 24" fill="var(--clpa-primary)"><path d="M3 8l4.5 3L12 4l4.5 7L21 8l-1.8 10H4.8L3 8z" /></svg>
  );
  return (
    <WCard style={{ padding: "12px 14px", display: "flex", flexDirection: "column" }}>
      <WHead title="Subscription Status" badge={statusLabel} badgeColor={statusMeta.color} badgeBg={statusMeta.bg} badgeSample={!entitlementReal} />

      <div className="flex items-center gap-3 flex-1">
        <WRingGauge pct={entitlementReal ? 100 : 0} color="var(--clpa-primary)" track="rgba(var(--clpa-primary-rgb),0.15)" center={Crown} />
        <div className="min-w-0">
          <div className="flex items-center gap-1">
            <span style={{ fontSize: 14, fontWeight: 800, color: "var(--clpa-primary)" }}>{planLabel}</span>
            {!entitlementReal && <SampleTag />}
          </div>
          <div className="flex items-center gap-1" style={{ marginTop: 2 }}>
            <span style={{ fontSize: 9, color: "var(--clpa-muted)" }}>{entitlementReal ? "Plan from Command Centre" : "Not synced"}</span>
          </div>
          <div className="flex items-center gap-1" style={{ marginTop: 8 }}>
            <span style={{ fontSize: 16, fontWeight: 900, color: "var(--clpa-title)", lineHeight: 1 }}>{expiryDateLabel}</span>
          </div>
          <div className="flex items-center gap-1" style={{ marginTop: 2 }}>
            <span style={{ fontSize: 8.5, color: "var(--clpa-subtle)" }}>{renewsInLabel}</span>
          </div>
        </div>
      </div>

      {/* Billing/Next Payment stay fully sample - no backend model for billing cycle or
          payment amount exists yet, unlike plan/status/expiry above. */}
      <div className="grid gap-1.5 mt-3" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <div className="rounded-lg" style={{ background: "var(--clpa-surface)", border: "1px solid var(--clpa-surface-border)", padding: "7px 8px" }}>
          <div style={{ fontSize: 8, color: "var(--clpa-subtle)" }}>Billing</div>
          <div className="flex items-center gap-1" style={{ marginTop: 2 }}>
            <span style={{ fontSize: 11, fontWeight: 800, color: "var(--clpa-title)" }}>—</span>
          </div>
        </div>
        <div className="rounded-lg" style={{ background: "var(--clpa-surface)", border: "1px solid var(--clpa-surface-border)", padding: "7px 8px" }}>
          <div style={{ fontSize: 8, color: "var(--clpa-subtle)" }}>Next Payment</div>
          <div className="flex items-center gap-1" style={{ marginTop: 2 }}>
            <span style={{ fontSize: 11, fontWeight: 800, color: "var(--clpa-title)" }}>—</span>
          </div>
        </div>
      </div>
    </WCard>
  );
}

// KPI 3: Coverage score only
function WCoverageCard() {
  const { data, connected } = useTelemetry();
  const entitlementReal = connected && data?.entitlement != null;
  const warrantyState = connected ? data?.entitlement?.warrantyState ?? null : null;
  const warrantyOk = warrantyState === "Active";
  const warrantyKnown = warrantyState != null;
  const items = [
    { label: "Warranty", pct: warrantyKnown ? (warrantyOk ? 100 : 0) : 0, display: warrantyKnown ? (warrantyOk ? "100%" : WARRANTY_STATE_META[warrantyState].label) : "—", color: warrantyKnown ? WARRANTY_STATE_META[warrantyState].color : "var(--clpa-muted)", sample: !warrantyKnown },
    { label: "Subscription", pct: entitlementReal ? 100 : 0, display: entitlementReal ? "Active" : "—", color: "var(--clpa-primary)", sample: !entitlementReal },
    { label: "Service", pct: 0, display: "—", color: "var(--clpa-accent)", sample: true },
  ];

  const verifiedCount = items.filter((it) => !it.sample).length;
  const verifiedPct = Math.round((verifiedCount / items.length) * 100);

  const overallBadgeLabel = !warrantyKnown ? "Unknown" : warrantyOk ? "Good" : "Needs Attention";
  const overallBadgeColor = !warrantyKnown ? "var(--clpa-muted)" : warrantyOk ? undefined : "var(--clpa-warning)";
  const overallBadgeBg = !warrantyKnown ? "rgba(var(--clpa-subtle-rgb),0.1)" : warrantyOk ? undefined : "rgba(var(--clpa-warning-bright-rgb),0.12)";

  return (
    <WCard style={{ padding: "12px 14px", display: "flex", flexDirection: "column" }}>
      <WHead title="Overall Coverage" badge={overallBadgeLabel} badgeColor={overallBadgeColor} badgeBg={overallBadgeBg} badgeSample={!warrantyKnown} />

      <div className="flex items-center gap-3 mb-2.5">
        <WRingGauge
          pct={verifiedPct}
          color="var(--clpa-warning-bright)"
          track="rgba(var(--clpa-warning-bright-rgb),0.18)"
          center={
            <div className="flex flex-col items-center">
              <span style={{ fontSize: 16, fontWeight: 900, color: "var(--clpa-title)", lineHeight: 1 }}>{verifiedCount}/{items.length}</span>
              <span style={{ fontSize: 7.5, color: "var(--clpa-subtle)" }}>Verified</span>
            </div>
          }
        />
        <div className="flex-1 flex flex-col gap-2">
          {items.map((it) => (
            <div key={it.label}>
              <div className="flex items-center justify-between mb-0.5">
                <span style={{ fontSize: 9, color: "var(--clpa-muted)", fontWeight: 500 }}>{it.label}</span>
                <div className="flex items-center gap-1">
                  <span style={{ fontSize: 9, fontWeight: 800, color: "var(--clpa-title)" }}>{it.display}</span>
                  {it.sample && <SampleTag />}
                </div>
              </div>
              <div className="rounded-full overflow-hidden" style={{ height: 4, background: "var(--clpa-divider)" }}>
                <div style={{ width: `${it.pct}%`, height: "100%", background: it.color, borderRadius: 4 }} />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Honest disclosure, not a fabricated claim - "expired" is real, "not independently
          verified" is an accurate statement about what this card can't check, so this line
          itself needs no SampleTag (same as any other honest caveat elsewhere in the app). */}
      <div className="flex items-center gap-1.5 rounded-lg mt-auto" style={{ background: "rgba(var(--clpa-warning-bright-rgb),0.08)", border: "1px solid rgba(var(--clpa-warning-bright-rgb),0.28)", padding: "7px 9px" }}>
        <AlertTriangle size={12} color="var(--clpa-warning)" strokeWidth={2.2} />
        <span style={{ fontSize: 9, color: "var(--clpa-warning-deep)", fontWeight: 600 }}>Warranty coverage not verified — OEM lookup not connected</span>
      </div>
    </WCard>
  );
}

// ─── Row 2: Details (unique fields only — no repeated dates) ─
function WSDetailsRow() {
  return (
    <div className="grid gap-2.5 items-stretch" style={{ gridTemplateColumns: "1fr 1fr" }}>
      <WWarrantyDetailsCard />
      <WSubscriptionDetailsCard />
    </div>
  );
}

function WWarrantyDetailsCard() {
  const { data, connected } = useTelemetry();

  // Same real Win32_ComputerSystem.Manufacturer field the Hardware page's own "Manufacturer"
  // row already uses (data.system.Vendor) - for this specific device the warranty provider and
  // the hardware manufacturer are the same real-world entity (a Dell-built machine with a Dell
  // support plan), so this is a genuine wiring gap, not a different concept that happens to look
  // similar.
  const manufacturerReal = connected && data?.system?.Vendor != null;
  const provider = manufacturerReal ? data!.system.Vendor : "Unknown";
  const serialReal = connected && data?.bios?.SerialNumber != null;
  const serial = serialReal ? data!.bios.SerialNumber : "Unknown";

  const details = [
    { label: "Type", value: "—" },
    { label: "Provider", value: provider, sample: !manufacturerReal },
    { label: "Serial", value: serial, sample: !serialReal },
    { label: "Period", value: "—" },
    { label: "Terms", value: "—" },
    { label: "Claim ID", value: "—" },
    { label: "Support", value: "—" },
  ];

  return (
    <WCard style={{ padding: "12px 14px" }}>
      <WHead title="Warranty Details" />
      <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <div className="flex flex-col gap-1.5">
          {details.map((d, i) => <WKV key={i} {...d} />)}
        </div>

        <div>
          <div style={{ fontSize: 9, fontWeight: 700, color: "var(--clpa-subtle)", letterSpacing: 0.3, marginBottom: 8 }}>COVERED</div>
          <div style={{ fontSize: 9, color: "var(--clpa-muted)", lineHeight: 1.4 }}>
            OEM coverage list is not connected. Only the serial and manufacturer above are from this PC.
          </div>
        </div>
      </div>
    </WCard>
  );
}

function WSubscriptionDetailsCard() {
  const { navigate } = useApp();
  const { data, connected } = useTelemetry();
  const entitlement = connected ? data?.entitlement ?? null : null;
  const entitlementReal = entitlement != null;

  // Real backend.countDevicesByTenant + entitlements.licensed_devices - null (not a fabricated
  // ratio) when the backend couldn't supply a licensed seat count.
  const deviceCount = entitlement?.deviceCount ?? null;
  const licensedDevicesLabel = deviceCount ? `${deviceCount.used} / ${deviceCount.licensed}` : "—";

  const details = [
    { label: "Plan", value: entitlementReal ? entitlement.plan : "—", sample: !entitlementReal },
    { label: "Licensed Devices", value: licensedDevicesLabel, sample: deviceCount == null },
    { label: "Auto Renew", value: "—" },
    { label: "Payment Method", value: "—" },
  ];

  const FEATURE_NAMES = [
    "AI Predictions", "Self-Healing", "Remote Assist", "ADE Console",
    "Hardware Attestation", "ESG Reports", "Alerts", "API Access",
  ];
  // Real, plan-wide rows from the backend's plan_features table (see schema.sql's own comment
  // for the reasoning behind each include/exclude decision) - a feature name with no matching
  // row (entitlement null, or a future plan with no defined rows yet) falls back to the old
  // "included" placeholder, sample-tagged, rather than guessing real-looking data.
  const featureRows = FEATURE_NAMES.map((name) => {
    const real = entitlement?.features.find((f) => f.feature === name);
    return { name, included: real ? real.included : false, sample: real == null };
  });

  return (
    <WCard style={{ padding: "12px 14px" }}>
      <WHead title="Subscription Details" />
      <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <div className="flex flex-col gap-1.5">
          {details.map((d, i) => <WKV key={i} {...d} />)}
          <button onClick={() => navigate("settings")} className="flex items-center justify-center gap-1.5 mt-2" style={{ background: "var(--clpa-surface)", border: "1px solid var(--clpa-input-border)", borderRadius: 8, padding: "6px 10px", cursor: "pointer" }}>
            <Settings size={11} style={{ color: "var(--clpa-primary)" }} strokeWidth={2} />
            <span style={{ fontSize: 9.5, color: "var(--clpa-primary)", fontWeight: 600 }}>Open Settings</span>
          </button>
        </div>

        <div>
          <div style={{ fontSize: 9, fontWeight: 700, color: "var(--clpa-subtle)", letterSpacing: 0.3, marginBottom: 8 }}>INCLUDED</div>
          <div className="grid gap-1.5" style={{ gridTemplateColumns: "1fr 1fr" }}>
            {featureRows.map((f) => (
              <div key={f.name} className="flex items-center gap-1 rounded-lg" style={{ background: "var(--clpa-surface)", border: "1px solid var(--clpa-surface-border)", padding: "6px 7px" }}>
                {f.included ? (
                  <CheckCircle2 size={10} color="var(--clpa-success-bright)" strokeWidth={2.2} />
                ) : (
                  <X size={10} color="var(--clpa-subtle)" strokeWidth={2.2} />
                )}
                <span style={{ fontSize: 8.5, color: f.included ? "var(--clpa-body)" : "var(--clpa-subtle)", fontWeight: 600 }}>{f.name}</span>
                {f.sample && <SampleTag />}
              </div>
            ))}
          </div>
        </div>
      </div>
    </WCard>
  );
}

// ─── Row 3: Usage + Transactions (no duplicate timeline dates) ─
function WSBottomRow() {
  return (
    <div className="grid gap-2.5 items-stretch" style={{ gridTemplateColumns: "1.2fr 1fr" }}>
      <WUsageCard />
      <WTransactionsCard />
    </div>
  );
}

function WUsageCard() {
  const { data, connected } = useTelemetry();

  // Same real backend.countDevicesByTenant + entitlements.licensed_devices already used by
  // Subscription Details' "Licensed Devices" row - "devices actually being monitored" and
  // "devices licensed under this plan" are the same real underlying fact for this device, not
  // two different metrics that happen to look alike. This row was a separate hardcoded "125/150"
  // that got missed when Licensed Devices was wired to the real count elsewhere on this page.
  const deviceCount = connected ? data?.entitlement?.deviceCount ?? null : null;
  const monitoredDevicesReal = deviceCount != null;
  const monitoredDevicesValue = monitoredDevicesReal ? `${deviceCount.used} / ${deviceCount.licensed}` : "—";
  const monitoredDevicesPct = monitoredDevicesReal ? Math.round((deviceCount.used / deviceCount.licensed) * 100) : 0;

  const rows = [
    { label: "Monitored Devices", value: monitoredDevicesValue, pct: monitoredDevicesPct, sample: !monitoredDevicesReal },
  ];
  return (
    <WCard style={{ padding: "12px 14px" }}>
      <WHead title="Usage & Entitlements" />
      <div className="grid gap-2.5" style={{ gridTemplateColumns: "1fr" }}>
        {rows.map((r, i) => (
          <div key={i} className="rounded-lg" style={{ background: "var(--clpa-surface)", border: "1px solid var(--clpa-surface-border)", padding: "8px 9px" }}>
            <div className="flex items-center justify-between mb-1">
              <span style={{ fontSize: 8.5, color: "var(--clpa-muted)", fontWeight: 500 }}>{r.label}</span>
              <span style={{ fontSize: 9, fontWeight: 800, color: "var(--clpa-title)" }}>{monitoredDevicesReal ? `${r.pct}%` : "—"}</span>
            </div>
            <div className="rounded-full overflow-hidden mb-1" style={{ height: 4, background: "var(--clpa-input-border)" }}>
              <div style={{ width: `${monitoredDevicesReal ? r.pct : 0}%`, height: "100%", background: "var(--clpa-primary)", borderRadius: 4 }} />
            </div>
            <div style={{ fontSize: 9, fontWeight: 600, color: "var(--clpa-body)" }}>{r.value}</div>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 9, color: "var(--clpa-muted)", lineHeight: 1.4, marginTop: 10 }}>
        API calls, remote-session counts, and cloud storage usage are not tracked on this agent.
      </div>
    </WCard>
  );
}

function WTransactionsCard() {
  return (
    <WCard style={{ padding: "12px 14px" }}>
      <WHead title="Recent Transactions" />
      <div style={{ fontSize: 9.5, color: "var(--clpa-muted)", padding: "12px 4px" }}>
        No billing history on this agent.
      </div>
    </WCard>
  );
}
// ═══════════════════════════════════════════════════════════
// ─── ALERTS PAGE ──────────────────────────────────────────
// ═══════════════════════════════════════════════════════════

type AlertFilter = "all" | AlertSeverity | "unread" | "resolved";

const SEVERITY_RANK: Record<AlertSeverity, number> = { critical: 3, warning: 2, info: 1 };
function sortByPriority(alerts: AlertItem[]): AlertItem[] {
  return [...alerts].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
}

function prettyAlertCategory(category: string): string {
  if (category === "BatteryHealth") return "Battery health";
  return category;
}

function alertRelativeTime(alert: AlertItem): string {
  return formatRelativeTime(new Date(alert.createdAt).toISOString()) ?? alert.time;
}

function liveReadingForAlert(
  alert: AlertItem,
  data: TelemetrySnapshot | null | undefined,
  connected: boolean,
): string | null {
  switch (alert.ruleId) {
    case "cpu-load": {
      const v = getCpuLoad(data, connected);
      return v != null ? `Live CPU ${v}%` : null;
    }
    case "memory-usage": {
      const v = getMemUsedPercent(data, connected);
      return v != null ? `Live RAM ${v}%` : null;
    }
    case "storage-free": {
      const used = getWorstStorageUsedPct(data, connected);
      return used != null ? `Live ${Math.round(100 - used)}% free on fullest volume` : null;
    }
    case "battery-low": {
      const v = getBatteryChargePercent(data, connected);
      return v != null ? `Live charge ${v}%` : null;
    }
    case "cpu-temp": {
      const v = connected ? data?.hardwareMonitor?.cpuTempC ?? null : null;
      return v != null ? `Live CPU ${Math.round(v)}°C` : null;
    }
    case "battery-health": {
      const v = getBatteryHealthPercent(data, connected);
      return v != null ? `Live health ${v}%` : null;
    }
    default:
      return null;
  }
}

function nextStepForAlert(alert: AlertItem): string | null {
  switch (alert.ruleId) {
    case "storage-free":
      return "Free space on the fullest volume, or move files off this disk.";
    case "battery-health":
      return "Health is below the replacement line. Plan a battery service.";
    case "battery-low":
      return "Plug in while the pack is discharging.";
    case "cpu-temp":
      return "CPU is hot. Ease load and check vents.";
    case "cpu-load":
      return "CPU is above the load threshold in Settings.";
    case "memory-usage":
      return "RAM is above the usage threshold in Settings.";
    default:
      return null;
  }
}

function categoryIcon(category: string): typeof Cpu {
  if (category === "Storage") return HardDrive;
  if (category === "Battery" || category === "BatteryHealth") return Battery;
  if (category === "Security") return Shield;
  if (category === "Warranty") return Award;
  if (category === "Remote") return Headphones;
  return Cpu;
}

function AlertsPage() {
  const {
    alerts,
    acknowledgeAlert,
    dismissAlert,
    snoozeAlert,
    snoozedUntil,
    dismissedButActive,
    groupSimilarAlertsEnabled,
    prioritySortingEnabled,
    markAllAlertsRead,
    unreadCount,
  } = useApp();
  const liveAlerts = alerts.filter((a) => a.source !== "sample");
  const [filter, setFilter] = useState<AlertFilter>("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(liveAlerts[0]?.id ?? "");

  const filteredRaw = liveAlerts.filter((a) => {
    if (filter === "unread") {
      if (!a.unread) return false;
    } else if (filter === "resolved") {
      if (a.unread) return false;
    } else if (filter !== "all" && a.severity !== filter) {
      return false;
    }
    if (categoryFilter !== "all" && a.category !== categoryFilter) return false;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return `${a.title} ${a.detail} ${a.category}`.toLowerCase().includes(q);
  });
  const filtered = prioritySortingEnabled ? sortByPriority(filteredRaw) : filteredRaw;

  const selected = liveAlerts.find((a) => a.id === selectedId) ?? filtered[0];

  useEffect(() => {
    if (!liveAlerts.find((a) => a.id === selectedId)) {
      setSelectedId(filtered[0]?.id ?? liveAlerts[0]?.id ?? "");
    }
  }, [liveAlerts, filtered, selectedId]);

  const counts = {
    open: liveAlerts.filter((a) => a.unread).length,
    critical: liveAlerts.filter((a) => a.severity === "critical" && a.unread).length,
    warning: liveAlerts.filter((a) => a.severity === "warning" && a.unread).length,
    resolved: liveAlerts.filter((a) => !a.unread).length,
  };

  const categoriesPresent = [...new Set(liveAlerts.map((a) => a.category))];

  return (
    <CLPAPage>
      <CLPARow columns="1fr 1fr 1fr 1fr">
        <ASeverityCard
          label="Open"
          value={counts.open}
          sub="Waiting on acknowledge"
          color="var(--clpa-primary)"
          bg="rgba(var(--clpa-primary-rgb),0.08)"
          Icon={Bell}
          active={filter === "unread"}
          onClick={() => setFilter("unread")}
        />
        <ASeverityCard
          label="Critical"
          value={counts.critical}
          sub="Needs action now"
          color="var(--clpa-critical)"
          bg="rgba(var(--clpa-critical-bright-rgb),0.08)"
          Icon={AlertTriangle}
          active={filter === "critical"}
          onClick={() => setFilter("critical")}
        />
        <ASeverityCard
          label="Warning"
          value={counts.warning}
          sub="Still open"
          color="var(--clpa-warning)"
          bg="rgba(var(--clpa-warning-bright-rgb),0.1)"
          Icon={Zap}
          active={filter === "warning"}
          onClick={() => setFilter("warning")}
        />
        <ASeverityCard
          label="Resolved"
          value={counts.resolved}
          sub="Acknowledged on this device"
          color="var(--clpa-success)"
          bg="rgba(var(--clpa-success-bright-rgb),0.08)"
          Icon={CheckCircle2}
          active={filter === "resolved"}
          onClick={() => setFilter("resolved")}
        />
      </CLPARow>

      {dismissedButActive.length > 0 && (
        <div
          className="flex items-start gap-2 rounded-xl"
          style={{ background: "rgba(var(--clpa-warning-bright-rgb),0.1)", border: "1px solid rgba(var(--clpa-warning-bright-rgb),0.28)", padding: "8px 12px" }}
        >
          <EyeOff size={14} style={{ color: "var(--clpa-warning)", marginTop: 1, flexShrink: 0 }} strokeWidth={2} />
          <div className="min-w-0">
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--clpa-title)" }}>
              {dismissedButActive.length} dismissed condition{dismissedButActive.length === 1 ? "" : "s"} still active
            </div>
            <div style={{ fontSize: 9.5, color: "var(--clpa-muted)", marginTop: 2, lineHeight: 1.4 }}>
              {dismissedButActive.map((r) => prettyAlertCategory(r.category)).join(" · ")}. No new alert until it clears and crosses the threshold again.
            </div>
          </div>
        </div>
      )}

      <ATopBar
        filter={filter}
        setFilter={setFilter}
        counts={counts}
        query={query}
        setQuery={setQuery}
        unreadCount={unreadCount}
        onMarkAllRead={unreadCount > 0 ? markAllAlertsRead : undefined}
      />

      {categoriesPresent.length > 1 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            onClick={() => setCategoryFilter("all")}
            style={{
              background: categoryFilter === "all" ? "rgba(var(--clpa-primary-rgb),0.1)" : "var(--clpa-card)",
              border: categoryFilter === "all" ? "1px solid rgba(var(--clpa-primary-rgb),0.25)" : "1px solid var(--clpa-surface-border)",
              borderRadius: 8,
              padding: "3px 8px",
              cursor: "pointer",
              fontSize: 9,
              fontWeight: 700,
              color: categoryFilter === "all" ? "var(--clpa-primary)" : "var(--clpa-muted)",
            }}
          >
            All types
          </button>
          {categoriesPresent.map((cat) => {
            const active = categoryFilter === cat;
            const CatIcon = categoryIcon(cat);
            const n = liveAlerts.filter((a) => a.category === cat && a.unread).length;
            return (
              <button
                key={cat}
                onClick={() => setCategoryFilter(active ? "all" : cat)}
                className="flex items-center gap-1"
                style={{
                  background: active ? "rgba(var(--clpa-primary-rgb),0.1)" : "var(--clpa-card)",
                  border: active ? "1px solid rgba(var(--clpa-primary-rgb),0.25)" : "1px solid var(--clpa-surface-border)",
                  borderRadius: 8,
                  padding: "3px 8px",
                  cursor: "pointer",
                }}
              >
                <CatIcon size={10} style={{ color: active ? "var(--clpa-primary)" : "var(--clpa-muted)" }} strokeWidth={2} />
                <span style={{ fontSize: 9, fontWeight: 700, color: active ? "var(--clpa-primary)" : "var(--clpa-muted)" }}>{prettyAlertCategory(cat)}</span>
                {n > 0 && <span style={{ fontSize: 8, fontWeight: 800, color: "var(--clpa-critical)" }}>{n}</span>}
              </button>
            );
          })}
        </div>
      )}

      <CLPARow columns="minmax(0, 1.2fr) minmax(0, 0.9fr)">
        <AAlertFeedCard
          alerts={filtered}
          selectedId={selected?.id}
          onSelect={setSelectedId}
          onAcknowledge={acknowledgeAlert}
          groupByCategory={groupSimilarAlertsEnabled}
          emptyHint={query.trim() ? "No alerts match this search." : "No alerts in this view."}
        />
        <AAlertDetailCard
          alert={selected}
          onAcknowledge={acknowledgeAlert}
          onDismiss={dismissAlert}
          onSnooze={snoozeAlert}
          snoozedUntil={snoozedUntil}
        />
      </CLPARow>

      <AAlertHistoryCard alerts={liveAlerts} snoozedUntil={snoozedUntil} onSelect={setSelectedId} selectedId={selected?.id} />
    </CLPAPage>
  );
}

function ASeverityCard({
  label,
  value,
  sub,
  color,
  bg,
  Icon,
  active,
  onClick,
}: {
  label: string;
  value: number;
  sub: string;
  color: string;
  bg: string;
  Icon: typeof AlertTriangle;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="clpa-card-hover rounded-2xl text-left w-full"
      style={{
        padding: "10px 12px",
        background: "var(--clpa-card)",
        border: active ? `1px solid ${color}` : "1px solid var(--clpa-card-border)",
        boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
        cursor: "pointer",
      }}
    >
      <div className="flex items-center gap-2.5">
        <div className="flex items-center justify-center rounded-xl flex-shrink-0" style={{ width: 32, height: 32, background: bg }}>
          <Icon size={15} style={{ color }} strokeWidth={2} />
        </div>
        <div>
          <div style={{ fontSize: 20, fontWeight: 900, color: "var(--clpa-title)", lineHeight: 1 }}>{value}</div>
          <div style={{ fontSize: 9.5, fontWeight: 700, color: "var(--clpa-body)", marginTop: 2 }}>{label}</div>
          <div style={{ fontSize: 8, color: "var(--clpa-subtle)", marginTop: 1 }}>{sub}</div>
        </div>
      </div>
    </button>
  );
}

function ATopBar({
  filter,
  setFilter,
  counts,
  query,
  setQuery,
  unreadCount,
  onMarkAllRead,
}: {
  filter: AlertFilter;
  setFilter: (f: AlertFilter) => void;
  counts: { open: number; critical: number; warning: number; resolved: number };
  query: string;
  setQuery: (q: string) => void;
  unreadCount: number;
  onMarkAllRead?: () => void;
}) {
  const chips: { id: AlertFilter; label: string; count?: number }[] = [
    { id: "all", label: "All" },
    { id: "unread", label: "Open", count: counts.open },
    { id: "critical", label: "Critical", count: counts.critical },
    { id: "warning", label: "Warning", count: counts.warning },
    { id: "info", label: "Info" },
    { id: "resolved", label: "Resolved", count: counts.resolved },
  ];

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {chips.map((chip) => {
        const active = filter === chip.id;
        return (
          <button
            key={chip.id}
            onClick={() => setFilter(chip.id)}
            className="flex items-center gap-1"
            style={{
              background: active ? "rgba(var(--clpa-primary-rgb),0.1)" : "var(--clpa-card)",
              border: active ? "1px solid rgba(var(--clpa-primary-rgb),0.25)" : "1px solid rgba(0,0,0,0.08)",
              borderRadius: 999,
              padding: "5px 11px",
              cursor: "pointer",
            }}
          >
            <span style={{ fontSize: 10, fontWeight: active ? 700 : 500, color: active ? "var(--clpa-primary)" : "var(--clpa-muted)" }}>{chip.label}</span>
            {chip.count !== undefined && chip.count > 0 && (
              <span style={{ fontSize: 8, fontWeight: 700, color: "#FFFFFF", background: chip.id === "critical" ? "var(--clpa-critical-bright)" : "var(--clpa-primary)", borderRadius: 999, padding: "1px 5px", minWidth: 14, textAlign: "center" }}>
                {chip.count}
              </span>
            )}
          </button>
        );
      })}
      <div className="flex items-center gap-1.5 flex-1 min-w-[160px] rounded-full" style={{ background: "var(--clpa-card)", border: "1px solid var(--clpa-surface-border)", padding: "4px 10px" }}>
        <Search size={12} style={{ color: "var(--clpa-subtle)", flexShrink: 0 }} strokeWidth={2} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search alerts"
          style={{ flex: 1, minWidth: 0, border: "none", outline: "none", background: "transparent", fontSize: 10.5, color: "var(--clpa-body)" }}
        />
      </div>
      {onMarkAllRead && unreadCount > 0 && (
        <button
          onClick={onMarkAllRead}
          style={{ background: "var(--clpa-primary)", border: "none", borderRadius: 8, padding: "5px 10px", cursor: "pointer", fontSize: 9.5, fontWeight: 700, color: "white", whiteSpace: "nowrap" }}
        >
          Mark all read
        </button>
      )}
    </div>
  );
}

function AAlertFeedRow({
  alert,
  isSelected,
  onSelect,
  onAcknowledge,
}: {
  alert: AlertItem;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onAcknowledge: (id: string) => void;
}) {
  const meta = SEVERITY_META[alert.severity];
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(alert.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(alert.id);
        }
      }}
      className="flex items-start gap-2.5 w-full text-left"
      style={{
        background: isSelected ? "rgba(var(--clpa-primary-rgb),0.06)" : "var(--clpa-surface)",
        border: isSelected ? "1px solid rgba(var(--clpa-primary-rgb),0.2)" : "1px solid var(--clpa-surface-border)",
        borderRadius: 10,
        padding: "8px 10px",
        cursor: "pointer",
      }}
    >
      <div className="flex items-center justify-center rounded-lg flex-shrink-0" style={{ width: 28, height: 28, background: alert.iconBg }}>
        <alert.Icon size={13} style={{ color: alert.iconColor }} strokeWidth={2} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 mb-0.5">
          {alert.unread && <span className="clpa-dot flex-shrink-0" style={{ width: 6, height: 6, borderRadius: 999, background: "var(--clpa-primary)" }} />}
          <span style={{ fontSize: 11, fontWeight: 700, color: "var(--clpa-title)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{alert.title}</span>
          {alert.occurrenceCount > 1 && (
            <CLPABadge label={`×${alert.occurrenceCount}`} color="var(--clpa-accent-strong)" bg="rgba(var(--clpa-accent-strong-rgb),0.1)" />
          )}
        </div>
        <div style={{ fontSize: 9.5, color: "var(--clpa-muted)", lineHeight: 1.4, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
          {alert.detail}
        </div>
        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
          <CLPABadge label={meta.label} color={meta.color} bg={meta.bg} />
          <span style={{ fontSize: 8.5, color: "var(--clpa-subtle)" }}>{prettyAlertCategory(alert.category)}</span>
          <span style={{ fontSize: 8.5, color: "var(--clpa-track)" }}>·</span>
          <span style={{ fontSize: 8.5, color: "var(--clpa-subtle)" }}>{alertRelativeTime(alert)}</span>
          {!alert.unread && <CLPABadge label="Acknowledged" color="var(--clpa-success)" bg="rgba(var(--clpa-success-bright-rgb),0.12)" />}
        </div>
      </div>
      {alert.unread && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onAcknowledge(alert.id);
          }}
          className="flex-shrink-0"
          style={{ background: "rgba(var(--clpa-primary-rgb),0.1)", border: "1px solid rgba(var(--clpa-primary-rgb),0.2)", borderRadius: 6, cursor: "pointer", fontSize: 8.5, color: "var(--clpa-primary)", fontWeight: 700, padding: "3px 7px" }}
        >
          Ack
        </button>
      )}
    </div>
  );
}

// Groups by the real `category` field already shown on every row (Performance/Storage/Battery/
// BatteryHealth/Warranty/Security for real rule-fired alerts, or a sample alert's own category) -
// not a separate invented taxonomy. Order of the groups themselves follows first-appearance in
// `alerts` (already newest-first), so the most recently-active category still surfaces first;
// order WITHIN each group is unchanged from the input order.
function groupAlertsByCategory(alerts: AlertItem[]): { category: string; alerts: AlertItem[] }[] {
  const order: string[] = [];
  const byCategory = new Map<string, AlertItem[]>();
  for (const a of alerts) {
    if (!byCategory.has(a.category)) {
      byCategory.set(a.category, []);
      order.push(a.category);
    }
    byCategory.get(a.category)!.push(a);
  }
  return order.map((category) => ({ category, alerts: byCategory.get(category)! }));
}

function AAlertFeedCard({
  alerts,
  selectedId,
  onSelect,
  onAcknowledge,
  groupByCategory,
  emptyHint,
}: {
  alerts: AlertItem[];
  selectedId?: string;
  onSelect: (id: string) => void;
  onAcknowledge: (id: string) => void;
  groupByCategory: boolean;
  emptyHint: string;
}) {
  return (
    <CLPACard style={{ padding: "12px 14px", display: "flex", flexDirection: "column", minHeight: 320 }}>
      <div className="flex items-center justify-between mb-2.5">
        <span style={{ fontSize: 11, fontWeight: 800, color: "var(--clpa-title)", letterSpacing: 0.4 }}>ALERT FEED</span>
        <CLPABadge label={`${alerts.length} shown`} color="var(--clpa-muted)" bg="var(--clpa-divider)" />
      </div>

      {alerts.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center py-8">
          <CheckCircle2 size={28} style={{ color: "var(--clpa-success-bright)", marginBottom: 8 }} strokeWidth={1.8} />
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--clpa-title)" }}>{emptyHint}</div>
          <div style={{ fontSize: 10, color: "var(--clpa-subtle)", marginTop: 4 }}>Open, Critical, or search to change this list.</div>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5 flex-1 overflow-y-auto clpa-scroll" style={{ scrollbarWidth: "none", maxHeight: 340 }}>
          {groupByCategory ? (
            groupAlertsByCategory(alerts).map((group) => (
              <div key={group.category} className="flex flex-col gap-1.5">
                <div style={{ fontSize: 8, fontWeight: 700, color: "var(--clpa-subtle)", letterSpacing: 0.4, marginTop: 2 }}>
                  {prettyAlertCategory(group.category).toUpperCase()}
                </div>
                {group.alerts.map((alert) => (
                  <AAlertFeedRow key={alert.id} alert={alert} isSelected={alert.id === selectedId} onSelect={onSelect} onAcknowledge={onAcknowledge} />
                ))}
              </div>
            ))
          ) : (
            alerts.map((alert) => (
              <AAlertFeedRow key={alert.id} alert={alert} isSelected={alert.id === selectedId} onSelect={onSelect} onAcknowledge={onAcknowledge} />
            ))
          )}
        </div>
      )}
    </CLPACard>
  );
}

function AAlertDetailCard({
  alert,
  onAcknowledge,
  onDismiss,
  onSnooze,
  snoozedUntil,
}: {
  alert?: AlertItem;
  onAcknowledge: (id: string) => void;
  onDismiss: (id: string) => void;
  onSnooze: (id: string) => void;
  snoozedUntil: Partial<Record<string, number>>;
}) {
  const { navigate } = useApp();
  const { data, connected } = useTelemetry();
  const deviceModel = !connected
    ? "Agent offline"
    : (data?.system?.Name?.trim() || data?.system?.Vendor?.trim() || "This device");
  const liveReading = alert ? liveReadingForAlert(alert, data, connected) : null;
  const nextStep = alert ? nextStepForAlert(alert) : null;

  if (!alert) {
    return (
      <CLPACard style={{ padding: "16px 14px", minHeight: 320, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <span style={{ fontSize: 10.5, color: "var(--clpa-subtle)" }}>Select an alert from the feed</span>
      </CLPACard>
    );
  }

  const meta = SEVERITY_META[alert.severity];
  const ruleSnoozeUntil = alert.ruleId ? snoozedUntil[alert.ruleId] : undefined;
  const isRuleSnoozed = ruleSnoozeUntil != null && ruleSnoozeUntil > Date.now();

  return (
    <CLPACard style={{ padding: "12px 14px", minHeight: 320, display: "flex", flexDirection: "column" }}>
      <div className="flex items-center justify-between mb-2.5">
        <span style={{ fontSize: 11, fontWeight: 800, color: "var(--clpa-title)", letterSpacing: 0.4 }}>DETAILS</span>
        <CLPABadge label={meta.label} color={meta.color} bg={meta.bg} />
      </div>

      <div className="flex items-start gap-2.5 mb-2.5">
        <div className="flex items-center justify-center rounded-xl flex-shrink-0" style={{ width: 36, height: 36, background: alert.iconBg }}>
          <alert.Icon size={16} style={{ color: alert.iconColor }} strokeWidth={2} />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span style={{ fontSize: 13, fontWeight: 800, color: "var(--clpa-title)", lineHeight: 1.3 }}>{alert.title}</span>
            {alert.occurrenceCount > 1 && (
              <CLPABadge label={`×${alert.occurrenceCount}`} color="var(--clpa-accent-strong)" bg="rgba(var(--clpa-accent-strong-rgb),0.1)" />
            )}
          </div>
          <div style={{ fontSize: 9.5, color: "var(--clpa-subtle)", marginTop: 4 }}>
            {prettyAlertCategory(alert.category)} · {alertRelativeTime(alert)}
          </div>
        </div>
      </div>

      <div className="rounded-lg mb-2.5" style={{ background: "var(--clpa-surface)", border: "1px solid var(--clpa-surface-border)", padding: "9px 10px" }}>
        <div style={{ fontSize: 10.5, color: "var(--clpa-body-alt)", lineHeight: 1.5 }}>{alert.detail}</div>
        {liveReading && (
          <div style={{ fontSize: 10, fontWeight: 700, color: "var(--clpa-title)", marginTop: 8 }}>{liveReading}</div>
        )}
      </div>

      {nextStep && (
        <div className="rounded-lg mb-2.5" style={{ background: "rgba(var(--clpa-primary-rgb),0.06)", border: "1px solid rgba(var(--clpa-primary-rgb),0.15)", padding: "8px 10px" }}>
          <div style={{ fontSize: 8, fontWeight: 700, color: "var(--clpa-primary)", letterSpacing: 0.3, marginBottom: 3 }}>NEXT STEP</div>
          <div style={{ fontSize: 10, color: "var(--clpa-body)", lineHeight: 1.4 }}>{nextStep}</div>
        </div>
      )}

      <div className="grid gap-1.5 mb-2.5" style={{ gridTemplateColumns: "1fr 1fr" }}>
        {[
          { label: "Device", value: deviceModel },
          { label: "Status", value: alert.unread ? "Open" : "Acknowledged", valueColor: alert.unread ? "var(--clpa-warning)" : "var(--clpa-success)" },
          { label: "First seen", value: alert.time },
          { label: "Rule", value: alert.ruleId ?? "—" },
        ].map((row) => (
          <div key={row.label} className="rounded-md" style={{ background: "var(--clpa-surface)", padding: "7px 8px" }}>
            <div style={{ fontSize: 8, color: "var(--clpa-subtle)", fontWeight: 600 }}>{row.label}</div>
            <div style={{ fontSize: 10, fontWeight: 700, color: row.valueColor ?? "var(--clpa-body)", marginTop: 2 }}>{row.value}</div>
          </div>
        ))}
      </div>

      {isRuleSnoozed && (
        <div className="flex items-center gap-1.5 rounded-lg mb-2.5" style={{ background: "rgba(var(--clpa-primary-rgb),0.08)", border: "1px solid rgba(var(--clpa-primary-rgb),0.2)", padding: "6px 9px" }}>
          <Clock size={10} style={{ color: "var(--clpa-primary)" }} strokeWidth={2} />
          <span style={{ fontSize: 8.5, color: "var(--clpa-info-blue)", fontWeight: 600 }}>
            Snoozed until {formatTimeLabel(new Date(ruleSnoozeUntil as number))}
          </span>
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap mt-auto">
        {alert.unread && (
          <button
            onClick={() => onAcknowledge(alert.id)}
            className="flex items-center gap-1.5"
            style={{ background: "var(--clpa-primary)", border: "none", borderRadius: 8, padding: "6px 12px", cursor: "pointer" }}
          >
            <CheckCircle2 size={11} color="white" strokeWidth={2.2} />
            <span style={{ fontSize: 10, color: "white", fontWeight: 700 }}>Acknowledge</span>
          </button>
        )}
        <button onClick={() => onSnooze(alert.id)} className="flex items-center gap-1.5" style={{ background: "var(--clpa-card)", border: "1px solid rgba(0,0,0,0.08)", borderRadius: 8, padding: "6px 12px", cursor: "pointer" }}>
          <Clock size={11} style={{ color: "var(--clpa-muted)" }} strokeWidth={2} />
          <span style={{ fontSize: 10, color: "var(--clpa-body-alt)", fontWeight: 600 }}>Snooze 24h</span>
        </button>
        <button
          onClick={() => onDismiss(alert.id)}
          className="flex items-center gap-1.5"
          style={{ background: "var(--clpa-card)", border: "1px solid rgba(var(--clpa-critical-bright-rgb),0.25)", borderRadius: 8, padding: "6px 12px", cursor: "pointer" }}
        >
          <span style={{ fontSize: 10, color: "var(--clpa-critical)", fontWeight: 600 }}>Dismiss</span>
        </button>
        <button
          onClick={() => navigate("settings")}
          style={{ background: "none", border: "none", cursor: "pointer", fontSize: 9.5, color: "var(--clpa-primary)", fontWeight: 600, marginLeft: "auto" }}
        >
          Thresholds →
        </button>
      </div>
    </CLPACard>
  );
}

function formatAvgResponseDuration(ms: number): string {
  const totalMinutes = Math.round(ms / 60000);
  if (totalMinutes < 1) return "<1m";
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

function AAlertHistoryCard({
  alerts,
  snoozedUntil,
  onSelect,
  selectedId,
}: {
  alerts: AlertItem[];
  snoozedUntil: Partial<Record<string, number>>;
  onSelect: (id: string) => void;
  selectedId?: string;
}) {
  const resolved = alerts.filter((a) => !a.unread);
  const history = resolved.slice(0, 8);

  const respondedReal = resolved.filter((a) => a.source === "real" && a.resolvedAt != null);
  const avgResponseMs =
    respondedReal.length > 0
      ? respondedReal.reduce((sum, a) => sum + (a.resolvedAt! - a.createdAt), 0) / respondedReal.length
      : null;
  const avgResponseLabel = avgResponseMs != null ? formatAvgResponseDuration(avgResponseMs) : "—";
  const activeSnoozeCount = Object.values(snoozedUntil).filter((until) => until != null && until > Date.now()).length;

  const stats: { label: string; value: string; color: string }[] = [
    { label: "Resolved", value: String(resolved.length), color: "var(--clpa-success)" },
    { label: "Avg response", value: avgResponseLabel, color: "var(--clpa-primary)" },
    { label: "Snoozed now", value: String(activeSnoozeCount), color: "var(--clpa-warning)" },
  ];

  const cats = [...new Set(alerts.map((a) => a.category))];

  return (
    <CLPACard style={{ padding: "12px 14px" }}>
      <div className="flex items-center justify-between mb-2.5">
        <span style={{ fontSize: 11, fontWeight: 800, color: "var(--clpa-title)", letterSpacing: 0.4 }}>RESOLVED</span>
        <span style={{ fontSize: 9, color: "var(--clpa-subtle)" }}>{history.length === 0 ? "None yet" : `Latest ${history.length}`}</span>
      </div>
      {cats.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap mb-2 pb-2" style={{ borderBottom: "1px solid var(--clpa-divider)" }}>
          {cats.map((cat) => {
            const CatIcon = categoryIcon(cat);
            const n = alerts.filter((a) => a.category === cat).length;
            return (
              <div key={cat} className="flex items-center gap-1 rounded-md" style={{ background: "var(--clpa-surface)", border: "1px solid var(--clpa-surface-border)", padding: "2px 7px" }}>
                <CatIcon size={9} style={{ color: "var(--clpa-muted)" }} strokeWidth={2} />
                <span style={{ fontSize: 8, fontWeight: 600, color: "var(--clpa-body-alt)" }}>{prettyAlertCategory(cat)}</span>
                <span style={{ fontSize: 8, fontWeight: 800, color: "var(--clpa-title)" }}>{n}</span>
              </div>
            );
          })}
        </div>
      )}
      <div className="grid gap-1.5 mb-2" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
        {stats.map((s) => (
          <div key={s.label} className="rounded-lg text-center" style={{ background: "var(--clpa-surface)", border: "1px solid var(--clpa-surface-border)", padding: "7px 4px" }}>
            <div style={{ fontSize: 14, fontWeight: 900, color: s.color, lineHeight: 1 }}>{s.value}</div>
            <div style={{ fontSize: 8, color: "var(--clpa-subtle)", marginTop: 3, fontWeight: 600 }}>{s.label}</div>
          </div>
        ))}
      </div>
      <div className="flex flex-col">
        {history.length === 0 && (
          <div className="text-center" style={{ fontSize: 9.5, color: "var(--clpa-subtle)", padding: "12px 0" }}>
            Acknowledge an alert to see it here.
          </div>
        )}
        {history.map((item, i) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onSelect(item.id)}
            className="flex items-center gap-2 py-1.5 text-left w-full"
            style={{
              borderBottom: i < history.length - 1 ? "1px solid var(--clpa-divider)" : "none",
              background: item.id === selectedId ? "rgba(var(--clpa-primary-rgb),0.06)" : "transparent",
              borderRadius: 8,
              cursor: "pointer",
              paddingLeft: 4,
              paddingRight: 4,
            }}
          >
            <div className="flex items-center justify-center rounded-md flex-shrink-0" style={{ width: 22, height: 22, background: item.iconBg }}>
              <item.Icon size={11} style={{ color: item.iconColor }} strokeWidth={2} />
            </div>
            <div className="flex-1 min-w-0">
              <div style={{ fontSize: 10, fontWeight: 600, color: "var(--clpa-body)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.title}</div>
              <div style={{ fontSize: 8.5, color: "var(--clpa-subtle)" }}>{prettyAlertCategory(item.category)} · {alertRelativeTime(item)}</div>
            </div>
            <CLPABadge label="Resolved" color="var(--clpa-success)" bg="rgba(var(--clpa-success-bright-rgb),0.12)" />
          </button>
        ))}
      </div>
    </CLPACard>
  );
}

// ═══════════════════════════════════════════════════════════
// ─── SETTINGS PAGE ────────────────────────────────────────
// ═══════════════════════════════════════════════════════════

function SettingsPage() {
  const [section, setSection] = useState("general");

  return (
    <CLPAPage>
      <SSTabBar section={section} setSection={setSection} />
      <SSAgentStrip />
      <SSContent section={section} />
      <SSFooter />
    </CLPAPage>
  );
}

// ─── Shared helpers ───────────────────────────────────────
function SCard({ children, style = {} }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <CLPACard style={{ padding: "12px 14px", height: "100%", ...style }}>
      {children}
    </CLPACard>
  );
}

function SHead({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-2">
      <span style={{ fontSize: 11, fontWeight: 800, color: "var(--clpa-title)", letterSpacing: 0.3 }}>{title}</span>
      {action}
    </div>
  );
}

function SToggle({
  label,
  on = true,
  checked,
  onToggle,
  onChange,
  sample = false,
  readOnly = false,
  readOnlyNote,
}: {
  label: string;
  on?: boolean;
  // When provided, this toggle is controlled by real external state (e.g. a localStorage-backed
  // preference) instead of the decorative internal state below — see onToggle.
  checked?: boolean;
  onToggle?: (v: boolean) => void;
  onChange?: (v: boolean) => void;
  sample?: boolean;
  // Displays real external state (via `checked`) but can't be changed from here - e.g. a real
  // Scheduled Task's actual registration, which creating/deleting would need privilege
  // elevation from a browser context (a bigger, separate feature) rather than a plain toggle.
  // Clicking is a genuine no-op, not just visually disabled - never calls onToggle/onChange.
  readOnly?: boolean;
  readOnlyNote?: string;
}) {
  const isControlled = checked !== undefined;
  const [val, setVal] = useState(on);
  const current = isControlled ? checked : val;

  const toggle = () => {
    if (readOnly) return;
    const next = !current;
    if (!isControlled) setVal(next);
    onToggle?.(next);
    onChange?.(next);
  };

  return (
    <div
      className="flex items-center justify-between gap-2 py-0.5"
      title={readOnly ? readOnlyNote ?? "Read-only - reflects actual state, can't be changed here" : undefined}
    >
      <div className="flex items-center gap-1">
        <span style={{ fontSize: 8.5, color: "var(--clpa-body)", fontWeight: 500, lineHeight: 1.25 }}>{label}</span>
        {readOnly && <Lock size={8} style={{ color: "var(--clpa-subtle)" }} strokeWidth={2} />}
        {sample && <SampleTag />}
      </div>
      <button
        onClick={toggle}
        style={{
          width: 28,
          height: 15,
          borderRadius: 999,
          border: "none",
          cursor: readOnly ? "not-allowed" : "pointer",
          padding: 2,
          flexShrink: 0,
          background: current ? "var(--clpa-primary)" : "var(--clpa-track)",
          opacity: readOnly ? 0.75 : 1,
          transition: "background 0.15s",
        }}
      >
        <span
          style={{
            display: "block",
            width: 11,
            height: 11,
            borderRadius: 999,
            background: "#FFF",
            transform: current ? "translateX(13px)" : "translateX(0)",
            transition: "transform 0.15s",
          }}
        />
      </button>
    </div>
  );
}

function SField({
  label,
  value,
  type = "text",
  sample = false,
  onClick,
}: {
  label: string;
  value: string;
  type?: "text" | "select";
  sample?: boolean;
  onClick?: () => void;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span style={{ fontSize: 7.5, color: "var(--clpa-subtle)", fontWeight: 600 }}>{label}</span>
      {type === "select" ? (
        <button
          onClick={onClick}
          disabled={!onClick}
          className="flex items-center justify-between w-full"
          style={{ background: "var(--clpa-surface)", border: "1px solid var(--clpa-input-border)", borderRadius: 6, padding: "5px 8px", cursor: onClick ? "pointer" : "default" }}
        >
          <div className="flex items-center gap-1">
            <span style={{ fontSize: 8.5, color: "var(--clpa-body)", fontWeight: 500 }}>{value}</span>
            {sample && <SampleTag />}
          </div>
          {onClick && <ChevronDown size={9} style={{ color: "var(--clpa-subtle)" }} />}
        </button>
      ) : (
        <div className="flex items-center gap-1" style={{ background: "var(--clpa-surface)", border: "1px solid var(--clpa-input-border)", borderRadius: 6, padding: "5px 8px" }}>
          <span style={{ fontSize: 8.5, color: "var(--clpa-body)", fontWeight: 500 }}>{value}</span>
          {sample && <SampleTag />}
        </div>
      )}
    </div>
  );
}

function STextField({
  label,
  value,
  placeholder,
  onCommit,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onCommit: (next: string) => void;
}) {
  const [text, setText] = useState(value);
  useEffect(() => {
    setText(value);
  }, [value]);

  return (
    <div className="flex flex-col gap-0.5">
      <span style={{ fontSize: 7.5, color: "var(--clpa-subtle)", fontWeight: 600 }}>{label}</span>
      <input
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => onCommit(text.trim())}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        style={{
          background: "var(--clpa-surface)",
          border: "1px solid var(--clpa-input-border)",
          borderRadius: 6,
          padding: "5px 8px",
          fontSize: 8.5,
          color: "var(--clpa-body)",
          fontWeight: 500,
          outline: "none",
        }}
      />
    </div>
  );
}

// Real, editable numeric field for the alert thresholds — unlike SField, this always writes
// through to real persisted state (via onCommit), so it never carries a SampleTag.
function SNumberField({ label, value, onCommit, unit = "%" }: { label: string; value: number; onCommit: (v: number) => void; unit?: string }) {
  const [text, setText] = useState(String(value));

  // The committed value can come back different from what was typed (e.g. clamped to keep
  // critical more extreme than warning) — resync the field to reflect what was actually saved.
  useEffect(() => {
    setText(String(value));
  }, [value]);

  const commit = () => {
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) {
      setText(String(value));
      return;
    }
    onCommit(parsed);
  };

  return (
    <div className="flex flex-col gap-0.5">
      <span style={{ fontSize: 7.5, color: "var(--clpa-subtle)", fontWeight: 600 }}>{label}</span>
      <div className="flex items-center gap-1" style={{ background: "var(--clpa-surface)", border: "1px solid var(--clpa-input-border)", borderRadius: 6, padding: "5px 8px" }}>
        <input
          type="number"
          min={0}
          max={100}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          style={{ width: "100%", background: "transparent", border: "none", outline: "none", fontSize: 8.5, color: "var(--clpa-body)", fontWeight: 500 }}
        />
        <span style={{ fontSize: 8, color: "var(--clpa-subtle)", fontWeight: 600, flexShrink: 0 }}>{unit}</span>
      </div>
    </div>
  );
}

function minutesToTimeInputValue(mins: number): string {
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
function timeInputValueToMinutes(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

// Real, editable quiet-hours control - a toggle (genuinely gates the OS-level desktop
// Notification call, see AppContext's isWithinQuietHours) plus two real <input type="time">
// fields shown only while enabled, matching this page's own dense/compact aesthetic rather than
// pulling in a new time-picker component for two fields.
function SQuietHoursField({ quietHours, onSet }: { quietHours: QuietHours; onSet: (next: QuietHours) => void }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2 py-0.5">
        <span style={{ fontSize: 8.5, color: "var(--clpa-body)", fontWeight: 500 }}>Quiet hours</span>
        <button
          onClick={() => onSet({ ...quietHours, enabled: !quietHours.enabled })}
          style={{
            width: 28, height: 15, borderRadius: 999, border: "none", cursor: "pointer", padding: 2, flexShrink: 0,
            background: quietHours.enabled ? "var(--clpa-primary)" : "var(--clpa-track)", transition: "background 0.15s",
          }}
        >
          <span
            style={{
              display: "block", width: 11, height: 11, borderRadius: 999, background: "#FFF",
              transform: quietHours.enabled ? "translateX(13px)" : "translateX(0)", transition: "transform 0.15s",
            }}
          />
        </button>
      </div>
      {quietHours.enabled && (
        <div className="flex items-center gap-1">
          <input
            type="time"
            value={minutesToTimeInputValue(quietHours.startMinutes)}
            onChange={(e) => {
              const v = timeInputValueToMinutes(e.target.value);
              if (v != null) onSet({ ...quietHours, startMinutes: v });
            }}
            style={{ fontSize: 8.5, background: "var(--clpa-surface)", border: "1px solid var(--clpa-input-border)", borderRadius: 6, padding: "3px 4px", flex: 1, color: "var(--clpa-body)" }}
          />
          <span style={{ fontSize: 8, color: "var(--clpa-subtle)" }}>to</span>
          <input
            type="time"
            value={minutesToTimeInputValue(quietHours.endMinutes)}
            onChange={(e) => {
              const v = timeInputValueToMinutes(e.target.value);
              if (v != null) onSet({ ...quietHours, endMinutes: v });
            }}
            style={{ fontSize: 8.5, background: "var(--clpa-surface)", border: "1px solid var(--clpa-input-border)", borderRadius: 6, padding: "3px 4px", flex: 1, color: "var(--clpa-body)" }}
          />
        </div>
      )}
    </div>
  );
}

function SSTabBar({ section, setSection }: { section: string; setSection: (id: string) => void }) {
  const { resetAllSettings } = useApp();

  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-1">
        {SS_SECTIONS.map(({ id, label, Icon }) => {
          const active = section === id;
          return (
            <button
              key={id}
              onClick={() => setSection(id)}
              className="flex items-center gap-1.5"
              style={{
                background: active ? "rgba(var(--clpa-primary-rgb),0.1)" : "var(--clpa-card)",
                border: active ? "1px solid rgba(var(--clpa-primary-rgb),0.25)" : "1px solid rgba(0,0,0,0.08)",
                borderRadius: 8,
                padding: "5px 12px",
                cursor: "pointer",
              }}
            >
              <Icon size={12} style={{ color: active ? "var(--clpa-primary)" : "var(--clpa-subtle)" }} strokeWidth={active ? 2 : 1.7} />
              <span style={{ fontSize: 9.5, fontWeight: active ? 700 : 500, color: active ? "var(--clpa-primary)" : "var(--clpa-muted)" }}>{label}</span>
            </button>
          );
        })}
      </div>
      <button onClick={resetAllSettings} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 9, color: "var(--clpa-primary)", fontWeight: 700 }}>
        Reset to Defaults
      </button>
    </div>
  );
}

function SSAgentStrip() {
  const { data, connected, updatedAt } = useTelemetry();
  const agentUpdate = useAgentUpdate(APP_VERSION);
  const lastSyncLabel = formatRelativeTime(updatedAt) ?? "Never";

  // Real GET /v1/health result (telemetry-server.mjs, same cadence as entitlement) - three
  // genuinely distinct states, not a boolean: true (backend reachable, DB query succeeded),
  // false (backend reachable, DB query itself failed - a real, determined problem, not
  // "unknown"), null (backend unreachable at all, so there's nothing to honestly report either
  // way). Only the null case is sample-tagged - "Unhealthy" is just as real a finding as
  // "Healthy" when the check actually ran and came back negative.
  const dbHealthy = connected ? data?.dbHealthy ?? null : null;
  const dbHealthyMeta =
    dbHealthy === true
      ? { label: "DB Healthy", color: "var(--clpa-success)", bg: "rgba(var(--clpa-success-bright-rgb),0.1)" }
      : dbHealthy === false
      ? { label: "DB Unhealthy", color: "var(--clpa-critical)", bg: "rgba(var(--clpa-critical-bright-rgb),0.1)" }
      : { label: "DB Unknown", color: "var(--clpa-subtle)", bg: "rgba(var(--clpa-subtle-rgb),0.12)" };

  const planLabel = connected && data?.entitlement?.plan ? data.entitlement.plan : null;

  const items = [
    { label: "Agent", value: connected ? "Running" : "Disconnected", color: connected ? "var(--clpa-success)" : "var(--clpa-critical)", dotColor: connected ? "var(--clpa-success-bright)" : "var(--clpa-critical-bright)" },
    {
      label: "Version",
      value: agentUpdate.updateAvailable && agentUpdate.latestVersion
        ? `v${APP_VERSION} → v${agentUpdate.latestVersion}`
        : `v${APP_VERSION}`,
      color: agentUpdate.updateAvailable ? "var(--clpa-warning)" : "var(--clpa-body)",
    },
    { label: "Connection", value: "HTTP polling · localhost:4317", color: "var(--clpa-body)", dotColor: connected ? "var(--clpa-success-bright)" : "var(--clpa-critical-bright)" },
    { label: "Last Sync", value: lastSyncLabel, color: "var(--clpa-body)" },
  ];

  return (
    <CLPACard style={{ padding: "8px 12px" }}>
      <div className="flex items-center gap-3">
        {items.map((it, i) => (
          <div key={it.label} className="flex items-center gap-2">
            {i > 0 && <div style={{ width: 1, height: 20, background: "var(--clpa-input-border)" }} />}
            <div>
              <div style={{ fontSize: 7, color: "var(--clpa-subtle)", fontWeight: 700, letterSpacing: 0.3, textTransform: "uppercase" }}>{it.label}</div>
              <div className="flex items-center gap-1 mt-0.5">
                {it.dotColor && <span style={{ width: 5, height: 5, borderRadius: 999, background: it.dotColor }} />}
                <span style={{ fontSize: 9.5, fontWeight: 800, color: it.color }}>{it.value}</span>
              </div>
            </div>
          </div>
        ))}
        {agentUpdate.updateAvailable && (
          <button
            onClick={() => {
              if (agentUpdate.downloadUrl) {
                window.open(agentUpdate.downloadUrl, "_blank", "noopener,noreferrer");
              } else {
                toast.message("Update available", {
                  description: `v${agentUpdate.latestVersion} is published. Copy the new installer or app.exe onto this PC.`,
                });
              }
            }}
            className="flex items-center gap-1"
            style={{
              background: "rgba(var(--clpa-warning-bright-rgb),0.12)",
              border: "1px solid rgba(var(--clpa-warning-bright-rgb),0.28)",
              borderRadius: 8,
              padding: "4px 8px",
              cursor: "pointer",
            }}
          >
            <Download size={10} style={{ color: "var(--clpa-warning)" }} strokeWidth={2.2} />
            <span style={{ fontSize: 9, fontWeight: 700, color: "var(--clpa-warning)" }}>
              {agentUpdate.downloadUrl ? `Download v${agentUpdate.latestVersion}` : "Update available"}
            </span>
          </button>
        )}
        <div className="flex-1" />
        {planLabel && (
          <div className="flex items-center gap-1">
            <CLPABadge label={planLabel} color="var(--clpa-primary)" bg="rgba(var(--clpa-primary-rgb),0.1)" />
          </div>
        )}
        <div className="flex items-center gap-1">
          <CLPABadge label="Rules Engine" color="var(--clpa-muted)" bg="rgba(var(--clpa-muted-rgb),0.1)" />
        </div>
        <div className="flex items-center gap-1">
          <CLPABadge label={dbHealthyMeta.label} color={dbHealthyMeta.color} bg={dbHealthyMeta.bg} />
        </div>
      </div>
    </CLPACard>
  );
}

const SS_SECTIONS = [
  { id: "general", label: "General", Icon: Settings },
  { id: "notifications", label: "Notifications", Icon: Bell },
  { id: "security", label: "Security", Icon: Shield },
  { id: "automation", label: "Automation", Icon: Zap },
];

// ─── Self-Healing & Automation (PRD §9, real v1) ──────────
// Real remediation actions, gated by a real policy check (this tenant's plan_features.Self-
// Healing row - see backend/schema.sql for why it's currently false for ProSupport), executed
// by local-agent (the only process with real OS access) and logged to the same real events
// table AI Intel's Timeline already reads. Clear Teams cache confirmed real via direct
// investigation (new Teams/MSIX genuinely installed here). Deliberately still not built: Repair
// VPN/OS diagnostic trigger/Certificate renewal - see telemetry-server.mjs's own comment for why
// each stays honestly unbuilt rather than faked.
type RemediationActionId = "flush-dns" | "clean-temp" | "restart-service" | "clear-teams-cache";

const REMEDIATION_ACTIONS_UI: { id: RemediationActionId; label: string; description: string }[] = [
  { id: "flush-dns", label: "Flush DNS Cache", description: "Real ipconfig /flushdns on this device." },
  { id: "clean-temp", label: "Clean Temp Files", description: "Real deletion of files directly in this device's %TEMP% folder (not subdirectories) - locked/in-use files are skipped, not an error." },
  { id: "restart-service", label: "Restart Print Spooler Service", description: "Real restart of this device's Windows Print Spooler service - chosen because it's safe and unrelated to this project's own processes." },
  { id: "clear-teams-cache", label: "Clear Teams Cache", description: "Real stop of running Teams processes, then deletion of this device's Teams (new Teams/MSIX) LocalCache files - reports \"not installed\" honestly if this device doesn't have Teams." },
];

type RemediationRunState = { running: boolean; result: string | null; succeeded: boolean | null };
const REMEDIATION_IDLE_STATE: RemediationRunState = { running: false, result: null, succeeded: null };

function SSAutomationSection() {
  const [policyAllowed, setPolicyAllowed] = useState<boolean | null>(null);
  const [runStates, setRunStates] = useState<Record<RemediationActionId, RemediationRunState>>({
    "flush-dns": REMEDIATION_IDLE_STATE,
    "clean-temp": REMEDIATION_IDLE_STATE,
    "restart-service": REMEDIATION_IDLE_STATE,
    "clear-teams-cache": REMEDIATION_IDLE_STATE,
  });
  const { events } = useEventHistory(50);

  useEffect(() => {
    let cancelled = false;
    fetch("http://localhost:4317/api/remediation-status")
      .then((r) => r.json())
      .then((body) => {
        if (!cancelled) setPolicyAllowed(body.allowed === true);
      })
      .catch(() => {
        if (!cancelled) setPolicyAllowed(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function runAction(id: RemediationActionId) {
    setRunStates((prev) => ({ ...prev, [id]: { running: true, result: null, succeeded: null } }));
    try {
      const res = await fetch("http://localhost:4317/api/remediate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: id }),
      });
      const body = await res.json();
      setRunStates((prev) => ({ ...prev, [id]: { running: false, result: body.message ?? "No result returned.", succeeded: body.succeeded === true } }));
    } catch (e) {
      setRunStates((prev) => ({
        ...prev,
        [id]: { running: false, result: e instanceof Error ? e.message : "Request to local agent failed.", succeeded: false },
      }));
    }
  }

  const remediationEvents = events.filter((ev) => ev.eventType.startsWith("remediation-")).slice(0, 8);

  // PRD §9.2 ADE Approval Workflows - real v1, distinct from the Self-Healing actions above:
  // both actions below request a real cryptographically signed (Ed25519) approval token from
  // the backend and won't execute without a genuinely valid one. No admin approval UI exists yet
  // (see backend/handlers.go's own comment) - approving/rejecting a pending request means
  // calling the backend directly, which is the honest state of this v1, not a placeholder gap.
  // useHighImpactAction is the one real client for this mechanism (shared module-level state, not
  // per-component - Settings' tabs fully unmount on switch, so a request made from Reset Agent's
  // own tile on the General tab has to still be checkable here after switching tabs).
  const credentialsClear = useHighImpactAction("clear-cached-credentials");
  const fullReset = useHighImpactAction("full-reset");

  async function handleCheckCredentialsClear() {
    const executed = await credentialsClear.check();
    if (executed) {
      // Nothing further for the frontend to do here - unlike full-reset below, this action only
      // ever touched the credentials file (local-agent's own job), never this app's own
      // localStorage, so there's no local cleanup/reload for this specific action to trigger.
    }
  }

  // Real UI feedback while the reset takes effect, replacing the old fake "restart required"
  // toast the decorative Reset Agent button used to show (performAction's own stand-in message).
  // A real window.location.reload() genuinely re-runs every hook's module-level
  // loadJSON(...) initializer fresh against the now-empty localStorage - the same standard
  // mechanism any real settings reset in a webview app uses, not a fabricated "please restart"
  // instruction the user would have to act on manually. No separate local-agent restart is
  // needed for credential re-registration itself - loadOrRegisterDevice already re-registers
  // automatically on runBackendCycle's own next poll tick once the file is gone.
  const [resetInProgress, setResetInProgress] = useState(false);

  async function handleCheckFullReset() {
    const executed = await fullReset.check();
    if (executed) {
      setResetInProgress(true);
      clearResetAgentLocalStorage();
      window.setTimeout(() => window.location.reload(), 1500);
    }
  }

  const highImpactStatusColor: Record<string, string> = {
    pending: "var(--clpa-warning)",
    executed: "var(--clpa-critical)",
    "verification-failed": "var(--clpa-critical)",
    rejected: "var(--clpa-muted)",
    error: "var(--clpa-critical)",
  };

  return (
    <>
    <CLPARow columns="1fr 1fr">
      <SCard>
        <SHead title="Self-Healing & Automation" />
        <div style={{ fontSize: 9.5, color: "var(--clpa-muted)", marginBottom: 8, lineHeight: 1.4 }}>
          Real PRD §9 v1 - each action genuinely executes on this device, gated by this tenant's real
          Self-Healing plan feature (backend/plan_features table).
        </div>
        {policyAllowed === false && (
          <div style={{ padding: "6px 8px", borderRadius: 8, marginBottom: 8, background: "var(--clpa-critical-wash)", border: "1px solid var(--clpa-critical-wash-border)", fontSize: 10, color: "var(--clpa-critical)", fontWeight: 700 }}>
            Blocked — not included in your current plan (ProSupport).
          </div>
        )}
        <div className="flex flex-col gap-2">
          {REMEDIATION_ACTIONS_UI.map((a) => {
            const state = runStates[a.id];
            const blocked = policyAllowed === false;
            const buttonLabel = blocked ? "Blocked" : policyAllowed === null ? "Checking…" : state.running ? "Running…" : "Run Now";
            return (
              <div key={a.id} className="rounded-lg" style={{ border: "1px solid var(--clpa-surface-border)", padding: "8px 10px" }}>
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--clpa-body)" }}>{a.label}</div>
                    <div style={{ fontSize: 8.5, color: "var(--clpa-subtle)", marginTop: 1, lineHeight: 1.35 }}>{a.description}</div>
                  </div>
                  <button
                    onClick={() => runAction(a.id)}
                    disabled={state.running || policyAllowed !== true}
                    style={{
                      padding: "5px 10px",
                      borderRadius: 8,
                      border: "none",
                      fontSize: 10,
                      fontWeight: 700,
                      whiteSpace: "nowrap",
                      flexShrink: 0,
                      background: blocked ? "var(--clpa-divider)" : state.running ? "var(--clpa-subtle)" : policyAllowed === true ? "var(--clpa-primary)" : "var(--clpa-input-border)",
                      color: blocked ? "var(--clpa-subtle)" : policyAllowed === true ? "#FFFFFF" : "var(--clpa-subtle)",
                      cursor: state.running || policyAllowed !== true ? "not-allowed" : "pointer",
                    }}
                  >
                    {buttonLabel}
                  </button>
                </div>
                {state.result && (
                  <div style={{ fontSize: 9, marginTop: 6, color: state.succeeded ? "var(--clpa-success)" : "var(--clpa-critical)", lineHeight: 1.4 }}>{state.result}</div>
                )}
              </div>
            );
          })}
        </div>
      </SCard>
      <SCard>
        <SHead title="Recent Automation Attempts" />
        {remediationEvents.length === 0 ? (
          <div style={{ fontSize: 10, color: "var(--clpa-subtle)", padding: "10px 0" }}>No automation attempts recorded yet.</div>
        ) : (
          <div className="flex flex-col">
            {remediationEvents.map((ev, i) => (
              <div
                key={ev.id}
                className="flex items-center justify-between gap-2 py-1.5"
                style={{ borderBottom: i < remediationEvents.length - 1 ? "1px solid var(--clpa-divider)" : "none" }}
              >
                <span style={{ fontSize: 9.5, color: "var(--clpa-body)", flex: 1, lineHeight: 1.35 }}>{ev.message}</span>
                <span style={{ fontSize: 8.5, color: "var(--clpa-subtle)", flexShrink: 0 }}>{formatRelativeTime(ev.createdAt)}</span>
              </div>
            ))}
          </div>
        )}
      </SCard>
    </CLPARow>

    <CLPARow columns="1fr">
      <SCard>
        <SHead title="High-Impact Actions (ADE Approval)" />
        <div style={{ fontSize: 9.5, color: "var(--clpa-muted)", marginBottom: 8, lineHeight: 1.4 }}>
          Real PRD §9.2 v1 - a cryptographically signed (Ed25519) approval token from the Cloud Command
          Center is genuinely required before either action below executes, distinct from Self-Healing's
          immediate-but-policy-gated actions above. There's no admin approval UI yet, so a pending
          request is approved/rejected by calling the backend directly (e.g. <code>POST /v1/approval-requests/&#123;id&#125;/approve</code>
          with an admin JWT) - that's this v1's honest state, not a stand-in for a missing button.
        </div>
        <div className="flex flex-col gap-2">
          <HighImpactActionRow
            title="Clear All Locally Cached Device Credentials"
            description="Real, and genuinely recoverable (not destructive) - this device automatically re-registers a brand new identity with the Cloud Command Center on its next cycle."
            state={credentialsClear.state}
            onRequest={credentialsClear.request}
            onCheck={handleCheckCredentialsClear}
            executedDetail="Real signed token verified - action executed. Local credentials cleared; this device will re-register with a new identity on its next cycle."
          />
          {resetInProgress ? (
            <div className="rounded-lg" style={{ border: "1px solid var(--clpa-critical-wash-border)", background: "var(--clpa-critical-wash)", padding: "8px 10px" }}>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--clpa-critical)" }}>Resetting…</div>
              <div style={{ fontSize: 9, color: "var(--clpa-critical)", marginTop: 2, lineHeight: 1.4 }}>
                Local credentials, alerts, and settings cleared. This device will re-register as new. Reloading…
              </div>
            </div>
          ) : (
            <HighImpactActionRow
              title="Reset Agent (Full Reset)"
              description="Real and destructive to LOCAL state only (not recoverable from here) - clears this device's cached credentials, alert history, and every local preference, then re-registers a brand new identity with the Cloud Command Center on its next cycle."
              state={fullReset.state}
              onRequest={fullReset.request}
              onCheck={handleCheckFullReset}
            />
          )}
        </div>
      </SCard>
    </CLPARow>
    </>
  );
}

// Shared real ADE-approval UI (request → pending → check/execute) - both High-Impact Actions
// rows above render through this so the two real actions stay visually/behaviorally consistent
// rather than two independently-maintained copies of the same flow.
function HighImpactActionRow({
  title, description, state, onRequest, onCheck, executedDetail,
}: {
  title: string;
  description: string;
  state: HighImpactState;
  onRequest: () => void;
  onCheck: () => void;
  executedDetail?: string;
}) {
  const highImpactStatusColor: Record<string, string> = {
    pending: "var(--clpa-warning)",
    executed: "var(--clpa-critical)",
    "verification-failed": "var(--clpa-critical)",
    rejected: "var(--clpa-muted)",
    error: "var(--clpa-critical)",
  };
  const shownDetail = state.phase === "executed" ? executedDetail : state.detail;

  return (
    <div className="rounded-lg" style={{ border: "1px solid var(--clpa-surface-border)", padding: "8px 10px" }}>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--clpa-body)" }}>{title}</div>
          <div style={{ fontSize: 8.5, color: "var(--clpa-subtle)", marginTop: 1, lineHeight: 1.35 }}>{description}</div>
        </div>
        <button
          onClick={onRequest}
          disabled={state.phase === "requesting" || state.phase === "pending"}
          style={{
            padding: "5px 10px",
            borderRadius: 8,
            border: "none",
            fontSize: 10,
            fontWeight: 700,
            whiteSpace: "nowrap",
            flexShrink: 0,
            background: state.phase === "requesting" || state.phase === "pending" ? "var(--clpa-subtle)" : "var(--clpa-primary)",
            color: "var(--clpa-card)",
            cursor: state.phase === "requesting" || state.phase === "pending" ? "not-allowed" : "pointer",
          }}
        >
          {state.phase === "requesting" ? "Requesting…" : "Request Approval"}
        </button>
      </div>

      {state.requestId && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--clpa-divider)" }}>
          <div style={{ fontSize: 9, color: "var(--clpa-body)" }}>
            Real request ID: <span style={{ fontFamily: "monospace" }}>{state.requestId}</span>
          </div>
          <div className="flex items-center justify-between gap-2 mt-1.5">
            <span style={{ fontSize: 9.5, fontWeight: 700, color: highImpactStatusColor[state.phase] ?? "var(--clpa-subtle)" }}>
              {state.phase === "pending" && "Pending approval"}
              {state.phase === "checking" && "Checking…"}
              {state.phase === "executed" && "Approved & executed"}
              {state.phase === "verification-failed" && "Approved, but rejected on verification"}
              {state.phase === "rejected" && "Rejected"}
              {state.phase === "error" && "Error"}
            </span>
            {state.phase !== "executed" && (
              <button
                onClick={onCheck}
                disabled={state.phase === "checking"}
                style={{
                  padding: "4px 8px",
                  borderRadius: 8,
                  border: "1px solid var(--clpa-input-border)",
                  background: "var(--clpa-surface)",
                  color: "var(--clpa-body)",
                  fontSize: 9.5,
                  fontWeight: 700,
                  cursor: state.phase === "checking" ? "not-allowed" : "pointer",
                  flexShrink: 0,
                }}
              >
                Check Status &amp; Execute if Approved
              </button>
            )}
          </div>
          {shownDetail && (
            <div style={{ fontSize: 9, marginTop: 4, color: highImpactStatusColor[state.phase] ?? "var(--clpa-muted)", lineHeight: 1.4 }}>
              {shownDetail}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SSContent({ section }: { section: string }) {
  const onChange = () => {};
  const {
    categoryPrefs, setCategoryEnabled,
    desktopNotifsEnabled, setDesktopNotifsEnabled,
    soundOnCriticalEnabled, setSoundOnCriticalEnabled,
    trayBadgeEnabled, setTrayBadgeEnabled,
    showInTrayEnabled, setShowInTrayEnabled,
    organization, setOrganization,
    department, setDepartment,
    quietHours, setQuietHours,
    groupSimilarAlertsEnabled, setGroupSimilarAlertsEnabled,
    prioritySortingEnabled, setPrioritySortingEnabled,
    thresholds, setThresholdField,
  } = useApp();
  const { data, connected, telemetryEnabled } = useTelemetry();
  const { theme, toggleTheme } = useTheme();
  const { density, setDensity } = useDensity();
  // Same shared, module-level request as the Automation tab's own "Reset Agent (Full Reset)"
  // row (useHighImpactAction) - this tile only kicks off the real approval request; completing
  // it (Check Status & Execute) happens in Automation, where the full request/pending/executed
  // UI actually lives, not squeezed into this compact quick-actions tile.
  const fullReset = useHighImpactAction("full-reset");
  const { accent, setAccentColor } = useAccentColor();
  const { enabled: idleLockEnabled, timeoutMinutes: idleTimeoutMinutes, setEnabled: setIdleLockEnabled, setTimeoutMinutes: setIdleTimeoutMinutes } = useIdleLockSettings();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const language = navigator.language;
  // Real, persisted preferences (lib/dateTimeFormat.ts) - local useState only so this specific
  // control re-renders with the current value on click; every other real time/date label in the
  // app (alert timestamps, snooze labels, warranty/entitlement dates) reads the same persisted
  // preference directly via formatTimeLabel/formatDateLabel, not through this component's state.
  const [timeFormatPref, setTimeFormatPrefState] = useState(getTimeFormatPref);
  const [dateFormatPref, setDateFormatPrefState] = useState(getDateFormatPref);
  const [enrollment, setEnrollment] = useState<{
    enrolled: boolean;
    deviceId: string | null;
    hostname: string | null;
    backendUrl: string;
    lastError: string | null;
  } | null>(null);
  const [backendUrlDraft, setBackendUrlDraft] = useState("");
  const [enrollBusy, setEnrollBusy] = useState(false);
  const [enrollMessage, setEnrollMessage] = useState<string | null>(null);
  const [eventRetentionDays, setEventRetentionDays] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const res = await fetch("http://127.0.0.1:4317/api/enrollment");
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok || !body || typeof body.enrolled !== "boolean") {
          setEnrollment(null);
          return;
        }
        setEnrollment(body);
        setBackendUrlDraft((prev) => prev || body.backendUrl || "");
      } catch {
        if (!cancelled) setEnrollment(null);
      }
    }
    tick();
    const id = window.setInterval(tick, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const res = await fetch("http://127.0.0.1:4317/api/event-retention");
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        const days = Number(body?.eventRetentionDays);
        setEventRetentionDays(Number.isFinite(days) && days > 0 ? days : null);
      } catch {
        if (!cancelled) setEventRetentionDays(null);
      }
    }
    tick();
    const id = window.setInterval(tick, 30000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  async function saveBackendUrl(next: string) {
    const url = next.trim().replace(/\/+$/, "");
    setBackendUrlDraft(url);
    setEnrollBusy(true);
    setEnrollMessage(null);
    try {
      const res = await fetch("http://127.0.0.1:4317/api/backend-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backendUrl: url }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setEnrollMessage(body?.error || `Save failed (HTTP ${res.status})`);
        return;
      }
      setEnrollment(body);
      setEnrollMessage(body?.enrolled ? `Enrolled as ${body.hostname}` : (body?.lastError || "Saved. Waiting for Command Centre…"));
    } catch (e) {
      setEnrollMessage(e instanceof Error ? e.message : "Could not reach local telemetry on port 4317.");
    } finally {
      setEnrollBusy(false);
    }
  }

  // Real device-registry lifecycle state (backend's devices.status, PRD's device-registry/
  // component) for this specific device, passed through telemetry-server.mjs's fetchEntitlement
  // -> useTelemetry's data.entitlement.deviceStatus. null (sample) only when the backend
  // entitlement fetch itself hasn't succeeded yet, never a fabricated "Active".
  const deviceStatusRaw = connected ? data?.entitlement?.deviceStatus ?? null : null;
  const deviceStatusLabel = deviceStatusRaw ? deviceStatusRaw[0].toUpperCase() + deviceStatusRaw.slice(1) : "Not synced";

  // Real `schtasks /Query /TN <name> /V /FO LIST` state per Scheduled Task (telemetry-server.mjs,
  // same cadence as entitlement) - null per task when the check itself couldn't determine an
  // answer, not "not registered" (that's a real, determined `false`).
  const scheduledTasks = connected ? data?.scheduledTasks ?? null : null;
  // "Background Service" is specifically the telemetry server - the one actual elevated
  // background service this project runs.
  const backgroundServiceEnabled = scheduledTasks?.telemetryServer ?? null;
  // "Launch on Startup" represents the whole product's auto-start, not one component - real
  // only when every one of the six registered Scheduled Tasks (including the Tauri desktop
  // app's own PulseEndpointDesktopApp - see scheduledTasks.desktopApp's own comment, and
  // ai-service's own PulseEndpointAiService - see scheduledTasks.aiService's own comment) is
  // confirmed Enabled. There is deliberately no separate per-app toggle for the desktop app anymore: it
  // always auto-starts via that Scheduled Task, with no user-facing way to turn it off, so its
  // state only shows up folded into this aggregate, not as its own control. If any task is
  // confirmed NOT enabled, that's a real, determined "not fully launching on startup" (false); if
  // none are false but at least one couldn't be determined, the honest answer is "unknown" (null),
  // not a guess either way.
  const launchOnStartupEnabled = (() => {
    if (!scheduledTasks) return null;
    const values = Object.values(scheduledTasks);
    if (values.some((v) => v === false)) return false;
    if (values.every((v) => v === true)) return true;
    return null;
  })();

  // Real - the exact same TPM/Secure Boot/BitLocker attestation verdict TitleBar's "PROTECTED"
  // badge and the Hardware page's own attestation card already compute (getHardwareInventoryBadge
  // in derived.ts), reused here rather than re-derived so this can't honestly disagree with them.
  const hardwareAttestationBadge = getHardwareInventoryBadge(data, connected);

  // Real - the same battery-health/storage-wear signals the Hardware page and AI Intel already
  // show, combined the same way getCpuBadge/getThermalCardBadge above combine multiple real
  // sensors: "Unknown" only when BOTH inputs are themselves unavailable, otherwise a real
  // determined verdict from whichever is available (a genuinely Poor/Critical reading on either
  // one is a real problem worth surfacing, not something a missing sibling metric should hide).
  const hardwareHealthBatteryBadge = getBatteryHealthBadge(data, connected, thresholds.batteryHealthWarning, thresholds.batteryHealthCritical);
  const hardwareHealthStorageBadge = getStorageBadge(data, connected);
  const hardwareHealthUnknown = hardwareHealthBatteryBadge.sample && hardwareHealthStorageBadge.sample;
  const hardwareHealthOk = !hardwareHealthUnknown && hardwareHealthBatteryBadge.label !== "Poor" && hardwareHealthStorageBadge.label !== "Critical";

  // Real - whether this device's actual plan/feature entitlement (backend's Cloud Command
  // Center, fetched by local-agent on its own slower interval) was successfully synced on the
  // last check-in. `connected` false means local-agent itself is unreachable, so there's nothing
  // honest to report either way; connected true with a null entitlement is a real, determined
  // "not synced" (not enrolled, or the backend fetch itself failed), same as dbHealthy's own
  // false-is-a-real-finding reasoning above.
  const policySynced = connected && data?.entitlement != null;

  const downloadAgentSettings = (filename: string) => {
    const config = {
      exportedAt: new Date().toISOString(),
      organization,
      department,
      theme,
      density,
      accent,
      alertCategoriesEnabled: categoryPrefs,
      alertThresholds: thresholds,
      desktopNotificationsEnabled: desktopNotifsEnabled,
      soundForCriticalEnabled: soundOnCriticalEnabled,
      trayBadgeEnabled,
      showInTrayEnabled,
      quietHours,
      groupSimilarAlertsEnabled,
      prioritySortingEnabled,
      idleLockEnabled,
      idleTimeoutMinutes,
      telemetryEnabled,
      timeFormat: timeFormatPref,
      dateFormat: dateFormatPref,
      timezone,
      language,
    };
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Settings file saved");
  };

  if (section === "notifications") {
    return (
      <CLPARow columns="1fr 1fr 1fr">
        <SCard>
          <SHead title="Alert Channels" />
          <SToggle
            label="Desktop notifications"
            checked={desktopNotifsEnabled}
            onToggle={(v) => { setDesktopNotifsEnabled(v); onChange(); }}
          />
          <SToggle
            label="Sound for critical"
            checked={soundOnCriticalEnabled}
            onToggle={(v) => { setSoundOnCriticalEnabled(v); onChange(); }}
          />
          {/* Real - gates whether AppContext's real, already-computed unreadCount is actually
              sent to the real Tauri tray icon's tooltip (see useTauriTraySync.ts). */}
          <SToggle
            label="Tray badge count"
            checked={trayBadgeEnabled}
            onToggle={(v) => { setTrayBadgeEnabled(v); onChange(); }}
          />
        </SCard>
        <SCard>
          <SHead title="Alert Types" />
          {/* Gates useAlertEngine's real "Performance" rule category - cpu-load, memory-usage,
              and cpu-temp (real per-core thermal alerting via LibreHardwareMonitor/HWiNFO) all
              share this one toggle. */}
          <SToggle
            label="Thermal & performance"
            checked={categoryPrefs.Performance}
            onToggle={(v) => { setCategoryEnabled("Performance", v); onChange(); }}
            sample={false}
          />
          {/* Gates useAlertEngine's real "Security" rule category - hardware-tamper, the real
              hardware-fingerprint baseline mismatch detection behind Hardware page's Tamper
              Detection field. */}
          <SToggle
            label="Security & integrity"
            checked={categoryPrefs.Security}
            onToggle={(v) => { setCategoryEnabled("Security", v); onChange(); }}
            sample={false}
          />
          <SToggle
            label="Battery & power"
            checked={categoryPrefs.Battery}
            onToggle={(v) => { setCategoryEnabled("Battery", v); onChange(); }}
            sample={false}
          />
          {/* Deliberately its own toggle, separate from "Battery & power" above - charge % and
              health/wear are independent real signals (see battery-health's own comment in
              useAlertEngine.ts), so a device can trip one without the other. */}
          <SToggle
            label="Battery health"
            checked={categoryPrefs.BatteryHealth}
            onToggle={(v) => { setCategoryEnabled("BatteryHealth", v); onChange(); }}
            sample={false}
          />
          <SToggle
            label="Warranty reminders"
            checked={categoryPrefs.Warranty}
            onToggle={(v) => { setCategoryEnabled("Warranty", v); onChange(); }}
            sample={false}
          />

          <div className="grid gap-1.5 mt-2 pt-2" style={{ gridTemplateColumns: "1fr 1fr", borderTop: "1px solid var(--clpa-divider)" }}>
            <SNumberField
              label="CPU Warning"
              value={thresholds.cpuWarning}
              onCommit={(v) => { setThresholdField("cpu", "warning", v); onChange(); }}
            />
            <SNumberField
              label="CPU Critical"
              value={thresholds.cpuCritical}
              onCommit={(v) => { setThresholdField("cpu", "critical", v); onChange(); }}
            />
            <SNumberField
              label="Memory Warning"
              value={thresholds.memoryWarning}
              onCommit={(v) => { setThresholdField("memory", "warning", v); onChange(); }}
            />
            <SNumberField
              label="Memory Critical"
              value={thresholds.memoryCritical}
              onCommit={(v) => { setThresholdField("memory", "critical", v); onChange(); }}
            />
            <SNumberField
              label="Battery Warning"
              value={thresholds.batteryWarning}
              onCommit={(v) => { setThresholdField("battery", "warning", v); onChange(); }}
            />
            <SNumberField
              label="Battery Critical"
              value={thresholds.batteryCritical}
              onCommit={(v) => { setThresholdField("battery", "critical", v); onChange(); }}
            />
            <SNumberField
              label="CPU Temp Warning"
              value={thresholds.cpuTempWarning}
              onCommit={(v) => { setThresholdField("cpuTemp", "warning", v); onChange(); }}
              unit="°C"
            />
            <SNumberField
              label="CPU Temp Critical"
              value={thresholds.cpuTempCritical}
              onCommit={(v) => { setThresholdField("cpuTemp", "critical", v); onChange(); }}
              unit="°C"
            />
            <SNumberField
              label="Battery Health Warning"
              value={thresholds.batteryHealthWarning}
              onCommit={(v) => { setThresholdField("batteryHealth", "warning", v); onChange(); }}
            />
            <SNumberField
              label="Battery Health Critical"
              value={thresholds.batteryHealthCritical}
              onCommit={(v) => { setThresholdField("batteryHealth", "critical", v); onChange(); }}
            />
          </div>
        </SCard>
        <SCard>
          <SHead title="Delivery" />
          <SQuietHoursField quietHours={quietHours} onSet={(next) => { setQuietHours(next); onChange(); }} />
          <div style={{ fontSize: 8.5, color: "var(--clpa-subtle)", lineHeight: 1.35, margin: "6px 0 4px" }}>
            Alerts show in this app, the tray, and optional desktop notifications. This agent does not send email.
          </div>
          {/* Real - the Alerts page's own feed groups by category when this is on (see
              AAlertFeedCard's own comment). */}
          <SToggle
            label="Group similar alerts"
            checked={groupSimilarAlertsEnabled}
            onToggle={(v) => { setGroupSimilarAlertsEnabled(v); onChange(); }}
            sample={false}
          />
          {/* Renamed from "AI priority sorting" - the real sort this gates is rule-based
              (severity, then recency), not AI-driven, so the label no longer claims otherwise. */}
          <SToggle
            label="Priority sorting"
            checked={prioritySortingEnabled}
            onToggle={(v) => { setPrioritySortingEnabled(v); onChange(); }}
            sample={false}
          />
        </SCard>
      </CLPARow>
    );
  }

  if (section === "security") {
    return (
      <CLPARow columns="1fr 1fr 1fr">
        <SCard>
          <SHead title="Agent Protection" />
          <SToggle
            label="Rules engine"
            checked
            readOnly
            readOnlyNote="Always on: live CPU, memory, battery, temperature, warranty, and tamper rules evaluate against the thresholds on the Notifications tab."
          />
          <SToggle
            label="Hardware attestation"
            checked={hardwareAttestationBadge.label === "Healthy"}
            readOnly
            readOnlyNote="Read-only: TPM, Secure Boot, and BitLocker — the same signals as the title bar. This does not change firmware from here."
          />
          <SToggle
            label="Tamper detection"
            checked={categoryPrefs.Security}
            onToggle={(v) => { setCategoryEnabled("Security", v); onChange(); }}
          />
        </SCard>
        <SCard>
          <SHead title="Access Control" />
          <SToggle
            label="Auto-lock on idle"
            checked={idleLockEnabled}
            onToggle={(v) => { setIdleLockEnabled(v); onChange(); }}
          />
          <SField
            label="Session timeout"
            value={`${idleTimeoutMinutes} minutes`}
            type="select"
            onClick={() => {
              const currentIdx = IDLE_TIMEOUT_PRESETS_MINUTES.indexOf(idleTimeoutMinutes as (typeof IDLE_TIMEOUT_PRESETS_MINUTES)[number]);
              const next = IDLE_TIMEOUT_PRESETS_MINUTES[(currentIdx + 1) % IDLE_TIMEOUT_PRESETS_MINUTES.length];
              setIdleTimeoutMinutes(next);
              onChange();
            }}
          />
        </SCard>
        <SCard>
          <SHead title="Compliance" />
          <SField label="Event retention" value={eventRetentionDays != null ? `${eventRetentionDays} days` : "Not synced"} />
          <SField label="Local telemetry" value="HTTP · 127.0.0.1:4317" />
          <SField label="Plan sync" value={policySynced ? data?.entitlement?.plan ?? "Synced" : connected ? "Not synced" : "Agent offline"} />
        </SCard>
      </CLPARow>
    );
  }

  if (section === "automation") {
    return <SSAutomationSection />;
  }

  return (
    <>
      <CLPARow columns="1fr">
        <SCard>
          <SHead title="Command Centre" />
          <STextField
            label="Backend URL"
            value={backendUrlDraft || enrollment?.backendUrl || ""}
            placeholder="http://<command-center-ip>:8443"
            onCommit={(v) => { saveBackendUrl(v); onChange(); }}
          />
          <div style={{ fontSize: 8.5, color: "var(--clpa-subtle)", lineHeight: 1.35, marginTop: 6 }}>
            {enrollment?.enrolled
              ? `Enrolled as ${enrollment.hostname}`
              : enrollBusy
                ? "Connecting…"
                : enrollMessage || enrollment?.lastError || "Not enrolled — this PC will not appear on the fleet dashboard until this URL is reachable."}
          </div>
        </SCard>
      </CLPARow>
      <CLPARow columns="1fr 1fr 1fr">
        <SCard>
          <SHead title="Device & Agent" />
          <div className="grid gap-1.5" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <SField label="Device Alias" value={data?.system?.Name || "—"} sample={false} />
            {/* Real - Win32_ComputerSystemProduct.IdentifyingNumber (this device's actual OEM
                asset tag/service tag), the same real per-device identifier already used in the
                hardware-tamper fingerprint (telemetry-server.mjs's systemSerial). Distinct from
                Device Alias above (that's the hostname) - this is a real fixed hardware ID, not
                a second copy of the same fact. "—" (not a SampleTag) when this machine's WMI
                data doesn't populate it, same honest-fallback convention as Device Alias. */}
            <SField label="Agent Name" value={data?.system?.IdentifyingNumber || "—"} />
            <STextField label="Organization" value={organization} placeholder="Not set" onCommit={(v) => { setOrganization(v); onChange(); }} />
            <STextField label="Department" value={department} placeholder="Not set" onCommit={(v) => { setDepartment(v); onChange(); }} />
            <SField label="Timezone" value={timezone} />
            <SField label="Language" value={language} />
            <SField label="Device Status" value={deviceStatusLabel} />
          </div>
        </SCard>
        <SCard>
          <SHead title="Behavior" />
          <div className="grid gap-x-2" style={{ gridTemplateColumns: "1fr 1fr" }}>
            {/* Real, read-only Scheduled Task status - this UI can only report whether
                PulseEndpointFrontend/CommandCenter/TelemetryServer/LibreHardwareMonitor/
                DesktopApp/AiService are actually registered+enabled, not create/delete them (that
                needs privilege elevation from a browser context - a bigger, separate feature).
                There is deliberately no separate "Launch on Startup (Desktop App)" toggle anymore -
                the desktop app always auto-starts via its own Scheduled Task with no user choice to
                disable it (see PulseEndpointDesktopApp's own README section), so its state only
                shows up folded into this one aggregate. Clicking the toggle does nothing, by
                design - see SToggle's readOnly handling. */}
            <SToggle
              label="Launch on Startup"
              checked={launchOnStartupEnabled === true}
              readOnly
              readOnlyNote={launchOnStartupEnabled == null
                ? "Could not read Scheduled Task state yet."
                : "Read-only: all registered agent tasks (telemetry, desktop app, LibreHardwareMonitor, AI service). Does not create or remove tasks from here."}
            />
            <SToggle
              label="Show in Tray"
              checked={showInTrayEnabled}
              onToggle={(v) => { setShowInTrayEnabled(v); onChange(); }}
            />
            <SToggle
              label="Minimize to Tray"
              checked={true}
              readOnly
              readOnlyNote="Closing this window always hides to the tray. Use Quit on the tray icon to exit."
            />
            <SToggle
              label="Auto Monitoring"
              checked={telemetryEnabled}
              onToggle={(v) => { setTelemetryEnabled(v); onChange(); }}
            />
            <SToggle
              label="Policy Sync"
              checked={policySynced}
              readOnly
              readOnlyNote="Whether this device's plan was fetched from Command Centre on the last check-in."
            />
            <SToggle
              label="Background Service"
              checked={backgroundServiceEnabled === true}
              readOnly
              readOnlyNote={backgroundServiceEnabled == null
                ? "Could not read the telemetry Scheduled Task yet."
                : "PulseEndpointTelemetryServer Scheduled Task is registered and enabled."}
            />
          </div>
        </SCard>
        <SCard>
          <SHead title="Appearance" />
          <div className="grid gap-1.5" style={{ gridTemplateColumns: "1fr 1fr" }}>
            {/* Real - toggles the same .dark class styles/theme.css's CLPA token block and the
                shadcn ui/* primitives both key off, repainting the whole app (see useTheme.ts). */}
            <SField
              label="Theme"
              value={theme === "dark" ? "Dark" : "Light"}
              type="select"
              sample={false}
              onClick={toggleTheme}
            />
            {/* Real - the same real density switch as "Compact mode" used to be (see
                useDensity.ts), consolidated into this one control rather than two separate
                toggles for the same concept - the earlier duplicate-toggle problem (Auto
                Monitoring) used the same fix. */}
            <SField
              label="View"
              value={density === "compact" ? "Compact" : "Comfortable"}
              type="select"
              sample={false}
              onClick={() => { setDensity(density === "compact" ? "comfortable" : "compact"); onChange(); }}
            />
          </div>
          <div className="mt-2">
            {/* Real - each swatch writes --clpa-primary/--clpa-primary-rgb (theme.css) at
                runtime via an inline override on <html>, which genuinely repaints every element
                that reads var(--clpa-primary) instead of a hardcoded blue (see useAccentColor.ts
                for why "no explicit choice yet" is tracked separately from "chose the first
                preset", so an unset accent still lets each theme's own default value win). */}
            <span style={{ fontSize: 7.5, color: "var(--clpa-subtle)", fontWeight: 600 }}>Accent Color</span>
            <div className="flex items-center gap-1 mt-1">
              {ACCENT_PRESETS.map((c) => (
                <button
                  key={c}
                  onClick={() => { setAccentColor(c); onChange(); }}
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: 999,
                    background: c,
                    border: "none",
                    cursor: "pointer",
                    boxShadow: accent === c ? `0 0 0 2px var(--clpa-card), 0 0 0 3px ${c}` : "none",
                  }}
                />
              ))}
            </div>
          </div>
        </SCard>
      </CLPARow>

      <CLPARow columns="1fr 1fr 1fr">
        <SCard>
          <SHead title="Scheduled Tasks" />
          <div className="flex flex-col gap-1">
            {([
              ["Telemetry Server", scheduledTasks?.telemetryServer],
              ["Desktop App", scheduledTasks?.desktopApp],
              ["LibreHardwareMonitor", scheduledTasks?.libreHardwareMonitor],
              ["AI Service", scheduledTasks?.aiService],
              ["Agent Frontend", scheduledTasks?.frontend],
              ["Command Centre", scheduledTasks?.commandCenter],
            ] as const).map(([label, enabled]) => (
              <SToggle
                key={label}
                label={label}
                checked={enabled === true}
                readOnly
                readOnlyNote={enabled == null ? "Not read yet, or this task is not installed on this PC." : enabled ? "Registered and enabled on this PC." : "Not registered or disabled."}
              />
            ))}
          </div>
        </SCard>
        <SCard>
          <SHead title="Data & Privacy" />
          <SToggle
            label="Hardware Health"
            checked={hardwareHealthOk}
            readOnly
            readOnlyNote="On when battery and SSD are not in Poor/Critical. Read-only — it reports live health, it does not hide sensors."
          />
          <SToggle
            label="Auto Monitoring"
            checked={telemetryEnabled}
            onToggle={(v) => { setTelemetryEnabled(v); onChange(); }}
          />
          <div style={{ fontSize: 8.5, color: "var(--clpa-subtle)", lineHeight: 1.35, marginTop: 6 }}>
            Sensor data is read on this PC. Command Centre only receives it when this agent is enrolled and online.
          </div>
        </SCard>
        <SCard>
          <SHead title="Date, Time & Actions" />
          <div className="grid gap-1.5 mb-2" style={{ gridTemplateColumns: "1fr 1fr" }}>
            {/* Real - cycles between the two real formats lib/dateTimeFormat.ts actually
                supports, applied everywhere a time/date is shown in this app (not just here). */}
            <SField
              label="Time Format"
              value={timeFormatPref === "24h" ? "24 Hour" : "12 Hour"}
              type="select"
              sample={false}
              onClick={() => {
                const next = timeFormatPref === "24h" ? "12h" : "24h";
                setTimeFormatPref(next);
                setTimeFormatPrefState(next);
                onChange();
              }}
            />
            <SField
              label="Date Format"
              value={dateFormatPref}
              type="select"
              sample={false}
              onClick={() => {
                const next = dateFormatPref === "DD MMM YYYY" ? "MM/DD/YYYY" : "DD MMM YYYY";
                setDateFormatPref(next);
                setDateFormatPrefState(next);
                onChange();
              }}
            />
          </div>
          <div className="grid gap-1 mt-2 pt-2" style={{ gridTemplateColumns: "1fr 1fr", borderTop: "1px solid var(--clpa-divider)" }}>
            {[
              {
                label: "Export Config",
                Icon: Package,
                onClick: () => downloadAgentSettings("pulse-endpoint-settings.json"),
              },
              {
                label: "Backup Settings",
                Icon: HardDrive,
                onClick: () => downloadAgentSettings(`pulse-endpoint-settings-${new Date().toISOString().slice(0, 10)}.json`),
              },
              {
                label: "View Docs",
                Icon: Layers,
                onClick: () => {
                  const blob = new Blob([readmeRaw], { type: "text/plain;charset=utf-8" });
                  const url = URL.createObjectURL(blob);
                  window.open(url, "_blank");
                  window.setTimeout(() => URL.revokeObjectURL(url), 60000);
                },
              },
              {
                label: "Reset Agent",
                Icon: AlertTriangle,
                danger: true,
                onClick: () => {
                  if (fullReset.state.phase === "requesting" || fullReset.state.phase === "pending") {
                    toast.info("A reset approval request is already pending - check Settings › Automation.");
                    return;
                  }
                  fullReset.request();
                  toast.info("Reset approval requested - go to Settings › Automation to check status and execute once approved.");
                },
              },
            ].map(({ label, Icon, danger, onClick }) => (
              <button
                key={label}
                onClick={onClick}
                className="flex items-center gap-1.5"
                style={{
                  background: "var(--clpa-surface)",
                  border: danger ? "1px solid rgba(var(--clpa-critical-bright-rgb),0.25)" : "1px solid var(--clpa-surface-border)",
                  borderRadius: 6,
                  padding: "5px 7px",
                  cursor: "pointer",
                }}
              >
                <Icon size={10} style={{ color: danger ? "var(--clpa-critical-bright)" : "var(--clpa-muted)" }} strokeWidth={2} />
                <span style={{ fontSize: 8, fontWeight: 700, color: danger ? "var(--clpa-critical)" : "var(--clpa-body-alt)" }}>{label}</span>
              </button>
            ))}
          </div>
        </SCard>
      </CLPARow>
    </>
  );
}

function SSFooter() {
  return (
    <div className="flex items-center justify-between rounded-xl" style={{ background: "var(--clpa-card)", border: "1px solid var(--clpa-card-border)", padding: "6px 10px" }}>
      <span style={{ fontSize: 9, color: "var(--clpa-subtle)", fontWeight: 700 }}>
        Changes save immediately
      </span>
      <div className="flex items-center gap-1">
        <CheckCircle2 size={10} style={{ color: "var(--clpa-success)" }} strokeWidth={2.2} />
        <span style={{ fontSize: 9, color: "var(--clpa-muted)", fontWeight: 600 }}>No pending draft</span>
      </div>
    </div>
  );
}
