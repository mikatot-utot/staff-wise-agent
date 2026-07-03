// Windows browser URL capture via UI Automation (no native module needed).
//
// active-win returns the active tab URL on macOS, but NOT on Windows. There,
// the reliable way to read the current URL is the Windows UI Automation API:
// find the foreground window, walk its automation tree to the address-bar
// Edit control, and read its value. We do that from a short PowerShell script.
//
// Everything here is fail-safe: any error resolves to null, so presence + app
// tracking keep working even if URL capture fails.

const { execFile } = require("child_process");

const BROWSERS = [
  "chrome",
  "google chrome",
  "msedge",
  "microsoft edge",
  "edge",
  "brave",
  "brave browser",
  "opera",
  "vivaldi",
  "firefox",
  "mozilla firefox",
];

function isBrowser(appName) {
  if (!appName) return false;
  const n = String(appName).toLowerCase();
  return BROWSERS.some((b) => n.includes(b));
}

// Reads the foreground window's first address-bar Edit control value.
// Works for Chromium browsers (Chrome/Edge/Brave/Opera/Vivaldi). Firefox exposes
// its URL bar similarly. Returns the raw text (may be scheme-less).
const PS_SCRIPT = `
$ErrorActionPreference='SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class FG { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); }
"@
$h=[FG]::GetForegroundWindow()
if($h -ne [IntPtr]::Zero){
  $root=[System.Windows.Automation.AutomationElement]::FromHandle($h)
  if($root){
    $cond=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Edit)
    $edit=$root.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$cond)
    if($edit){
      $vp=$edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
      if($vp){ Write-Output $vp.Current.Value }
    }
  }
}
`;

function windowsBrowserUrl() {
  return new Promise((resolve) => {
    if (process.platform !== "win32") return resolve(null);
    try {
      // -EncodedCommand takes base64 UTF-16LE, sidestepping all the quoting pain.
      const b64 = Buffer.from(PS_SCRIPT, "utf16le").toString("base64");
      const child = execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-EncodedCommand", b64],
        { timeout: 3000, windowsHide: true },
        (err, stdout) => {
          if (err) return resolve(null);
          const line = String(stdout).trim().split(/\r?\n/)[0].trim();
          resolve(line || null);
        },
      );
      child.on("error", () => resolve(null));
    } catch {
      resolve(null);
    }
  });
}

module.exports = { isBrowser, windowsBrowserUrl };
