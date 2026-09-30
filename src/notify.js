"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");
const { app, BrowserWindow, ipcMain, shell, screen } = require("electron");
const WebSocket = require("ws");

/**
 * PetNotify 桌宠通知客户端（主进程模块）。
 * 独立自包含：配置/密钥/HTTP/WS 均在主进程，渲染层仅通过受限 IPC 交互。
 *
 * @param {object} ctx 依赖上下文（由 main.js 注入）
 */
module.exports = function initNotify(ctx) {
  const log = ctx.logger || console;

  // -------------------------------------------------------------------------
  // 配置持久化
  // -------------------------------------------------------------------------
  const configDir = ctx.configDir || path.join(os.homedir(), ".clawd");
  const configFile = path.join(configDir, "notify.json");

  const defaults = {
    serverUrl: "http://127.0.0.1:8080",
    token: "",
    userCode: "",
    displayName: "",
    deviceId: "",
    soundEnabled: true,
    doNotDisturb: false,
    bubbleDurationSeconds: 8,
  };

  let config = loadConfig();

  function loadConfig() {
    try {
      if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
      if (fs.existsSync(configFile)) {
        return Object.assign({}, defaults, JSON.parse(fs.readFileSync(configFile, "utf8")));
      }
    } catch (e) {
      log.warn("[notify] 配置读取失败，使用默认值:", e.message);
    }
    return Object.assign({}, defaults);
  }

  function saveConfig() {
    try {
      if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(configFile, JSON.stringify(config, null, 2), "utf8");
    } catch (e) {
      log.error("[notify] 配置保存失败:", e.message);
    }
  }

  // -------------------------------------------------------------------------
  // 运行时状态
  // -------------------------------------------------------------------------
  let ws = null;
  let connected = false;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let heartbeatTimer = null;
  let disposed = false;

  /** 通知气泡队列（按优先级、时间排序） */
  const bubbleQueue = [];
  /** 已处理消息ID，用于去重（最近 N 条） */
  const seenMessageIds = [];
  const SEEN_LIMIT = 500;

  let centerWindow = null;
  let bubbleWindow = null;
  let currentBubble = null;

  // -------------------------------------------------------------------------
  // HTTP 客户端
  // -------------------------------------------------------------------------
  function normalizeBase(url) {
    return (url || "").replace(/\/+$/, "");
  }

  async function api(method, urlPath, body) {
    const headers = { "Content-Type": "application/json" };
    if (config.token) headers["Authorization"] = "Bearer " + config.token;
    const res = await fetch(normalizeBase(config.serverUrl) + urlPath, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    const text = await res.text();
    try {
      json = text ? JSON.parse(text) : null;
    } catch (e) {
      throw new Error("服务端响应不是合法 JSON（HTTP " + res.status + "）");
    }
    if (!res.ok || !json || json.code !== 0) {
      const msg = (json && json.message) || "请求失败（HTTP " + res.status + "）";
      const err = new Error(msg);
      err.status = res.status;
      err.code = json && json.code;
      throw err;
    }
    return json.data;
  }

  // -------------------------------------------------------------------------
  // 认证 / 设备注册
  // -------------------------------------------------------------------------
  async function login(serverUrl, username, password) {
    config.serverUrl = normalizeBase(serverUrl) || defaults.serverUrl;
    const data = await api("POST", "/api/v1/auth/login", { username, password });
    config.token = data.token;
    config.userCode = data.userCode;
    config.displayName = data.displayName;
    saveConfig();

    // 注册设备（失败不阻断登录）
    try {
      await registerDevice();
    } catch (e) {
      log.warn("[notify] 设备注册失败:", e.message);
    }

    connectWs();
    return snapshot();
  }

  async function registerDevice() {
    const deviceName = os.hostname() || "Windows 设备";
    const data = await api("POST", "/api/v1/devices/register", {
      deviceId: config.deviceId || undefined,
      deviceName,
      platform: "WINDOWS",
      appVersion: app.getVersion(),
    });
    config.deviceId = data.deviceId;
    saveConfig();
  }

  function logout() {
    disconnectWs();
    config.token = "";
    config.userCode = "";
    config.displayName = "";
    // deviceId 保留，便于下次登录复用
    saveConfig();
    broadcastState();
  }

  // -------------------------------------------------------------------------
  // WebSocket 生命周期
  // -------------------------------------------------------------------------
  function wsUrl() {
    const base = normalizeBase(config.serverUrl)
      .replace(/^http:/, "ws:")
      .replace(/^https:/, "wss:");
    return base + "/ws/connect";
  }

  function connectWs() {
    if (!config.token || disposed) return;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    try {
      ws = new WebSocket(wsUrl(), {
        // 凭据通过握手请求头安全传递，不写入 URL / 日志
        headers: { "X-WS-Ticket": config.token },
      });
    } catch (e) {
      scheduleReconnect();
      return;
    }

    ws.on("open", () => {
      connected = true;
      reconnectAttempts = 0;
      startHeartbeat();
      broadcastState();
    });

    ws.on("message", (raw) => {
      let envelope;
      try {
        envelope = JSON.parse(raw.toString());
      } catch (e) {
        return;
      }
      handleServerEvent(envelope);
    });

    ws.on("close", () => {
      connected = false;
      stopHeartbeat();
      broadcastState();
      scheduleReconnect();
    });

    ws.on("error", () => {
      // 'close' 会随后触发并安排重连
      try {
        if (ws) ws.close();
      } catch (e) {}
    });
  }

  function disconnectWs() {
    connected = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    stopHeartbeat();
    if (ws) {
      try {
        ws.removeAllListeners();
        ws.close();
      } catch (e) {}
      ws = null;
    }
  }

  function scheduleReconnect() {
    if (disposed || !config.token) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    // 指数退避：1,2,4,8...封顶 30s
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
    reconnectAttempts += 1;
    reconnectTimer = setTimeout(() => connectWs(), delay);
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ event: "PING" }));
        } catch (e) {}
      }
    }, 30000);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // 服务端事件处理
  // -------------------------------------------------------------------------
  function priorityRank(p) {
    return { LOW: 0, NORMAL: 1, HIGH: 2, URGENT: 3 }[p] ?? 1;
  }

  function rememberSeen(messageId) {
    if (seenMessageIds.includes(messageId)) return true;
    seenMessageIds.push(messageId);
    if (seenMessageIds.length > SEEN_LIMIT) seenMessageIds.shift();
    return false;
  }

  function handleServerEvent(envelope) {
    const event = envelope.event;
    if (event === "PONG") return;

    if (event === "MESSAGE_NEW") {
      const data = envelope.data || {};
      if (rememberSeen(data.messageId)) return; // 去重

      enqueueBubble(data);
      notifyCenterChanged();

      // 回 CLIENT_ACK(RECEIVED) + RECEIVED 事件
      sendClientAck(data.messageId, "RECEIVED");
      postMessageEvent(data.messageId, "RECEIVED").catch(() => {});
    }
  }

  function sendClientAck(messageId, status) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(
          JSON.stringify({
            event: "CLIENT_ACK",
            eventId: "ack_" + messageId + "_" + status,
            data: { messageId, status },
          })
        );
      } catch (e) {}
    }
  }

  async function postMessageEvent(messageId, event) {
    return api("POST", "/api/v1/me/messages/" + encodeURIComponent(messageId) + "/events", {
      event,
      deviceId: config.deviceId,
      eventId: "evt_" + messageId + "_" + event,
      occurredAt: new Date().toISOString(),
    });
  }

  // -------------------------------------------------------------------------
  // 通知气泡队列与窗口
  // -------------------------------------------------------------------------
  function isExpired(message) {
    return message.expireAt && new Date(message.expireAt).getTime() < Date.now();
  }

  function enqueueBubble(message) {
    if (isExpired(message)) return;
    bubbleQueue.push(message);
    // 优先级高在前，同级时间早在前
    bubbleQueue.sort((a, b) => {
      const pr = priorityRank(b.priority) - priorityRank(a.priority);
      if (pr !== 0) return pr;
      return new Date(a.createdAt) - new Date(b.createdAt);
    });
    if (!currentBubble) showNextBubble();
  }

  function showNextBubble() {
    if (bubbleQueue.length === 0) {
      closeBubbleWindow();
      currentBubble = null;
      return;
    }
    currentBubble = bubbleQueue.shift();

    // 免打扰：不弹气泡，但消息已在服务端保存（退出免打扰后由消息中心/补拉体现）
    if (config.doNotDisturb) {
      currentBubble = null;
      return showNextBubble();
    }

    ensureBubbleWindow();
    if (bubbleWindow && bubbleWindow.webContents) {
      bubbleWindow.webContents.once("did-finish-load", () => {
        bubbleWindow.webContents.send("notify-bubble:show", currentBubble);
      });
      // 窗口可能已加载完成
      bubbleWindow.webContents.send("notify-bubble:show", currentBubble);
    }
    playAlertSound(currentBubble.priority);

    // 自动关闭后展示下一条
    setTimeout(() => {
      if (currentBubble && currentBubble.messageId === bubbleWindow?._messageId) {
        // no-op，具体关闭由气泡渲染器或下方计时处理
      }
      dismissCurrentBubble();
    }, (config.bubbleDurationSeconds || 8) * 1000);
  }

  function dismissCurrentBubble() {
    currentBubble = null;
    showNextBubble();
  }

  function defaultBubbleBounds() {
    const display = screen.getPrimaryDisplay();
    const wa = display.workArea;
    const width = 320;
    const height = 120;
    return {
      x: wa.x + wa.width - width - 24,
      y: wa.y + wa.height - height - 24,
      width,
      height,
    };
  }

  function ensureBubbleWindow() {
    if (bubbleWindow && !bubbleWindow.isDestroyed()) {
      bubbleWindow.setBounds(defaultBubbleBounds());
      return;
    }
    const isWin = process.platform === "win32";
    bubbleWindow = new BrowserWindow({
      ...defaultBubbleBounds(),
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      resizable: false,
      skipTaskbar: true,
      hasShadow: false,
      focusable: false,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "preload-notify-bubble.js"),
        nodeIntegration: false,
        contextIsolation: true,
      },
    });
    if (isWin) bubbleWindow.setAlwaysOnTop(true, "screen-saver");
    bubbleWindow.loadFile(path.join(__dirname, "notify-bubble.html"));
    bubbleWindow.once("ready-to-show", () => bubbleWindow.show());
    bubbleWindow.on("closed", () => {
      bubbleWindow = null;
    });
  }

  function closeBubbleWindow() {
    if (bubbleWindow && !bubbleWindow.isDestroyed()) {
      try {
        bubbleWindow.close();
      } catch (e) {}
    }
  }

  function playAlertSound(priority) {
    if (!config.soundEnabled) return;
    // 复用桌宠既有提示音通道（若上下文提供）
    if (typeof ctx.playSound === "function" && priorityRank(priority) >= priorityRank("HIGH")) {
      ctx.playSound("confirm");
    }
  }

  // -------------------------------------------------------------------------
  // 消息中心窗口
  // -------------------------------------------------------------------------
  function openMessageCenter() {
    if (centerWindow && !centerWindow.isDestroyed()) {
      centerWindow.show();
      centerWindow.focus();
      return;
    }
    centerWindow = new BrowserWindow({
      width: 880,
      height: 640,
      minWidth: 640,
      minHeight: 480,
      title: "消息中心",
      webPreferences: {
        preload: path.join(__dirname, "preload-notify.js"),
        nodeIntegration: false,
        contextIsolation: true,
      },
    });
    centerWindow.loadFile(path.join(__dirname, "message-center.html"));
    centerWindow.on("closed", () => {
      centerWindow = null;
    });
  }

  // -------------------------------------------------------------------------
  // 渲染层广播
  // -------------------------------------------------------------------------
  function snapshot() {
    return {
      connected,
      loggedIn: !!config.token,
      serverUrl: config.serverUrl,
      displayName: config.displayName,
      userCode: config.userCode,
      deviceId: config.deviceId,
      soundEnabled: config.soundEnabled,
      doNotDisturb: config.doNotDisturb,
    };
  }

  function broadcastState() {
    if (centerWindow && !centerWindow.isDestroyed()) {
      centerWindow.webContents.send("notify:state-changed", snapshot());
    }
  }

  function notifyCenterChanged() {
    if (centerWindow && !centerWindow.isDestroyed()) {
      centerWindow.webContents.send("notify:messages-changed");
    }
  }

  // -------------------------------------------------------------------------
  // IPC 注册
  // -------------------------------------------------------------------------
  const handlers = [];
  function handle(channel, listener) {
    const wrapped = async (...args) => listener(...args);
    ipcMain.handle(channel, wrapped);
    handlers.push(() => ipcMain.removeHandler(channel));
  }

  function registerIpc() {
    handle("notify:get-state", async () => snapshot());

    handle("notify:login", async (_e, payload) =>
      login(payload.serverUrl, payload.username, payload.password)
    );
    handle("notify:logout", async () => {
      logout();
      return snapshot();
    });

    handle("notify:list-messages", async (_e, params) => {
      const q = new URLSearchParams();
      if (params.status) q.set("status", params.status);
      if (params.topic) q.set("topic", params.topic);
      q.set("page", String(params.page || 1));
      q.set("size", String(params.size || 20));
      return api("GET", "/api/v1/me/messages?" + q.toString());
    });

    handle("notify:list-topics", async () => api("GET", "/api/v1/topics"));
    handle("notify:list-subscriptions", async () => api("GET", "/api/v1/me/subscriptions"));
    handle("notify:subscribe", async (_e, topicCode) =>
      api("PUT", "/api/v1/me/subscriptions/" + encodeURIComponent(topicCode))
    );
    handle("notify:unsubscribe", async (_e, topicCode) =>
      api("DELETE", "/api/v1/me/subscriptions/" + encodeURIComponent(topicCode))
    );

    handle("notify:post-event", async (_e, payload) => {
      await postMessageEvent(payload.messageId, payload.event);
      notifyCenterChanged();
    });

    handle("notify:set-settings", async (_e, settings) => {
      if (typeof settings.soundEnabled === "boolean") config.soundEnabled = settings.soundEnabled;
      if (typeof settings.doNotDisturb === "boolean") config.doNotDisturb = settings.doNotDisturb;
      saveConfig();
      broadcastState();
      return snapshot();
    });

    handle("notify:open-link", async (_e, url) => {
      if (typeof url === "string" && /^https?:\/\//i.test(url.trim())) {
        await shell.openExternal(url.trim());
      }
    });

    // 气泡交互
    ipcMain.on("notify-bubble:click", (_e, message) => {
      dismissCurrentBubble();
      openMessageCenter();
      if (message && message.action && message.action.url) {
        if (/^https?:\/\//i.test(message.action.url)) {
          shell.openExternal(message.action.url);
        }
      }
      postMessageEvent(message.messageId, "READ").catch(() => {});
    });
    ipcMain.on("notify-bubble:dismiss", () => dismissCurrentBubble());
  }

  // -------------------------------------------------------------------------
  // 启动 / 清理
  // -------------------------------------------------------------------------
  registerIpc();

  // 已有登录凭据时自动连接
  if (config.token) {
    if (!config.deviceId) {
      registerDevice()
        .then(() => connectWs())
        .catch(() => connectWs());
    } else {
      connectWs();
    }
  }

  function cleanup() {
    disposed = true;
    disconnectWs();
    handlers.forEach((fn) => {
      try {
        fn();
      } catch (e) {}
    });
    try {
      ipcMain.removeAllListeners("notify-bubble:click");
      ipcMain.removeAllListeners("notify-bubble:dismiss");
    } catch (e) {}
    closeBubbleWindow();
    if (centerWindow && !centerWindow.isDestroyed()) {
      try {
        centerWindow.close();
      } catch (e) {}
    }
  }

  return {
    openMessageCenter,
    applySettings: (s) => {
      config = Object.assign(config, s);
      saveConfig();
    },
    cleanup,
    isConnected: () => connected,
  };
};
