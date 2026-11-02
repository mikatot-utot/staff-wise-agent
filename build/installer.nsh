; --- Staff Wise Agent: close the old copy cleanly during install/upgrade ---
; The agent runs in the background: closing its window hides it, it does not
; quit. To upgrade over it, the installer must end the old process first.
;
; electron-builder's default routine tries to do that with a taskkill that
; filters on the exact PID *and* Windows username. On several of our machines
; that filter didn't match, the old process survived, and the install stalled
; on "Staff Wise Agent cannot be closed. Please close it manually and click
; Retry" — forcing people into Task Manager.
;
; customCheckAppRunning replaces that routine (electron-builder calls it in
; place of the default, in both the installer and the uninstaller). We end the
; app directly by image name with no fragile filters; /T also ends the helper
; processes it spawns. Because this runs before the old version is removed, the
; old uninstaller then finds nothing running and proceeds too.
!macro customCheckAppRunning
  nsExec::Exec `taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"`
  Sleep 1000
!macroend
