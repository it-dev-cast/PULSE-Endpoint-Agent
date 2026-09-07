import { useEffect, useRef, useState, type RefObject } from "react";
import {
  Monitor, Mic, MicOff, MessageCircle, Send, Paperclip, Play, Pause,
  Copy, Check, RotateCcw, AlertTriangle, Download, ShieldCheck, ShieldAlert,
  Share2, Eye, Headphones, Wifi, CheckCircle2, Clock, Square,
} from "lucide-react";
import { useApp } from "../context/AppContext";
import { CLPAPage, CLPACard, CLPABadge } from "../components/shared/clpa";
import { isRunningInTauri } from "../lib/tauriRuntime";
import { useTelemetry } from "../hooks/useTelemetry";

// ─── Real WebRTC screen-share proof of concept ─────────────
// Genuinely connects two browser tabs peer-to-peer and streams a real captured screen between
// them - no mock data. Signaling (the offer/answer SDP exchange a real WebRTC connection needs
// before either side knows how to reach the other) now goes over a real WebSocket relay
// (backend/remote_session.go) instead of manual copy-paste - see that file's own comments for
// why session creation is agent-authenticated (this device's real API key, proxied through
// local-agent/server/telemetry-server.mjs's new /api/remote-session) while the WebSocket join
// itself needs no auth at all (the session ID, shared out-of-band, is the access control - the
// same trust model a real Zoom/Meet guest-join link uses).
//
// STUN vs TURN: STUN (stun.l.google.com:19302, a public Google server) only helps two peers
// discover their own public IP/port through NAT - it does NOT relay media. PRD §30 hardening -
// a real, self-hosted coturn instance (infra/coturn) now provides an actual TURN fallback for
// when STUN alone can't punch through (e.g. two different corporate networks, or certain
// symmetric-NAT home routers). TURN credentials are real and time-limited (backend/turn.go,
// coturn's own documented REST API convention), fetched fresh per connection attempt rather than
// hardcoded - see buildIceServers below. If TURN_SECRET/TURN_URL aren't configured on the
// backend, this degrades to the original STUN-only behavior, not a hard failure.
//
// VOICE/CHAT/FILE TRANSFER: added on top of the same real RTCPeerConnection - a real
// microphone track is added alongside the screen-video track (both sides, real 2-way audio),
// and a real RTCDataChannel carries chat text and file bytes directly peer-to-peer (never
// touching the backend - the WebSocket relay is signaling-only, same as before). REAL BUG
// avoided here, not just described: naively doing `remoteStreamRef.current = event.streams[0]`
// on every ontrack call (the original approach, fine when only one track/stream ever existed)
// would have silently broken video the moment audio was added - video and mic are two separate
// MediaStream objects on the sender side, so a second ontrack firing for the audio track would
// overwrite remoteStreamRef with an audio-only stream, orphaning the video track already
// playing. Fixed by accumulating every real track into one persistent MediaStream instead of
// replacing it.
//
// VISUAL REDESIGN (this file's own display layer only - see the design plan in the PR/commit
// history for the full rationale): every function above CommunicationPanel below is byte-for-
// byte the same real logic as before - same state, same handlers, same WebRTC/data-channel
// wiring. Only CommunicationPanel's own JSX and the final `return` were rewritten, to match this
// app's existing CLPACard/CLPABadge visual language (styles/tokens.ts, components/shared/clpa.tsx)
// instead of this page's old plain, unstyled <div> layout.

const STUN_SERVER: RTCIceServer = { urls: "stun:stun.l.google.com:19302" };
const CONNECT_TIMEOUT_MS = 15000;
// Share-side signaling-socket reconnect backoff - same doubling schedule as dashboard's own
// sse.js reconnect (1s -> 2s -> 4s -> ... capped at 30s), reset to the initial value on every
// real successful reconnect. Chosen to comfortably fit inside the backend's own
// sessionRemovalGracePeriod (25s, remote_session.go) - several attempts land before the backend
// would ever actually give up on this session.
const SIGNAL_INITIAL_RETRY_MS = 1000;
const SIGNAL_MAX_RETRY_MS = 30000;

type TurnCredentialsResponse =
  | { configured: true; urls: string[]; username: string; credential: string }
  | { configured: false };

// Real device-authenticated fetch, proxied the same way createRemoteSession below is (Tauri
// command when packaged - a plain WebView fetch POST hits a real CORS-preflight bug there, see
// that function's own comment; this GET likely wouldn't, but the Tauri path is kept for
// consistency and because that assumption isn't worth re-testing live to save one code path).
// Never throws - a fetch/parse failure degrades to STUN-only, the same honest fallback as an
// explicit {configured: false} from the backend when TURN_SECRET/TURN_URL aren't set.
async function fetchTurnCredentials(): Promise<TurnCredentialsResponse> {
  try {
    if (await isRunningInTauri()) {
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke<TurnCredentialsResponse>("get_turn_credentials");
    }
    const res = await fetch("http://127.0.0.1:4317/api/turn-credentials");
    if (!res.ok) return { configured: false };
    return (await res.json()) as TurnCredentialsResponse;
  } catch {
    return { configured: false };
  }
}

// Called fresh for every new RTCPeerConnection (not cached at module scope) - a real, short-lived
// credential is the point; reusing a stale one across the app's whole lifetime would defeat the
// TTL. STUN stays in the list alongside TURN when TURN is configured, never replaced by it.
async function buildIceServers(): Promise<{ config: RTCConfiguration; turnConfigured: boolean }> {
  const turn = await fetchTurnCredentials();
  const iceServers: RTCIceServer[] = [STUN_SERVER];
  if (turn.configured) {
    iceServers.push({ urls: turn.urls, username: turn.username, credential: turn.credential });
  }
  return { config: { iceServers }, turnConfigured: turn.configured };
}

// The backend speaks plain HTTP/WS, same pattern as BACKEND_URL elsewhere in this project
// (local-agent/server/telemetry-server.mjs) - a real deployment would sit both behind a
// TLS-terminating reverse proxy (wss://), out of scope for this local POC. Session creation
// always goes through local-agent (same machine, always localhost:4317) regardless of how far
// away the real backend actually is - local-agent is the one that knows/proxies to it.

// FIX (found live, on a genuinely remote laptop): this used to be a hardcoded
// "ws://localhost:8443" constant, which only ever worked when the Tauri app and backend
// happened to be the same machine - the original dev setup's own reality, not a real remote
// customer laptop's. Session creation already worked correctly (createRemoteSession below
// proxies through local-agent, which already knows this device's real, possibly-remote
// BACKEND_URL) - this was the one piece that hadn't been updated to match, so the WebSocket
// join failed outright with "backend unreachable" on the first genuinely remote laptop that
// ever tried it. Fetched once, from local-agent's own new /api/backend-url endpoint (the same
// device that already knows this address, exposing it - not a secret, no API key crosses this
// boundary), with the old hardcoded value kept only as a fallback for same-machine dev use.
const DEFAULT_BACKEND_WS_ORIGIN = "ws://localhost:8443";
let backendWsOriginPromise: Promise<string> | null = null;
function getBackendWsOrigin(): Promise<string> {
  if (!backendWsOriginPromise) {
    backendWsOriginPromise = fetch("http://localhost:4317/api/backend-url")
      .then((res) => res.json())
      .then((body) => (body?.backendUrl ? String(body.backendUrl).replace(/^http/, "ws") : DEFAULT_BACKEND_WS_ORIGIN))
      .catch(() => DEFAULT_BACKEND_WS_ORIGIN);
  }
  return backendWsOriginPromise;
}

type Role = "share" | "view";

// A freshly-created offer/answer has no ICE candidates in it yet - they arrive asynchronously
// as ICE gathering discovers them. A real signaling server could trickle candidates as they
// arrive instead, but this POC still waits for gathering to finish (or time out) before reading
// `pc.localDescription`, unchanged from the manual copy-paste version - only the transport that
// carries the resulting blob changed, not this decision.
function waitForIceGatheringComplete(pc: RTCPeerConnection, timeoutMs = 8000): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      pc.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === "complete") finish();
    };
    pc.addEventListener("icegatheringstatechange", onChange);
    // Some networks/devices never reach "complete" (a known real quirk, not everywhere
    // consistent) - proceed with whatever candidates were gathered in this window rather than
    // hang forever waiting for an event that might not fire.
    setTimeout(finish, timeoutMs);
  });
}

function describeMediaError(e: unknown): string {
  if (e instanceof Error) {
    if (e.name === "NotAllowedError") {
      return "Screen share permission was denied (or the browser blocked the prompt). Click \"Start Screen Share\" again and allow access when prompted.";
    }
    if (e.name === "NotFoundError") {
      return "No shareable screen/window source was found.";
    }
    return `getDisplayMedia failed: ${e.name} - ${e.message}`;
  }
  return "getDisplayMedia failed for an unknown reason.";
}

// Real POST to the local agent, which proxies to the real backend using this device's own
// already-issued API key (see telemetry-server.mjs's handleRemoteSessionCreate) - the browser
// itself never sees or handles that key. mode is purely informational for the admin-facing
// queue on the dashboard (Screen Share / Voice+Chat / Chat Only) - it doesn't change any real
// signaling behavior, which stays mode-agnostic either way.
async function createRemoteSession(mode: "screen" | "voice" | "chat"): Promise<{ id: string }> {
  if (await isRunningInTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke<{ id: string }>("create_remote_session", { mode });
    } catch (e) {
      const msg = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
      throw new Error(msg || "Can't create a remote session from the agent.");
    }
  }

  let res: Response;
  try {
    // Same-origin via the Vite proxy in the browser preview; no CORS preflight.
    res = await fetch("/api/remote-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    });
  } catch {
    try {
      res = await fetch(`http://127.0.0.1:4317/api/remote-session?mode=${encodeURIComponent(mode)}`);
    } catch {
      throw new Error("Can't reach the local agent on port 4317. Start Pulse telemetry, then try Share again.");
    }
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(body?.error || `Failed to create a real signaling session (HTTP ${res.status}).`);
  }
  return body;
}

// The real, instant Stop Sharing call - proxies to the backend's device-authenticated POST
// .../remote-sessions/{id}/end (see backend/remote_session.go's endImmediately), same
// browser-never-holds-the-API-key convention as createRemoteSession above. Best-effort by
// design - see stopSharing's own comment on why a failed call here still lets local teardown
// proceed; this never throws past a console warning.
async function endRemoteSessionOnBackend(sessionId: string): Promise<void> {
  try {
    if (await isRunningInTauri()) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("end_remote_session", { sessionId });
      return;
    }
    try {
      await fetch(`/api/remote-session/${encodeURIComponent(sessionId)}/end`, { method: "POST" });
    } catch {
      await fetch(`http://127.0.0.1:4317/api/remote-session/${encodeURIComponent(sessionId)}/end`, { method: "POST" });
    }
  } catch (e) {
    console.warn("[remote-assist] failed to notify the backend this session ended:", e);
  }
}

async function openSessionSocket(sessionId: string): Promise<WebSocket> {
  const origin = await getBackendWsOrigin();
  return new WebSocket(`${origin}/v1/remote-sessions/${sessionId}/ws`);
}

