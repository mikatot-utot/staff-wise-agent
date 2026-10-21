const {
  app,
  BrowserWindow,
  ipcMain,
  powerMonitor,
  Notification,
  shell,
  systemPreferences,
} = require("electron");
const path = require("path");
const fs = require("fs");
const { isBrowser, windowsBrowserUrl } = require("./browser-url");

// Point this at your server. Production by default; override with BIUKIN_API for local dev.
const API_BASE = process.env.BIUKIN_API || "https://staff-wise-theta.vercel.app";

const SAMPLE_INTERVAL_MS = 60_000; // take a reading every 60s
const IDLE_THRESHOLD_S = 540; // idle if no keyboard/mouse for 9 min
const STATUS_POLL_MS = 15 * 60_000; // refresh clock/shift state from the server
const FLUSH_CHUNK = 200; // replay uploads go out in chunks this size
const DISCONNECTED_AFTER = 3; // unsent readings before the loud red state

let win = null;
let token = null;
let employee = null;
let buffer = [];
let sampleTimer = null;
let statusTimer = null;
let quitting = false;
let lastStatus = "Signed out";
let clockedInSince = null;
let onBreak = false;
let breakSince = null;
let todayShift = null; // { client, startsAt, endsAt }
let flushFailing = false; // last upload attempt failed (network)
let outageNotified = false;

const sessionFile = () => path.join(app.getPath("userData"), "session.json");
// Pending readings are stored PER PERSON — if a different CSR signs in on the
// same laptop, the previous person's unsent work must never upload under the
// new account. Each person's file is picked up again when THEY sign back in.
const pendingFile = () =>
  path.join(
    app.getPath("userData"),
    `pending-readings-${employee && employee.id ? employee.id : "anon"}.json`,
  );

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

/**
 * Readings are written to disk the moment they're taken and only removed once
 * the server confirms them — a crash, restart, or a night of bad internet can
 * no longer lose tracked work.
 */
function savePending() {
  try {
    // write-then-rename: a crash or power cut mid-write can only ever lose the
    // temp file, never the real backlog this feature exists to protect
    const file = pendingFile();
    fs.writeFileSync(file + ".tmp", JSON.stringify(buffer));
    fs.renameSync(file + ".tmp", file);
  } catch {}
}
function loadPending() {
  try {
    const rows = JSON.parse(fs.readFileSync(pendingFile(), "utf8"));
    if (Array.isArray(rows)) buffer = rows.filter((r) => r && r.ts);
  } catch {}
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/** macOS screen-recording permission state ("granted" | "denied" | ...). */
function screenPerm() {
  if (process.platform !== "darwin") return "granted";
  try {
    return systemPreferences.getMediaAccessStatus("screen");
  } catch {
    return "granted";
  }
}

function updateUI() {
  send("status", {
    signedIn: !!token,
    employee,
    clockedIn: !!sampleTimer,
    since: clockedInSince,
    onBreak,
    breakSince,
    todayShift,
    status: lastStatus,
    pending: buffer.length,
    disconnected: flushFailing && buffer.length >= DISCONNECTED_AFTER,
    screenPerm: screenPerm(),
    version: app.getVersion(),
    apiBase: API_BASE,
  });
}

/** One native heads-up per outage — tracking silently dying was the old bug. */
function notifyOutage() {
  if (outageNotified) return;
  outageNotified = true;
  try {
    new Notification({
      title: "Staff Wise Agent — not reaching the server",
      body: "Your work is still being recorded on this laptop and will upload by itself when internet returns.",
    }).show();
  } catch {}
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
  savePending(); // on disk before we even try the network
  const place = domain ? " · " + domain : app_name ? " · " + app_name : "";
  if (onBreak) lastStatus = "On break";
  else lastStatus = active ? `Active${place}` : `Idle${place}`;
  await flush();
  updateUI();
}

// Only one flush at a time: a second run while the first awaits the network
// could confirm-and-drop readings the server never saw.
let flushing = false;

async function flush() {
  if (!token || buffer.length === 0 || flushing) return;
  flushing = true;
  try {
    await flushInner();
  } finally {
    flushing = false;
  }
}

async function flushInner() {
  // replay in order, oldest first, in chunks — one bad chunk stops the run
  // and everything unsent stays on disk for the next try
  while (token && buffer.length > 0) {
    const batch = buffer.slice(0, FLUSH_CHUNK);
    try {
      const res = await fetch(API_BASE + "/api/agent/activity", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
        },
        body: JSON.stringify({ samples: batch }),
        // a HUNG connection must fail fast, or the red warning never shows
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        buffer.splice(0, batch.length); // drop only what the server confirmed
        savePending();
        if (flushFailing) {
          flushFailing = false;
          outageNotified = false;
          lastStatus = "Back online — readings caught up";
        }
      } else if (res.status === 401) {
        lastStatus = "Session expired — sign in again";
        stopSampling();
        token = null;
        clearSession();
        // tracking just silently stopped — make sure the person can see it
        if (win) win.show();
        return;
      } else if (res.status >= 400 && res.status < 500) {
        // the server LOOKED at this batch and rejected it — retrying the same
        // data forever would block everything queued behind it
        buffer.splice(0, batch.length);
        savePending();
      } else {
        // 5xx: the server is in trouble — same loud path as no internet, so
        // tracking can never die silently again
        flushFailing = true;
        if (buffer.length >= DISCONNECTED_AFTER) notifyOutage();
        return;
      }
    } catch {
      // offline — keep everything buffered (and on disk), retry next minute
      flushFailing = true;
      if (buffer.length >= DISCONNECTED_AFTER) notifyOutage();
      return;
    }
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
    height: 560,
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
    buffer = [];
    loadPending(); // THIS person's rescued readings (per-person file) go out now
    lastStatus = "Ready — clock in to start your shift";
    updateUI();
    refreshClockStatus(); // resume if already clocked in (e.g. from the web)
    flush().catch(() => {});
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
    onBreak = !!data.onBreak;
    breakSince = data.breakSince ?? null;
    todayShift = data.todayShift ?? null;
    if (data.clockedIn && !sampleTimer) startSampling();
    if (!data.clockedIn && sampleTimer) stopSampling();
    if (!data.clockedIn) {
      onBreak = false;
      breakSince = null;
      lastStatus = "Ready — clock in to start your shift";
    }
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
    todayShift = data.todayShift ?? todayShift;
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
  onBreak = false;
  breakSince = null;
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

/** Break toggle — a recorded span on the server; no countdown by design. */
ipcMain.handle("breakToggle", async () => {
  if (!token) return { error: "Not signed in" };
  const action = onBreak ? "end" : "start";
  try {
    const res = await fetch(API_BASE + "/api/agent/break", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
      },
      body: JSON.stringify({ action }),
    });
    const data = await res.json();
    if (!res.ok) return { error: data.error || "Break failed — try again" };
    onBreak = !!data.onBreak;
    breakSince = data.breakSince ?? null;
    lastStatus = onBreak ? "On break" : "Back from break";
    updateUI();
    return { ok: true };
  } catch {
    return { error: "Can't reach server — check your internet and try again" };
  }
});

