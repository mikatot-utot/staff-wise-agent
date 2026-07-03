# Biukin Agent

Desktop time & activity tracker for Biukin CSRs (Windows + Mac, built with Electron).
It signs in, then every 60 seconds records whether you're **active or idle** (from
keyboard/mouse) and which **app** is in front, and uploads it to the Biukin server.

## What it tracks (v1)
- **Presence** — active vs. idle, from system input timing (no keylogging — it only
  knows that input happened, not what you typed).
- **App usage** — the name of the foreground app (e.g. "Google Chrome").
- ❌ No screenshots, no website URLs, no webcam in this version.

## Run it (development)
The agent talks to your running Biukin web app.

1. Start the web app first (so the API is reachable):
   ```bash
   cd ../biukin-scheduler && npm run dev   # http://localhost:3200 (or :3000)
   ```
2. Start the agent:
   ```bash
   cd biukin-agent
   npm install            # first time only
   npm start
   ```
3. Sign in with an employee email + password (same accounts as the web app; first
   login sets the password).

Point the agent at a different server with an env var:
```bash
BIUKIN_API=https://your-app.vercel.app npm start
```

## macOS permission (for app names)
macOS blocks reading other apps' info until you allow it. **Presence/idle works without
this**, but to capture **app names** the employee must grant permission:

System Settings → Privacy & Security → **Screen Recording** → enable the agent (or the
terminal, during development) → relaunch the agent.

(Windows needs no special permission.)

## How it behaves
- Closing the window keeps it **running in the background** (still tracking).
- Use **Sign out** to stop tracking but keep the app open, or **Stop & quit** to exit.
- Works offline — readings are queued and uploaded when the connection returns.

## Files
- `main.js` — Electron main process: login, the 60s sampling loop, batched upload
- `preload.js` — safe bridge to the UI
- `renderer/` — the small login + status window
- `test-headless.js` — no-window verification harness (`electron test-headless.js`)

## Not yet done (future)
- Packaging into installers (.exe / .dmg) + code-signing for distribution
- Screenshots / URL tracking (would be a v2, with a consent policy)
