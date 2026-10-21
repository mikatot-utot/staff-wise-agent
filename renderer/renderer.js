const $ = (id) => document.getElementById(id);

const PH = "Asia/Manila";

/* ---------- sign in ---------- */

$("loginBtn").addEventListener("click", async () => {
  $("err").textContent = "";
  const email = $("email").value.trim();
  const password = $("password").value;
  if (!email || !password) {
    $("err").textContent = "Enter your email and password.";
    return;
  }
  $("loginBtn").textContent = "Signing in…";
  $("loginBtn").disabled = true;
  const res = await window.biukin.login({ email, password });
  $("loginBtn").textContent = "Sign in";
  $("loginBtn").disabled = false;
  if (res.error) $("err").textContent = res.error;
});

// a stale error once sent a CSR into a password reset she didn't need —
// the moment the input changes, the old message is gone
for (const id of ["email", "password"]) {
  $(id).addEventListener("input", () => {
    $("err").textContent = "";
  });
  $(id).addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("loginBtn").click();
  });
}

/* ---------- clock in / out ---------- */

// Guard the in/out toggle two ways:
// 1. Clocking OUT takes a second confirming click (5s window) — one stray
//    click can no longer end tracking.
// 2. After any punch the button stays locked until the next status update,
//    plus a short cooldown — a double-click used to clock in AND right back
//    out (the second click landed after the button had already toggled).
let confirmingOut = false;
let confirmTimer = null;
let cooldown = false;

function resetConfirm() {
  confirmingOut = false;
  if (confirmTimer) clearTimeout(confirmTimer);
  confirmTimer = null;
}

$("trackBtn").addEventListener("click", () => {
  const btn = $("trackBtn");
  if (btn.disabled || cooldown) return;

  if (btn.dataset.on === "1" && !confirmingOut) {
    // first click while clocked in → ask for confirmation
    confirmingOut = true;
    btn.textContent = "Click again to confirm clock out";
    confirmTimer = setTimeout(() => {
      resetConfirm();
      btn.textContent = "Clock out";
    }, 5000);
    return;
  }

  const clockingOut = btn.dataset.on === "1";
  resetConfirm();
  btn.disabled = true;
  cooldown = true;
  setTimeout(() => {
    cooldown = false;
  }, 2500);
  const p = clockingOut ? window.biukin.clockOut() : window.biukin.clockIn();
  Promise.resolve(p).then((r) => {
    btn.disabled = false;
    if (r && r.error) $("statusLine").textContent = r.error;
  });
});

/* ---------- break ---------- */

$("breakBtn").addEventListener("click", async () => {
  const btn = $("breakBtn");
  if (btn.disabled) return;
  btn.disabled = true;
  const r = await window.biukin.breakToggle();
  btn.disabled = false;
  if (r && r.error) $("statusLine").textContent = r.error;
});

$("permBtn").addEventListener("click", () => window.biukin.openScreenSettings());
$("logoutBtn").addEventListener("click", () => window.biukin.logout());
$("quitBtn").addEventListener("click", () => window.biukin.quitApp());

/* ---------- display ---------- */

// Everything on this screen is PH time, whatever the laptop's clock is set to
// (US-timezone Windows machines showed "since 12:51 PM" for a 3:51 AM shift).
function phTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("en-US", {
    timeZone: PH,
    hour: "numeric",
    minute: "2-digit",
  });
}

function elapsed(iso) {
  if (!iso) return "—";
  let s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

let last = null;

function render() {
  if (!last || !last.signedIn) return;
  const s = last;
  const on = !!s.clockedIn;
  const box = $("stateBox");

  // state box: DOWN > BREAK > TRACKING > CLOCKED OUT
  let cls = "off";
  let label = "CLOCKED OUT";
  let line = "Clock in to start your shift";
  let timer = "—";
  if (on && s.disconnected) {
    cls = "down";
    label = "⚠ NOT REACHING SERVER";
    line = `Your work is still recorded on this laptop — ${s.pending} reading${s.pending === 1 ? "" : "s"} saved. They upload by themselves.`;
    timer = elapsed(s.since);
  } else if (on && s.onBreak) {
    cls = "break";
    label = "⏸ ON BREAK";
    line = `since ${phTime(s.breakSince)} · PH time`;
    timer = elapsed(s.since);
  } else if (on) {
    cls = "tracking";
    label = "● TRACKING";
    line = `since ${phTime(s.since)} · PH time`;
    timer = elapsed(s.since);
  }
  box.className = "state " + cls;
  $("stateLabel").textContent = label;
  $("stateLine").textContent = line;
  $("timer").textContent = timer;
}

// live timer tick
setInterval(render, 1000);

window.biukin.onStatus((s) => {
  last = s;
  const loggedIn = s.signedIn;
  $("ver").textContent = s.version ? "v" + s.version : "";
  $("loginView").classList.toggle("hide", loggedIn);
  $("trackingView").classList.toggle("hide", !loggedIn);
  if (!loggedIn) return;

  const on = !!s.clockedIn;

  // today's shift card — PH times, matching My week (built with textContent,
  // never markup, so a client name can't inject anything)
  if (s.todayShift) {
    $("shiftCard").classList.remove("hide");
    const line = $("shiftLine");
    line.textContent = "";
    const name = document.createElement("strong");
    name.textContent = s.todayShift.client;
    line.appendChild(name);
    line.appendChild(
      document.createTextNode(
        ` · ${phTime(s.todayShift.startsAt)} – ${phTime(s.todayShift.endsAt)} PH`,
      ),
    );
  } else {
    $("shiftCard").classList.add("hide");
  }

  // macOS screen permission card (Windows never sees this)
  $("permCard").classList.toggle("hide", s.screenPerm === "granted");

  // status line: live detail (Active · site, Idle, Back online…)
  $("statusLine").textContent = s.status || "";

  // foot note: upload state + the idle rule, so nobody has to guess
  $("footNote").textContent = on
    ? (s.pending > 0
        ? `${s.pending} reading${s.pending === 1 ? "" : "s"} waiting to upload`
        : "readings up to date ✓") + " · idle after 9 min of no input"
    : "";

  // break button only while on the clock
  $("breakBtn").classList.toggle("hide", !on);
  $("breakBtn").textContent = s.onBreak ? "▶ End break" : "☕ Break";

  // Clock in / out toggle (leave the label alone mid-confirmation)
  const btn = $("trackBtn");
  const wasOn = btn.dataset.on;
  btn.dataset.on = on ? "1" : "0";
  if (!confirmingOut || wasOn !== btn.dataset.on) {
    resetConfirm();
    btn.textContent = on ? "Clock out" : "Clock in";
  }
  btn.classList.toggle("secondary", on);

  render();
});
