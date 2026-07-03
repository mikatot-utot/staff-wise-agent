// Headless verification: runs under Electron, logs in, reads idle + active app,
// posts samples to the local API, prints results, quits. No window.
const { app, powerMonitor } = require("electron");

const API = process.env.BIUKIN_API || "http://localhost:3200";
const EMAIL = process.env.TEST_EMAIL;
const PASSWORD = process.env.TEST_PASSWORD || "agentpass1";

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const out = (x) => console.log("[harness] " + x);
  try {
    const lr = await fetch(API + "/api/agent/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    const ld = await lr.json();
    if (!lr.ok) throw new Error("login: " + JSON.stringify(ld));
    out("login OK, token " + ld.token.slice(0, 16) + "…");

    const idle = powerMonitor.getSystemIdleTime();
    out("powerMonitor idle seconds = " + idle);

    let appName = null;
    let realUrl = null;
    try {
      const m = await import("active-win");
      const w = await m.default();
      appName = w && w.owner ? w.owner.name : null;
      realUrl = w && w.url ? w.url : null;
    } catch (e) {
      out("active-win unavailable (expected without Screen Recording): " + e.message.slice(0, 40));
    }
    out("active app = " + appName);
    out("active-win url (real browser tab, if a browser is frontmost + permission granted) = " + realUrl);

    const now = new Date().toISOString();
    // include a distinctive test domain so we can verify the new domain field ingests
    const pr = await fetch(API + "/api/agent/activity", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + ld.token,
      },
      body: JSON.stringify({
        samples: [
          { ts: now, active: true, app_name: "AgentSelfTest", domain: "agent-test.local" },
        ],
      }),
    });
    const pd = await pr.json();
    out("activity POST -> " + JSON.stringify(pd));
    out("RESULT: " + (pd.ok ? "PASS" : "FAIL"));
  } catch (e) {
    out("ERROR: " + e.message);
  } finally {
    app.quit();
  }
});
