/**
 * Mock chrome.* API for local development.
 *
 * Injected by tools/dev.mjs ahead of popup.js so the real popup can run in an
 * ordinary browser tab. Never packaged — the injection happens at serve time
 * and this file is excluded from the zip.
 *
 * Implements exactly the surface popup.js touches:
 *   chrome.storage.local   .get/.set          (backed by localStorage)
 *   chrome.storage.session .get/.set/.remove  (backed by an in-memory Map)
 *   chrome.runtime.sendMessage — hasToken | saveToken | clearToken |
 *                                acsIpAllowList | getLog
 *
 * Scenarios (append to the URL) let you drive design states without a stack:
 *   ?scenario=populated   three subnets on search-api            (default)
 *   ?scenario=empty       allow list comes back empty
 *   ?scenario=error       ACS returns 403
 *   ?scenario=slow        2.5s latency, for loading states
 *   ?scenario=fresh       no token, no saved profile (first-run)
 *   &shot=1               hides the DEV chip, for screenshots
 */
(function () {
  "use strict";

  const params = new URLSearchParams(location.search);
  const scenario = params.get("scenario") || "populated";
  const isShot = params.get("shot") === "1";

  const LATENCY = scenario === "slow" ? 2500 : 120;
  const FIXTURE_KEY = "sam_dev_fixtures";

  // Token lifetime in seconds. Mirrors the worker's 60-minute self-destruct;
  // override with &ttl=<seconds> to watch the countdown expire quickly.
  const TOKEN_TTL_S = Number(params.get("ttl")) > 0 ? Number(params.get("ttl")) : 3600;

  // Expired tokens are as good as absent — same behaviour as the worker's
  // alarm, enforced lazily at read time since the mock has no alarms.
  function liveToken() {
    const t = memSession.getItem("sam_token");
    if (!t) return null;
    const exp = Number(memSession.getItem("sam_token_expiry"));
    if (exp && Date.now() > exp) {
      memSession.removeItem("sam_token");
      memSession.removeItem("sam_token_expiry");
      return null;
    }
    return t;
  }

  const SEED = {
    "search-api": ["52.24.108.7/32", "34.210.15.0/24", "18.246.31.128/25"],
    "search-ui": ["52.24.108.7/32"],
    hec: ["34.210.15.0/24"],
    s2s: [],
  };

  if (scenario === "fresh") {
    localStorage.removeItem("sam_profile");
    sessionStorage.clear();
  }
  if (params.get("reset") === "1") {
    localStorage.removeItem(FIXTURE_KEY);
    localStorage.removeItem("sam_profile");
    sessionStorage.clear();
  }

  function fixtures() {
    try {
      const raw = localStorage.getItem(FIXTURE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (_) {
      /* fall through to seed */
    }
    const seeded = JSON.parse(JSON.stringify(SEED));
    localStorage.setItem(FIXTURE_KEY, JSON.stringify(seeded));
    return seeded;
  }

  function saveFixtures(f) {
    localStorage.setItem(FIXTURE_KEY, JSON.stringify(f));
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ── in-memory session store ─────────────────────────────────────────── */
  // Deliberately NOT sessionStorage: browsers persist sessionStorage to disk
  // for tab restore, so a token pasted into the harness would outlive the
  // session on disk. The real extension keeps the token memory-only in
  // chrome.storage.session; the mock must not be weaker than the real thing.
  // Values here last until the page is reloaded — re-save after a refresh.
  const memSession = (() => {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
    };
  })();

  /* ── storage ─────────────────────────────────────────────────────────── */
  function makeStore(backing) {
    const keysOf = (query) => {
      if (query === null || query === undefined) return Object.keys(backing);
      if (typeof query === "string") return [query];
      if (Array.isArray(query)) return query;
      return Object.keys(query);
    };
    return {
      async get(query) {
        const out = {};
        for (const k of keysOf(query)) {
          const raw = backing.getItem(k);
          if (raw !== null) {
            try {
              out[k] = JSON.parse(raw);
            } catch (_) {
              out[k] = raw;
            }
          } else if (query && typeof query === "object" && !Array.isArray(query)) {
            out[k] = query[k];
          }
        }
        return out;
      },
      async set(obj) {
        for (const [k, v] of Object.entries(obj)) backing.setItem(k, JSON.stringify(v));
      },
      async remove(key) {
        for (const k of Array.isArray(key) ? key : [key]) backing.removeItem(k);
      },
    };
  }

  /* ── request log ─────────────────────────────────────────────────────── */
  const log = [];
  function record(method, url, status, ms, curl) {
    log.unshift({ method, url, status, ms, curl });
    if (log.length > 25) log.pop();
  }

  // Mirrors acs.js buildCurl, including the placeholder token — the log never
  // carries a real credential, in dev or in the shipped extension.
  function curlFor(p) {
    const url = urlFor(p);
    const token = "eyJraWQiOiJzcGx1bmsuc2...";
    if (p.method === "GET") return `curl ${url} --header 'Authorization: Bearer ${token}'`;
    return [
      `curl -X ${p.method} '${url}' \\`,
      `--header 'Content-Type: application/json' \\`,
      `--header 'Authorization: Bearer ${token}' \\`,
      `--data '${JSON.stringify({ subnets: p.subnets || [] })}'`,
    ].join("\n");
  }

  const BASES = {
    commercial: "https://admin.splunk.com",
    commercial_staging: "https://staging.admin.splunk.com",
    govcloud_il2: "https://admin.splunkcloudgc.com",
    govcloud_il2_staging: "https://staging.admin.splunkcloudgc.com",
  };

  const PATHS = {
    "search-api": "search-api",
    "search-ui": "search-ui",
    hec: "hec",
    s2s: "s2s",
  };

  function urlFor(p) {
    const base = BASES[p.envId] || BASES.commercial;
    const suffix = p.ipVersion === "v6" ? "/ipv6" : "";
    return `${base}/${p.stack}/adminconfig/v2/access/${PATHS[p.feature]}/ipallowlists${suffix}`;
  }

  /* ── message router ──────────────────────────────────────────────────── */
  async function route(msg) {
    switch (msg.type) {
      case "hasToken":
        return {
          ok: true,
          hasToken: Boolean(liveToken()),
          expiresAt: liveToken() ? Number(memSession.getItem("sam_token_expiry")) : null,
        };

      case "saveToken":
        // A real Splunk Cloud token is a three-segment JWT. Refuse the shape
        // outright: the harness never contacts ACS, so a production credential
        // here is pure risk with zero function.
        if (/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(String(msg.token || ""))) {
          return {
            ok: false,
            error:
              'That looks like a real JWT. The dev harness never contacts ACS — use any fake string (e.g. "test") instead.',
          };
        }
        memSession.setItem("sam_token", msg.token);
        memSession.setItem("sam_token_expiry", String(Date.now() + TOKEN_TTL_S * 1000));
        return { ok: true };

      case "clearToken":
        memSession.removeItem("sam_token");
        memSession.removeItem("sam_token_expiry");
        return { ok: true };

      case "getLog":
        return { ok: true, log: log.slice() };

      case "acsIpAllowList": {
        const p = msg.payload;
        const url = urlFor(p);
        const started = Date.now();
        await sleep(LATENCY);
        const ms = Date.now() - started;

        if (!liveToken()) {
          record(p.method, url, 0, ms, curlFor(p));
          return { ok: false, error: "No API token in session. Enter one and save.", ms };
        }
        if (!p.stack) {
          record(p.method, url, 0, ms, curlFor(p));
          return { ok: false, error: "No stack configured.", ms };
        }
        if (scenario === "error") {
          record(p.method, url, 403, ms, curlFor(p));
          return {
            ok: false,
            error: "ACS returned 403: token lacks the sc_admin role on this stack.",
            ms,
          };
        }

        const f = fixtures();
        const key = p.feature;
        f[key] = f[key] || [];

        if (p.method === "GET") {
          const subnets = scenario === "empty" ? [] : f[key];
          record("GET", url, 200, ms, curlFor(p));
          return { ok: true, data: { subnets: subnets.slice() }, ms };
        }
        if (p.method === "POST") {
          for (const s of msg.payload.subnets) if (!f[key].includes(s)) f[key].push(s);
          saveFixtures(f);
          record("POST", url, 200, ms, curlFor(p));
          return { ok: true, data: { subnets: f[key].slice() }, ms };
        }
        if (p.method === "DELETE") {
          f[key] = f[key].filter((s) => !msg.payload.subnets.includes(s));
          saveFixtures(f);
          record("DELETE", url, 200, ms, curlFor(p));
          return { ok: true, data: { subnets: f[key].slice() }, ms };
        }
        return { ok: false, error: `Unsupported method ${p.method}`, ms };
      }

      default:
        return { ok: false, error: `Mock has no handler for "${msg.type}"` };
    }
  }

  window.chrome = {
    storage: {
      local: makeStore(window.localStorage),
      session: makeStore(memSession),
    },
    runtime: {
      sendMessage: (msg) => route(msg),
      // "dev" rather than a real number, so a harness tab can never be
      // mistaken for the installed extension.
      getManifest: () => ({ version: "dev" }),
      lastError: null,
    },
  };

  /* ── screenshot mode ─────────────────────────────────────────────────── */
  // A sticky header renders at its stuck offset in full-page captures, which
  // shuffles the layout and makes visual diffs noisy. Pin it for screenshots
  // only — the shipped popup keeps its sticky behaviour.
  if (isShot) {
    const style = document.createElement("style");
    style.textContent = ".topbar{position:static !important}";
    document.documentElement.appendChild(style);
  }

  /* ── dev chip ────────────────────────────────────────────────────────── */
  if (!isShot) {
    window.addEventListener("DOMContentLoaded", () => {
      const chip = document.createElement("div");
      chip.textContent = `DEV · ${scenario}`;
      chip.title = "Mock chrome.* API — not the packaged extension";
      chip.style.cssText = [
        "position:fixed",
        "right:6px",
        "bottom:6px",
        "z-index:9999",
        "font:9px/1 ui-monospace,Menlo,monospace",
        "letter-spacing:.5px",
        "padding:4px 6px",
        "border-radius:4px",
        "background:rgba(217,164,65,.16)",
        "border:1px solid rgba(217,164,65,.5)",
        "color:#ecc57a",
        "pointer-events:none",
      ].join(";");
      document.body.appendChild(chip);
    });
  }
})();
