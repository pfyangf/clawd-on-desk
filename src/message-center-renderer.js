"use strict";

/**
 * 消息中心渲染逻辑。
 * 通过 window.notifyAPI（preload 注入）与主进程交互。
 */
(function () {
  const $ = (id) => document.getElementById(id);

  const els = {
    login: $("login"),
    app: $("app"),
    loginBtn: $("loginBtn"),
    loginError: $("loginError"),
    logoutBtn: $("logoutBtn"),
    connDot: $("connDot"),
    connLabel: $("connLabel"),
    userChip: $("userChip"),
    messageList: $("messageList"),
    filterStatus: $("filterStatus"),
    filterTopic: $("filterTopic"),
    refreshBtn: $("refreshBtn"),
    subscriptionList: $("subscriptionList"),
    setSound: $("setSound"),
    setDnd: $("setDnd"),
    modalMask: $("modalMask"),
    modalTitle: $("modalTitle"),
    modalBody: $("modalBody"),
    modalClose: $("modalClose"),
  };

  const PAGE_SIZE = 20;
  let currentPage = 1;
  let messages = [];
  let loading = false;
  let hasMore = true;

  // -------------------------------------------------------------------------
  // 视图切换
  // -------------------------------------------------------------------------
  function showLogin() {
    els.app.style.display = "none";
    els.login.style.display = "flex";
  }

  function showApp() {
    els.login.style.display = "none";
    els.app.style.display = "flex";
  }

  function renderState(state) {
    if (state.loggedIn) {
      showApp();
      els.userChip.textContent = state.displayName || state.userCode || "";
      els.connDot.className = "conn-dot " + (state.connected ? "on" : "off");
      els.connLabel.textContent = state.connected ? "已连接" : "连接中断，重连中";
      els.setSound.checked = !!state.soundEnabled;
      els.setDnd.checked = !!state.doNotDisturb;
    } else {
      showLogin();
    }
  }

  // -------------------------------------------------------------------------
  // 登录
  // -------------------------------------------------------------------------
  async function doLogin() {
    const serverUrl = $("serverUrl").value.trim();
    const username = $("username").value.trim();
    const password = $("password").value;
    els.loginError.textContent = "";

    if (!serverUrl || !username || !password) {
      els.loginError.textContent = "请填写服务端地址、用户名和密码";
      return;
    }
    els.loginBtn.disabled = true;
    els.loginBtn.textContent = "登录中...";
    try {
      const state = await window.notifyAPI.login({ serverUrl, username, password });
      renderState(state);
      await reloadMessages();
      await loadSubscriptions();
    } catch (e) {
      els.loginError.textContent = e.message || "登录失败";
    } finally {
      els.loginBtn.disabled = false;
      els.loginBtn.textContent = "登 录";
    }
  }

  async function doLogout() {
    const state = await window.notifyAPI.logout();
    renderState(state);
  }

  // -------------------------------------------------------------------------
  // Tab 切换
  // -------------------------------------------------------------------------
  function switchTab(tab) {
    document.querySelectorAll("nav.tabs button").forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === tab);
    });
    document.querySelectorAll(".section").forEach((s) => {
      s.classList.toggle("active", s.id === "sec-" + tab);
    });
    if (tab === "subscriptions") loadSubscriptions();
  }

  // -------------------------------------------------------------------------
  // 消息列表
  // -------------------------------------------------------------------------
  const STATUS_LABEL = {
    PENDING: "待投递",
    SENT: "已发送",
    RECEIVED: "已接收",
    READ: "已读",
    ACKNOWLEDGED: "已确认",
    FAILED: "投递失败",
    EXPIRED: "已过期",
  };

  function isUnread(status) {
    return status === "PENDING" || status === "SENT" || status === "RECEIVED";
  }

  function formatTime(value) {
    if (!value) return "";
    const d = new Date(value);
    if (isNaN(d.getTime())) return value;
    const p = (n) => String(n).padStart(2, "0");
    return (
      d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      " " + p(d.getHours()) + ":" + p(d.getMinutes())
    );
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderMessages() {
    if (messages.length === 0) {
      els.messageList.innerHTML = '<div class="empty">暂无消息</div>';
      return;
    }
    els.messageList.innerHTML = messages.map((m) => {
      const unread = isUnread(m.status);
      const actionBtn =
        m.actionJson && JSON.parseSafe(m.actionJson) && JSON.parseSafe(m.actionJson).url
          ? '<button class="link-btn act-open" data-id="' + escapeHtml(m.messageId) + '">' +
            escapeHtml(JSON.parse(m.actionJson).label || "打开链接") + "</button>"
          : "";
      const ackBtn = unread
        ? '<button class="link-btn act-ack" data-id="' + escapeHtml(m.messageId) + '">确认处理</button>'
        : "";
      return (
        '<div class="msg">' +
          '<div class="mhead">' +
            '<span class="topic">' + escapeHtml(m.topicCode) + '</span>' +
            '<span class="tag prio ' + escapeHtml(m.priority) + '">' + escapeHtml(m.priority) + '</span>' +
            '<span class="tag status">' + escapeHtml(STATUS_LABEL[m.status] || m.status) + '</span>' +
            (unread ? ' <span style="color:#3370ff;font-size:11px">●</span>' : "") +
          "</div>" +
          '<div class="mtitle">' + escapeHtml(m.title) + "</div>" +
          '<div class="mcontent">' + escapeHtml(m.content) + "</div>" +
          '<div class="mactions">' +
            actionBtn + ackBtn +
            '<button class="link-btn act-detail" data-id="' + escapeHtml(m.messageId) + '">详情</button>' +
            '<span class="mtime">' + formatTime(m.createdAt) + "</span>" +
          "</div>" +
        "</div>"
      );
    }).join("");

    if (hasMore) {
      els.messageList.insertAdjacentHTML(
        "beforeend",
        '<div class="empty" id="loadMoreHint" style="cursor:pointer">加载更多</div>'
      );
      const hint = $("loadMoreHint");
      if (hint) hint.addEventListener("click", loadMore);
    }
  }

  async function reloadMessages() {
    currentPage = 1;
    messages = [];
    hasMore = true;
    await loadMore();
  }

  async function loadMore() {
    if (loading || !hasMore) return;
    loading = true;
    try {
      const params = {
        status: els.filterStatus.value,
        topic: els.filterTopic.value.trim(),
        page: currentPage,
        size: PAGE_SIZE,
      };
      const list = await window.notifyAPI.listMessages(params);
      const arr = Array.isArray(list) ? list : [];

      // 进入列表即标记 READ（仅对未读消息）
      for (const m of arr) {
        if (isUnread(m.status)) {
          window.notifyAPI.postEvent({ messageId: m.messageId, event: "READ" }).catch(() => {});
          m.status = "READ";
        }
      }

      messages = messages.concat(arr);
      hasMore = arr.length === PAGE_SIZE;
      currentPage += 1;
      renderMessages();
    } catch (e) {
      els.messageList.innerHTML = '<div class="empty">加载失败：' + escapeHtml(e.message) + "</div>";
    } finally {
      loading = false;
    }
  }

  async function onMessageAction(e) {
    const btn = e.target.closest("button.link-btn");
    if (!btn) return;
    const id = btn.dataset.id;
    const msg = messages.find((x) => x.messageId === id);
    if (!msg) return;

    if (btn.classList.contains("act-open")) {
      const action = JSON.parseSafe(msg.actionJson);
      if (action && action.url) window.notifyAPI.openLink(action.url);
    } else if (btn.classList.contains("act-ack")) {
      await window.notifyAPI.postEvent({ messageId: id, event: "ACKNOWLEDGED" });
      msg.status = "ACKNOWLEDGED";
      renderMessages();
    } else if (btn.classList.contains("act-detail")) {
      openDetail(msg);
    }
  }

  function openDetail(m) {
    els.modalTitle.textContent = m.title;
    const detail = {
      messageId: m.messageId,
      topic: m.topicCode,
      priority: m.priority,
      status: m.status,
      content: m.content,
      data: m.dataJson ? JSON.parseSafe(m.dataJson) : undefined,
      action: m.actionJson ? JSON.parseSafe(m.actionJson) : undefined,
      createdAt: m.createdAt,
    };
    els.modalBody.textContent = JSON.stringify(detail, null, 2);
    els.modalMask.classList.add("show");
  }

  // -------------------------------------------------------------------------
  // 订阅
  // -------------------------------------------------------------------------
  async function loadSubscriptions() {
    try {
      const [topics, subs] = await Promise.all([
        window.notifyAPI.listTopics(),
        window.notifyAPI.listSubscriptions().catch(() => []),
      ]);
      const subscribedCodes = new Set(
        (subs || []).filter((s) => s.subscribed).map((s) => s.topicCode)
      );

      els.subscriptionList.innerHTML = (topics || []).map((t) => {
        const checked = subscribedCodes.has(t.topicCode);
        return (
          '<div class="row-card">' +
            '<div class="info"><div class="t">' + escapeHtml(t.topicName) + "</div>" +
            '<div class="d">' + escapeHtml(t.topicCode) +
            (t.description ? " · " + escapeHtml(t.description) : "") + "</div></div>" +
            '<label class="switch"><input type="checkbox" data-code="' + escapeHtml(t.topicCode) +
            '" ' + (checked ? "checked" : "") + ' /><span class="slider"></span></label>' +
          "</div>"
        );
      }).join("");

      if (!topics || topics.length === 0) {
        els.subscriptionList.innerHTML = '<div class="empty">暂无可订阅主题</div>';
      }

      els.subscriptionList.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
        cb.addEventListener("change", () => onToggleSubscription(cb));
      });
    } catch (e) {
      els.subscriptionList.innerHTML = '<div class="empty">订阅加载失败：' + escapeHtml(e.message) + "</div>";
    }
  }

  async function onToggleSubscription(cb) {
    const code = cb.dataset.code;
    try {
      if (cb.checked) {
        await window.notifyAPI.subscribe(code);
      } else {
        await window.notifyAPI.unsubscribe(code);
      }
    } catch (e) {
      cb.checked = !cb.checked;
      alert("订阅变更失败：" + e.message);
    }
  }

  // -------------------------------------------------------------------------
  // 设置
  // -------------------------------------------------------------------------
  async function onSettingsChange() {
    await window.notifyAPI.setSettings({
      soundEnabled: els.setSound.checked,
      doNotDisturb: els.setDnd.checked,
    });
  }

  // -------------------------------------------------------------------------
  // 事件绑定 & 启动
  // -------------------------------------------------------------------------
  function bind() {
    els.loginBtn.addEventListener("click", doLogin);
    [["serverUrl"], ["username"], ["password"]].forEach(() => {});
    document.getElementById("password").addEventListener("keydown", (e) => {
      if (e.key === "Enter") doLogin();
    });
    document.getElementById("username").addEventListener("keydown", (e) => {
      if (e.key === "Enter") doLogin();
    });

    els.logoutBtn.addEventListener("click", doLogout);
    document.querySelectorAll("nav.tabs button").forEach((b) => {
      b.addEventListener("click", () => switchTab(b.dataset.tab));
    });
    els.refreshBtn.addEventListener("click", reloadMessages);
    els.filterStatus.addEventListener("change", reloadMessages);
    els.filterTopic.addEventListener("keydown", (e) => {
      if (e.key === "Enter") reloadMessages();
    });
    els.messageList.addEventListener("click", onMessageAction);

    els.setSound.addEventListener("change", onSettingsChange);
    els.setDnd.addEventListener("change", onSettingsChange);

    els.modalClose.addEventListener("click", () => els.modalMask.classList.remove("show"));
    els.modalMask.addEventListener("click", (e) => {
      if (e.target === els.modalMask) els.modalMask.classList.remove("show");
    });

    window.notifyAPI.onStateChanged(renderState);
    window.notifyAPI.onMessagesChanged(() => {
      if (document.getElementById("sec-messages").classList.contains("active")) {
        reloadMessages();
      }
    });
  }

  // 安全 JSON 解析辅助
  JSON.parseSafe = function (s) {
    try {
      return s ? JSON.parse(s) : null;
    } catch (e) {
      return null;
    }
  };

  async function init() {
    bind();
    const state = await window.notifyAPI.getState();
    renderState(state);
    if (state.loggedIn) {
      await reloadMessages();
      await loadSubscriptions();
    }
  }

  if (window.notifyAPI) {
    init();
  } else {
    document.body.innerHTML = "<p style='padding:20px'>无法加载通知模块 API</p>";
  }
})();
