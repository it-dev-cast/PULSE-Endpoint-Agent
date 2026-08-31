import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// local-agent/ (this file's parent), not the overall repo root - only used as the elevated
// child process's working directory below, and telemetry-server.mjs locates everything it
// needs (PS_SCRIPT, RUST_BINARY) via its own __dirname regardless of CWD, so this being
// local-agent/ rather than the repo root doesn't affect anything - named precisely so a future
// reader isn't misled into thinking it's the repo root.
const LOCAL_AGENT_ROOT = path.resolve(__dirname, "..");
const TELEMETRY_SCRIPT = path.join(__dirname, "telemetry-server.mjs");
const TELEMETRY_URL = "http://localhost:4317/api/telemetry";
const LHM_EXE = "C:\\Program Files\\LibreHardwareMonitor\\LibreHardwareMonitor.exe";

async function pingTelemetryServer(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(TELEMETRY_URL, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function ensureTelemetryServer() {
  if (await pingTelemetryServer(3000)) {
    console.log("[ensure] Telemetry server already running (likely the logon Scheduled Task) - nothing to launch.");
    return;
  }

  console.log("[ensure] Telemetry server not running - launching it elevated now.");
  console.log("[ensure] A UAC prompt should appear - approve it to start the server.");

  // Standard, sanctioned way to request interactive elevation: Start-Process -Verb RunAs shows
  // the normal Windows UAC consent dialog (the same one for any admin action), it's not a
  // workaround. -WindowStyle Hidden just keeps the elevated node console out of the way - the
  // process itself still runs normally in the background.
  const psCommand =
    `Start-Process -FilePath 'node' -ArgumentList '"${TELEMETRY_SCRIPT}"' ` +
    `-WorkingDirectory '${LOCAL_AGENT_ROOT}' -WindowStyle Hidden -Verb RunAs`;

  const child = spawn("powershell.exe", ["-NoProfile", "-Command", psCommand], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();

  // 25s, not 15s: observed directly that the exact same elevation command can take
  // meaningfully longer than 15s to resolve when launched via a detached background spawn
  // versus an interactive invocation (elevation-broker timing, not something under this
  // script's control) - 15s produced a false "didn't come up" once in testing even though the
  // server came up cleanly about 5s after that window closed.
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (await pingTelemetryServer(2000)) {
      console.log("[ensure] Telemetry server is up and responding.");
      return;
    }
  }

  console.error(
    "[ensure] Telemetry server did not come up within 25s of launching it. " +
      "If you dismissed the UAC prompt, or it's still starting slowly, dev:all will continue " +
      "anyway - the dashboard will just show sample data for real-only fields until it's up.",
  );
}

function ensureLibreHardwareMonitor() {
  return new Promise((resolve) => {
    const check = spawn("powershell.exe", [
      "-NoProfile",
      "-Command",
      "if (Get-Process -Name LibreHardwareMonitor -ErrorAction SilentlyContinue) { Write-Output 'RUNNING' } else { Write-Output 'NOT_RUNNING' }",
    ]);
    let output = "";
    check.stdout.on("data", (d) => (output += d.toString()));
    check.on("close", () => {
      if (output.includes("RUNNING")) {
        console.log("[ensure] LibreHardwareMonitor is already running.");
      } else {
        console.log("[ensure] LibreHardwareMonitor is not running - launching it now (no elevation needed just to open it).");
        const launched = spawn(LHM_EXE, [], { detached: true, stdio: "ignore" });
        launched.unref();
      }
      resolve();
    });
  });
}

await ensureTelemetryServer();
await ensureLibreHardwareMonitor();

// Printed every time, success or not - this one step genuinely can't be automated safely (no
// CLI flag exists, and its menu isn't accessible to UI-automation tooling either - both were
// investigated directly, see README).
console.log("");
console.log("⚠ Remember to click Options → Remote Web Server → Run in LibreHardwareMonitor for live CPU/GPU temps — this one step can't be automated safely.");
console.log("");
