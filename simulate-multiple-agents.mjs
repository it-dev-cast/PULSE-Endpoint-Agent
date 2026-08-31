// Simulates N independent endpoint agents registering with and reporting to your REAL
// command-center backend - not a mock. Proves the backend + dashboard correctly handle multiple
// concurrent devices (separate telemetry, separate events, no cross-contamination) before you
// roll this out to real additional laptops.
//
// Usage: node simulate-multiple-agents.mjs [numDevices]
// Defaults to 5 simulated devices. Run this ON the machine where the backend is reachable
// (localhost:8443), e.g. the same Windows machine, via `node simulate-multiple-agents.mjs`.

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8443";
const NUM_DEVICES = parseInt(process.argv[2] || process.env.NUM_DEVICES || "5", 10);
const LIVE_STATUS_INTERVAL_MS = 5000;
const EVENT_INTERVAL_MS = 20000;

const EVENT_TYPES = [
  { type: "disk-usage-high", severity: "warning", message: "Disk usage crossed 85% threshold." },
  { type: "cpu-spike", severity: "warning", message: "Sustained CPU usage above 90% for 5 minutes." },
  { type: "battery-degraded", severity: "warning", message: "Battery health dropped below 70%." },
  { type: "malware-scan-complete", severity: "info", message: "Scheduled malware scan completed with no findings." },
  { type: "update-installed", severity: "info", message: "Security update installed successfully." },
  { type: "unauthorized-access-attempt", severity: "critical", message: "Repeated failed login attempts detected." },
];

function randomBetween(min, max) {
  return Math.round(min + Math.random() * (max - min));
}

async function registerDevice(hostname) {
  const res = await fetch(`${BACKEND_URL}/v1/devices/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hostname }),
  });
  if (!res.ok) throw new Error(`register failed for ${hostname}: HTTP ${res.status}`);
  return res.json(); // { id, tenantId, hostname, apiKey }
}

async function postLiveStatus(device) {
  const body = {
    cpuPct: randomBetween(5, 95),
    ramPct: randomBetween(10, 90),
    diskPct: randomBetween(20, 98),
    batteryPct: randomBetween(5, 100),
  };
  const res = await fetch(`${BACKEND_URL}/v1/devices/${device.id}/live-status`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${device.apiKey}` },
    body: JSON.stringify(body),
  });
  return res.ok;
}

async function postHeartbeat(device) {
  const res = await fetch(`${BACKEND_URL}/v1/devices/${device.id}/heartbeat`, {
    method: "POST",
    headers: { Authorization: `Bearer ${device.apiKey}` },
  });
  return res.ok;
}

async function postRandomEvent(device) {
  const e = EVENT_TYPES[randomBetween(0, EVENT_TYPES.length - 1)];
  const res = await fetch(`${BACKEND_URL}/v1/devices/${device.id}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${device.apiKey}` },
    body: JSON.stringify({ eventType: e.type, message: `[${device.hostname}] ${e.message}`, severity: e.severity }),
  });
  return res.ok;
}

async function main() {
  console.log(`[sim] Registering ${NUM_DEVICES} simulated devices with ${BACKEND_URL}...`);
  const devices = [];
  for (let i = 1; i <= NUM_DEVICES; i++) {
    const hostname = `SIM-LAPTOP-${String(i).padStart(2, "0")}`;
    try {
      const device = await registerDevice(hostname);
      devices.push(device);
      console.log(`[sim] Registered ${hostname} -> id=${device.id}`);
    } catch (e) {
      console.error(`[sim] Failed to register ${hostname}:`, e.message);
    }
  }

  if (devices.length === 0) {
    console.error("[sim] No devices registered - is the backend running on " + BACKEND_URL + "?");
    process.exit(1);
  }

  console.log(`[sim] ${devices.length} devices registered. Sending live telemetry every ${LIVE_STATUS_INTERVAL_MS / 1000}s, random events every ~${EVENT_INTERVAL_MS / 1000}s.`);
  console.log("[sim] Check your dashboard's Endpoints page now - these should all appear within a few seconds.");
  console.log("[sim] Press Ctrl+C to stop.");

  setInterval(() => {
    devices.forEach((d) => {
      postLiveStatus(d).catch(() => {});
      postHeartbeat(d).catch(() => {});
    });
  }, LIVE_STATUS_INTERVAL_MS);

  setInterval(() => {
    const d = devices[randomBetween(0, devices.length - 1)];
    postRandomEvent(d)
      .then((ok) => console.log(`[sim] ${ok ? "Sent" : "Failed to send"} event for ${d.hostname}`))
      .catch(() => {});
  }, EVENT_INTERVAL_MS);
}

main();
