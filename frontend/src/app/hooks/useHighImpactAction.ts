import { useEffect, useState } from "react";

// Real PRD §9.2 ADE Approval Workflow client - the exact same mechanism the pre-existing "Clear
// All Locally Cached Device Credentials" action already used (POST /api/high-impact/request,
// POST /api/high-impact/check against local-agent, which proxies to the backend's real Ed25519-
// signed approval-request flow), generalized to a real `action` parameter instead of one
// hardcoded flow, so a second real action (Reset Agent's full reset) can reuse it rather than a
// second, parallel implementation. local-agent's own HIGH_IMPACT_ACTION constant/hardcoded
// executeClearCachedCredentials() dispatch were changed to match - see telemetry-server.mjs.
//
// Module-level state per action (not component-local useState) - Settings' tabs fully unmount
// their content on switch (SSContent's ternary), so a request made from the General tab's
// "Reset Agent" tile has to still be checkable after switching to the Automation tab's
// "High-Impact Actions" card, which is a different component instance entirely. Same shared-
// state-across-instances shape as useTheme.ts/useIdleLock.ts.
export type HighImpactPhase = "idle" | "requesting" | "pending" | "checking" | "executed" | "verification-failed" | "rejected" | "error";
export type HighImpactState = { requestId: string | null; phase: HighImpactPhase; detail: string | null };

const IDLE_STATE: HighImpactState = { requestId: null, phase: "idle", detail: null };

const statesByAction = new Map<string, HighImpactState>();
const listenersByAction = new Map<string, Set<(state: HighImpactState) => void>>();

function getState(action: string): HighImpactState {
  return statesByAction.get(action) ?? IDLE_STATE;
}

function setState(action: string, next: HighImpactState) {
  statesByAction.set(action, next);
  listenersByAction.get(action)?.forEach((listener) => listener(next));
}

async function requestApproval(action: string) {
  setState(action, { requestId: null, phase: "requesting", detail: null });
  try {
    const res = await fetch("http://localhost:4317/api/high-impact/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    const body = await res.json();
    if (!res.ok) {
      setState(action, { requestId: null, phase: "error", detail: body.error ?? "Request failed." });
      return;
    }
    setState(action, { requestId: body.id, phase: "pending", detail: null });
  } catch (e) {
    setState(action, { requestId: null, phase: "error", detail: e instanceof Error ? e.message : "Request failed." });
  }
}

// Returns whether this check call itself just observed a genuine, freshly-verified execution
// (status transitioning to executed=true) - the caller (Reset Agent's own onExecuted logic) uses
// this to know exactly when to run its own local cleanup, not by polling/guessing from the phase
// value alone.
async function checkStatus(action: string): Promise<boolean> {
  const current = getState(action);
  if (!current.requestId) return false;
  const requestId = current.requestId;
  setState(action, { ...current, phase: "checking" });
  try {
    const res = await fetch("http://localhost:4317/api/high-impact/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId }),
    });
    const body = await res.json();
    if (!res.ok) {
      setState(action, { requestId, phase: "error", detail: body.error ?? "Check failed." });
      return false;
    }
    if (body.status === "approved" && body.executed) {
      setState(action, { requestId, phase: "executed", detail: null });
      return true;
    }
    if (body.status === "approved" && !body.executed) {
      setState(action, { requestId, phase: "verification-failed", detail: `Approved, but signature verification genuinely failed: ${body.error}` });
    } else if (body.status === "rejected") {
      setState(action, { requestId, phase: "rejected", detail: "This request was rejected." });
    } else {
      setState(action, { requestId, phase: "pending", detail: null });
    }
  } catch (e) {
    setState(action, { requestId, phase: "error", detail: e instanceof Error ? e.message : "Check failed." });
  }
  return false;
}

export function useHighImpactAction(action: string) {
  const [state, setLocalState] = useState<HighImpactState>(() => getState(action));

  useEffect(() => {
    setLocalState(getState(action));
    const listener = (next: HighImpactState) => setLocalState(next);
    if (!listenersByAction.has(action)) listenersByAction.set(action, new Set());
    listenersByAction.get(action)!.add(listener);
    return () => {
      listenersByAction.get(action)?.delete(listener);
    };
  }, [action]);

  return {
    state,
    request: () => requestApproval(action),
    check: () => checkStatus(action),
  };
}
