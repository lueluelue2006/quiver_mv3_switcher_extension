const statusEl = document.getElementById("status");
const historyListEl = document.getElementById("historyList");
const exportOutputEl = document.getElementById("exportOutput");
const importInputEl = document.getElementById("importInput");
const importEmailEl = document.getElementById("importEmail");
const refreshBtn = document.getElementById("refreshBtn");
const exportBtn = document.getElementById("exportBtn");
const copyExportBtn = document.getElementById("copyExportBtn");
const importBtn = document.getElementById("importBtn");
const versionTextEl = document.getElementById("versionText");
const checkUpdateBtn = document.getElementById("checkUpdateBtn");
const updateStatusEl = document.getElementById("updateStatus");
const openUpdateBtn = document.getElementById("openUpdateBtn");
const repoLinkEl = document.getElementById("repoLink");

const REPO_WEB_URL = "https://github.com/lueluelue2006/quiver_mv3_switcher_extension";
const REPO_RELEASES_URL = `${REPO_WEB_URL}/releases`;
const REMOTE_MANIFEST_URL = "https://raw.githubusercontent.com/lueluelue2006/quiver_mv3_switcher_extension/main/manifest.json";
const CURRENT_VERSION = chrome.runtime.getManifest().version || "0.0.0";
let latestVersionCached = null;

function setStatus(text, isError = false) {
  statusEl.textContent = text || "";
  statusEl.classList.toggle("error", Boolean(isError));
}