ipcMain.handle("openScreenSettings", async () => {
  if (process.platform === "darwin") {
    await shell.openExternal(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    );
  }
  return { ok: true };
});

ipcMain.handle("logout", async () => {
  stopSampling();
  await flush().catch(() => {});
  savePending(); // unsent readings stay in THIS person's file for next sign-in
  buffer = [];
  token = null;
  employee = null;
  lastStatus = "Signed out";
  onBreak = false;
  breakSince = null;
  todayShift = null;
  clearSession();
  updateUI();
  return { ok: true };
});

ipcMain.handle("quitApp", async () => {
  quitting = true;
  await flush().catch(() => {});
  app.quit();
});

/** Self-update: pulls new signed builds from GitHub releases — no reinstalls. */
function setupAutoUpdate() {
  if (!app.isPackaged) return;
  try {
    const { autoUpdater } = require("electron-updater");
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    const check = () => autoUpdater.checkForUpdatesAndNotify().catch(() => {});
    check();
    setInterval(check, 6 * 60 * 60_000);
  } catch {}
}

app.whenReady().then(() => {
  loadSession();
  loadPending();
  createWindow();
  if (token) {
    lastStatus = "Ready — clock in to start your shift";
    refreshClockStatus();
    flush().catch(() => {}); // readings rescued from disk go out first
  }

  // start with the laptop so nobody forgets to open the tracker
  if (app.isPackaged) {
    try {
      app.setLoginItemSettings({ openAtLogin: true });
    } catch {}
  }

  setupAutoUpdate();

  // after sleep/wake the local clock state can be stale (e.g. auto-closed
  // server-side overnight) — resync with the server
  powerMonitor.on("resume", () => refreshClockStatus());

  // periodic resync keeps the shift card and break state honest even if the
  // person also uses the website
  statusTimer = setInterval(() => refreshClockStatus(), STATUS_POLL_MS);

  app.on("activate", () => {
    if (win) win.show();
    else createWindow();
  });
});

app.on("will-quit", () => {
  if (statusTimer) clearInterval(statusTimer);
});

// keep running in background when the window is closed
app.on("window-all-closed", () => {});
