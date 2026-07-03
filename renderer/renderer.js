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

$("trackBtn").addEventListener("click", () => {
  const btn = $("trackBtn");
  btn.disabled = true;
  const p = btn.dataset.on === "1" ? window.biukin.clockOut() : window.biukin.clockIn();
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

  // Clock in / out toggle
  const btn = $("trackBtn");
  btn.dataset.on = on ? "1" : "0";
  btn.textContent = on ? "Clock out" : "Clock in";
  btn.classList.toggle("secondary", on);
});
