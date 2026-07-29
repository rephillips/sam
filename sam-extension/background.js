// background.js — service worker.
// The API token lives here and in chrome.storage.session ONLY. It is never
// returned to the popup and never written to disk-backed storage.

import { buildIpAllowListUrl, buildCurl, ENVIRONMENTS } from "./acs.js";

const TOKEN_KEY = "sam_token";
const LOG_KEY = "sam_request_log";
const MAX_LOG = 25;
const TOKEN_TTL_ALARM = "sam_token_ttl";
const TOKEN_TTL_MINUTES = 30;

// Session storage is TRUSTED_CONTEXTS by default; state it explicitly so the
// guarantee survives future drift (e.g. someone adding a content script).
chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).catch(() => {});

/* ------------------------------ token ------------------------------ */

// A Splunk Cloud API token is a three-segment JWT. Enforcing the shape at the
// trust boundary catches the wrong secret being pasted (an AWS key, a
// password) before it is stored or ever sent as a bearer header.
const JWT_SHAPE = /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/;

async function setToken(token) {
  await chrome.storage.session.set({ [TOKEN_KEY]: token });
  await touchTokenTtl();
}

async function getToken() {
  const bag = await chrome.storage.session.get(TOKEN_KEY);
  return bag[TOKEN_KEY] || null;
}

async function clearToken() {
  await chrome.storage.session.remove(TOKEN_KEY);
  await chrome.alarms.clear(TOKEN_TTL_ALARM);
}

// Idle timeout: the token dies TOKEN_TTL_MINUTES after its last use, not when
// the browser eventually closes — browsers stay open for days. Re-arming on
// every use makes it a sliding window over the working session.
async function touchTokenTtl() {
  await chrome.alarms.create(TOKEN_TTL_ALARM, { delayInMinutes: TOKEN_TTL_MINUTES });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TOKEN_TTL_ALARM) clearToken();
});

// Walk-away protection: wipe the token the moment the OS session locks.
chrome.idle.onStateChanged.addListener((state) => {
  if (state === "locked") clearToken();
});

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
    return {
      ok: false,
      status: 0,
      error:
        "No API token in session — it may have expired after " +
        `${TOKEN_TTL_MINUTES} minutes idle or been cleared on screen lock. ` +
        "Save a token in the Connection panel.",
    };
  }
  await touchTokenTtl(); // each use slides the expiry window

  let url;
  try {
    url = buildIpAllowListUrl({ envId, stack, feature, ipVersion });
  } catch (e) {
    return { ok: false, status: 0, error: e.message };
  }

  // The curl equivalent goes into the activity log. buildCurl substitutes a
  // placeholder token, so the real bearer token never enters the log.
  const curl = buildCurl({ envId, stack, feature, ipVersion, method, subnets });

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
    const entry = { ts: started, method, url, status: 0, ms: Date.now() - started, error: e.message, curl };
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

  await pushLog({ ts: started, method, url, status: response.status, ms, curl });

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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Defense-in-depth: only this extension's own pages may drive the worker.
  // Currently nothing else can reach onMessage (no content scripts, no
  // externally_connectable), but this check keeps that true if the manifest
  // ever drifts.
  if (!sender || sender.id !== chrome.runtime.id) {
    sendResponse({ ok: false, error: "Unauthorized sender." });
    return false;
  }
  (async () => {
    try {
      switch (msg.type) {
        case "saveToken":
          if (!JWT_SHAPE.test(String(msg.token || ""))) {
            sendResponse({
              ok: false,
              error:
                "That doesn't look like a Splunk Cloud token (expected a three-segment JWT starting with \"eyJ\"). Check what you pasted.",
            });
            break;
          }
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
