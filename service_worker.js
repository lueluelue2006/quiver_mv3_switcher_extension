const STATE_KEY = "quiver_switcher_state_v1";
const QUIVER_ORIGIN = "https://app.quiver.ai";
const SESSION_COOKIE = "nuxt-session";
const MAGIC_URL = `${QUIVER_ORIGIN}/api/auth/magic`;
const MAGIC_VERIFY_URL = `${QUIVER_ORIGIN}/api/auth/magic/verify`;
const SESSION_URL = `${QUIVER_ORIGIN}/api/_auth/session`;
const MAIL_BASE = "https://api.mail.tm";
const QUEUE_TARGET = 1;
const MAIL_POLL_INTERVAL_MS = 3000;
const MAIL_TIMEOUT_MS = 120000;
const QUEUE_PREFILL_TIMEOUT_MS = 120000;
const TAB_READY_TIMEOUT_MS = 18000;
const REQUEST_TIMEOUT_MS = 12000;
const SWITCH_GUARD_TIMEOUT_MS = 150000;
const COOKIE_HISTORY_LIMIT = 3;

let state = {
  queue: [],
  switching: false,
  switchStartedAt: null,
  filling: false,
  currentEmail: null,
  lastSwitchResult: null,
  cookieHistory: [],
  preparedCookieSupported: true,
  lastError: null,
};

