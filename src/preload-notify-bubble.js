"use strict";

const { contextBridge, ipcRenderer } = require("electron");

/**
 * 通知气泡渲染层暴露的受限 API。
 */
contextBridge.exposeInMainWorld("bubbleAPI", {
  onShow: (fn) => {
    const listener = (_e, message) => fn(message);
    ipcRenderer.on("notify-bubble:show", listener);
    return () => ipcRenderer.removeListener("notify-bubble:show", listener);
  },
  click: (message) => ipcRenderer.send("notify-bubble:click", message),
  dismiss: () => ipcRenderer.send("notify-bubble:dismiss"),
});
