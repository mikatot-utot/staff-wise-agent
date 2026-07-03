const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("biukin", {
  login: (creds) => ipcRenderer.invoke("login", creds),
  logout: () => ipcRenderer.invoke("logout"),
  startTracking: () => ipcRenderer.invoke("startTracking"),
  stopTracking: () => ipcRenderer.invoke("stopTracking"),
  quitApp: () => ipcRenderer.invoke("quitApp"),
  onStatus: (cb) => ipcRenderer.on("status", (_e, data) => cb(data)),
});
