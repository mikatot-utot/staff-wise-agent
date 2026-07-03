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
  $("loginBtn").textContent = "Sign in & start tracking";
  $("loginBtn").disabled = false;
  if (res.error) $("err").textContent = res.error;
});

$("logoutBtn").addEventListener("click", () => window.biukin.logout());
$("quitBtn").addEventListener("click", () => window.biukin.quitApp());

window.biukin.onStatus((s) => {
  const loggedIn = s.signedIn;
  $("loginView").classList.toggle("hide", loggedIn);
  $("trackingView").classList.toggle("hide", !loggedIn);
  if (!loggedIn) return;

  $("who").textContent = s.employee
    ? `${s.employee.short_name} — tracking`
    : "Tracking";
  const active = (s.status || "").startsWith("Active");
  $("dot").style.background = active ? "#10b981" : "#9ca3af";
  $("statusLine").textContent = s.status || "";
  $("pending").textContent = s.pending
    ? `${s.pending} reading(s) queued to upload`
    : "All readings uploaded";
  $("server").textContent = `Server: ${s.apiBase}`;
});
