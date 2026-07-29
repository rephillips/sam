// background.js — service worker.
// The API token lives here and in chrome.storage.session ONLY. It is never
// returned to the popup and never written to disk-backed storage.

import { buildIpAllowListUrl, ENVIRONMENTS } from "./acs.js";

const TOKEN_KEY = "sam_token";
const LOG_KEY = "sam_request_log";
const MAX_LOG = 25;

/* ------------------------------ token ------------------------------ */

async function setToken(token) {
  await chrome.storage.session.set({ [TOKEN_KEY]: token });
}

async function getToken() {
  const bag = await chrome.storage.session.get(TOKEN_KEY);
  return bag[TOKEN_KEY] || null;
}

async function clearToken() {
  await chrome.storage.session.remove(TOKEN_KEY);
}

/* ------------------------------ logging ------------------------------ */
// Log metadata only. Never the token, never full response bodies.

async function pushLog(entry) {
  const bag = await chrome.storage.session.get(LOG_KEY);
  const log = bag[LOG_KEY] || [];
  log.unshift(entry);
  await chrome.storage.session.set({ [LOG_KEY]: log.slice(0, MAX_LOG) });
}

async function getLog() {
  const bag = await chrome.storage.session.get(LOG_KEY);
  return bag[LOG_KEY] || [];
}

/* ------------------------------ ACS call ------------------------------ */

async function acsIpAllowList({ envId, stack, feature, ipVersion, method, subnets }) {
  const token = await getToken();
  if (!token) {
    return { ok: false, status: 0, error: "No API token saved. Save a token in the Connection panel." };
  }

  let url;
  try {
    url = buildIpAllowListUrl({ envId, stack, feature, ipVersion });
  } catch (e) {
    return { ok: false, status: 0, error: e.message };
  }

  const init = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  };

  if (method === "POST" || method === "DELETE") {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify({ subnets });
  }

  const started = Date.now();
  let response, text;
  try {
    response = await fetch(url, init);
    text = await response.text();
  } catch (e) {
    const entry = { ts: started, method, url, status: 0, ms: Date.now() - started, error: e.message };
    await pushLog(entry);
    return {
      ok: false,
      status: 0,
      url,
      method,
      error:
        `Network error: ${e.message}. ` +
        `Check that the stack name is correct and that this environment is reachable from your network.`,
    };
  }

  const ms = Date.now() - started;
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  await pushLog({ ts: started, method, url, status: response.status, ms });

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      url,
      method,
      ms,
      data,
      error: humanizeError(response.status, data, envId),
    };
  }

  return { ok: true, status: response.status, url, method, ms, data };
}

function humanizeError(status, data, envId) {
  const detail =
    (data && (data.message || data.error || (data.messages && data.messages[0]?.text))) || "";
  const env = ENVIRONMENTS[envId];

  switch (status) {
    case 401:
      return `401 Unauthorized — the token is invalid, expired, or was issued for a different stack. ${detail}`;
    case 403:
      return `403 Forbidden — the token's role lacks the capability for this operation (IP allow list changes need admin). ${detail}`;
    case 404:
      return (
        `404 Not Found — stack not found at ${env ? env.host : "this host"}. ` +
        `Verify the stack name, and that the environment selector matches where this stack actually lives. ${detail}`
      );
    case 429:
      return `429 Rate limited — ACS is throttling. Wait a moment and retry. ${detail}`;
    default:
      return `${status} — ${detail || "Request failed."}`;
  }
}

/* ------------------------------ messaging ------------------------------ */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case "saveToken":
          await setToken(msg.token);
          sendResponse({ ok: true });
          break;
        case "hasToken":
          sendResponse({ ok: true, hasToken: Boolean(await getToken()) });
          break;
        case "clearToken":
          await clearToken();
          sendResponse({ ok: true });
          break;
        case "acsIpAllowList":
          sendResponse(await acsIpAllowList(msg.payload));
          break;
        case "getLog":
          sendResponse({ ok: true, log: await getLog() });
          break;
        default:
          sendResponse({ ok: false, error: `Unknown message type: ${msg.type}` });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true; // async response
});
