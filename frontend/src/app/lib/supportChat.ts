export type SupportChatTurn = { who: "Customer" | "Support"; text: string };

type TelemetryPayload = {
  data?: Record<string, unknown> | null;
};

function ollamaBase(): string {
  if (typeof window !== "undefined" && (window.location.port === "5173" || window.location.port === "1420")) {
    return "/ollama";
  }
  return "http://127.0.0.1:11434";
}

function briefFromTelemetry(data: Record<string, unknown> | null | undefined): string {
  if (!data) return "Live telemetry is not available yet.";
  const cpu = data.cpu as { Name?: string; LoadPercentage?: number } | undefined;
  const mem = data.memory as { usedKB?: number; totalKB?: number } | undefined;
  const disks = Array.isArray(data.logicalDisks)
    ? (data.logicalDisks as { DeviceID?: string; FreeSpace?: number; Size?: number; DiskModel?: string }[])
    : [];
  const drives = Array.isArray(data.storage) ? (data.storage as { Model?: string }[]) : [];
  const gpus = Array.isArray(data.gpu) ? (data.gpu as { Name?: string }[]) : [];
  const battery = Array.isArray(data.battery) ? (data.battery[0] as { EstimatedChargeRemaining?: number; Name?: string } | undefined) : undefined;
  const wifi = data.wifi as { state?: string; signalPercent?: string; ssid?: string } | undefined;
  const osDetail = data.osDetail as { Caption?: string } | undefined;
  const system = data.system as { Vendor?: string; Name?: string } | undefined;
  const usedPct = mem?.totalKB ? Math.round(((mem.usedKB ?? 0) / mem.totalKB) * 100) : null;
  const volumeLines = disks
    .filter((d) => d?.Size != null && d.Size > 0)
    .map((d) => {
      const freeGb = d.FreeSpace != null ? (d.FreeSpace / 1024 / 1024 / 1024).toFixed(1) : "—";
      const used = d.FreeSpace != null ? Math.round(((d.Size! - d.FreeSpace) / d.Size!) * 100) : null;
      return `${d.DeviceID ?? "?"} ${d.DiskModel ?? ""} ${used != null ? `${used}% used` : ""} ${freeGb} GB free`.replace(/\s+/g, " ").trim();
    });
  const driveModels = drives.map((d) => d.Model).filter(Boolean).join(", ") || "—";
  const gpuNames = gpus.map((g) => g.Name).filter(Boolean).join(", ") || "—";
  const lines = [
    `Model: ${system?.Vendor ?? "—"} ${system?.Name ?? "—"}`.trim(),
    `OS: ${osDetail?.Caption ?? "—"}`,
    `CPU: ${cpu?.Name ?? "—"} at ${cpu?.LoadPercentage ?? "—"}% load`,
    `Memory: ${usedPct != null ? `${usedPct}% used` : "—"}`,
    `Disks: ${driveModels}`,
    `Volumes: ${volumeLines.length > 0 ? volumeLines.join("; ") : "—"}`,
    `GPU: ${gpuNames}`,
    `Battery: ${battery?.Name ?? "—"}, charge ${battery?.EstimatedChargeRemaining ?? "—"}%`,
    `Wi-Fi: ${wifi?.state ?? "unknown"}${wifi?.ssid ? ` SSID ${wifi.ssid}` : ""}${wifi?.signalPercent ? ` signal ${wifi.signalPercent}%` : ""}`,
    `Address: ${(data.localIp as string | null) ?? "—"}`,
  ];
  return lines.join("\n");
}

function ollamaUnreachable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /Failed to fetch|NetworkError|Load failed|ECONNREFUSED|Unable to connect/i.test(msg);
}

function ollamaDownError(): Error {
  return new Error("Ollama is not running on this PC. Install Ollama, then in a terminal run: ollama pull llama3.2");
}

async function pickModel(): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${ollamaBase()}/api/tags`, { cache: "no-store" });
  } catch (err) {
    throw ollamaUnreachable(err) ? ollamaDownError() : err instanceof Error ? err : ollamaDownError();
  }
  if (!res.ok) throw ollamaDownError();
  const body = (await res.json()) as { models?: { name: string }[] };
  const names = (body.models ?? []).map((m) => m.name);
  const preferred =
    names.find((n) => n.startsWith("llama3.2")) ||
    names.find((n) => n.startsWith("llama3.1")) ||
    names.find((n) => n.startsWith("llama3")) ||
    names.find((n) => n.startsWith("phi")) ||
    names.find((n) => n.startsWith("gemma")) ||
    names.find((n) => n.startsWith("qwen")) ||
    names[0];
  if (!preferred) throw new Error("Ollama is running but has no model. In a terminal run: ollama pull llama3.2");
  return preferred;
}

export async function askCasterlySupport(message: string, history: SupportChatTurn[]): Promise<string> {
  const trimmed = message.trim();
  if (!trimmed) throw new Error("Type a message first.");

  const agentRes = await fetch("http://127.0.0.1:4317/api/support-chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: trimmed,
      history: history.slice(-12).map((m) => ({ who: m.who, text: m.text })),
    }),
  }).catch(() => null);

  if (agentRes && agentRes.status !== 404) {
    const body = (await agentRes.json().catch(() => ({}))) as { reply?: string; error?: string };
    if (!agentRes.ok || !body.reply) throw new Error(body.error || ollamaDownError().message);
    return body.reply;
  }

  const telemetryRes = await fetch("http://127.0.0.1:4317/api/telemetry", { cache: "no-store" }).catch(() => null);
  const telemetry = telemetryRes?.ok ? ((await telemetryRes.json()) as TelemetryPayload) : { data: null };
  const model = await pickModel();
  const system = [
    "You are Casterly Support, the in-app assistant for Pulse Endpoint agent on this Windows PC.",
    "Answer the user's question using the live device facts below. If a fact is missing, say you do not have it — never invent hardware, serials, IPs, or alert history.",
    "Be concise and practical. You are not a human operator and cannot remote-control the PC.",
    "",
    "Live device facts:",
    briefFromTelemetry(telemetry.data ?? null),
  ].join("\n");

  const messages = [
    { role: "system", content: system },
    ...history.slice(-12).map((m) => ({
      role: m.who === "Customer" ? "user" : "assistant",
      content: m.text,
    })),
    { role: "user", content: trimmed },
  ];

  let chatRes: Response;
  try {
    chatRes = await fetch(`${ollamaBase()}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, stream: false, messages }),
    });
  } catch (err) {
    throw ollamaUnreachable(err) ? ollamaDownError() : err instanceof Error ? err : ollamaDownError();
  }
  if (!chatRes.ok) {
    const errText = await chatRes.text();
    throw new Error(errText || `Ollama chat failed (HTTP ${chatRes.status})`);
  }
  const chatBody = (await chatRes.json()) as { message?: { content?: string } };
  const reply = chatBody.message?.content?.trim();
  if (!reply) throw new Error("Ollama returned an empty reply.");
  return reply;
}
