const {
  app,
  BrowserWindow,
  ipcMain,
  powerMonitor,
} = require("electron");
const path = require("path");
const fs = require("fs");
const { isBrowser, windowsBrowserUrl } = require("./browser-url");

// Point this at your server. Production by default; override with BIUKIN_API for local dev.
const API_BASE = process.env.BIUKIN_API || "https://staff-wise-theta.vercel.app";

const SAMPLE_INTERVAL_MS = 60_000; // take a reading every 60s
const IDLE_THRESHOLD_S = 60; // idle if no keyboard/mouse for 60s
const FLUSH_EVERY = 3; // upload after every 3 samples (~3 min)

let win = null;
let token = null;
let employee = null;
let buffer = [];
let sampleTimer = null;
let quitting = false;
let lastStatus = "Signed out";
let clockedInSince = null;

const sessionFile = () => path.join(app.getPath("userData"), "session.json");

function saveSession() {
  try {
    fs.writeFileSync(sessionFile(), JSON.stringify({ token, employee }));
  } catch {}
}
function loadSession() {
  try {
    const s = JSON.parse(fs.readFileSync(sessionFile(), "utf8"));
    token = s.token || null;
    employee = s.employee || null;
  } catch {}
}
function clearSession() {
  try {
    fs.unlinkSync(sessionFile());
  } catch {}
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function updateUI() {
  send("status", {
    signedIn: !!token,
    employee,
    clockedIn: !!sampleTimer,
    since: clockedInSince,
    status: lastStatus,
    pending: buffer.length,
    apiBase: API_BASE,
  });
}

/**
 * Extract a clean domain (no www.) from a URL or scheme-less address-bar text.
 * Rejects search text (no dot / has spaces) so we don't log garbage "domains".
 */
function domainOf(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = "https://" + s; // Windows bar often omits scheme
  try {
    const h = new URL(s).hostname.replace(/^www\./, "").toLowerCase();
    if (!h || !h.includes(".") || h.includes(" ")) return null;
    return h;
  } catch {
    return null;
  }
}

/**
 * Foreground app + (for browsers) the active tab's domain.
 * macOS: active-win exposes `url` directly.
 * Windows: active-win has no URL, so we read the address bar via UI Automation.
 */
async function getActiveWindow() {
  try {
    const mod = await import("active-win");
    const w = await mod.default();
    if (!w || !w.owner) return { app_name: null, domain: null };
    const app_name = w.owner.name;
    let domain = domainOf(w.url); // macOS
    if (!domain && process.platform === "win32" && isBrowser(app_name)) {
      domain = domainOf(await windowsBrowserUrl()); // Windows
    }
    return { app_name, domain };
  } catch {
    return { app_name: null, domain: null }; // permission not granted — presence still works
  }
}

async function takeSample() {
  if (!token) return;
  const idleSeconds = powerMonitor.getSystemIdleTime();
  const active = idleSeconds < IDLE_THRESHOLD_S;
  const { app_name, domain } = active
    ? await getActiveWindow()
    : { app_name: null, domain: null };
  buffer.push({ ts: new Date().toISOString(), active, app_name, domain });
  lastStatus = active
    ? `Active${domain ? " · " + domain : app_name ? " · " + app_name : " (grant permissions for app/site names)"}`
    : "Idle";
  if (buffer.length >= FLUSH_EVERY) await flush();
  updateUI();
}

async function flush() {
  if (!token || buffer.length === 0) return;
  const batch = buffer.slice();
  try {
    const res = await fetch(API_BASE + "/api/agent/activity", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
      },
      body: JSON.stringify({ samples: batch }),
    });
    if (res.ok) {
      buffer.splice(0, batch.length); // drop only what we sent
    } else if (res.status === 401) {
      lastStatus = "Session expired — sign in again";
      stopSampling();
      token = null;
      clearSession();
    }
  } catch {
    // offline — keep buffering, retry next flush
    lastStatus = "Offline — will retry";
  }
}

function startSampling() {
  if (sampleTimer) return;
  takeSample();
  sampleTimer = setInterval(takeSample, SAMPLE_INTERVAL_MS);
}
function stopSampling() {
  if (sampleTimer) clearInterval(sampleTimer);
  sampleTimer = null;
}

function createWindow() {
  win = new BrowserWindow({
    width: 380,
    height: 460,
    resizable: false,
    title: "Staff Wise Agent",
    webPreferences: { preload: path.join(__dirname, "preload.js") },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide(); // keep tracking in the background
    }
  });
  win.webContents.on("did-finish-load", updateUI);
}

ipcMain.handle("login", async (_e, { email, password }) => {
  try {
    const res = await fetch(API_BASE + "/api/agent/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) return { error: data.error || "Login failed" };
    token = data.token;
    employee = data.employee;
    saveSession();
    lastStatus = "Ready — clock in to start your shift";
    updateUI();
    refreshClockStatus(); // resume if already clocked in (e.g. from the web)
    return { ok: true };
  } catch {
    return { error: "Can't reach server at " + API_BASE };
  }
});

async function clockApi(action) {
  const res = await fetch(API_BASE + "/api/agent/clock", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + token,
    },
    body: JSON.stringify({ action }),
  });
  return res.ok ? res.json() : Promise.reject(new Error("clock " + res.status));
}

/** Reflect the server's clock state (e.g. clocked in from the web) into the agent. */
async function refreshClockStatus() {
  if (!token) return;
  try {
    const data = await clockApi("status");
    clockedInSince = data.since;
    if (data.clockedIn && !sampleTimer) startSampling();
    if (!data.clockedIn && sampleTimer) stopSampling();
    if (!data.clockedIn) lastStatus = "Ready — clock in to start your shift";
    updateUI();
  } catch {
    /* offline — leave as-is */
  }
}

ipcMain.handle("clockIn", async () => {
  if (!token) return { error: "Not signed in" };
  try {
    const data = await clockApi("in");
    clockedInSince = data.since;
    startSampling();
    lastStatus = "Starting…";
    updateUI();
    return { ok: true };
  } catch {
    return { error: "Can't reach server — try again" };
  }
});

ipcMain.handle("clockOut", async () => {
  stopSampling();
  await flush().catch(() => {});
  try {
    await clockApi("out");
  } catch {
    /* still stop locally even if offline */
  }
  clockedInSince = null;
  lastStatus = "Clocked out";
  updateUI();
  return { ok: true };
});

ipcMain.handle("logout", async () => {
  stopSampling();
  await flush().catch(() => {});
  token = null;
  employee = null;
  buffer = [];
  lastStatus = "Signed out";
  clearSession();
  updateUI();
  return { ok: true };
});

ipcMain.handle("quitApp", async () => {
  quitting = true;
  await flush().catch(() => {});
  app.quit();
});

app.whenReady().then(() => {
  loadSession();
  createWindow();
  if (token) {
    lastStatus = "Ready — clock in to start your shift";
    refreshClockStatus();
  }

  app.on("activate", () => {
    if (win) win.show();
    else createWindow();
  });
});

// keep running in background when the window is closed
app.on("window-all-closed", () => {});
