const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("biukin", {
  login: (creds) => ipcRenderer.invoke("login", creds),
  logout: () => ipcRenderer.invoke("logout"),
  clockIn: () => ipcRenderer.invoke("clockIn"),
  clockOut: () => ipcRenderer.invoke("clockOut"),
  quitApp: () => ipcRenderer.invoke("quitApp"),
  onStatus: (cb) => ipcRenderer.on("status", (_e, data) => cb(data)),
});
