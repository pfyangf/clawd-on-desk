"use strict";

const { contextBridge, ipcRenderer } = require("electron");

/**
 * 消息中心渲染层暴露的受限 API。
 */
contextBridge.exposeInMainWorld("notifyAPI", {
  getState: () => ipcRenderer.invoke("notify:get-state"),
  login: (payload) => ipcRenderer.invoke("notify:login", payload),
  logout: () => ipcRenderer.invoke("notify:logout"),

  listMessages: (params) => ipcRenderer.invoke("notify:list-messages", params),
  listTopics: () => ipcRenderer.invoke("notify:list-topics"),
  listSubscriptions: () => ipcRenderer.invoke("notify:list-subscriptions"),
  subscribe: (topicCode) => ipcRenderer.invoke("notify:subscribe", topicCode),
  unsubscribe: (topicCode) => ipcRenderer.invoke("notify:unsubscribe", topicCode),

  postEvent: (payload) => ipcRenderer.invoke("notify:post-event", payload),
  setSettings: (settings) => ipcRenderer.invoke("notify:set-settings", settings),
  openLink: (url) => ipcRenderer.invoke("notify:open-link", url),

  onStateChanged: (fn) => {
    const listener = (_e, state) => fn(state);
    ipcRenderer.on("notify:state-changed", listener);
    return () => ipcRenderer.removeListener("notify:state-changed", listener);
  },
  onMessagesChanged: (fn) => {
    const listener = () => fn();
    ipcRenderer.on("notify:messages-changed", listener);
    return () => ipcRenderer.removeListener("notify:messages-changed", listener);
  },
});
