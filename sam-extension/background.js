// background.js — service worker.
// The API token lives here and in chrome.storage.session ONLY. It is never
// returned to the popup and never written to disk-backed storage.

import {
  buildIpAllowListUrl,
  buildCurl,
  ENVIRONMENTS,
  CURL_PLACEHOLDER_TOKEN,
} from "./acs.js";

const TOKEN_KEY = "sam_token";
const TOKEN_EXPIRY_KEY = "sam_token_expiry";
const LOG_KEY = "sam_request_log";
const MAX_LOG = 25;
const TOKEN_TTL_ALARM = "sam_token_ttl";
const TOKEN_TTL_MINUTES = 60;

// Session storage is TRUSTED_CONTEXTS by default; state it explicitly so the
// guarantee survives future drift (e.g. someone adding a content script).
chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).catch(() => {});

/* ------------------------------ token ------------------------------ */

// A Splunk Cloud API token is a three-segment JWT. Enforcing the shape at the
// trust boundary catches the wrong secret being pasted (an AWS key, a
// password) before it is stored or ever sent as a bearer header.
const JWT_SHAPE = /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/;

// Self-destruct: the token has a fixed TOKEN_TTL_MINUTES lifetime from the
// moment it is saved. No activity extends it — a credential in a browser has
// a bounded life, full stop. The expiry timestamp is stored alongside so the
// popup can render a countdown; the alarm is the enforcement.
async function setToken(token) {
  const expiresAt = Date.now() + TOKEN_TTL_MINUTES * 60 * 1000;
  await chrome.storage.session.set({ [TOKEN_KEY]: token, [TOKEN_EXPIRY_KEY]: expiresAt });
  await chrome.alarms.create(TOKEN_TTL_ALARM, { delayInMinutes: TOKEN_TTL_MINUTES });
}

async function getToken() {
  const bag = await chrome.storage.session.get(TOKEN_KEY);
  return bag[TOKEN_KEY] || null;
}

async function getTokenExpiry() {
  const bag = await chrome.storage.session.get(TOKEN_EXPIRY_KEY);
  return bag[TOKEN_EXPIRY_KEY] || null;
}

async function clearToken(reason = "manual") {
  await chrome.storage.session.remove([TOKEN_KEY, TOKEN_EXPIRY_KEY]);
  await chrome.alarms.clear(TOKEN_TTL_ALARM);
  // Tell any open SAM view immediately. Without this a windowed view keeps a
  // countdown burning for a token that no longer exists — the popup only
  // re-checks on its own when the fuse reaches zero, which never happens if
  // the token was killed early by a screen lock. Rejects when no view is
  // open, which is the normal case.
  chrome.runtime.sendMessage({ type: "tokenCleared", reason }).catch(() => {});
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TOKEN_TTL_ALARM) clearToken("expired");
});

// Walk-away protection: wipe the token the moment the OS session locks.
chrome.idle.onStateChanged.addListener((state) => {
  if (state === "locked") clearToken("locked");
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
        "No API token in session — it self-destructs " +
        `${TOKEN_TTL_MINUTES} minutes after being saved, and is also cleared ` +
        "on screen lock. Save a token in the Connection panel.",
    };
  }

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
          sendResponse({
            ok: true,
            hasToken: Boolean(await getToken()),
            expiresAt: await getTokenExpiry(),
            // Total lifetime, so the popup can draw the fuse as a fraction.
            ttlMs: TOKEN_TTL_MINUTES * 60 * 1000,
          });
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
        // Runnable curl: swap the placeholder for the live token so an
        // operator can paste a working command into a terminal. The popup
        // sends the redacted string and writes the result straight to the
        // clipboard — the credential is never rendered, stored, or logged.
        case "curlWithToken": {
          const tok = await getToken();
          if (!tok) {
            sendResponse({ ok: false, error: "No API token in session." });
            break;
          }
          sendResponse({
            ok: true,
            curl: String(msg.curl || "").split(CURL_PLACEHOLDER_TOKEN).join(tok),
          });
          break;
        }
        default:
          sendResponse({ ok: false, error: `Unknown message type: ${msg.type}` });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true; // async response
});
