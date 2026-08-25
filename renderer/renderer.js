const $ = (id) => document.getElementById(id);

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
$("logoutBtn").addEventListener("click", () => window.biukin.logout());
$("quitBtn").addEventListener("click", () => window.biukin.quitApp());

function fmtSince(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

window.biukin.onStatus((s) => {
  const loggedIn = s.signedIn;
  $("loginView").classList.toggle("hide", loggedIn);
  $("trackingView").classList.toggle("hide", !loggedIn);
  if (!loggedIn) return;

  const on = !!s.clockedIn;
  const name = s.employee ? s.employee.short_name : "You";
  $("who").textContent = on
    ? `${name} — on the clock${s.since ? " · since " + fmtSince(s.since) : ""}`
    : `${name} — clocked out`;
  const active = on && (s.status || "").startsWith("Active");
  $("dot").style.background = on ? (active ? "#10b981" : "#f59e0b") : "#6b6b70";
  $("statusLine").textContent = s.status || "";
  $("pending").textContent = s.pending
    ? `${s.pending} reading(s) queued to upload`
    : on
      ? "All readings uploaded"
      : "";
  $("server").textContent = `Server: ${s.apiBase}`;

  // Clock in / out toggle (leave the label alone mid-confirmation)
  const btn = $("trackBtn");
  const wasOn = btn.dataset.on;
  btn.dataset.on = on ? "1" : "0";
  if (!confirmingOut || wasOn !== btn.dataset.on) {
    resetConfirm();
    btn.textContent = on ? "Clock out" : "Clock in";
  }
  btn.classList.toggle("secondary", on);
});