function setUpdateStatus(text, isError = false) {
  updateStatusEl.textContent = text || "";
  updateStatusEl.classList.toggle("error", Boolean(isError));
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

function formatSavedAt(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function buildUsageText(item) {
  const usage = item?.usage;
  if (!usage || typeof usage !== "object") {
    return "积分: -";
  }
  const raw = typeof usage.raw === "string" ? usage.raw.trim() : "";
  if (raw) {
    return `积分: ${raw}`;
  }
  const used = Number(usage.used);
  const total = Number(usage.total);
  if (Number.isFinite(used) && Number.isFinite(total)) {
    return `积分: ${used}/${total}`;
  }
  return "积分: -";
}

function sanitizeForFilename(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

function downloadJsonFile(payload, filename) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function parseSemver(input) {
  const parts = String(input || "")
    .trim()
    .replace(/^v/i, "")
    .split(".")
    .map((p) => Number.parseInt(p, 10));
  while (parts.length < 3) {
    parts.push(0);
  }
  return parts.slice(0, 3).map((n) => (Number.isFinite(n) ? n : 0));
}

function compareSemver(a, b) {
  const av = parseSemver(a);
  const bv = parseSemver(b);
  for (let i = 0; i < 3; i += 1) {
    if (av[i] > bv[i]) return 1;
    if (av[i] < bv[i]) return -1;
  }
  return 0;
}

async function fetchLatestVersion() {
  const res = await fetch(`${REMOTE_MANIFEST_URL}?t=${Date.now()}`, {
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`remote manifest ${res.status}`);
  }
  const data = await res.json();
  const version = String(data?.version || "").trim();
  if (!version) {
    throw new Error("remote version missing");
  }
  latestVersionCached = version;
  return version;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    return false;
  }
}

async function loadHistory() {
  const resp = await sendMessage({ type: "GET_COOKIE_HISTORY" });
  if (!resp?.ok) {
    throw new Error(resp?.error || "读取历史失败");
  }
  renderHistory(resp.items || []);
}

function renderHistory(items) {
  historyListEl.innerHTML = "";
  if (!Array.isArray(items) || items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "暂无历史记录";
    historyListEl.appendChild(empty);
    return;
  }

  for (const item of items.slice(0, 3)) {
    const wrapper = document.createElement("div");
    wrapper.className = "history-item";

    const meta = document.createElement("div");
    meta.className = "history-meta";
    const email = item.email || "(未标记)";
    meta.textContent = `${email} | ${formatSavedAt(item.savedAt)}`;

    const usageMeta = document.createElement("div");
    usageMeta.className = "history-usage";
    usageMeta.textContent = buildUsageText(item);

    const actions = document.createElement("div");
    actions.className = "history-actions";

    const applyBtn = document.createElement("button");
    applyBtn.textContent = "应用";
    applyBtn.addEventListener("click", async () => {
      setStatus("正在应用 Cookie...");
      try {
        const resp = await sendMessage({
          type: "APPLY_HISTORY_COOKIE",
          id: item.id,
          reloadTabs: true,
        });
        if (!resp?.ok) {
          throw new Error(resp?.error || "应用失败");
        }
        setStatus("应用成功，已刷新页面会话");
        await loadHistory();
      } catch (err) {
        setStatus(`应用失败: ${String(err?.message || err)}`, true);
      }
    });

    const copyBtn = document.createElement("button");
    copyBtn.textContent = "复制 JSON";
    copyBtn.addEventListener("click", async () => {
      const ok = await copyText(JSON.stringify(item.cookie, null, 2));
      if (ok) {
        setStatus("已复制 Cookie JSON");
      } else {
        setStatus("复制失败，请手动复制", true);
      }
    });

    const downloadBtn = document.createElement("button");
    downloadBtn.textContent = "下载 JSON";
    downloadBtn.addEventListener("click", () => {
      const emailPart = sanitizeForFilename(item.email || "cookie");
      const tsPart = sanitizeForFilename((item.savedAt || "").replace(/[:]/g, "-")) || Date.now();
      const name = `quiver_cookie_${emailPart}_${tsPart}.json`;
      downloadJsonFile(item.cookie, name);
      setStatus("已下载 JSON");
    });

    actions.appendChild(applyBtn);
    actions.appendChild(copyBtn);
    actions.appendChild(downloadBtn);
    wrapper.appendChild(meta);
    wrapper.appendChild(usageMeta);
    wrapper.appendChild(actions);
    historyListEl.appendChild(wrapper);
  }
}

refreshBtn.addEventListener("click", async () => {
  setStatus("刷新中...");
  try {
    await loadHistory();
    setStatus("已刷新");
  } catch (err) {
    setStatus(`刷新失败: ${String(err?.message || err)}`, true);
  }
});

exportBtn.addEventListener("click", async () => {
  setStatus("导出中...");
  try {
    const resp = await sendMessage({ type: "EXPORT_CURRENT_COOKIE" });
    if (!resp?.ok) {
      throw new Error(resp?.error || "导出失败");
    }
    const payload = JSON.stringify(resp.item?.cookie || null, null, 2);
    exportOutputEl.value = payload;
    setStatus("导出成功并加入历史");
    await loadHistory();
  } catch (err) {
    setStatus(`导出失败: ${String(err?.message || err)}`, true);
  }
});

copyExportBtn.addEventListener("click", async () => {
  const text = exportOutputEl.value.trim();
  if (!text) {
    setStatus("没有可复制的导出内容", true);
    return;
  }
  const ok = await copyText(text);
  if (ok) {
    setStatus("导出内容已复制");
  } else {
    setStatus("复制失败，请手动复制", true);
  }
});

importBtn.addEventListener("click", async () => {
  const payload = importInputEl.value.trim();
  if (!payload) {
    setStatus("请先输入 Cookie", true);
    return;
  }
  setStatus("导入中...");
  try {
    const resp = await sendMessage({
      type: "IMPORT_COOKIE",
      payload,
      email: importEmailEl.value.trim() || null,
      reloadTabs: true,
    });
    if (!resp?.ok) {
      throw new Error(resp?.error || "导入失败");
    }
    importInputEl.value = "";
    setStatus("导入成功并已应用");
    await loadHistory();
  } catch (err) {
    setStatus(`导入失败: ${String(err?.message || err)}`, true);
  }
});

checkUpdateBtn.addEventListener("click", async () => {
  setUpdateStatus("检查中...");
  openUpdateBtn.style.display = "none";
  try {
    const latest = await fetchLatestVersion();
    if (compareSemver(latest, CURRENT_VERSION) > 0) {
      setUpdateStatus(`发现新版本: ${latest}（当前 ${CURRENT_VERSION}）`);
      openUpdateBtn.style.display = "";
    } else {
      setUpdateStatus(`已是最新版本: ${CURRENT_VERSION}`);
    }
  } catch (err) {
    setUpdateStatus(`检查失败: ${String(err?.message || err)}`, true);
  }
});

openUpdateBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: REPO_RELEASES_URL });
});

repoLinkEl.addEventListener("click", (event) => {
  event.preventDefault();
  chrome.tabs.create({ url: REPO_WEB_URL });
});

(async () => {
  versionTextEl.textContent = `版本: ${CURRENT_VERSION}`;
  setUpdateStatus(`当前版本: ${CURRENT_VERSION}`);
  setStatus("加载中...");
  try {
    await loadHistory();
    setStatus("就绪");
  } catch (err) {
    setStatus(`初始化失败: ${String(err?.message || err)}`, true);
  }
})();
