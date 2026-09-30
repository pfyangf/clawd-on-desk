"use strict";

/**
 * 通知气泡渲染逻辑。
 * 通过 window.bubbleAPI（preload 注入）与主进程交互。
 */
(function () {
  const card = document.getElementById("card");
  const topicEl = document.getElementById("topic");
  const prioEl = document.getElementById("prio");
  const titleEl = document.getElementById("title");
  const contentEl = document.getElementById("content");
  const hintEl = document.getElementById("hint");

  const ACCENT = {
    LOW: "#909399",
    NORMAL: "#409eff",
    HIGH: "#e6a23c",
    URGENT: "#f56c6c",
  };

  function render(message) {
    if (!message) return;
    topicEl.textContent = message.topic || "";
    prioEl.textContent = message.priority || "NORMAL";
    titleEl.textContent = message.title || "";
    contentEl.textContent = message.content || "";
    const accent = ACCENT[message.priority] || ACCENT.NORMAL;
    card.style.setProperty("--accent", accent);
    prioEl.style.background = accent + "2e";
    prioEl.style.color = accent;
    hintEl.textContent = message.action && message.action.label ? message.action.label : "点击查看详情";
  }

  let current = null;

  if (window.bubbleAPI) {
    window.bubbleAPI.onShow((message) => {
      current = message;
      render(message);
    });

    card.addEventListener("click", () => {
      if (current) window.bubbleAPI.click(current);
    });
  }
})();
