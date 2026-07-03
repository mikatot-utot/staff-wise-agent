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
  if ($("trackBtn").dataset.tracking === "1") window.biukin.stopTracking();
  else window.biukin.startTracking();
});
$("logoutBtn").addEventListener("click", () => window.biukin.logout());
$("quitBtn").addEventListener("click", () => window.biukin.quitApp());

window.biukin.onStatus((s) => {
  const loggedIn = s.signedIn;
  $("loginView").classList.toggle("hide", loggedIn);
  $("trackingView").classList.toggle("hide", !loggedIn);
  if (!loggedIn) return;

  const tracking = !!s.tracking;
  const name = s.employee ? s.employee.short_name : "You";
  $("who").textContent = tracking ? `${name} — tracking` : `${name} — paused`;
  const active = tracking && (s.status || "").startsWith("Active");
  $("dot").style.background = tracking ? (active ? "#10b981" : "#f59e0b") : "#6b6b70";
  $("statusLine").textContent = s.status || "";
  $("pending").textContent = s.pending
    ? `${s.pending} reading(s) queued to upload`
    : tracking
      ? "All readings uploaded"
      : "";
  $("server").textContent = `Server: ${s.apiBase}`;

  // Start/Stop toggle
  const btn = $("trackBtn");
  btn.dataset.tracking = tracking ? "1" : "0";
  btn.textContent = tracking ? "■ Stop tracking" : "▶ Start tracking";
  btn.classList.toggle("secondary", tracking);
});
