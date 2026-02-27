(() => {
  const STATE_POLL_MS = 4000;
  const DRAG_THRESHOLD_PX = 4;
  const POSITION_STORAGE_KEY = "__qsw_floating_pos_v1";
  const STYLE = `
    .qsw-floating {
      position: fixed;
      top: 12px;
      right: 12px;
      z-index: 2147483647;
      font-family: "Inter", "Segoe UI", system-ui, -apple-system, sans-serif;
      background: rgba(15, 23, 42, 0.92);
      color: #f8fafc;
      border: 1px solid rgba(148, 163, 184, 0.32);
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px;
      border-radius: 999px;
      box-shadow: 0 10px 24px rgba(0, 0, 0, 0.30);
      user-select: none;
      touch-action: none;
      cursor: default;
    }
    .qsw-btn {
      border: none;
      background: linear-gradient(90deg, #2563eb, #0ea5e9);
      color: #fff;
      font-size: 11px;
      padding: 7px 10px;
      border-radius: 999px;
      cursor: pointer;
      white-space: nowrap;
    }
    .qsw-btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .qsw-queued {
      color: #cbd5e1;
      font-size: 10px;
      white-space: nowrap;
      min-width: 44px;
      padding: 6px 8px;
      border-radius: 999px;
      border: 1px solid rgba(148, 163, 184, 0.24);
      background: rgba(2, 6, 23, 0.5);
      cursor: grab;
    }
    .qsw-floating[data-dragging="1"] .qsw-queued {
      cursor: grabbing;
    }
  `;

  const root = document.createElement("div");
  root.className = "qsw-floating";
  root.innerHTML = `
    <button id="qsw-switch" class="qsw-btn">切换账号</button>
    <div id="qsw-queued" class="qsw-queued">待切: -</div>
  `;

  const style = document.createElement("style");
  style.textContent = STYLE;
  document.documentElement.appendChild(style);
  document.body.appendChild(root);

  const switchBtn = root.querySelector("#qsw-switch");
  const queuedEl = root.querySelector("#qsw-queued");
  let isBusy = false;
  let pollTimer = null;
  let suppressClickUntil = 0;
  const dragState = {
    active: false,
    moved: false,
    pointerId: null,
    startX: 0,
    startY: 0,
    originLeft: 0,
    originTop: 0,
    width: 0,
    height: 0,
  };

  function setStatus(msg) {
    root.dataset.status = String(msg || "");
    switchBtn.title = String(msg || "");
  }

  function setCurrentEmail(_) {}

  function clamp(value, min, max) {
    if (value < min) return min;
    if (value > max) return max;
    return value;
  }

  function applyFloatingPosition(left, top) {
    root.style.left = `${left}px`;
    root.style.top = `${top}px`;
    root.style.right = "auto";
    root.style.bottom = "auto";
  }

  function loadFloatingPosition() {
    try {
      const raw = localStorage.getItem(POSITION_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      const left = Number(parsed?.left);
      const top = Number(parsed?.top);
      if (!Number.isFinite(left) || !Number.isFinite(top)) return;
      const rect = root.getBoundingClientRect();
      const maxLeft = Math.max(0, window.innerWidth - rect.width);
      const maxTop = Math.max(0, window.innerHeight - rect.height);
      applyFloatingPosition(clamp(left, 0, maxLeft), clamp(top, 0, maxTop));
    } catch (_) {}
  }

  function saveFloatingPosition(left, top) {
    try {
      localStorage.setItem(POSITION_STORAGE_KEY, JSON.stringify({ left, top }));
    } catch (_) {}
  }

  function onDragStart(event) {
    if (event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof Node) || !queuedEl.contains(target)) return;
    const rect = root.getBoundingClientRect();
    dragState.active = true;
    dragState.moved = false;
    dragState.pointerId = event.pointerId;
    dragState.startX = event.clientX;
    dragState.startY = event.clientY;
    dragState.originLeft = rect.left;
    dragState.originTop = rect.top;
    dragState.width = rect.width;
    dragState.height = rect.height;
    root.dataset.dragging = "1";
    root.setPointerCapture(event.pointerId);
  }

  function onDragMove(event) {
    if (!dragState.active || dragState.pointerId !== event.pointerId) return;
    const dx = event.clientX - dragState.startX;
    const dy = event.clientY - dragState.startY;
    if (!dragState.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) {
      return;
    }
    dragState.moved = true;
    event.preventDefault();
    const maxLeft = Math.max(0, window.innerWidth - dragState.width);
    const maxTop = Math.max(0, window.innerHeight - dragState.height);
    const left = clamp(dragState.originLeft + dx, 0, maxLeft);
    const top = clamp(dragState.originTop + dy, 0, maxTop);
    applyFloatingPosition(left, top);
  }

  function onDragEnd(event) {
    if (!dragState.active || dragState.pointerId !== event.pointerId) return;
    if (root.hasPointerCapture(event.pointerId)) {
      root.releasePointerCapture(event.pointerId);
    }
    if (dragState.moved) {
      const rect = root.getBoundingClientRect();
      saveFloatingPosition(rect.left, rect.top);
      suppressClickUntil = Date.now() + 250;
    }
    dragState.active = false;
    dragState.moved = false;
    dragState.pointerId = null;
    root.dataset.dragging = "0";
  }

  function isContextInvalidatedError(err) {
    return /Extension context invalidated/i.test(String(err?.message || err || ""));
  }

  function scheduleHardRefresh(reason) {
    setStatus(reason || "扩展已更新，正在刷新页面...");
    switchBtn.disabled = true;
    switchBtn.textContent = "页面刷新中...";
    setTimeout(() => {
      window.location.reload();
    }, 250);
  }

  function applyStateToUi(state) {
    const filling = Boolean(state && state.filling);
    const queued = Number(state?.queued || 0);
    if (isBusy) return;
    switchBtn.disabled = false;
    switchBtn.textContent = filling && queued === 0 ? "切换账号" : "切换账号";
  }

  function fetchWithTimeout(resource, options = {}, timeoutMs = 6000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(resource, { ...options, signal: controller.signal })
      .finally(() => clearTimeout(timer));
  }

  async function refreshState() {
    try {
      const state = await sendMessageWithTimeout({ type: "GET_STATE" }, 10000);
      if (!state) return;
      const filling = Boolean(state.filling);
      const queued = Number(state.queued || 0);
      let liveEmail = null;
      try {
        const live = await checkSession();
        if (live && live.ok && live.email) {
          liveEmail = live.email;
        }
      } catch (_) {}
      queuedEl.textContent = `待切: ${state.queued}`;
      applyStateToUi(state);
      if (state.lastError) {
        root.dataset.lastErrorState = String(state.lastError);
        setStatus(`上次失败: ${state.lastError}`);
      } else if (filling && queued === 0) {
        setStatus("后台预取中");
      } else if (state.preparedCookieSupported === false) {
        setStatus("验证码兜底模式");
      } else {
        setStatus("就绪，可切");
      }
    } catch (err) {
      if (isContextInvalidatedError(err)) {
        scheduleHardRefresh("扩展已更新，自动刷新恢复中...");
        return;
      }
      setStatus(`状态同步失败: ${String(err.message || err).slice(0, 72)}`);
    }
  }

  function sendMessageWithTimeout(message, timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        reject(new Error("background timeout"));
      }, timeoutMs);

      chrome.runtime.sendMessage(message, (resp) => {
        if (done) return;
        done = true;
        clearTimeout(timer);

        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message || "runtime error"));
          return;
        }
        if (resp === undefined) {
          reject(new Error("empty response"));
          return;
        }
        resolve(resp);
      });
    });
  }

  async function applyByMagic(account) {
    const body = JSON.stringify({
      email: account.email,
      code: account.magicCode,
    });
    const verifyResp = await fetchWithTimeout("/api/auth/magic/verify", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (!verifyResp.ok) {
      const txt = await verifyResp.text();
      throw new Error(`verify failed ${verifyResp.status}: ${txt.slice(0, 180)}`);
    }

    const sessionResp = await fetchWithTimeout("/api/_auth/session", { credentials: "include" });
    if (!sessionResp.ok) {
      throw new Error(`session check failed ${sessionResp.status}`);
    }
    const session = await sessionResp.json();
    const email = session?.user?.email || account.email;
    return { ok: true, email };
  }

  async function checkSession() {
    const sessionResp = await fetchWithTimeout("/api/_auth/session", { credentials: "include" });
    if (!sessionResp.ok) {
      return { ok: false };
    }
    const session = await sessionResp.json();
    return { ok: true, email: session?.user?.email || null };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "APPLY_ACCOUNT") {
      (async () => {
        try {
          const result = await applyByMagic(message.account);
          sendResponse(result);
        } catch (err) {
          sendResponse({ ok: false, error: String(err?.message || err) });
        }
      })();
      return true;
    }
    if (message.type === "CHECK_SESSION") {
      (async () => {
        sendResponse(await checkSession());
      })();
      return true;
    }
    return;
  });

  root.addEventListener("pointerdown", onDragStart);
  root.addEventListener("pointermove", onDragMove);
  root.addEventListener("pointerup", onDragEnd);
  root.addEventListener("pointercancel", onDragEnd);

  switchBtn.addEventListener("click", async () => {
    if (Date.now() < suppressClickUntil) return;
    if (switchBtn.disabled || isBusy) return;
    isBusy = true;
    switchBtn.disabled = true;
    switchBtn.textContent = "切换中...";
    setStatus("请求切换...");
    try {
      const res = await sendMessageWithTimeout({ type: "REQUEST_SWITCH" }, 130000);
      if (!res || !res.ok) {
        throw new Error(res?.error || "switch failed");
      }
      try {
        localStorage.setItem(
          "__qsw_last_switch_result",
          JSON.stringify({ ts: Date.now(), ok: true, response: res }),
        );
      } catch (_) {}
      const switchedEmail = res?.session?.sessionEmail || res?.account?.email || null;
      setCurrentEmail(switchedEmail);
      setStatus(`已切到: ${switchedEmail || "-"}`);
    } catch (err) {
      try {
        localStorage.setItem(
          "__qsw_last_switch_result",
          JSON.stringify({ ts: Date.now(), ok: false, error: String(err?.message || err) }),
        );
      } catch (_) {}
      if (isContextInvalidatedError(err)) {
        scheduleHardRefresh("扩展已更新，自动刷新后可继续切换");
        return;
      }
      root.dataset.lastErrorFull = String(err.message || err);
      setStatus(`失败: ${String(err.message || err)}`);
    } finally {
      isBusy = false;
      switchBtn.disabled = false;
      switchBtn.textContent = "切换账号";
      try {
        await refreshState();
      } catch (_) {}
    }
  });

  loadFloatingPosition();
  refreshState();
  pollTimer = setInterval(() => {
    if (isBusy) return;
    refreshState().catch(() => {});
  }, STATE_POLL_MS);
})();
