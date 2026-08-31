import { useEffect, useState } from "react";

export type AgentUpdateState = {
  installedVersion: string;
  latestVersion: string | null;
  downloadUrl: string | null;
  updateAvailable: boolean;
  error: string | null;
};

const AGENT_LATEST_URL = "http://localhost:4317/api/agent-latest";
const POLL_MS = 60_000;

function parseVersion(raw: string): number[] | null {
  const cleaned = raw.trim().replace(/^v/i, "");
  if (!cleaned) return null;
  const parts = cleaned.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length === 0 || parts.some((n) => Number.isNaN(n) || n < 0)) return null;
  return parts;
}

/** Positive if a is newer than b. Null if either side is not a real dotted version. */
export function compareAgentVersions(a: string, b: string): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i++) {
    const lv = left[i] ?? 0;
    const rv = right[i] ?? 0;
    if (lv !== rv) return lv - rv;
  }
  return 0;
}

export function useAgentUpdate(installedVersion: string): AgentUpdateState {
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;

    async function poll() {
      try {
        const res = await fetch(AGENT_LATEST_URL, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { version?: string | null; downloadUrl?: string | null; error?: string };
        if (cancelled) return;
        const latest = typeof body.version === "string" && body.version.trim() ? body.version.trim().replace(/^v/i, "") : null;
        setLatestVersion(latest);
        setDownloadUrl(typeof body.downloadUrl === "string" && body.downloadUrl ? body.downloadUrl : null);
        setError(body.error ?? null);
      } catch (e) {
        if (cancelled) return;
        setLatestVersion(null);
        setDownloadUrl(null);
        setError(e instanceof Error ? e.message : "failed to check for agent updates");
      } finally {
        if (!cancelled) {
          timer = window.setTimeout(poll, POLL_MS);
        }
      }
    }

    void poll();
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
    };
  }, []);

  const cmp = latestVersion ? compareAgentVersions(latestVersion, installedVersion) : null;
  return {
    installedVersion,
    latestVersion,
    downloadUrl,
    updateAvailable: cmp != null && cmp > 0,
    error,
  };
}
