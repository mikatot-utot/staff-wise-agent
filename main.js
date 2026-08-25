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
const IDLE_THRESHOLD_S = 540; // idle if no keyboard/mouse for 9 min
const FLUSH_EVERY = 1; // upload after every sample (~1 min) so the dashboard is near-live

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
  // Always capture the foreground app/site — even while idle — so watching a
  // video (no input) still shows WHERE the person is, not just "idle".
  const { app_name, domain } = await getActiveWindow();
  buffer.push({ ts: new Date().toISOString(), active, app_name, domain });
  const place = domain ? " · " + domain : app_name ? " · " + app_name : "";
  lastStatus = active
    ? `Active${place || " (grant permissions for app/site names)"}`
    : `Idle${place}`;
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
      // tracking just silently stopped — make sure the person can see it
      if (win) win.show();
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

/** Error whose .userMessage is safe to show as-is (server told us why). */
class ClockError extends Error {
  constructor(userMessage, status) {
    super(userMessage);
    this.userMessage = userMessage;
    this.status = status;
  }
}

async function clockApi(action) {
  const res = await fetch(API_BASE + "/api/agent/clock", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + token,
    },
    body: JSON.stringify({ action }),
  });
  if (res.ok) return res.json();
  // Surface the server's actual reason — a 409 ("Outside your shift window")
  // is not a network problem, and telling people "can't reach server" sent
  // them into pointless retries.
  if (res.status === 401) {
    token = null;
    clearSession();
    stopSampling();
    lastStatus = "Session expired — sign in again";
    updateUI();
    if (win) win.show();
    throw new ClockError("Session expired — sign in again", 401);
  }
  let msg = null;
  try {
    msg = (await res.json()).error || null;
  } catch {}
  throw new ClockError(msg || "Server error (" + res.status + ") — try again", res.status);
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
    if (!data.clockedIn) {
      // server refused (e.g. outside the shift window) with a 200-level body
      return { error: data.error || "Couldn't clock in — try again" };
    }
    clockedInSince = data.since;
    startSampling();
    lastStatus = "Starting…";
    updateUI();
    return { ok: true };
  } catch (e) {
    if (e && e.userMessage) return { error: e.userMessage };
    return { error: "Can't reach server — check your internet and try again" };
  }
});

// If a clock-out can't reach the server, the entry stays open server-side and
// would later be auto-closed at the shift end — hours the person didn't work.
// Keep retrying in the background until the server confirms.
let outRetryTimer = null;
function scheduleOutRetry() {
  if (outRetryTimer) return;
  outRetryTimer = setInterval(async () => {
    try {
      await clockApi("out");
      clearInterval(outRetryTimer);
      outRetryTimer = null;
      lastStatus = "Clocked out";
      updateUI();
    } catch (e) {
      if (e && e.status) {
        // server answered (session expired / already closed) — stop retrying
        clearInterval(outRetryTimer);
        outRetryTimer = null;
      }
      // network failure: keep the timer, try again next round
    }
  }, 30_000);
}

ipcMain.handle("clockOut", async () => {
  stopSampling();
  await flush().catch(() => {});
  clockedInSince = null;
  try {
    await clockApi("out");
    lastStatus = "Clocked out";
  } catch (e) {
    if (e && e.status) {
      lastStatus = "Clocked out";
    } else {
      lastStatus = "Clock-out pending — offline, will keep retrying";
      scheduleOutRetry();
    }
  }
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

  // after sleep/wake the local clock state can be stale (e.g. auto-closed
  // server-side overnight) — resync with the server
  powerMonitor.on("resume", () => refreshClockStatus());

  app.on("activate", () => {
    if (win) win.show();
    else createWindow();
  });
});

// keep running in background when the window is closed
app.on("window-all-closed", () => {});
