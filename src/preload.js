"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("oncall", {
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  testConnection: (settings) => ipcRenderer.invoke("connection:test", settings),
  getFrontends: () => ipcRenderer.invoke("frontends:list"),
  send: (request) => ipcRenderer.invoke("chat:send", request),
  exportPdf: (request) => ipcRenderer.invoke("chat:export-pdf", request),
  onChatEvent: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("chat:event", handler);
    return () => ipcRenderer.removeListener("chat:event", handler);
  },
});