// Real signal for "is this session genuinely gone" vs "can't reach the backend right now" -
// a raw WebSocket's onerror/onclose expose no HTTP status on a failed handshake (a real browser
// API limitation), so scheduleShareReconnect below calls this plain HTTP existence check
// instead (backend/remote_session.go's handleRemoteSessionExists) to decide whether to keep
// retrying or show a terminal "this session has ended" message. true/false are both confident
// answers; null means the check itself couldn't reach the backend - treated the same as "still
// exists" (keep retrying), since a network problem reaching the backend says nothing about
// whether the session itself is still there.
async function checkSessionExists(sessionId: string): Promise<boolean | null> {
  try {
    const wsOrigin = await getBackendWsOrigin();
    const res = await fetch(`${wsOrigin.replace(/^ws/, "http")}/v1/remote-sessions/${sessionId}`);
    if (res.status === 404) return false;
    if (res.ok) return true;
    return null;
  } catch {
    return null;
  }
}

// PRD §30 Remote Assist hardening - join-request/join-denied are the real consent gate (see this
// file's own top-of-section comment below): relayed through the exact same dumb WebSocket relay
// as offer/answer already are (backend/remote_session.go needs no changes - it never parses any
// of these, just broadcasts verbatim), so adding new kinds here doesn't touch the backend at all.
type SignalMessage =
  | { type: "offer"; sdp: RTCSessionDescriptionInit }
  | { type: "answer"; sdp: RTCSessionDescriptionInit }
  | { type: "join-request" }
  | { type: "join-denied" };

// Real, best-effort audit-trail logging (PRD §30 hardening) - Tauri command when packaged (same
// CORS-preflight reason as create_remote_session), plain fetch proxy otherwise. Never blocks or
// surfaces an error to the caller: an audit event failing to log doesn't undo the real join/
// deny/transfer/end that already happened, matching useAlertEngine.ts's own postRealEvent
// (a separate, not-imported copy - different file, same real pattern).
async function postRealEvent(eventType: string, message: string, severity: "info" | "warning" | "critical") {
  try {
    if (await isRunningInTauri()) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("log_remote_assist_event", { eventType, message, severity });
      return;
    }
    await fetch("http://127.0.0.1:4317/api/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventType, message, severity }),
    });
  } catch {
    // Best-effort audit log - nothing more useful to do with the error here (see comment above).
  }
}

// ─── Real chat + file transfer over a real RTCDataChannel ──
// Ordered+reliable by default (like TCP) - relied on deliberately here: file-start (JSON) ->
// N raw binary chunks -> file-end (JSON) always arrive in that exact order, so no per-chunk
// sequence number is needed. Only one file transfer at a time per direction is supported (the
// UI disables "Send File" while one is already in flight) - simple and correct beats a
// more complex concurrent-transfer protocol at this project's real scale.
const FILE_CHUNK_SIZE = 16 * 1024; // 16KB - safe, widely-compatible RTCDataChannel message size
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB - a real, deliberate cap for a support-session file (logs, configs), not arbitrary media
const BUFFERED_AMOUNT_HIGH_WATERMARK = 1024 * 1024; // 1MB - back off sending more chunks past this

type ChatMessage = { text: string; from: "customer" | "operator"; at: number };
type IncomingFile = { id: string; name: string; mimeType: string; chunks: ArrayBuffer[] };
type ReceivedFile = { name: string; mimeType: string; url: string; receivedAt: number };
// PRD §30 Remote Assist hardening - a real transfer offer awaiting this side's explicit
// accept/decline, shown before any bytes move (see setupDataChannel's own comment).
type PendingFileOffer = { id: string; name: string; size: number; mimeType: string };

type CommunicationPanelProps = {
  from: "customer" | "operator";
  micEnabled: boolean;
  micAvailable: boolean;
  micError: string | null;
  onToggleMic: () => void;
  dataChannelOpen: boolean;
  chatMessages: ChatMessage[];
  chatInput: string;
  onChatInputChange: (value: string) => void;
  onSendChat: () => void;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onPickFile: (file: File | undefined) => void;
  sendingFileProgress: number | null;
  fileSendError: string | null;
  receivedFiles: ReceivedFile[];
  // PRD §30 Remote Assist hardening - a real transfer offer awaiting this side's explicit
  // accept/decline (see setupDataChannel's own comment) - null when there's nothing pending.
  pendingFileOffer: PendingFileOffer | null;
  onRespondToFileOffer: (accepted: boolean) => void;
};