function randomText(length = 12, alphabet = "abcdefghijklmnopqrstuvwxyz0123456789") {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

function randomPassword() {
  const lower = "abcdefghijklmnopqrstuvwxyz";
  const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const digits = "0123456789";
  const symbols = "!@#$%&*?+-=";
  const alphabet = lower + upper + digits + symbols;
  while (true) {
    let s = "";
    for (let i = 0; i < 18; i += 1) {
      s += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    const hasLower = [...s].some((c) => lower.includes(c));
    const hasUpper = [...s].some((c) => upper.includes(c));
    const hasDigit = [...s].some((c) => digits.includes(c));
    if (hasLower && hasUpper && hasDigit) {
      return s;
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sessionCookieLike(cookie) {
  if (!cookie) return null;
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path || "/",
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    expirationDate: cookie.expirationDate,
  };
}

function hasSessionCookie(obj) {
  return Boolean(obj && typeof obj === "object" && obj[SESSION_COOKIE]);
}

function normalizeSameSite(value) {
  if (!value) return "lax";
  const v = String(value).toLowerCase();
  if (v === "lax" || v === "strict" || v === "no_restriction" || v === "unspecified") {
    return v;
  }
  if (v === "none" || v === "no-restriction") {
    return "no_restriction";
  }
  return "lax";
}

function sanitizeCookieRecord(record) {
  if (!record || typeof record !== "object") return null;
  const value = String(record.value || "").trim();
  if (!value) {
    return null;
  }
  return {
    name: record.name || SESSION_COOKIE,
    value,
    domain: record.domain || ".app.quiver.ai",
    path: record.path || "/",
    secure: typeof record.secure === "boolean" ? record.secure : true,
    httpOnly: typeof record.httpOnly === "boolean" ? record.httpOnly : true,
    sameSite: normalizeSameSite(record.sameSite),
    expirationDate: Number.isFinite(record.expirationDate) ? record.expirationDate : undefined,
  };
}

function normalizeUsageSnapshot(usage) {
  if (!usage || typeof usage !== "object") return null;
  const used = Number(usage.used);
  const total = Number(usage.total);
  let raw = typeof usage.raw === "string" ? usage.raw.trim() : "";
  if (!raw && Number.isFinite(used) && Number.isFinite(total)) {
    raw = `${used}/${total}`;
  }
  if (!raw) {
    return null;
  }
  return {
    used: Number.isFinite(used) ? used : null,
    total: Number.isFinite(total) ? total : null,
    raw,
    label: usage.label ? String(usage.label) : null,
    capturedAt: usage.capturedAt || new Date().toISOString(),
  };
}

function makeCookieHistoryEntry(cookieRecord, email = null, usageSnapshot = null) {
  const normalizedCookie = sanitizeCookieRecord(cookieRecord);
  if (!normalizedCookie) {
    return null;
  }
  const usage = normalizeUsageSnapshot(usageSnapshot);
  return {
    id: `${Date.now()}-${randomText(5)}`,
    savedAt: new Date().toISOString(),
    email: email || null,
    cookie: sessionCookieLike(normalizedCookie),
    usage,
  };
}

function pushCookieHistory(entry) {
  if (!entry || !entry.cookie || !entry.cookie.value) return;
  const list = Array.isArray(state.cookieHistory) ? state.cookieHistory : [];
  const filtered = list.filter((item) => item?.cookie?.value !== entry.cookie.value && item?.id !== entry.id);
  state.cookieHistory = [entry, ...filtered].slice(0, COOKIE_HISTORY_LIMIT);
}

function normalizeHistoryEntry(item) {
  if (!item || typeof item !== "object") return null;
  const cookieSource = item.cookie && typeof item.cookie === "object" ? item.cookie : item;
  const cookie = sanitizeCookieRecord(cookieSource);
  if (!cookie) return null;
  return {
    id: item.id ? String(item.id) : `${Date.now()}-${randomText(5)}`,
    savedAt: item.savedAt || new Date().toISOString(),
    email: item.email ? String(item.email) : null,
    cookie: sessionCookieLike(cookie),
    usage: normalizeUsageSnapshot(item.usage),
  };
}

function getCookieHistorySnapshot() {
  const list = Array.isArray(state.cookieHistory) ? state.cookieHistory : [];
  return list
    .map((item) => normalizeHistoryEntry(item))
    .filter(Boolean)
    .slice(0, COOKIE_HISTORY_LIMIT);
}

function findCookieHistoryEntryById(id) {
  if (!id) return null;
  const list = Array.isArray(state.cookieHistory) ? state.cookieHistory : [];
  return list.find((item) => item?.id === id) || null;
}

function normalizeCookieImportPayload(payload) {
  let parsed = payload;
  if (typeof parsed === "string") {
    const text = parsed.trim();
    if (!text) {
      throw new Error("empty cookie payload");
    }
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      parsed = text;
    }
  }

  if (Array.isArray(parsed)) {
    parsed = parsed.find((item) => item && item.name === SESSION_COOKIE) || parsed[0];
  }
  if (parsed && typeof parsed === "object" && parsed.cookie && typeof parsed.cookie === "object") {
    parsed = parsed.cookie;
  }

  if (typeof parsed === "string") {
    const value = parsed.trim();
    if (!value) throw new Error("empty cookie value");
    return {
      name: SESSION_COOKIE,
      value,
      domain: ".app.quiver.ai",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "lax",
    };
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("invalid cookie payload");
  }
  const cookie = sanitizeCookieRecord(parsed);
  if (!cookie) {
    throw new Error("cookie value missing");
  }
  return cookie;
}

async function jsonFetch(url, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const mergedOptions = {
    ...options,
    signal: options.signal || controller.signal,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  };
  delete mergedOptions.timeoutMs;
  try {
    const response = await fetch(url, mergedOptions);
    const text = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch (err) {
      payload = text;
    }
    if (!response.ok) {
      throw new Error(`${url} -> ${response.status}: ${typeof payload === "string" ? payload : JSON.stringify(payload).slice(0, 260)}`);
    }
    return payload;
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(`${url} request timeout ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function mailGet(url, options = {}) {
  return jsonFetch(url, { method: "GET", ...options });
}

async function mailPost(url, body, options = {}) {
  return jsonFetch(url, { method: "POST", body: JSON.stringify(body), ...options });
}

function normalizeMailMessageCode(msg) {
  if (!msg || typeof msg !== "object") return null;
  const candidates = [msg.subject, msg.text, msg.intro, msg.html];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const text = String(candidate).replace(/<[^>]+>/g, " ");
    const contextual = text.match(/(?:one[\s-]?time|verification)?\s*code[^0-9]{0,40}(\d{6})/i);
    if (contextual) {
      return contextual[1];
    }
    const all = [...text.matchAll(/\b(\d{6})\b/g)].map((m) => m[1]);
    if (all.length === 1) {
      return all[0];
    }
    if (all.length > 1) {
      return all[all.length - 1];
    }
  }
  return null;
}

function isAuthUrl(msg) {
  if (!msg || typeof msg !== "string") return false;
  const s = msg.toLowerCase();
  return s.includes("quiver") && s.includes("sign up");
}

async function pickMailDomain() {
  const body = await mailGet(`${MAIL_BASE}/domains`);
  const members = Array.isArray(body["hydra:member"]) ? body["hydra:member"] : [];
  if (!members.length) {
    throw new Error("mail.tm domains empty");
  }
  const active = members.find((m) => m && m.isActive);
  return (active && active.domain) || members[0].domain;
}

async function createMailAccount(domain) {
  const password = randomPassword();
  for (let i = 0; i < 8; i += 1) {
    const address = `${Date.now().toString(36)}${randomText(6)}@${domain}`;
    try {
      const body = await mailPost(`${MAIL_BASE}/accounts`, { address, password });
      if (!body || typeof body !== "object" || !body.id) {
        throw new Error(`mail.tm create account result invalid: ${JSON.stringify(body).slice(0, 180)}`);
      }
      return { address, password };
    } catch (err) {
      if (i === 7) {
        throw err;
      }
      if (/already|422/i.test(String(err.message))) {
        continue;
      }
      throw err;
    }
  }
  throw new Error("mail.tm account creation retry exhausted");
}

async function mailLogin(address, password) {
  const auth = await mailPost(`${MAIL_BASE}/token`, { address, password });
  const token = auth && auth.token;
  if (!token) {
    throw new Error(`mail.tm login failed: ${JSON.stringify(auth).slice(0, 180)}`);
  }
  return token;
}

async function pollMagicCode(mailToken, knownIds = new Set(), timeoutMs = MAIL_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  const headers = { Authorization: `Bearer ${mailToken}` };
  let lastListSize = 0;
  let observed = 0;
  const lastSubjects = [];
  while (Date.now() < deadline) {
    const list = await mailGet(`${MAIL_BASE}/messages?page=1&limit=50`, { headers });
    const members = Array.isArray(list["hydra:member"]) ? list["hydra:member"] : [];
    lastListSize = members.length;
    for (const msg of members) {
      const messageId = msg && msg.id;
      if (!messageId || knownIds.has(messageId)) continue;
      knownIds.add(messageId);
      observed += 1;

      const detail = await jsonFetch(`${MAIL_BASE}/messages/${messageId}`, { headers });
      if (detail?.subject) {
        lastSubjects.push(String(detail.subject).slice(0, 48));
        if (lastSubjects.length > 3) {
          lastSubjects.shift();
        }
      }
      const marker = [detail?.subject, detail?.intro, detail?.text].filter(Boolean).join(" ");
      if (marker && !isAuthUrl(marker)) {
        continue;
      }
      const code = normalizeMailMessageCode(detail);
      if (code) {
        return { code, messageId };
      }
    }
    await sleep(MAIL_POLL_INTERVAL_MS);
  }
  throw new Error(`timeout waiting for mail.tm verification code (list=${lastListSize}, observed=${observed}, subjects=${lastSubjects.join("|") || "none"})`);
}

async function createAndPrepareAccount(options = {}) {
  const mailTimeoutMs = Number.isFinite(options.mailTimeoutMs) ? options.mailTimeoutMs : MAIL_TIMEOUT_MS;
  const domain = await pickMailDomain();
  const { address, password } = await createMailAccount(domain);
  const mailToken = await mailLogin(address, password);
  await mailPost(MAGIC_URL, { email: address, intent: "signup" });
  const { code } = await pollMagicCode(mailToken, new Set(), mailTimeoutMs);
  return {
    id: `${Date.now()}-${randomText(4)}`,
    email: address,
    mailPassword: password,
    magicCode: code,
    preparedCookie: null,
    createdAt: new Date().toISOString(),
  };
}

async function getCurrentSessionCookie() {
  const cookie = await chrome.cookies.get({ url: QUIVER_ORIGIN, name: SESSION_COOKIE });
  return sessionCookieLike(cookie);
}

function cookieToPayload(cookie, url = QUIVER_ORIGIN) {
  if (!cookie) return null;
  return {
    url,
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path || "/",
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    expirationDate: cookie.expirationDate,
  };
}

async function restoreCookie(cookieRecord) {
  const current = await getCurrentSessionCookie();
  await chrome.cookies.remove({ url: QUIVER_ORIGIN, name: SESSION_COOKIE });
  if (!cookieRecord || !cookieRecord.value) {
    return current;
  }
  await chrome.cookies.set(cookieToPayload(cookieRecord, QUIVER_ORIGIN));
  return current;
}

async function applyCookieRecord(cookieRecord) {
  if (!cookieRecord || !cookieRecord.value) return false;
  await chrome.cookies.set(cookieToPayload(cookieRecord, QUIVER_ORIGIN));
  return true;
}

async function waitForHiddenTabComplete(tabId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await chrome.tabs.get(tabId);
    if (info && info.status === "complete") {
      return;
    }
    await sleep(100);
  }
  throw new Error("hidden tab timeout");
}

async function waitForTabComplete(tabId, timeoutMs = TAB_READY_TIMEOUT_MS) {
  const current = await chrome.tabs.get(tabId);
  if (current && current.status === "complete") return;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("tab complete timeout"));
    }, timeoutMs);

    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function reloadTabAndWait(tabId, timeoutMs = TAB_READY_TIMEOUT_MS) {
  await chrome.tabs.reload(tabId);
  await waitForTabComplete(tabId, timeoutMs);
}

async function reloadOrNavigateTab(tabId) {
  try {
    await reloadTabAndWait(tabId, 12000);
    return;
  } catch (err) {
    await chrome.tabs.update(tabId, { url: `${QUIVER_ORIGIN}/creations` });
    await waitForTabComplete(tabId, 12000);
  }
}

async function reloadQuiverTabs() {
  const tabs = await chrome.tabs.query({ url: [`${QUIVER_ORIGIN}/*`] });
  await Promise.all(
    tabs
      .filter((tab) => Number.isInteger(tab.id))
      .map((tab) => reloadOrNavigateTab(tab.id).catch(() => {})),
  );
}

async function withTimeout(promise, label, timeoutMs = 30000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timeout ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}

async function runVerifyInTab(tabId, email, magicCode) {
  const result = await withTimeout(
    chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: (payload) => {
      const data = JSON.stringify(payload);
      return fetch("/api/auth/magic/verify", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
        body: data,
      })
        .then(async (resp) => {
          const text = await resp.text();
          return {
            ok: resp.ok,
            status: resp.status,
            body: text,
            redirected: resp.redirected,
            url: resp.url,
            email: payload.email,
          };
        });
    },
    args: [{ email, code: magicCode, intent: "signup" }],
    }),
    "verify in tab",
    30000,
  );
  if (!result || result[0] == null) {
    throw new Error("executeScript no result");
  }
  return result[0].result;
}

async function runRequestMagicInTab(tabId, email) {
  const result = await withTimeout(
    chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: (payload) => {
        const data = JSON.stringify({ email: payload.email, intent: "signup" });
        return fetch("/api/auth/magic", {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
          },
          body: data,
        }).then(async (resp) => {
          const text = await resp.text();
          return {
            ok: resp.ok,
            status: resp.status,
            body: text,
          };
        });
      },
      args: [{ email }],
    }),
    "request magic in tab",
    30000,
  );
  if (!result || result[0] == null) {
    throw new Error("request magic executeScript no result");
  }
  return result[0].result;
}

async function requestMagicInBackground(email) {
  let tab = null;
  try {
    tab = await chrome.tabs.create({ url: `${QUIVER_ORIGIN}/generate`, active: false });
    await waitForHiddenTabComplete(tab.id, 20000);
    const req = await runRequestMagicInTab(tab.id, email);
    if (!req || !req.ok) {
      throw new Error(`request magic in tab failed: ${JSON.stringify(req)}`);
    }
    return true;
  } finally {
    if (tab && tab.id) {
      try {
        await chrome.tabs.remove(tab.id);
      } catch (err) {
        void err;
      }
    }
  }
}

async function runSessionInTab(tabId) {
  const result = await withTimeout(
    chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () =>
        fetch("/api/_auth/session", { credentials: "include" })
          .then(async (resp) => {
            const text = await resp.text();
            let body = null;
            try {
              body = JSON.parse(text);
            } catch (err) {
              body = null;
            }
            return {
              ok: resp.ok,
              status: resp.status,
              body,
              text,
            };
          })
          .catch((error) => ({
            ok: false,
            status: 0,
            error: String(error?.message || error),
          })),
    }),
    "session in tab",
    15000,
  );
  if (!result || result[0] == null) {
    throw new Error("session executeScript no result");
  }
  return result[0].result;
}

async function prepareCookieInBackground(email, magicCode) {
  if (!state.preparedCookieSupported) {
    return null;
  }

  const original = await getCurrentSessionCookie();
  let tab = null;
  try {
    tab = await chrome.tabs.create({ url: `${QUIVER_ORIGIN}/generate`, active: false });
    await waitForHiddenTabComplete(tab.id, 20000);
    const verify = await runVerifyInTab(tab.id, email, magicCode);
    if (!verify || !verify.ok) {
      throw new Error(`background verify failed: ${JSON.stringify(verify)}`);
    }
    const cookie = await getCurrentSessionCookie();
    if (!cookie) {
      throw new Error("background verify no session cookie");
    }
    return cookie;
  } finally {
    if (tab && tab.id) {
      try {
        await chrome.tabs.remove(tab.id);
      } catch (err) {
        void err;
      }
    }
    try {
      await restoreCookie(original || {});
    } catch (err) {
      state.preparedCookieSupported = false;
    }
  }
}

async function sendMessageToTab(tabId, message, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error("content script timeout"));
    }, timeoutMs);
    chrome.tabs.sendMessage(tabId, message, (resp) => {
      clearTimeout(t);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(resp || { ok: true });
    });
  });
}

async function checkSessionInTab(tabId) {
  try {
    const session = await runSessionInTab(tabId);
    if (!session || !session.ok) {
      throw new Error(session?.error || `session check failed ${session?.status || 0}`);
    }
    const email = session?.body?.user?.email || null;
    if (!email) {
      throw new Error("session has no authenticated user");
    }
    return {
      ok: true,
      email,
    };
  } catch (err) {
    const resp = await sendMessageToTab(tabId, { type: "CHECK_SESSION" });
    if (!resp || !resp.ok || !resp.email) {
      throw new Error(resp && resp.error ? resp.error : String(err?.message || err));
    }
    return resp;
  }
}

async function applyByCookie(tabId, account) {
  if (!account?.preparedCookie) {
    throw new Error("no prepared cookie");
  }
  await applyCookieRecord(account.preparedCookie);
  await reloadOrNavigateTab(tabId);

  const session = await checkSessionInTabWithRetry(tabId, 4, 4000, 220);
  if (!session.ok || !session.email) {
    throw new Error(`cookie session verify failed: ${session.error ? String(session.error) : "unverified"}`);
  }
  return { ok: true, source: "cookie", sessionEmail: session.email };
}

async function checkSessionInTabWithRetry(tabId, attempts = 3, timeoutMs = 5000, intervalMs = 200) {
  let lastErr = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      await sleep(i * intervalMs);
      return await checkSessionInTab(tabId);
    } catch (err) {
      lastErr = err;
      await waitForTabComplete(tabId, timeoutMs).catch(() => {});
      try {
        await sleep(intervalMs);
      } catch (_) {}
    }
  }
  return { ok: false, error: String(lastErr?.message || "session check failed") };
}

async function ensureQueue() {
  if (state.filling) {
    return;
  }
  state.filling = true;
  state.lastError = null;
  const deadline = Date.now() + QUEUE_PREFILL_TIMEOUT_MS;
  let attempts = 0;
  let lastPrefillErr = null;
  try {
    while (state.queue.length < QUEUE_TARGET) {
      if (Date.now() > deadline) {
        state.lastError = `预取超时 (${QUEUE_PREFILL_TIMEOUT_MS}ms)，请稍后重试`;
        break;
      }
      attempts += 1;
      try {
        const next = await createAndPrepareAccount();
        if (!next || !next.email || !next.magicCode) {
          throw new Error("prepared account missing required fields");
        }
        state.queue.push(next);
        await saveState();
      } catch (err) {
        console.warn("[quiver-switcher] prefetch failed", err);
        lastPrefillErr = String(err?.message || err);
        if (attempts >= 5) {
          state.lastError = lastPrefillErr || "prefetch failed";
          await saveState();
          break;
        }
        await sleep(500);
      }
    }
    if (state.queue.length >= QUEUE_TARGET) {
      state.lastError = null;
      await saveState();
    }
  } finally {
    state.filling = false;
  }
}

async function ensureQueueWithDeadline(ms = QUEUE_PREFILL_TIMEOUT_MS) {
  const timeout = new Promise((resolve) => {
    setTimeout(() => resolve(false), ms);
  });
  const result = await Promise.race([ensureQueue().then(() => true), timeout]);
  return result;
}

async function waitForFillComplete(timeoutMs = 8000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (state.filling) {
    if (Date.now() > deadline) {
      return false;
    }
    await sleep(intervalMs);
  }
  return true;
}

function pickPreparedAccountFromQueue() {
  while (state.queue.length > 0) {
    const account = state.queue.shift();
    if (account?.email && account?.magicCode) {
      return account;
    }
  }
  return null;
}

async function applyByAccount(tabId, account) {
  if (account?.preparedCookie?.value) {
    return applyByCookie(tabId, account);
  }
  if (account?.magicCode && account?.email) {
    try {
      await chrome.cookies.remove({ url: QUIVER_ORIGIN, name: SESSION_COOKIE });
    } catch (err) {
      void err;
    }
    await reloadOrNavigateTab(tabId);

    const verify = await runVerifyInTab(tabId, account.email, account.magicCode);
    if (!verify || !verify.ok) {
      throw new Error(`magic verify failed ${verify?.status || 0}: ${String(verify?.body || "").slice(0, 180)}`);
    }
    await reloadOrNavigateTab(tabId);
    const session = await checkSessionInTabWithRetry(tabId, 4, 4000, 220);
    if (!session.ok || !session.email) {
      throw new Error(
        `magic session verify failed: ${session.error ? String(session.error) : "unverified"}; verify=${String(verify?.body || "").slice(0, 180)}`,
      );
    }
    if (String(session.email).toLowerCase() !== String(account.email).toLowerCase()) {
      throw new Error(`magic session mismatch: expected ${account.email}, got ${session.email}`);
    }
    return { ok: true, source: "magic", sessionEmail: session.email || account.email };
  }
  throw new Error("account missing prepared cookie and magic code");
}

async function readUsageSnapshotInTab(tabId) {
  try {
    const result = await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: () => {
          const text = String(document.body?.innerText || "");
          if (!text) return null;
          const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
          let match = null;
          let label = null;

          const labelIdx = lines.findIndex((line) => /free included svg/i.test(line));
          if (labelIdx >= 0) {
            label = lines[labelIdx];
            for (let i = labelIdx; i < Math.min(lines.length, labelIdx + 6); i += 1) {
              const m = lines[i].match(/(\d+)\s*\/\s*(\d+)/);
              if (m) {
                match = m;
                break;
              }
            }
          }

          if (!match) {
            match = text.match(/(\d+)\s*\/\s*(\d+)/);
          }
          if (!match) return null;

          const used = Number(match[1]);
          const total = Number(match[2]);
          if (!Number.isFinite(used) || !Number.isFinite(total)) return null;
          return {
            used,
            total,
            raw: `${used}/${total}`,
            label: label || null,
          };
        },
      }),
      "read usage in tab",
      8000,
    );
    if (!result || result[0] == null) {
      return null;
    }
    return normalizeUsageSnapshot(result[0].result);
  } catch (err) {
    return null;
  }
}

async function snapshotCurrentAccountToHistory(tabId) {
  try {
    const cookie = await getCurrentSessionCookie();
    if (!cookie?.value) {
      return false;
    }

    let email = state.currentEmail || null;
    try {
      const session = await checkSessionInTabWithRetry(tabId, 2, 2500, 150);
      if (session?.ok && session.email) {
        email = session.email;
      }
    } catch (err) {
      void err;
    }

    const usage = await readUsageSnapshotInTab(tabId);
    const entry = makeCookieHistoryEntry(cookie, email, usage);
    if (!entry) {
      return false;
    }
    pushCookieHistory(entry);
    await saveState();
    return true;
  } catch (err) {
    return false;
  }
}

async function switchToNextAccount(tabId) {
  if (state.switching) {
    const startedAt = Number(state.switchStartedAt || 0);
    const age = startedAt > 0 ? Date.now() - startedAt : Number.MAX_SAFE_INTEGER;
    if (age > SWITCH_GUARD_TIMEOUT_MS) {
      state.switching = false;
      state.switchStartedAt = null;
      state.lastError = "switch guard released stale lock";
      await saveState();
    } else {
      throw new Error("switch in progress");
    }
  }
  state.switching = true;
  state.switchStartedAt = Date.now();
  const startedAt = Date.now();
  try {
    await snapshotCurrentAccountToHistory(tabId);

    let account = pickPreparedAccountFromQueue();

    if (!account && state.filling) {
      await waitForFillComplete(2500);
      account = pickPreparedAccountFromQueue();
    }

    if (!account) {
      account = await createAndPrepareAccount();
    }

    if (!account || !account.email || !account.magicCode) {
      throw new Error("account preparation failed");
    }

    await saveState();
    const result = await applyByAccount(tabId, account);
    if (!result || !result.ok) {
      throw new Error("apply by cookie failed");
    }

    const finalSession = await checkSessionInTabWithRetry(tabId, 3, 3000, 220);
    if (!finalSession.ok || !finalSession.email) {
      throw new Error(`post-switch session invalid: ${finalSession.error ? String(finalSession.error) : "no email"}`);
    }
    if (String(finalSession.email).toLowerCase() !== String(account.email).toLowerCase()) {
      throw new Error(`post-switch session mismatch: expected ${account.email}, got ${finalSession.email}`);
    }
    state.currentEmail = finalSession.email;
    state.lastUsed = new Date().toISOString();
    state.lastError = null;
    state.lastSwitchResult = {
      ts: Date.now(),
      ok: true,
      accountEmail: account.email,
      sessionEmail: result.sessionEmail || null,
      source: result.source || null,
    };
    await saveState();
    ensureQueue().catch(() => {
      void 0;
    });

    return {
      ok: true,
      account: {
        email: account.email,
        usedAt: new Date().toISOString(),
        switchMs: Date.now() - startedAt,
      },
      session: result,
      queued: state.queue.length,
    };
  } catch (error) {
    state.lastError = String(error?.message || error);
    state.lastSwitchResult = {
      ts: Date.now(),
      ok: false,
      error: String(error?.message || error),
    };
    await saveState();
    return { ok: false, error: String(error?.message || error), queued: state.queue.length };
  } finally {
    state.switching = false;
    state.switchStartedAt = null;
  }
}

function getStateSnapshot() {
  return {
    queued: state.queue.length,
    currentEmail: state.currentEmail,
    switching: state.switching,
    switchStartedAt: state.switchStartedAt || null,
    filling: state.filling,
    lastError: state.lastError || null,
    lastSwitchResult: state.lastSwitchResult || null,
    preparedCookieSupported: state.preparedCookieSupported,
    cookieHistoryCount: getCookieHistorySnapshot().length,
  };
}

function sanitizeStateForStorage() {
  return {
    queue: state.queue.slice(0, 20).map((item) => ({
      ...item,
      preparedCookie: item.preparedCookie || null,
      password: item.mailPassword || null,
      magicCode: item.magicCode || null,
    })),
    currentEmail: state.currentEmail || null,
    preparedCookieSupported: state.preparedCookieSupported,
    lastError: state.lastError || null,
    lastUsed: state.lastUsed || null,
    lastSwitchResult: state.lastSwitchResult || null,
    cookieHistory: getCookieHistorySnapshot(),
  };
}

async function loadState() {
  const raw = await chrome.storage.local.get([STATE_KEY]);
  const saved = raw[STATE_KEY];
  if (!saved || typeof saved !== "object") return;
  // Drop stale prepared cookies after extension updates; rebuild queue fresh.
  state.queue = [];
  state.currentEmail = saved.currentEmail || null;
  state.preparedCookieSupported = typeof saved.preparedCookieSupported === "boolean" ? saved.preparedCookieSupported : true;
  state.lastError = saved.lastError || null;
  state.lastUsed = saved.lastUsed || null;
  state.lastSwitchResult = saved.lastSwitchResult || null;
  state.cookieHistory = (Array.isArray(saved.cookieHistory) ? saved.cookieHistory : [])
    .map((item) => normalizeHistoryEntry(item))
    .filter(Boolean)
    .slice(0, COOKIE_HISTORY_LIMIT);
}

async function saveState() {
  await chrome.storage.local.set({
    [STATE_KEY]: sanitizeStateForStorage(),
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  await loadState();
  await ensureQueue();
});

chrome.runtime.onStartup.addListener(async () => {
  await loadState();
  await ensureQueue();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "GET_COOKIE_HISTORY") {
    sendResponse({ ok: true, items: getCookieHistorySnapshot() });
    return;
  }
  if (message.type === "EXPORT_CURRENT_COOKIE") {
    (async () => {
      try {
        const cookie = await getCurrentSessionCookie();
        if (!cookie?.value) {
          throw new Error("no active session cookie");
        }
        const entry = makeCookieHistoryEntry(cookie, state.currentEmail || null);
        pushCookieHistory(entry);
        await saveState();
        sendResponse({ ok: true, item: entry, items: getCookieHistorySnapshot() });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }
  if (message.type === "IMPORT_COOKIE") {
    (async () => {
      try {
        const cookie = normalizeCookieImportPayload(message.payload ?? message.cookie ?? "");
        await applyCookieRecord(cookie);
        const entry = makeCookieHistoryEntry(cookie, message.email || null);
        pushCookieHistory(entry);
        await saveState();
        if (message.reloadTabs !== false) {
          await reloadQuiverTabs();
        }
        sendResponse({ ok: true, item: entry, items: getCookieHistorySnapshot() });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }
  if (message.type === "APPLY_HISTORY_COOKIE") {
    (async () => {
      try {
        const target = findCookieHistoryEntryById(String(message.id || ""));
        if (!target || !target.cookie?.value) {
          throw new Error("history cookie not found");
        }
        await applyCookieRecord(target.cookie);
        const freshEntry = makeCookieHistoryEntry(target.cookie, target.email || null, target.usage || null);
        pushCookieHistory(freshEntry);
        await saveState();
        if (message.reloadTabs !== false) {
          await reloadQuiverTabs();
        }
        sendResponse({ ok: true, item: freshEntry, items: getCookieHistorySnapshot() });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }
  if (message.type === "GET_STATE") {
    if (!state.filling && state.queue.length < QUEUE_TARGET) {
      ensureQueue().catch(() => {
        void 0;
      });
    }
    sendResponse(getStateSnapshot());
    return;
  }
  if (message.type === "REQUEST_SWITCH") {
    const tabId = sender?.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: "No tab context" });
      return;
    }
    switchToNextAccount(tabId).then((res) => sendResponse(res)).catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
});