// Declared at module scope on purpose. Defining this inside ScreenSharePOC made React treat it
// as a new component type on every keystroke, which remounted the input and stole focus — you
// had to click the box again after each word.
function CommunicationPanel({
  from,
  micEnabled,
  micAvailable,
  micError,
  onToggleMic,
  dataChannelOpen,
  chatMessages,
  chatInput,
  onChatInputChange,
  onSendChat,
  fileInputRef,
  onPickFile,
  sendingFileProgress,
  fileSendError,
  receivedFiles,
  pendingFileOffer,
  onRespondToFileOffer,
}: CommunicationPanelProps) {
  return (
    <div className="flex flex-col" style={{ height: "100%" }}>
      {pendingFileOffer && (
        <div style={{ padding: "10px 11px", borderRadius: 10, border: "1px solid rgba(var(--clpa-warning-bright-rgb),0.35)", background: "rgba(var(--clpa-warning-bright-rgb),0.08)", marginBottom: 10 }}>
          <div style={{ fontSize: 10.5, fontWeight: 800, color: "var(--clpa-title)", marginBottom: 2 }}>
            Incoming file: {pendingFileOffer.name}
          </div>
          <div style={{ fontSize: 9, color: "var(--clpa-muted)", marginBottom: 8 }}>
            {Math.round(pendingFileOffer.size / 1024)}KB - nothing transfers until you accept.
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => onRespondToFileOffer(true)}
              className="clpa-focusable"
              style={{ padding: "5px 11px", borderRadius: 7, border: "none", background: "var(--clpa-primary)", color: "#FFFFFF", fontSize: 10, fontWeight: 700, cursor: "pointer" }}
            >
              Accept
            </button>
            <button
              onClick={() => onRespondToFileOffer(false)}
              className="clpa-focusable"
              style={{ padding: "5px 11px", borderRadius: 7, border: "1px solid var(--clpa-input-border)", background: "var(--clpa-card)", color: "var(--clpa-muted)", fontSize: 10, fontWeight: 700, cursor: "pointer" }}
            >
              Decline
            </button>
          </div>
        </div>
      )}
      <div className="flex items-center justify-between gap-2 flex-wrap" style={{ marginBottom: 12 }}>
        <span style={{ fontSize: 11, fontWeight: 800, color: "var(--clpa-title)", letterSpacing: 0.3 }}>SESSION CHAT</span>
        <CLPABadge
          label={dataChannelOpen ? "Channel open" : "Connecting…"}
          color={dataChannelOpen ? "var(--clpa-success)" : "var(--clpa-subtle)"}
          bg={dataChannelOpen ? "rgba(var(--clpa-success-bright-rgb),0.1)" : "rgba(var(--clpa-subtle-rgb),0.14)"}
        />
      </div>
      <div className="flex items-center gap-2 flex-wrap" style={{ marginBottom: 10 }}>
        <button
          type="button"
          onClick={onToggleMic}
          disabled={!micAvailable}
          className="flex items-center gap-1.5 clpa-focusable"
          style={{
            padding: "6px 11px", borderRadius: 8, border: micEnabled ? "1px solid rgba(var(--clpa-success-bright-rgb),0.3)" : "1px solid var(--clpa-input-border)",
            background: micEnabled ? "rgba(var(--clpa-success-bright-rgb),0.1)" : "var(--clpa-surface)", color: micEnabled ? "var(--clpa-success)" : "var(--clpa-muted)",
            fontSize: 10.5, fontWeight: 700, cursor: micAvailable ? "pointer" : "not-allowed",
          }}
        >
          {micEnabled ? <Mic size={12} strokeWidth={2.2} /> : <MicOff size={12} strokeWidth={2.2} />}
          {micEnabled ? "Mic on" : "Mic off"}
        </button>
        {micError && <span style={{ fontSize: 9, color: "var(--clpa-warning-deep)" }}>{micError}</span>}
      </div>

      <div
        className="clpa-scroll"
        style={{ flex: 1, minHeight: 110, maxHeight: 180, overflowY: "auto", border: "1px solid var(--clpa-surface-border)", borderRadius: 12, padding: 10, marginBottom: 8, background: "var(--clpa-surface)" }}
      >
        {chatMessages.length === 0 && (
          <div className="flex flex-col items-center justify-center text-center" style={{ padding: "18px 8px" }}>
            <MessageCircle size={16} style={{ color: "var(--clpa-subtle)", marginBottom: 6 }} strokeWidth={2} />
            <div style={{ fontSize: 10, color: "var(--clpa-subtle)" }}>No messages yet. Peer-to-peer once connected.</div>
          </div>
        )}
        {chatMessages.map((m, i) => {
          const mine = m.from === from;
          return (
            <div key={`${m.at}-${i}`} className="flex" style={{ justifyContent: mine ? "flex-end" : "flex-start", marginBottom: 6 }}>
              <div
                style={{
                  maxWidth: "85%", borderRadius: 10, padding: "6px 9px", fontSize: 10.5, lineHeight: 1.35,
                  background: mine ? "var(--clpa-primary)" : "var(--clpa-card)", color: mine ? "#FFFFFF" : "var(--clpa-body)",
                  border: mine ? "none" : "1px solid var(--clpa-surface-border)",
                }}
              >
                {!mine && <div style={{ fontSize: 8, fontWeight: 700, color: "var(--clpa-subtle)", marginBottom: 1 }}>{m.from}</div>}
                {m.text}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-1.5" style={{ marginBottom: 14 }}>
        <input
          value={chatInput}
          onChange={(e) => onChatInputChange(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              onSendChat();
            }
          }}
          disabled={!dataChannelOpen}
          placeholder={dataChannelOpen ? "Type a message…" : "Waiting for connection…"}
          className="clpa-focusable"
          autoComplete="off"
          style={{ flex: 1, fontSize: 10.5, padding: "7px 10px", borderRadius: 8, border: "1px solid var(--clpa-input-border)", background: "var(--clpa-surface)", color: "var(--clpa-body)" }}
        />
        <button
          type="button"
          onClick={onSendChat}
          disabled={!dataChannelOpen || !chatInput.trim()}
          className="flex items-center justify-center clpa-focusable"
          style={{
            width: 32, height: 30, borderRadius: 8, border: "none", flexShrink: 0,
            background: dataChannelOpen && chatInput.trim() ? "var(--clpa-primary)" : "var(--clpa-track)",
            cursor: dataChannelOpen && chatInput.trim() ? "pointer" : "not-allowed",
          }}
        >
          <Send size={12} color="#FFFFFF" strokeWidth={2.2} />
        </button>
      </div>

      <div className="flex items-center gap-1.5" style={{ marginBottom: 8 }}>
        <Paperclip size={11} style={{ color: "var(--clpa-primary)" }} strokeWidth={2} />
        <span style={{ fontSize: 9.5, fontWeight: 700, color: "var(--clpa-body)" }}>File transfer</span>
        <span style={{ fontSize: 8, color: "var(--clpa-subtle)" }}>up to {Math.round(MAX_FILE_SIZE / 1024 / 1024)}MB</span>
      </div>
      {fileSendError && (
        <div className="flex items-center gap-1" style={{ fontSize: 9.5, color: "var(--clpa-critical)", marginBottom: 6 }}>
          <AlertTriangle size={10} strokeWidth={2.2} /> {fileSendError}
        </div>
      )}
      <label
        className="flex items-center justify-center gap-1.5 clpa-focusable"
        style={{
          marginBottom: 8,
          padding: "10px 12px",
          borderRadius: 10,
          border: "1px dashed var(--clpa-input-border)",
          background: "var(--clpa-surface)",
          cursor: dataChannelOpen && sendingFileProgress == null ? "pointer" : "not-allowed",
          fontSize: 10.5,
          fontWeight: 700,
          color: dataChannelOpen ? "var(--clpa-primary)" : "var(--clpa-subtle)",
        }}
      >
        <Paperclip size={12} strokeWidth={2} />
        {dataChannelOpen ? "Choose a file" : "Connect to send files"}
        <input
          ref={fileInputRef as RefObject<HTMLInputElement>}
          type="file"
          disabled={!dataChannelOpen || sendingFileProgress != null}
          onChange={(e) => onPickFile(e.target.files?.[0])}
          style={{ display: "none" }}
        />
      </label>
      {sendingFileProgress != null && (
        <div style={{ marginBottom: 8 }}>
          <div className="rounded-full overflow-hidden" style={{ height: 4, background: "var(--clpa-input-border)" }}>
            <div style={{ width: `${sendingFileProgress}%`, height: "100%", background: "var(--clpa-primary)", borderRadius: 4, transition: "width 0.15s" }} />
          </div>
          <div style={{ fontSize: 8.5, color: "var(--clpa-subtle)", marginTop: 3 }}>Sending… {sendingFileProgress}%</div>
        </div>
      )}
      {receivedFiles.length > 0 && (
        <div className="flex flex-col gap-1">
          <div style={{ fontSize: 8, color: "var(--clpa-subtle)", fontWeight: 700, letterSpacing: 0.3 }}>RECEIVED</div>
          {receivedFiles.map((f, i) => (
            <a
              key={`${f.receivedAt}-${i}`}
              href={f.url}
              download={f.name}
              className="flex items-center gap-1.5 clpa-focusable"
              style={{ fontSize: 10, color: "var(--clpa-primary)", fontWeight: 600, textDecoration: "none" }}
            >
              <Download size={11} strokeWidth={2.2} /> {f.name}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

type DataChannelHandle = {
  // Real, explicit acceptance - called from the UI once the user clicks Accept on a file-offer;
  // arms the handler below to actually start accumulating chunks for that specific transfer id.
  // Nothing before this call ever writes bytes for an unaccepted transfer.
  acceptIncomingFile: (offer: PendingFileOffer) => void;
};

// PRD §30 Remote Assist hardening - file-start is now a real OFFER, not an implicit "chunks
// incoming": the receiving side must explicitly accept (onFileOffer) before this function ever
// starts accumulating chunks for that transfer id, and the SENDING side (sendFileOverChannel)
// waits for that accept/decline before sending any chunk bytes at all - gating everything, not
// just when the transfer is considered "complete." Both sides run this same handler, so it
// reacts symmetrically: file-start means "I'm being offered a file," file-accept/file-decline
// means "the file I sent an offer for was just answered."
function setupDataChannel(
  dc: RTCDataChannel,
  onOpenChange: (open: boolean) => void,
  onChatMessage: (msg: ChatMessage) => void,
  onFileOffer: (offer: PendingFileOffer) => void,
  onFileReceived: (file: ReceivedFile) => void,
  onFileResponse: (id: string, accepted: boolean) => void,
  onVideoPauseChange?: (paused: boolean) => void,
): DataChannelHandle {
  dc.binaryType = "arraybuffer";
  let incoming: IncomingFile | null = null; // only set once THIS side has explicitly accepted

  dc.onopen = () => onOpenChange(true);
  dc.onclose = () => onOpenChange(false);
  dc.onerror = () => onOpenChange(false);
  dc.onmessage = (event) => {
    if (typeof event.data === "string") {
      let msg: any;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.kind === "chat") {
        onChatMessage({ text: msg.text, from: msg.from, at: msg.at });
      } else if (msg.kind === "file-start") {
        onFileOffer({ id: msg.id, name: msg.name, size: msg.size, mimeType: msg.mimeType });
      } else if (msg.kind === "file-accept" || msg.kind === "file-decline") {
        onFileResponse(msg.id, msg.kind === "file-accept");
      } else if (msg.kind === "file-end" && incoming && incoming.id === msg.id) {
        const blob = new Blob(incoming.chunks, { type: incoming.mimeType || "application/octet-stream" });
        onFileReceived({ name: incoming.name, mimeType: incoming.mimeType, url: URL.createObjectURL(blob), receivedAt: Date.now() });
        incoming = null;
      } else if (msg.kind === "video-pause") {
        // Real privacy toggle notification, not just a frozen video frame - the video track
        // itself is what's actually disabled (see toggleVideoPause), this message is purely so
        // the OTHER side gets an honest "paused" indicator instead of wondering if the
        // connection died.
        onVideoPauseChange?.(!!msg.paused);
      }
    } else if (incoming) {
      incoming.chunks.push(event.data as ArrayBuffer);
    }
  };

  return {
    acceptIncomingFile: (offer) => {
      incoming = { id: offer.id, name: offer.name, mimeType: offer.mimeType, chunks: [] };
    },
  };
}

// waitForResponse resolves once the receiving side sends file-accept/file-decline for this
// exact id (see the component's own waitForFileResponse) - or false after a real 30s timeout, so
// an unattended/closed receiving tab doesn't hang the sender's UI forever. PRD §30 hardening:
// no chunk bytes are sent until this resolves true - the gate covers everything, not just
// whatever "completion" would otherwise have meant.
async function sendFileOverChannel(
  dc: RTCDataChannel,
  file: File,
  from: "customer" | "operator",
  onProgress: (pct: number) => void,
  waitForResponse: (id: string) => Promise<boolean>,
): Promise<void> {
  if (file.size > MAX_FILE_SIZE) {
    throw new Error(`File too large - this session supports up to ${Math.round(MAX_FILE_SIZE / 1024 / 1024)}MB per transfer.`);
  }
  const id = `${from}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  dc.send(JSON.stringify({ kind: "file-start", id, name: file.name, size: file.size, mimeType: file.type || "application/octet-stream" }));

  const accepted = await waitForResponse(id);
  if (!accepted) {
    throw new Error("The other side declined this file, or didn't respond in time.");
  }

  const buf = await file.arrayBuffer();
  let offset = 0;
  while (offset < buf.byteLength) {
    if (dc.bufferedAmount > BUFFERED_AMOUNT_HIGH_WATERMARK) {
      await new Promise<void>((resolve) => {
        const check = () => {
          if (dc.bufferedAmount <= BUFFERED_AMOUNT_HIGH_WATERMARK) resolve();
          else setTimeout(check, 50);
        };
        check();
      });
    }
    dc.send(buf.slice(offset, offset + FILE_CHUNK_SIZE));
    offset += FILE_CHUNK_SIZE;
    onProgress(Math.min(100, Math.round((offset / buf.byteLength) * 100)));
  }
  dc.send(JSON.stringify({ kind: "file-end", id }));
}

type EnrollmentStatus = {
  enrolled: boolean;
  deviceId: string | null;
  hostname: string | null;
  backendUrl: string;
  lastError: string | null;
};

export default function ScreenSharePOC() {
  const { startRemoteSession, endRemoteSession } = useApp();
  const { data, connected } = useTelemetry();
  const deviceName = connected && data?.system?.Name?.trim() ? data.system.Name.trim() : null;
  const localIp = connected ? data?.localIp ?? null : null;
  const [role, setRole] = useState<Role>("share");
  const [enrollment, setEnrollment] = useState<EnrollmentStatus | null>(null);

  // Share role state
  // "reconnecting" - the signaling socket dropped unexpectedly (network blip, not a real end of
  // session) while still waiting for an operator; see connectShareSocket/scheduleShareReconnect
  // below. Distinct from "waiting-for-peer" purely for honest UI copy - the underlying wait is
  // the same, but a genuine reconnect is worth saying out loud rather than looking identical to
  // the very first wait.
  const [shareStatus, setShareStatus] = useState<"idle" | "starting" | "creating-session" | "waiting-for-peer" | "reconnecting" | "completing">("idle");
  const [shareError, setShareError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState("");
  const [sessionMode, setSessionMode] = useState<"screen" | "voice" | "chat">("screen");
  const [videoPaused, setVideoPaused] = useState(false);
  // PRD §30 Remote Assist hardening - the real join-gate: true from the moment a join-request
  // arrives until this customer explicitly approves or denies it. Nothing (offer creation
  // included) proceeds while this is true - see approveJoinRequest/denyJoinRequest below.
  const [pendingJoinRequest, setPendingJoinRequest] = useState(false);
  const [turnConfigured, setTurnConfigured] = useState<boolean | null>(null);

  // View role state
  const [joinSessionId, setJoinSessionId] = useState(() => new URLSearchParams(window.location.search).get("join") ?? "");
  const [viewStatus, setViewStatus] = useState<"idle" | "connecting" | "waiting-for-approval" | "answering" | "answer-ready">("idle");
  const [viewError, setViewError] = useState<string | null>(null);

  // Shared, real connection-state indicator - RTCPeerConnection.connectionState itself, not a
  // guess about whether the UI merely rendered something.
  const [connectionState, setConnectionState] = useState<RTCPeerConnectionState | "none">("none");
  const [timedOut, setTimedOut] = useState(false);

  // Real voice/chat/file-transfer state
  const [micEnabled, setMicEnabled] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [dataChannelOpen, setDataChannelOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [sendingFileProgress, setSendingFileProgress] = useState<number | null>(null);
  const [fileSendError, setFileSendError] = useState<string | null>(null);
  const [receivedFiles, setReceivedFiles] = useState<ReceivedFile[]>([]);
  const [remotePaused, setRemotePaused] = useState(false);
  // PRD §30 Remote Assist hardening - a real file offer awaiting THIS side's accept/decline.
  const [pendingFileOffer, setPendingFileOffer] = useState<PendingFileOffer | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const connectTimerRef = useRef<number | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const dataChannelHandleRef = useRef<DataChannelHandle | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Share-side signaling socket resilience (matches sse.js's own reconnect-with-backoff
  // pattern) - see connectShareSocket/scheduleShareReconnect below.
  // True only while WE are deliberately closing the socket (Reset, unmount) - lets onclose tell
  // an intentional close apart from a real, unexpected drop worth reconnecting.
  const intentionalCloseRef = useRef(false);
  // True once approveJoinRequest has actually sent the real offer - past that point the
  // signaling socket has nothing left to do (this POC's offer/answer exchange happens exactly
  // once), so a later drop isn't worth reconnecting.
  const offerSentRef = useRef(false);
  const reconnectBackoffRef = useRef(SIGNAL_INITIAL_RETRY_MS);
  const reconnectTimerRef = useRef<number | null>(null);
  // PRD §30 Remote Assist hardening - real session-duration tracking for the "session ended"
  // audit event: set the instant a join is actually approved (not session creation - "duration"
  // means how long an operator was actually connected, not how long this customer sat waiting).
  const operatorJoinedAtRef = useRef<number | null>(null);
  // Pending file-transfer accept/decline (PRD §30 hardening) - keyed by transfer id so the
  // sender's own sendFileOverChannel call can await the receiver's real response before sending
  // any chunk bytes at all, not just before "completion."
  const pendingFileResponseRef = useRef<Map<string, (accepted: boolean) => void>>(new Map());

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const res = await fetch("http://127.0.0.1:4317/api/enrollment");
        const body = (await res.json().catch(() => null)) as EnrollmentStatus | null;
        if (cancelled) return;
        if (!res.ok || !body || typeof body.enrolled !== "boolean") {
          setEnrollment(null);
          return;
        }
        setEnrollment(body);
      } catch {
        if (!cancelled) setEnrollment(null);
      }
    }
    tick();
    const id = window.setInterval(tick, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  // PRD §30 Remote Assist hardening - real, one-time check (not polled - this doesn't change
  // while the app is running) for the "· STUN only" status line below, so it reflects whether
  // TURN is actually configured rather than a hardcoded claim either way.
  useEffect(() => {
    let cancelled = false;
    fetchTurnCredentials().then((turn) => {
      if (!cancelled) setTurnConfigured(turn.configured);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Real bug found during live two-tab testing (manual-signaling version): connectionState
  // reached "connected" in both tabs, but the View tab's <video> stayed black. Root cause,
  // confirmed by comparing the two <video> elements in this file: the Share tab's local preview
  // has muted set, the View tab's remote video didn't. Browsers block UNMUTED autoplay by
  // default (Chrome/Firefox/Safari all require either `muted` or prior user/site engagement) -
  // muted autoplay is always allowed. Fixed below, plus: calling .play() explicitly (not just
  // relying on the `autoplay` attribute) so a rejected promise can be caught and surfaced as a
  // real "Click to play" fallback instead of silently staying black for some other/future
  // autoplay-policy reason this fix doesn't anticipate.
  const [needsManualPlay, setNeedsManualPlay] = useState(false);
  const [hasRemoteVideo, setHasRemoteVideo] = useState(false);

  function getOrCreateRemoteStream(): MediaStream {
    if (!remoteStreamRef.current) remoteStreamRef.current = new MediaStream();
    return remoteStreamRef.current;
  }

  function attachRemoteStreamToVideo() {
    const video = remoteVideoRef.current;
    const stream = remoteStreamRef.current;
    if (!video || !stream || video.srcObject === stream) return;
    video.srcObject = stream;
    video.play().catch(() => setNeedsManualPlay(true));
  }

  // Closes the ref-lifecycle gap for real, rather than just asserting it can't happen: if
  // ontrack ever fires before the <video> is mounted (viewStatus not yet "answer-ready"), the
  // stream is still remembered in remoteStreamRef and gets attached here as soon as the element
  // exists, instead of being silently dropped by the `if (remoteVideoRef.current)` check ontrack
  // alone would have relied on.
  useEffect(() => {
    if (viewStatus === "answer-ready") attachRemoteStreamToVideo();
  }, [viewStatus]);

  const isSecureContext = typeof window !== "undefined" && window.isSecureContext;
  const hasDisplayMediaApi = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia;

  function armConnectTimeout() {
    if (connectTimerRef.current != null) window.clearTimeout(connectTimerRef.current);
    setTimedOut(false);
    connectTimerRef.current = window.setTimeout(() => {
      const pc = pcRef.current;
      if (pc && pc.connectionState !== "connected") setTimedOut(true);
    }, CONNECT_TIMEOUT_MS);
  }

  function attachConnectionStateTracking(pc: RTCPeerConnection) {
    pc.onconnectionstatechange = () => {
      setConnectionState(pc.connectionState);
      if (pc.connectionState === "connected" && connectTimerRef.current != null) {
        window.clearTimeout(connectTimerRef.current);
        connectTimerRef.current = null;
        setTimedOut(false);
      }
    };
    // Real accumulation, not replacement - see the top-of-file comment on why overwriting
    // remoteStreamRef on every call would have silently broken video once audio was added.
    pc.ontrack = (event) => {
      const combined = getOrCreateRemoteStream();
      if (!combined.getTracks().includes(event.track)) combined.addTrack(event.track);
      if (event.track.kind === "video") setHasRemoteVideo(true);
      attachRemoteStreamToVideo();
    };
  }

  // Real mic capture - optional, never blocks the screen-share/connection itself if denied or
  // unavailable. Tracks added to the SAME peer connection as the screen video, giving a real
  // 2-way voice call alongside the screen share once both sides do this.
  async function acquireMicAndAddTrack(pc: RTCPeerConnection) {
    setMicError(null);
    try {
      const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = micStream;
      micStream.getTracks().forEach((track) => pc.addTrack(track, micStream));
      setMicEnabled(true);
    } catch (e) {
      setMicEnabled(false);
      setMicError(e instanceof Error ? `Microphone unavailable: ${e.message} (voice call disabled, screen share still works)` : "Microphone unavailable (voice call disabled, screen share still works).");
    }
  }

  function toggleMic() {
    const stream = micStreamRef.current;
    if (!stream) return;
    const nextEnabled = !micEnabled;
    stream.getAudioTracks().forEach((t) => (t.enabled = nextEnabled));
    setMicEnabled(nextEnabled);
  }

  function sendChatMessage(from: "customer" | "operator") {
    const dc = dcRef.current;
    const text = chatInput.trim();
    if (!dc || dc.readyState !== "open" || !text) return;
    const msg: ChatMessage = { text, from, at: Date.now() };
    dc.send(JSON.stringify({ kind: "chat", ...msg }));
    setChatMessages((prev) => [...prev, msg]);
    setChatInput("");
  }

  // PRD §30 Remote Assist hardening - resolves the Promise sendFileOverChannel is awaiting for
  // this exact transfer id, via whatever resolver onFileResponse (below) registered when the
  // accept/decline actually arrived. A real 30s timeout covers the "receiving side never
  // responds" case (closed tab, inattentive human) without hanging the sender's UI forever.
  function waitForFileResponse(id: string): Promise<boolean> {
    return new Promise((resolve) => {
      const timeoutId = window.setTimeout(() => {
        pendingFileResponseRef.current.delete(id);
        resolve(false);
      }, 30000);
      pendingFileResponseRef.current.set(id, (accepted) => {
        window.clearTimeout(timeoutId);
        pendingFileResponseRef.current.delete(id);
        resolve(accepted);
      });
    });
  }

  function handleFileResponse(id: string, accepted: boolean) {
    pendingFileResponseRef.current.get(id)?.(accepted);
  }

  // PRD §30 Remote Assist hardening - real audit log for a completed inbound transfer (the
  // outbound side is logged in handleSendFile above) - one log per transfer either way, always
  // from this customer's own device (the only side with real logEvent access - see
  // postRealEvent), regardless of which direction the file actually moved.
  function handleFileReceived(file: ReceivedFile) {
    setReceivedFiles((prev) => [...prev, file]);
    postRealEvent("remote-assist-file-transferred", `File received: "${file.name}".`, "info");
  }

  async function handleSendFile(from: "customer" | "operator", file: File | undefined) {
    const dc = dcRef.current;
    if (!file || !dc || dc.readyState !== "open") return;
    setFileSendError(null);
    setSendingFileProgress(0);
    try {
      await sendFileOverChannel(dc, file, from, setSendingFileProgress, waitForFileResponse);
      postRealEvent("remote-assist-file-transferred", `File sent: "${file.name}" (${Math.round(file.size / 1024)}KB).`, "info");
    } catch (e) {
      setFileSendError(e instanceof Error ? e.message : "File transfer failed.");
    } finally {
      setSendingFileProgress(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  // PRD §30 Remote Assist hardening - the receiving side's real accept/decline action. Accept
  // arms the data channel handle to actually start accumulating bytes for this id (see
  // setupDataChannel's own comment) before telling the sender; decline just tells the sender,
  // nothing to arm.
  function respondToFileOffer(accepted: boolean) {
    const dc = dcRef.current;
    const offer = pendingFileOffer;
    if (!dc || !offer) return;
    if (accepted) dataChannelHandleRef.current?.acceptIncomingFile(offer);
    dc.send(JSON.stringify({ kind: accepted ? "file-accept" : "file-decline", id: offer.id }));
    setPendingFileOffer(null);
  }

  // The real local teardown - shared by the generic Reset button (resetAll, unchanged below) and
  // the session-scoped Stop Sharing button (stopSharing) so there's exactly one implementation of
  // "close everything and go back to idle," not two copies that could silently drift apart. The
  // only difference between the two call sites is what happens BEFORE this runs (stopSharing
  // notifies the backend first - see its own comment).
  function teardownLocalState() {
    // PRD §30 Remote Assist hardening - real "session ended" audit event with a real computed
    // duration, measured from when an operator actually joined (operatorJoinedAtRef, set in
    // approveJoinRequest) - not from session creation, since "duration" means how long help was
    // actually happening, not how long this customer sat waiting. Only logged if a session
    // genuinely had a real ID (never fires on an idle "Reset" click with nothing to end).
    if (sessionId) {
      const joinedAt = operatorJoinedAtRef.current;
      const durationLabel = joinedAt != null ? `${Math.round((Date.now() - joinedAt) / 1000)}s` : "never joined";
      postRealEvent("remote-assist-ended", `Remote assist session ended (operator connected for ${durationLabel}).`, "info");
    }
    operatorJoinedAtRef.current = null;
    pendingFileResponseRef.current.clear();
    dataChannelHandleRef.current = null;

    endRemoteSession();
    if (connectTimerRef.current != null) window.clearTimeout(connectTimerRef.current);
    connectTimerRef.current = null;
    // Real close, on purpose - tells connectShareSocket's onclose this wasn't an unexpected
    // drop, so it doesn't schedule a reconnect for a session that's being deliberately ended.
    intentionalCloseRef.current = true;
    offerSentRef.current = false;
    if (reconnectTimerRef.current != null) window.clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
    reconnectBackoffRef.current = SIGNAL_INITIAL_RETRY_MS;
    pcRef.current?.close();
    pcRef.current = null;
    wsRef.current?.close();
    wsRef.current = null;
    dcRef.current?.close();
    dcRef.current = null;
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
    remoteStreamRef.current = null;
    setNeedsManualPlay(false);
    setHasRemoteVideo(false);
    setShareStatus("idle");
    setShareError(null);
    setSessionId("");
    setSessionMode("screen");
    setVideoPaused(false);
    setRemotePaused(false);
    setPendingJoinRequest(false);
    setViewStatus("idle");
    setViewError(null);
    setConnectionState("none");
    setTimedOut(false);
    setMicEnabled(false);
    setMicError(null);
    setDataChannelOpen(false);
    setChatMessages([]);
    setChatInput("");
    setSendingFileProgress(null);
    setFileSendError(null);
    setPendingFileOffer(null);
    setReceivedFiles((prev) => {
      prev.forEach((f) => URL.revokeObjectURL(f.url));
      return [];
    });
  }

  // The generic Reset button - unchanged behavior, local-only, no backend notification. Kept
  // distinct from stopSharing below rather than merged into one button/handler: this one is
  // always present regardless of session state, and its whole point is "clear this panel,"
  // not "tell the other side I'm ending a live session" (see stopSharing's own comment).
  function resetAll() {
    teardownLocalState();
  }

  // PRD §30 Remote Assist hardening - the real Stop Sharing action: unlike resetAll/Reset above,
  // this tells the backend the session is deliberately over BEFORE tearing down locally, so it's
  // removed immediately (endImmediately, bypassing sessionRemovalGracePeriod's 25s) rather than
  // relying on the WebSocket close alone - the exact gap found live in the operator's own
  // Disconnect button. endRemoteSessionOnBackend is best-effort by design (catches and warns
  // internally, never throws) - a failed notification (backend unreachable, session already
  // gone) must never block the real local teardown that follows it regardless; the customer's
  // own screen/mic need to stop either way.
  async function stopSharing() {
    if (sessionId) {
      await endRemoteSessionOnBackend(sessionId);
    }
    teardownLocalState();
  }

  // Clean up the real capture/connection/socket on unmount so a screen-share indicator doesn't
  // keep running in the browser after navigating away from this POC.
  useEffect(() => {
    return () => {
      if (connectTimerRef.current != null) window.clearTimeout(connectTimerRef.current);
      // Same real-close signal as resetAll's own - see its comment on why this matters to
      // connectShareSocket's onclose.
      intentionalCloseRef.current = true;
      if (reconnectTimerRef.current != null) window.clearTimeout(reconnectTimerRef.current);
      pcRef.current?.close();
      wsRef.current?.close();
      dcRef.current?.close();
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  function switchRole(next: Role) {
    resetAll();
    setRole(next);
  }

  // Real found-live bug fix: a customer whose single signaling socket dropped (network blip,
  // WebView2 process suspend, brief WiFi hiccup) while still waiting for an operator lost the
  // whole session outright - remote_session.go used to remove a session the instant its peer
  // count hit zero, so the drop was indistinguishable from a real end. Backend now holds a
  // sessionRemovalGracePeriod (25s) before actually removing an empty session; this is the
  // client half - reconnect to the SAME session id with the same doubling backoff dashboard's
  // own sse.js already uses (1s -> 2s -> ... capped at 30s), reset on a real successful
  // reconnect. Scoped to only the pre-negotiation window (offerSentRef false) - once
  // approveJoinRequest has actually sent the real offer, this POC's one-shot offer/answer
  // exchange is done and the signaling socket has nothing left to do, so a later drop isn't
  // worth reconnecting.
  async function connectShareSocket(sessionId: string) {
    const ws = await openSessionSocket(sessionId);
    wsRef.current = ws;
    ws.onopen = () => {
      reconnectBackoffRef.current = SIGNAL_INITIAL_RETRY_MS;
      setShareStatus((prev) => (prev === "reconnecting" ? "waiting-for-peer" : prev));
    };
    ws.onmessage = async (event) => {
      let msg: SignalMessage;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === "join-request") {
        setPendingJoinRequest(true);
        // Logged unconditionally, the instant this arrives - not just from approveJoinRequest/
        // denyJoinRequest, which only ever fired once a human had already reacted to the banner.
        // Without this, a join-request nobody saw (window minimized, banner missed) left no
        // trace anywhere that it had ever arrived at all.
        postRealEvent("remote-assist-join-request-received", "An operator requested to join this session - awaiting Approve/Deny.", "info");
        // Real fix for "the banner rendered into a hidden/minimized window and nobody saw it" -
        // forces the window forward and, if the OS blocks that outright, flashes the taskbar
        // icon instead (see request_remote_assist_attention's own comment). Best-effort outside
        // the Tauri app (e.g. this POC running in a plain browser tab) - nothing to focus there.
        if (await isRunningInTauri()) {
          try {
            const { invoke } = await import("@tauri-apps/api/core");
            await invoke("request_remote_assist_attention");
          } catch {
            // Best-effort - see postRealEvent's own comment on this class of call.
          }
        }
      } else if (msg.type === "answer" && msg.sdp) {
        applyAnswer(msg.sdp);
      }
    };
    // A WebSocket's onerror carries no diagnostic detail of its own and is always followed by
    // onclose (per spec) - the real decision (reconnect vs. give up) happens there, once, rather
    // than duplicated across both handlers.
    ws.onclose = () => {
      if (intentionalCloseRef.current || offerSentRef.current) return;
      scheduleShareReconnect(sessionId);
    };
  }

  async function scheduleShareReconnect(sessionId: string) {
    const stillExists = await checkSessionExists(sessionId);
    if (stillExists === false) {
      setShareStatus("idle");
      setShareError("This session has ended - the operator's join window closed. Start a new request.");
      return;
    }
    // Exists, or the existence check itself couldn't reach the backend - either way, worth
    // retrying rather than giving up (see checkSessionExists's own comment on the null case).
    setShareStatus("reconnecting");
    reconnectTimerRef.current = window.setTimeout(() => {
      connectShareSocket(sessionId);
    }, reconnectBackoffRef.current);
    reconnectBackoffRef.current = Math.min(reconnectBackoffRef.current * 2, SIGNAL_MAX_RETRY_MS);
  }

  // ─── Share role ───────────────────────────────────────────
  // Three real entry points into the same session mechanism - a customer shouldn't have to
  // share their screen (or even grant microphone access) just to ask a quick question or send
  // a file. "chat" mode skips BOTH getDisplayMedia and getUserMedia entirely - no permission
  // prompts at all beyond the connection itself.
  async function startSession(mode: "screen" | "voice" | "chat") {
    setShareError(null);
    setSessionMode(mode);

    let stream: MediaStream | null = null;
    if (mode === "screen") {
      if (!hasDisplayMediaApi) {
        setShareError(
          isSecureContext
            ? "navigator.mediaDevices.getDisplayMedia is not available in this browser."
            : "getDisplayMedia requires a secure context (HTTPS, or http://localhost) - this page isn't running in one.",
        );
        return;
      }
      setShareStatus("starting");
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      } catch (e) {
        setShareError(describeMediaError(e));
        setShareStatus("idle");
        return;
      }
      localStreamRef.current = stream;
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;
    } else {
      setShareStatus("starting");
    }

    const { config } = await buildIceServers();
    const pc = new RTCPeerConnection(config);
    pcRef.current = pc;
    attachConnectionStateTracking(pc);
    if (stream) {
      stream.getTracks().forEach((track) => pc.addTrack(track, stream!));
      // If the user closes the "Stop sharing" browser UI directly, reflect that honestly
      // instead of leaving stale "starting" status up.
      stream.getVideoTracks()[0]?.addEventListener("ended", () => {
        setShareError("Screen share was stopped (browser \"Stop sharing\" control, or the shared window/tab was closed).");
      });
    }
    // Chat-only mode skips mic entirely - no permission prompt at all for this mode.
    if (mode !== "chat") await acquireMicAndAddTrack(pc);

    // Share side creates the data channel (the offerer's responsibility) - the View/operator
    // side receives it via pc.ondatachannel, set up below in handleOffer.
    const dc = pc.createDataChannel("data");
    dcRef.current = dc;
    dataChannelHandleRef.current = setupDataChannel(
      dc, setDataChannelOpen,
      (msg) => setChatMessages((prev) => [...prev, msg]),
      setPendingFileOffer,
      handleFileReceived,
      handleFileResponse,
      setRemotePaused,
    );

    // PRD §30 Remote Assist hardening - the real consent gate: no offer is created or sent here
    // anymore. This connects and waits; approveJoinRequest below is the only place that ever
    // creates+sends the real SDP offer, and only once this customer has explicitly clicked
    // Accept on a join-request. Default is deny - nothing happens until that click.
    setShareStatus("creating-session");
    let session: { id: string };
    try {
      session = await createRemoteSession(mode);
    } catch (e) {
      setShareError(e instanceof Error ? e.message : "Failed to create a real signaling session.");
      setShareStatus("idle");
      return;
    }
    setSessionId(session.id);
    intentionalCloseRef.current = false;
    offerSentRef.current = false;
    reconnectBackoffRef.current = SIGNAL_INITIAL_RETRY_MS;
    await connectShareSocket(session.id);

    setShareStatus("waiting-for-peer");
    startRemoteSession(
      mode === "chat"
        ? "Text chat requested. Command Centre can join from Remote Assist."
        : mode === "voice"
          ? "Voice + chat requested. Command Centre can join from Remote Assist."
          : "Screen share requested. Command Centre can join from Remote Assist.",
    );
  }

  // PRD §30 Remote Assist hardening - the real approval action: THIS is where the SDP offer is
  // actually created and sent, for the first time, only now that a specific join-request has
  // been explicitly accepted. Its arrival at the joining peer is the approval - no separate
  // "approved" message is needed (see the SignalMessage type's own comment).
  async function approveJoinRequest() {
    const pc = pcRef.current;
    const ws = wsRef.current;
    setPendingJoinRequest(false);
    if (!pc || !ws || ws.readyState !== WebSocket.OPEN) {
      setShareError("Can't approve - the session connection is no longer open.");
      return;
    }
    let offer: RTCSessionDescriptionInit;
    try {
      const created = await pc.createOffer();
      await pc.setLocalDescription(created);
      await waitForIceGatheringComplete(pc);
      offer = pc.localDescription!;
    } catch (e) {
      setShareError(e instanceof Error ? `Failed to create offer: ${e.message}` : "Failed to create offer.");
      return;
    }
    const msg: SignalMessage = { type: "offer", sdp: offer };
    ws.send(JSON.stringify(msg));
    // Past this point the signaling socket's one job is done (this POC's offer/answer exchange
    // happens exactly once) - a later drop isn't worth connectShareSocket's onclose reconnecting.
    offerSentRef.current = true;
    operatorJoinedAtRef.current = Date.now();
    postRealEvent("remote-assist-operator-joined", `An operator was approved and joined this ${MODE_META[sessionMode].label} session.`, "info");
  }

  // PRD §30 Remote Assist hardening - the real denial action: default is deny, so this is what
  // actually happens if the customer does nothing wrong except decline - the session itself
  // stays open (a different operator, or a retry, can still request to join).
  function denyJoinRequest() {
    const ws = wsRef.current;
    setPendingJoinRequest(false);
    if (ws && ws.readyState === WebSocket.OPEN) {
      const msg: SignalMessage = { type: "join-denied" };
      ws.send(JSON.stringify(msg));
    }
    postRealEvent("remote-assist-join-denied", "A join request for this session was denied by the customer.", "warning");
  }

  // Real privacy toggle - pauses the video TRACK itself (not just hiding it in the UI), so no
  // frames are actually sent while paused. Tells the other side via the data channel so they
  // see an honest "paused" indicator instead of wondering if the connection died or froze.
  function toggleVideoPause() {
    const stream = localStreamRef.current;
    const dc = dcRef.current;
    if (!stream) return;
    const nextPaused = !videoPaused;
    stream.getVideoTracks().forEach((t) => (t.enabled = !nextPaused));
    setVideoPaused(nextPaused);
    if (dc && dc.readyState === "open") {
      dc.send(JSON.stringify({ kind: "video-pause", paused: nextPaused }));
    }
  }

  async function applyAnswer(sdp: RTCSessionDescriptionInit) {
    const pc = pcRef.current;
    if (!pc) return;
    setShareError(null);
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    } catch (e) {
      setShareError(e instanceof Error ? `Failed to apply the answer: ${e.message}` : "Failed to apply the answer.");
      return;
    }
    setShareStatus("completing");
    armConnectTimeout();
  }

  // ─── View role ────────────────────────────────────────────
  async function joinSession() {
    setViewError(null);
    const id = joinSessionId.trim();
    if (!id) return;

    setViewStatus("connecting");
    const ws = await openSessionSocket(id);
    wsRef.current = ws;
    // PRD §30 Remote Assist hardening - the real consent gate, joining side: send join-request
    // the instant the socket opens, before any SDP exchange at all. Nothing else happens until
    // either an offer arrives (the customer approved - see approveJoinRequest's own comment on
    // why its arrival IS the approval) or an explicit join-denied does.
    ws.onopen = () => {
      const msg: SignalMessage = { type: "join-request" };
      ws.send(JSON.stringify(msg));
      setViewStatus("waiting-for-approval");
    };
    ws.onerror = () => {
      setViewError("Failed to connect to the signaling server for this session ID (backend unreachable, or the session doesn't exist/has expired).");
      setViewStatus("idle");
    };
    ws.onmessage = (event) => {
      let msg: SignalMessage;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === "offer" && msg.sdp) {
        handleOffer(msg.sdp, ws);
      } else if (msg.type === "join-denied") {
        setViewError("The customer denied this join request.");
        setViewStatus("idle");
        ws.close();
      }
    };
  }

  async function handleOffer(offerSdp: RTCSessionDescriptionInit, ws: WebSocket) {
    setViewStatus("answering");
    const { config } = await buildIceServers();
    const pc = new RTCPeerConnection(config);
    pcRef.current = pc;
    attachConnectionStateTracking(pc);
    // View/operator side receives the data channel the Share side created (it's the answerer).
    pc.ondatachannel = (event) => {
      dcRef.current = event.channel;
      dataChannelHandleRef.current = setupDataChannel(
        event.channel, setDataChannelOpen,
        (msg) => setChatMessages((prev) => [...prev, msg]),
        setPendingFileOffer,
        handleFileReceived,
        handleFileResponse,
        setRemotePaused,
      );
    };
    await acquireMicAndAddTrack(pc);

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offerSdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await waitForIceGatheringComplete(pc);
    } catch (e) {
      setViewError(e instanceof Error ? `Failed to create answer: ${e.message}` : "Failed to create answer.");
      setViewStatus("idle");
      return;
    }

    const msg: SignalMessage = { type: "answer", sdp: pc.localDescription! };
    ws.send(JSON.stringify(msg));
    setViewStatus("answer-ready");
    armConnectTimeout();
  }

  // ─── Visual layer only from here down ──────────────────────
  // Real connection-state -> display mapping (label/color/whether it pulses) - the SAME
  // `connectionState` value tracked above, just given a clearer visual treatment. Nothing here
  // invents a fake "signal quality" reading beyond the one real signal WebRTC actually reports
  // (RTCPeerConnection.connectionState) - no fabricated bars/percentage.
  const CONNECTION_META: Record<string, { label: string; color: string; bg: string; pulse: boolean }> = {
    none: { label: "Idle", color: "var(--clpa-subtle)", bg: "rgba(var(--clpa-subtle-rgb),0.14)", pulse: false },
    new: { label: "Initializing", color: "var(--clpa-subtle)", bg: "rgba(var(--clpa-subtle-rgb),0.14)", pulse: true },
    connecting: { label: "Connecting", color: "var(--clpa-warning)", bg: "rgba(var(--clpa-warning-bright-rgb),0.12)", pulse: true },
    connected: { label: "Connected", color: "var(--clpa-success)", bg: "rgba(var(--clpa-success-bright-rgb),0.1)", pulse: false },
    disconnected: { label: "Reconnecting", color: "var(--clpa-warning)", bg: "rgba(var(--clpa-warning-bright-rgb),0.12)", pulse: true },
    failed: { label: "Failed", color: "var(--clpa-critical)", bg: "rgba(var(--clpa-critical-bright-rgb),0.1)", pulse: false },
    closed: { label: "Ended", color: "var(--clpa-muted)", bg: "rgba(var(--clpa-muted-rgb),0.12)", pulse: false },
  };
  const connMeta = CONNECTION_META[connectionState] ?? CONNECTION_META.none;

  const shareableLink = sessionId ? `${window.location.origin}${window.location.pathname}?join=${sessionId}` : "";
  const isConnected = connectionState === "connected";

  const MODE_META = {
    screen: { label: "Screen share", Icon: Monitor, desc: "Operator sees this display. Pause anytime." },
    voice: { label: "Voice + chat", Icon: Mic, desc: "Talk and message. No screen is shared." },
    chat: { label: "Chat only", Icon: MessageCircle, desc: "Text and files. No mic or screen prompt." },
  } as const;

  // Purely cosmetic, self-contained feedback for the existing Copy Link button below - doesn't
  // touch the real navigator.clipboard.writeText call itself, just how long the button
  // acknowledges it happened.
  const [linkCopied, setLinkCopied] = useState(false);
  function copyShareableLink() {
    navigator.clipboard.writeText(shareableLink);
    setLinkCopied(true);
    window.setTimeout(() => setLinkCopied(false), 1600);
  }

  const communicationPanel = (
    <CommunicationPanel
      from={role === "share" ? "customer" : "operator"}
      micEnabled={micEnabled}
      micAvailable={!!micStreamRef.current}
      micError={micError}
      onToggleMic={toggleMic}
      dataChannelOpen={dataChannelOpen}
      chatMessages={chatMessages}
      chatInput={chatInput}
      onChatInputChange={setChatInput}
      onSendChat={() => sendChatMessage(role === "share" ? "customer" : "operator")}
      fileInputRef={fileInputRef}
      onPickFile={(file) => handleSendFile(role === "share" ? "customer" : "operator", file)}
      sendingFileProgress={sendingFileProgress}
      fileSendError={fileSendError}
      receivedFiles={receivedFiles}
      pendingFileOffer={pendingFileOffer}
      onRespondToFileOffer={respondToFileOffer}
    />
  );

  // Small, reusable status/placeholder card - used for every "nothing to see yet" moment
  // (waiting for a peer, audio-only session, paused screen, offline video) so those real states
  // read consistently instead of each being its own one-off block of text.
  function StatusPlaceholder({ label, sub }: { label: string; sub?: string }) {
    return (
      <div
        className="flex flex-col items-center justify-center text-center"
        style={{ padding: "36px 18px", borderRadius: 14, background: "var(--clpa-surface)", border: "1px dashed var(--clpa-input-border)" }}
      >
        <div className="flex items-center justify-center rounded-full" style={{ width: 40, height: 40, background: "rgba(var(--clpa-primary-rgb),0.1)", marginBottom: 10 }}>
          <Headphones size={18} style={{ color: "var(--clpa-primary)" }} strokeWidth={2} />
        </div>
        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--clpa-title)" }}>{label}</div>
        {sub && <div style={{ fontSize: 10, color: "var(--clpa-subtle)", marginTop: 4, maxWidth: 340, lineHeight: 1.45 }}>{sub}</div>}
      </div>
    );
  }

  return (
    <CLPAPage>
      <div className="grid gap-2.5" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
        {[
          { label: "Session", value: connMeta.label, color: connMeta.color, Icon: Headphones, pulse: connMeta.pulse },
          { label: "This PC", value: enrollment?.hostname || deviceName || "—", color: "var(--clpa-title)", Icon: Monitor, pulse: false },
          { label: "Command Centre", value: enrollment == null ? "Checking…" : enrollment.enrolled ? "Enrolled" : "Not enrolled", color: enrollment?.enrolled ? "var(--clpa-success)" : enrollment == null ? "var(--clpa-muted)" : "var(--clpa-critical)", Icon: Wifi, pulse: false },
          { label: "LAN", value: localIp || "—", color: "var(--clpa-title)", Icon: Share2, pulse: false },
        ].map((tile) => (
          <CLPACard key={tile.label} style={{ padding: "10px 12px" }}>
            <div className="flex items-center gap-2">
              <div className="flex items-center justify-center rounded-lg flex-shrink-0" style={{ width: 28, height: 28, background: "var(--clpa-surface)" }}>
                <tile.Icon size={13} style={{ color: "var(--clpa-primary)" }} strokeWidth={2} />
              </div>
              <div className="min-w-0">
                <div style={{ fontSize: 8, fontWeight: 700, color: "var(--clpa-subtle)", letterSpacing: 0.3 }}>{tile.label}</div>
                <div className="flex items-center gap-1.5 min-w-0">
                  {tile.pulse && <span className="clpa-dot" style={{ width: 7, height: 7, borderRadius: 999, background: tile.color, flexShrink: 0 }} />}
                  <span style={{ fontSize: 12, fontWeight: 800, color: tile.color, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{tile.value}</span>
                </div>
              </div>
            </div>
          </CLPACard>
        ))}
      </div>

      <CLPACard style={{ padding: "10px 14px" }}>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2.5 min-w-0">
            <span
              className={connMeta.pulse ? "clpa-dot" : undefined}
              style={{ width: 10, height: 10, borderRadius: 999, background: connMeta.color, display: "inline-block", flexShrink: 0 }}
            />
            <div className="min-w-0">
              <div style={{ fontSize: 12, fontWeight: 800, color: "var(--clpa-title)", lineHeight: 1.2 }}>
                {role === "share" ? "You are sharing" : "You are joining"}
              </div>
              <div style={{ fontSize: 9, color: "var(--clpa-subtle)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {role === "share"
                  ? sessionId
                    ? `Session ${sessionId}`
                    : "No active session"
                  : joinSessionId
                  ? `Joining ${joinSessionId}`
                  : "Paste a session ID from the share side"}
              </div>
            </div>
            {(shareStatus !== "idle" || viewStatus !== "idle") && (
              <CLPABadge label={MODE_META[sessionMode].label} color="var(--clpa-accent-strong)" bg="rgba(var(--clpa-accent-strong-rgb),0.1)" />
            )}
          </div>

          <div className="flex items-center gap-2">
            <div className="flex items-center" style={{ background: "var(--clpa-divider)", borderRadius: 8, padding: 2 }}>
              <button
                onClick={() => switchRole("share")}
                className="flex items-center gap-1.5 clpa-focusable"
                style={{
                  padding: "6px 12px", borderRadius: 6, border: "none", cursor: "pointer",
                  background: role === "share" ? "var(--clpa-card)" : "transparent",
                  color: role === "share" ? "var(--clpa-primary)" : "var(--clpa-muted)",
                  boxShadow: role === "share" ? "0 1px 3px rgba(0,0,0,0.08)" : "none",
                  fontSize: 10.5, fontWeight: 700,
                }}
              >
                <Share2 size={11} strokeWidth={2.2} /> Share
              </button>
              <button
                onClick={() => switchRole("view")}
                className="flex items-center gap-1.5 clpa-focusable"
                style={{
                  padding: "6px 12px", borderRadius: 6, border: "none", cursor: "pointer",
                  background: role === "view" ? "var(--clpa-card)" : "transparent",
                  color: role === "view" ? "var(--clpa-primary)" : "var(--clpa-muted)",
                  boxShadow: role === "view" ? "0 1px 3px rgba(0,0,0,0.08)" : "none",
                  fontSize: 10.5, fontWeight: 700,
                }}
              >
                <Eye size={11} strokeWidth={2.2} /> Join
              </button>
            </div>
            <button
              onClick={resetAll}
              className="flex items-center gap-1.5 clpa-focusable"
              style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--clpa-input-border)", background: "var(--clpa-card)", color: "var(--clpa-muted)", fontSize: 10, fontWeight: 700, cursor: "pointer" }}
            >
              <RotateCcw size={11} strokeWidth={2.2} /> Reset
            </button>
          </div>
        </div>
      </CLPACard>

      {enrollment && !enrollment.enrolled && (
        <CLPACard style={{ padding: "10px 12px", background: "var(--clpa-critical-wash)", border: "1px solid var(--clpa-critical-wash-border)" }}>
          <div className="flex items-start gap-2">
            <AlertTriangle size={14} style={{ color: "var(--clpa-critical)", flexShrink: 0, marginTop: 1 }} strokeWidth={2.2} />
            <span style={{ fontSize: 10.5, color: "var(--clpa-critical)", lineHeight: 1.4 }}>
              Not enrolled at {enrollment.backendUrl}. Command Centre will not list this PC until that address is reachable.
              {enrollment.lastError ? ` ${enrollment.lastError}` : ""} Set Command Centre URL in Settings, or use this PC’s Wi-Fi address / the Shared-in Tailscale IP — not the Command Centre PC’s own Tailscale IP if the accounts differ.
            </span>
          </div>
        </CLPACard>
      )}

      <div className="flex items-center gap-3 flex-wrap" style={{ fontSize: 9.5, color: "var(--clpa-subtle)" }}>
        <span className="flex items-center gap-1">
          {isSecureContext ? <ShieldCheck size={12} style={{ color: "var(--clpa-success)" }} strokeWidth={2.2} /> : <ShieldAlert size={12} style={{ color: "var(--clpa-critical)" }} strokeWidth={2.2} />}
          <span style={{ color: isSecureContext ? "var(--clpa-success)" : "var(--clpa-critical)", fontWeight: 700 }}>
            {isSecureContext ? "Secure context" : "Not a secure context"}
          </span>
        </span>
        <span>· Screen capture {hasDisplayMediaApi ? "available" : "unavailable"}</span>
        <span>
          · {turnConfigured == null ? "Checking TURN relay…" : turnConfigured ? "STUN + TURN relay configured" : "STUN only — no TURN relay configured"}
        </span>
      </div>

      {timedOut && (
        <CLPACard style={{ padding: "10px 12px", background: "var(--clpa-critical-wash)", border: "1px solid var(--clpa-critical-wash-border)" }}>
          <div className="flex items-start gap-2">
            <AlertTriangle size={14} style={{ color: "var(--clpa-critical)", flexShrink: 0, marginTop: 1 }} strokeWidth={2.2} />
            <span style={{ fontSize: 10.5, fontWeight: 600, color: "var(--clpa-critical)", lineHeight: 1.4 }}>
              Connection failed - didn't reach "connected" within {CONNECT_TIMEOUT_MS / 1000}s. This can happen across
              different networks without a TURN server (STUN alone can't traverse every NAT type) - try both sides on the
              same network, or accept this as this feature's known limitation.
            </span>
          </div>
        </CLPACard>
      )}

      {role === "share" ? (
        <>
          {shareError && (
            <CLPACard style={{ padding: "10px 12px", background: "var(--clpa-critical-wash)", border: "1px solid var(--clpa-critical-wash-border)" }}>
              <div className="flex items-start gap-2">
                <AlertTriangle size={14} style={{ color: "var(--clpa-critical)", flexShrink: 0, marginTop: 1 }} strokeWidth={2.2} />
                <span style={{ fontSize: 10.5, color: "var(--clpa-critical)", lineHeight: 1.4 }}>{shareError}</span>
              </div>
            </CLPACard>
          )}

          {shareStatus === "idle" && (
            <div className="grid gap-2.5" style={{ gridTemplateColumns: "minmax(0, 1.15fr) minmax(0, 0.85fr)" }}>
              <CLPACard style={{ padding: "18px 16px" }}>
                <div className="flex items-center gap-2 mb-2">
                  <div className="flex items-center justify-center rounded-xl" style={{ width: 36, height: 36, background: "rgba(var(--clpa-primary-rgb),0.12)" }}>
                    <Headphones size={18} style={{ color: "var(--clpa-primary)" }} strokeWidth={2} />
                  </div>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 800, color: "var(--clpa-title)" }}>Start assistance</div>
                    <div style={{ fontSize: 10, color: "var(--clpa-subtle)" }}>Command Centre sees the request and can join.</div>
                  </div>
                </div>
                <div className="grid gap-2" style={{ gridTemplateColumns: "1fr 1fr 1fr", marginTop: 14 }}>
                  {(Object.entries(MODE_META) as [keyof typeof MODE_META, typeof MODE_META[keyof typeof MODE_META]][]).map(([mode, meta]) => (
                    <button
                      key={mode}
                      onClick={() => startSession(mode)}
                      className="flex flex-col items-start text-left clpa-focusable clpa-card-hover"
                      style={{
                        padding: "14px 12px",
                        borderRadius: 12,
                        border: mode === "screen" ? "1px solid rgba(var(--clpa-primary-rgb),0.35)" : "1px solid var(--clpa-card-border)",
                        background: mode === "screen" ? "rgba(var(--clpa-primary-rgb),0.06)" : "var(--clpa-surface)",
                        cursor: "pointer",
                        minHeight: 132,
                      }}
                    >
                      <div
                        className="flex items-center justify-center rounded-lg"
                        style={{ width: 32, height: 32, background: mode === "screen" ? "rgba(var(--clpa-primary-rgb),0.14)" : "rgba(var(--clpa-subtle-rgb),0.12)", marginBottom: 10 }}
                      >
                        <meta.Icon size={15} style={{ color: mode === "screen" ? "var(--clpa-primary)" : "var(--clpa-muted)" }} strokeWidth={2} />
                      </div>
                      <div style={{ fontSize: 12, fontWeight: 800, color: "var(--clpa-title)" }}>{meta.label}</div>
                      <div style={{ fontSize: 9.5, color: "var(--clpa-subtle)", marginTop: 4, lineHeight: 1.4 }}>{meta.desc}</div>
                      {mode === "screen" && (
                        <span style={{ fontSize: 8, fontWeight: 700, color: "var(--clpa-primary)", marginTop: 8 }}>Recommended</span>
                      )}
                    </button>
                  ))}
                </div>
              </CLPACard>

              <CLPACard style={{ padding: "18px 16px" }}>
                <div style={{ fontSize: 11, fontWeight: 800, color: "var(--clpa-title)", letterSpacing: 0.3, marginBottom: 12 }}>HOW IT WORKS</div>
                {[
                  { n: "1", title: "Start a mode", body: "Screen, voice, or chat. This PC creates a real signaling session." },
                  { n: "2", title: "Operator joins", body: "Command Centre sees the request. Share the session ID if they join from a browser." },
                  { n: "3", title: "Talk and send files", body: "Chat and files go peer-to-peer. Pause screen share whenever you need." },
                ].map((step) => (
                  <div key={step.n} className="flex items-start gap-2.5" style={{ marginBottom: 12 }}>
                    <div className="flex items-center justify-center rounded-full flex-shrink-0" style={{ width: 22, height: 22, background: "rgba(var(--clpa-primary-rgb),0.12)", fontSize: 10, fontWeight: 800, color: "var(--clpa-primary)" }}>
                      {step.n}
                    </div>
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--clpa-title)" }}>{step.title}</div>
                      <div style={{ fontSize: 9.5, color: "var(--clpa-muted)", lineHeight: 1.4, marginTop: 2 }}>{step.body}</div>
                    </div>
                  </div>
                ))}
                <div className="flex items-center gap-1.5" style={{ borderTop: "1px solid var(--clpa-divider)", paddingTop: 10, marginTop: 4 }}>
                  {enrollment?.enrolled ? (
                    <CheckCircle2 size={12} style={{ color: "var(--clpa-success)" }} strokeWidth={2} />
                  ) : (
                    <Clock size={12} style={{ color: "var(--clpa-warning)" }} strokeWidth={2} />
                  )}
                  <span style={{ fontSize: 9.5, color: "var(--clpa-subtle)" }}>
                    {enrollment?.enrolled ? "Listed on Command Centre" : "Enroll in Settings so Command Centre can see this PC"}
                  </span>
                </div>
              </CLPACard>
            </div>
          )}

          {(shareStatus === "starting" || shareStatus === "creating-session") && (
            <CLPACard style={{ padding: "16px" }}>
              <StatusPlaceholder
                label={
                  shareStatus === "creating-session"
                    ? "Creating a real signaling session…"
                    : sessionMode === "screen" ? "Requesting screen share permission…" : sessionMode === "voice" ? "Setting up voice/chat session…" : "Setting up chat session…"
                }
              />
            </CLPACard>
          )}

          {(shareStatus === "waiting-for-peer" || shareStatus === "reconnecting" || shareStatus === "completing") && (
            <CLPARowLike>
              <CLPACard style={{ padding: "12px 14px" }}>
                {sessionMode === "screen" ? (
                  <div style={{ position: "relative", marginBottom: 12 }}>
                    <video ref={localVideoRef} autoPlay muted playsInline style={{ width: "100%", borderRadius: 10, background: "var(--clpa-title)", maxHeight: 300, objectFit: "contain", opacity: videoPaused ? 0.15 : 1, display: "block" }} />
                    {videoPaused && (
                      <div className="flex items-center gap-1.5" style={{ position: "absolute", inset: 0, alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "#FFFFFF" }}>
                        <Pause size={13} strokeWidth={2.4} /> Screen sharing paused
                      </div>
                    )}
                    <button
                      onClick={toggleVideoPause}
                      className="flex items-center gap-1.5 clpa-focusable"
                      style={{ position: "absolute", top: 8, right: 8, padding: "5px 10px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.25)", background: "rgba(15,23,42,0.82)", color: "#FFFFFF", fontSize: 10, fontWeight: 700, cursor: "pointer" }}
                    >
                      {videoPaused ? <Play size={11} strokeWidth={2.4} /> : <Pause size={11} strokeWidth={2.4} />}
                      {videoPaused ? "Resume Sharing" : "Pause Sharing"}
                    </button>
                  </div>
                ) : (
                  <div style={{ marginBottom: 12 }}>
                    <StatusPlaceholder
                      label={sessionMode === "voice" ? "Voice/chat only" : "Chat only"}
                      sub={sessionMode === "voice" ? "No screen is being shared this session." : "No screen or microphone in this session."}
                    />
                  </div>
                )}

                <div style={{ fontSize: 9.5, fontWeight: 700, color: "var(--clpa-body)", marginBottom: 4 }}>
                  Session ID - share this with the other side
                </div>
                <div className="flex items-center gap-1.5" style={{ marginBottom: 12 }}>
                  <input
                    readOnly
                    value={sessionId}
                    onFocus={(e) => e.currentTarget.select()}
                    className="clpa-focusable"
                    style={{ flex: 1, fontFamily: "monospace", fontSize: 10.5, padding: "6px 9px", borderRadius: 8, border: "1px solid var(--clpa-input-border)", background: "var(--clpa-surface)", color: "var(--clpa-body)" }}
                  />
                  <button
                    onClick={copyShareableLink}
                    className="flex items-center gap-1.5 clpa-focusable"
                    style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--clpa-input-border)", background: linkCopied ? "rgba(var(--clpa-success-bright-rgb),0.1)" : "var(--clpa-surface)", color: linkCopied ? "var(--clpa-success)" : "var(--clpa-body)", fontSize: 10, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}
                  >
                    {linkCopied ? <Check size={11} strokeWidth={2.4} /> : <Copy size={11} strokeWidth={2.2} />}
                    {linkCopied ? "Copied" : "Copy Link"}
                  </button>
                </div>

                {/* PRD §30 Remote Assist hardening - the customer's own real Stop Sharing action.
                    Previously the only way to end a live session from this side was the generic,
                    always-present "Reset" button up in the header - functionally complete (it
                    already stopped tracks/closed the connection) but not labeled or positioned as
                    a live-session action, and it never told the backend the session was actually
                    over (see stopSharing's own comment on the real difference: instant removal
                    via the backend vs. waiting out the 25s grace period). This whole card only
                    renders while shareStatus is waiting-for-peer/reconnecting/completing (see the
                    enclosing condition above) - i.e. exactly the non-idle range where a real
                    session (and sessionId) actually exists, connected or not - so no separate
                    state check is needed here. */}
                <div style={{ marginBottom: 12 }}>
                  <button
                    onClick={stopSharing}
                    className="flex items-center gap-1.5 clpa-focusable"
                    style={{ padding: "7px 14px", borderRadius: 8, border: "1px solid var(--clpa-critical-wash-border)", background: "var(--clpa-critical-wash)", color: "var(--clpa-critical)", fontSize: 10.5, fontWeight: 700, cursor: "pointer" }}
                  >
                    <Square size={12} strokeWidth={2.2} /> Stop Sharing
                  </button>
                </div>

                {pendingJoinRequest ? (
                  <div style={{ padding: "14px 12px", borderRadius: 12, border: "1px solid rgba(var(--clpa-warning-bright-rgb),0.35)", background: "rgba(var(--clpa-warning-bright-rgb),0.08)" }}>
                    <div className="flex items-center gap-1.5" style={{ marginBottom: 6 }}>
                      <AlertTriangle size={13} style={{ color: "var(--clpa-warning)" }} strokeWidth={2.2} />
                      <span style={{ fontSize: 11, fontWeight: 800, color: "var(--clpa-title)" }}>An operator wants to join</span>
                    </div>
                    <div style={{ fontSize: 10, color: "var(--clpa-muted)", lineHeight: 1.4, marginBottom: 10 }}>
                      Nothing is shared until you approve. Deny keeps this session open for another attempt.
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={approveJoinRequest}
                        className="flex items-center gap-1.5 clpa-focusable"
                        style={{ padding: "7px 14px", borderRadius: 8, border: "none", background: "var(--clpa-primary)", color: "#FFFFFF", fontSize: 10.5, fontWeight: 700, cursor: "pointer" }}
                      >
                        <CheckCircle2 size={12} strokeWidth={2.2} /> Approve
                      </button>
                      <button
                        onClick={denyJoinRequest}
                        className="flex items-center gap-1.5 clpa-focusable"
                        style={{ padding: "7px 14px", borderRadius: 8, border: "1px solid var(--clpa-input-border)", background: "var(--clpa-card)", color: "var(--clpa-muted)", fontSize: 10.5, fontWeight: 700, cursor: "pointer" }}
                      >
                        Deny
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    {shareStatus === "waiting-for-peer" && <StatusPlaceholder label="Waiting for the other side to join…" />}
                    {shareStatus === "reconnecting" && <StatusPlaceholder label="Reconnecting…" sub="A brief connection drop - retrying automatically. The session is still open." />}
                    {shareStatus === "completing" && <StatusPlaceholder label="Peer joined - completing connection…" />}
                  </>
                )}

                {isConnected && (
                  <>
                    {/* Real audio playback for the customer to actually HEAR the operator's voice -
                        previously missing entirely: this role had no element bound to
                        remoteVideoRef at all, so an operator's real, arriving mic audio track had
                        nowhere to play. Visually hidden (nothing to see - operator never sends
                        video), but functionally real - same muted-autoplay-then-manual-play-button
                        pattern already proven on the View role, except deliberately NOT muted
                        here, since the whole point is for the customer to hear real sound. */}
                    <video ref={remoteVideoRef} autoPlay playsInline style={{ display: "none" }} onLoadedMetadata={attachRemoteStreamToVideo} />
                    {needsManualPlay && (
                      <button
                        onClick={() => remoteVideoRef.current?.play().then(() => setNeedsManualPlay(false)).catch(() => {})}
                        className="flex items-center gap-1.5 clpa-focusable"
                        style={{ padding: "7px 12px", borderRadius: 8, border: "1px solid rgba(var(--clpa-primary-rgb),0.3)", background: "rgba(var(--clpa-primary-rgb),0.08)", color: "var(--clpa-primary)", fontSize: 10.5, fontWeight: 700, cursor: "pointer", marginTop: 12 }}
                      >
                        <Play size={11} strokeWidth={2.4} /> Click to enable operator's voice
                      </button>
                    )}
                  </>
                )}
              </CLPACard>

              {isConnected && (
                <CLPACard style={{ padding: "12px 14px" }}>
                  {communicationPanel}
                </CLPACard>
              )}
            </CLPARowLike>
          )}
        </>
      ) : (
        <>
          {viewError && (
            <CLPACard style={{ padding: "10px 12px", background: "var(--clpa-critical-wash)", border: "1px solid var(--clpa-critical-wash-border)" }}>
              <div className="flex items-start gap-2">
                <AlertTriangle size={14} style={{ color: "var(--clpa-critical)", flexShrink: 0, marginTop: 1 }} strokeWidth={2.2} />
                <span style={{ fontSize: 10.5, color: "var(--clpa-critical)", lineHeight: 1.4 }}>{viewError}</span>
              </div>
            </CLPACard>
          )}

          {viewStatus === "idle" && (
            <div className="grid gap-2.5" style={{ gridTemplateColumns: "minmax(0, 1.1fr) minmax(0, 0.9fr)" }}>
            <CLPACard style={{ padding: "20px 18px" }}>
              <div className="flex items-center gap-2 mb-3">
                <div className="flex items-center justify-center rounded-xl" style={{ width: 36, height: 36, background: "rgba(var(--clpa-primary-rgb),0.12)" }}>
                  <Eye size={18} style={{ color: "var(--clpa-primary)" }} strokeWidth={2} />
                </div>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 800, color: "var(--clpa-title)" }}>Join a session</div>
                  <div style={{ fontSize: 10, color: "var(--clpa-subtle)" }}>Use the session ID from the share side.</div>
                </div>
              </div>
              <div style={{ fontSize: 8.5, color: "var(--clpa-subtle)", fontWeight: 700, letterSpacing: 0.3, marginBottom: 4 }}>SESSION ID</div>
              <input
                value={joinSessionId}
                onChange={(e) => setJoinSessionId(e.target.value)}
                placeholder="Paste session ID"
                className="clpa-focusable"
                style={{ width: "100%", fontFamily: "monospace", fontSize: 12, padding: "9px 11px", borderRadius: 8, border: "1px solid var(--clpa-input-border)", background: "var(--clpa-surface)", color: "var(--clpa-body)", marginBottom: 12 }}
              />
              <button
                onClick={joinSession}
                disabled={!joinSessionId.trim()}
                className="flex items-center gap-1.5 clpa-focusable"
                style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: joinSessionId.trim() ? "var(--clpa-primary)" : "var(--clpa-track)", color: "#FFFFFF", fontSize: 11, fontWeight: 700, cursor: joinSessionId.trim() ? "pointer" : "not-allowed" }}
              >
                <Eye size={13} strokeWidth={2.2} /> Join session
              </button>
            </CLPACard>
            <CLPACard style={{ padding: "18px 16px" }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: "var(--clpa-title)", letterSpacing: 0.3, marginBottom: 12 }}>ON THIS ROLE</div>
              <div style={{ fontSize: 10.5, color: "var(--clpa-muted)", lineHeight: 1.5, marginBottom: 12 }}>
                Join is for watching a share that already started. Operators normally join from Command Centre. Use this if you have a session ID from another tab or browser.
              </div>
              <div className="flex items-start gap-2" style={{ fontSize: 10, color: "var(--clpa-subtle)", lineHeight: 1.45 }}>
                <ShieldCheck size={13} style={{ color: "var(--clpa-success)", flexShrink: 0, marginTop: 1 }} strokeWidth={2} />
                Signaling goes through this device’s enrolled backend. Media is peer-to-peer.
              </div>
            </CLPACard>
            </div>
          )}

          {(viewStatus === "connecting" || viewStatus === "waiting-for-approval" || viewStatus === "answering") && (
            <CLPACard style={{ padding: "16px" }}>
              <StatusPlaceholder
                label={
                  viewStatus === "connecting"
                    ? "Connecting to the signaling session…"
                    : viewStatus === "waiting-for-approval"
                      ? "Waiting for the customer to approve this join request…"
                      : "Offer received - creating answer…"
                }
                sub={viewStatus === "waiting-for-approval" ? "Nothing connects until they approve - this is the real consent gate, not a formality." : undefined}
              />
            </CLPACard>
          )}

          {viewStatus === "answer-ready" && (
            <CLPARowLike>
              <CLPACard style={{ padding: "12px 14px" }}>
                <div style={{ position: "relative" }}>
                  <video
                    ref={remoteVideoRef}
                    autoPlay
                    playsInline
                    onLoadedMetadata={attachRemoteStreamToVideo}
                    style={{ width: "100%", borderRadius: 10, background: "var(--clpa-title)", maxHeight: 320, objectFit: "contain", display: hasRemoteVideo && !remotePaused ? "block" : "none" }}
                  />
                  {(!hasRemoteVideo || remotePaused) && (
                    <StatusPlaceholder
                      label={remotePaused ? "Screen sharing paused" : "Voice/chat only"}
                      sub={remotePaused ? "The customer has paused sharing, likely for privacy." : "This session's customer hasn't shared their screen."}
                    />
                  )}
                  {hasRemoteVideo && !remotePaused && needsManualPlay && (
                    <button
                      onClick={() => {
                        remoteVideoRef.current?.play().then(() => setNeedsManualPlay(false)).catch(() => {});
                      }}
                      className="flex items-center gap-1.5 clpa-focusable"
                      style={{
                        position: "absolute", inset: 0, margin: "auto", width: 150, height: 38,
                        background: "rgba(15,23,42,0.82)", color: "#FFFFFF", border: "1px solid rgba(255,255,255,0.25)",
                        borderRadius: 8, fontSize: 10.5, fontWeight: 700, cursor: "pointer",
                      }}
                    >
                      <Play size={12} strokeWidth={2.4} /> Click to play
                    </button>
                  )}
                </div>
                {hasRemoteVideo && !remotePaused && needsManualPlay && (
                  <div style={{ fontSize: 9, color: "var(--clpa-warning-deep)", marginTop: 6 }}>
                    Autoplay was blocked - click the button above (a real click satisfies the browser's autoplay policy).
                  </div>
                )}
              </CLPACard>

              {isConnected && (
                <CLPACard style={{ padding: "12px 14px" }}>
                  {communicationPanel}
                </CLPACard>
              )}
            </CLPARowLike>
          )}
        </>
      )}
    </CLPAPage>
  );
}

// Local, minimal 2-column layout (video/session-info left, chat/file panel right) matching this
// app's own established `columns="3fr 2fr"` split (see Alerts page's feed+detail layout) -
// defined here rather than importing CLPARow directly, since that shared component always
// renders both children with equal stretch height and this page needs the right column to only
// appear once `isConnected`, collapsing cleanly to one column otherwise.
function CLPARowLike({ children }: { children: React.ReactNode }) {
  const items = Array.isArray(children) ? children : [children];
  return (
    <div className="grid gap-2.5" style={{ gridTemplateColumns: items.length > 1 ? "3fr 2fr" : "1fr", alignItems: "start" }}>
      {children}
    </div>
  );
}
