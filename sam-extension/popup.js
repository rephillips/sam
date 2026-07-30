import {
  environmentById,
  FEATURES,
  featureById,
  parseSubnetList,
  assessRemoval,
  assessAddition,
  buildCurl,
  ACS_USAGE_URL,
  KCS_ARTICLE_URL,
  REPO_URL,
  ACS_CAPABILITIES_URL,
  ACS_SH_TARGETING_URL,
} from "./acs.js";

const $ = (id) => document.getElementById(id);
const PROFILE_KEY = "sam_profile";

let currentList = [];
let listLoaded = false;

/* ------------------------------ helpers ------------------------------ */

const send = (msg) => chrome.runtime.sendMessage(msg);

function setStatus(el, text, kind = "info") {
  el.textContent = text;
  el.className = `status status--${kind}`;
}

function profile() {
  return {
    envId: $("env").value,
    experience: $("experience").value,
    stack: $("stack").value.trim(),
    feature: $("feature").value,
    // The UI manages IPv4 lists only. The v6 endpoints and validation remain
    // in acs.js, so re-exposing a selector is a UI-only change.
    ipVersion: "v4",
  };
}

function applyEnvChrome() {
  // A stored profile can name an environment that no longer exists, which
  // leaves the select with no matching option. Fall back rather than throw
  // during init.
  const env = environmentById($("env").value) || environmentById("govcloud_il2");
  const badge = $("envBadge");
  badge.textContent = env.badge;
  badge.className = `badge ${env.restricted ? "badge--gov" : "badge--accent"}`;
  $("govNotice").classList.toggle("hidden", !env.restricted);
}

function applyFeatureNote() {
  const f = featureById($("feature").value);
  // Some features (ACS itself) have no stack port to open.
  $("featureNote").textContent = f ? (f.ports ? `Opens port ${f.ports}. ${f.note}` : f.note) : "";
  // Name the feature on the button and on the View tab's header, so a loaded
  // list can never be mistaken for a different feature's.
  $("loadList").textContent = `View current allow list for ${f ? f.label : "this feature"}`;
  $("listFeature").textContent = f ? f.label : "";
}

function updateConnSummary() {
  const el = $("connSummary");
  const p = profile();
  const env = environmentById(p.envId);
  el.textContent = "";

  if (!p.stack || !env) {
    el.textContent = "not configured";
    return;
  }

  // Boundary in plain text, tier in its own element so staging can carry its
  // neon hue and production can glow.
  el.append(`${p.stack} · ${env.boundary} · `);
  const tier = document.createElement("span");
  tier.textContent = env.tier;
  tier.className = env.staging
    ? `envtag ${env.restricted ? "envtag--staging-gov" : "envtag--staging-com"}`
    : "envtag envtag--prod";
  el.appendChild(tier);
}

function invalidateList() {
  listLoaded = false;
  currentList = [];
  $("ipTabsWrap").classList.add("hidden");
}

/* ------------------------------ persistence ------------------------------ */

async function loadProfile() {
  const bag = await chrome.storage.local.get(PROFILE_KEY);
  const p = bag[PROFILE_KEY];
  if (p) {
    $("env").value = p.envId || "govcloud_il2";
    $("experience").value = p.experience || "classic";
    $("stack").value = p.stack || "";
    $("feature").value = p.feature || "search-api";
  }
  applyEnvChrome();
  applyFeatureNote();
  updateConnSummary();

  const res = await send({ type: "hasToken" });
  if (res && res.hasToken) {
    $("token").placeholder = "•••••••• token in session";
    setStatus($("connStatus"), "Token is loaded for this browser session.", "ok");
    collapseConn(true);
    startTokenTimer(res.expiresAt, res.ttlMs);
    showSplunkExpiry(res.splunkExpiresAt);
  } else if (p && p.stack) {
    setStatus($("connStatus"), "Stack saved. Enter your API token to continue.", "info");
  }
}

async function saveProfile() {
  await chrome.storage.local.set({ [PROFILE_KEY]: profile() });
}

function collapseConn(collapse) {
  $("connBody").classList.toggle("hidden", collapse);
  $("connToggle").querySelector(".panel__chev").textContent = collapse ? "▸" : "▾";
  $("connToggle").setAttribute("aria-expanded", String(!collapse));
}

/* ------------------------------ token countdown ------------------------------ */

// The worker gives the token a fixed lifetime and reports expiresAt; this
// renders the remaining time in the top bar. The alarm in the worker is the
// enforcement — this display is informational and self-corrects by re-asking
// the worker when it reaches zero.
// The fuse turns amber for the last fifth of the token's life, capped at five
// minutes — proportional so a short test lifetime still warns, capped so a
// full-length token is not amber for its final twelve minutes.
const WARN_FRACTION = 0.2;
const WARN_MAX_MS = 5 * 60 * 1000;
// Sub-second ticks so the ring creeps rather than jumping a degree at a time.
const TICK_MS = 250;
let timerInterval = null;

// Splunk's expiry for the saved token, which the local fuse knows nothing
// about. Hidden when the token states no expiry, or is not a decodable JWT.
function showSplunkExpiry(ms) {
  const el = $("splunkExp");
  if (!ms) {
    el.classList.add("hidden");
    el.textContent = "";
    return;
  }
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  const past = ms <= Date.now();
  el.textContent = past ? `Splunk token expired ${stamp}` : `Splunk token expires ${stamp}`;
  el.className = `topbar__exp${past ? " topbar__exp--past" : ""}`;
}

function stopTokenTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
  $("timerRow").classList.add("hidden");
  $("tokenFuse").classList.remove("fuse--warn", "fuse--boom");
  showSplunkExpiry(null);
}

// The fuse burns out: fire the burst, then hide the chip once it has played.
function detonateFuse() {
  const fuse = $("tokenFuse");
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
  fuse.style.setProperty("--fuse-progress", "0");
  fuse.classList.add("fuse--boom");
  setTimeout(() => {
    $("timerRow").classList.add("hidden");
    fuse.classList.remove("fuse--warn", "fuse--boom");
  }, 700);
}

const CLEAR_REASONS = {
  locked: "Screen lock cleared the token. Save a token to continue.",
  expired: "Token self-destructed. Save a token to continue.",
  manual: "Token cleared from session memory.",
};

// The token can die while a view is open — a screen lock is the case the
// countdown cannot predict. Snuff the fuse and say why.
function onTokenCleared(reason) {
  stopTokenTimer();
  $("token").placeholder = "eyJhbGciOi...";
  setStatus($("connStatus"), CLEAR_REASONS[reason] || CLEAR_REASONS.manual, "info");
}

// Belt and braces for the broadcast: re-read the worker's state whenever the
// view regains focus, so a message missed while the worker slept cannot leave
// a stale countdown on screen.
async function syncTokenState() {
  const res = await send({ type: "hasToken" });
  if (!res) return;
  if (!res.hasToken) {
    if (timerInterval) onTokenCleared("locked");
    return;
  }
  if (res.expiresAt) startTokenTimer(res.expiresAt, res.ttlMs);
  showSplunkExpiry(res.splunkExpiresAt);
}

function startTokenTimer(expiresAt, ttlMs) {
  stopTokenTimer();
  if (!expiresAt) return;
  const total = ttlMs || Math.max(expiresAt - Date.now(), 1);
  $("timerRow").classList.remove("hidden");
  const chip = $("tokenTimer");
  const fuse = $("tokenFuse");

  const tick = async () => {
    const left = expiresAt - Date.now();
    if (left <= 0) {
      detonateFuse();
      // Confirm with the worker rather than assuming — lock-clear or a
      // re-save may have changed the state underneath us.
      const res = await send({ type: "hasToken" });
      if (res && res.hasToken && res.expiresAt) {
        startTokenTimer(res.expiresAt, res.ttlMs);
        showSplunkExpiry(res.splunkExpiresAt);
      } else {
        $("token").placeholder = "eyJhbGciOi...";
        setStatus($("connStatus"), "Token self-destructed. Save a token to continue.", "info");
      }
      return;
    }
    const mins = Math.floor(left / 60000);
    const secs = Math.floor((left % 60000) / 1000);
    chip.textContent = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;

    const remaining = Math.min(left / total, 1);
    fuse.style.setProperty("--fuse-progress", remaining.toFixed(4));
    const warn = left <= Math.min(total * WARN_FRACTION, WARN_MAX_MS);
    fuse.classList.toggle("fuse--warn", warn);
    chip.className = `badge ${warn ? "badge--warn" : "badge--accent"}`;
  };

  tick();
  timerInterval = setInterval(tick, TICK_MS);
}

/* ------------------------------ ACS ------------------------------ */

async function callAcs(method, subnets) {
  const p = profile();
  return send({
    type: "acsIpAllowList",
    payload: { ...p, method, subnets },
  });
}

// Render current subnets into a list. `withRemove` draws the per-row × control,
// used by the Delete tab; the View tab renders the same data read-only.
function renderRows(ul, withRemove) {
  ul.innerHTML = "";

  if (!currentList.length) {
    const li = document.createElement("li");
    li.className = "item-list__row item-list__row--empty";
    li.textContent = "No subnets on this allow list.";
    ul.appendChild(li);
    return;
  }

  for (const cidr of currentList) {
    const li = document.createElement("li");
    li.className = "item-list__row";
    const span = document.createElement("span");
    span.className = "item-list__value";
    span.textContent = cidr;
    li.appendChild(span);
    if (withRemove) {
      const btn = document.createElement("button");
      btn.className = "icon-btn";
      btn.title = `Remove ${cidr}`;
      btn.setAttribute("aria-label", `Remove ${cidr}`);
      btn.textContent = "×";
      btn.addEventListener("click", () => confirmRemove([cidr]));
      li.appendChild(btn);
    }
    ul.appendChild(li);
  }
}

function renderList(subnets) {
  currentList = Array.isArray(subnets) ? subnets : [];
  renderRows($("subnetList"), false); // View — read-only
  renderRows($("subnetListDel"), true); // Delete — with × remove
  $("listCount").textContent = `${currentList.length} subnet${currentList.length === 1 ? "" : "s"}`;
  $("ipTabsWrap").classList.remove("hidden");
  listLoaded = true;
}

// statusEl overrides where progress and errors are reported. The default is
// the IP panel's own status line; Save & Test passes the Connection panel's,
// since that is where the operator is looking during a connection test.
async function loadList(silent = false, statusEl) {
  const status = statusEl || $("listStatus");
  const btn = $("loadList");
  btn.disabled = true;
  btn.classList.add("is-loading");
  if (!silent) setStatus(status, "Loading allow list…", "info");

  const res = await callAcs("GET", []);
  btn.disabled = false;
  btn.classList.remove("is-loading");

  if (!res || !res.ok) {
    setStatus(status, res ? res.error : "No response from service worker.", "err");
    invalidateList();
    await refreshLog();
    return false;
  }

  renderList(res.data && res.data.subnets);
  const f = featureById(profile().feature);
  setStatus(status, `Loaded ${f.label} allow list in ${res.ms}ms.`, "ok");
  await refreshLog();
  return true;
}

/* ------------------------------ curl copy ------------------------------ */

// Icon-only copy control: the familiar two-sheets glyph, swapping to a tick on
// success. Inline SVG rather than an icon font or an image, so it inherits
// currentColor and ships with no extra asset.
const ICON_COPY =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="9" y="9" width="13" height="13" rx="2"/>' +
  '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const ICON_TICK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<polyline points="20 6 9 17 4 12"/></svg>';

function paintCopyButton(btn, state) {
  const label = {
    idle: "Copy curl command",
    copied: "Copied, includes your token",
    plain: "Copied. No token in session, so the command carries a placeholder",
    failed: "Could not reach the clipboard. Select the command and copy it manually",
  }[state];
  btn.innerHTML = state === "copied" || state === "plain" ? ICON_TICK : ICON_COPY;
  btn.title = label;
  btn.setAttribute("aria-label", label);
}

function makeCopyButton() {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "copy-btn";
  paintCopyButton(btn, "idle");
  return btn;
}

// Copy a runnable command: the worker swaps the placeholder for the live
// token on its way to the clipboard, so the pasted curl actually works. The
// credential never touches the DOM — what stays on screen is still redacted.
// With no token in session there is nothing to substitute, so the redacted
// form is copied and the button says so.
// The worker owns this: it substitutes the token and writes to the clipboard
// through an offscreen document, so the live credential never reaches this
// page. All the popup learns is whether it worked. If the worker cannot reach
// the clipboard, fall back to copying the redacted command from here, which
// by definition carries only the placeholder.
async function copyCurl(redactedCurl, btn) {
  const res = await send({ type: "copyCurl", curl: redactedCurl });
  if (res && res.ok) {
    paintCopyButton(btn, res.withToken ? "copied" : "plain");
  } else {
    try {
      await navigator.clipboard.writeText(redactedCurl);
      paintCopyButton(btn, "plain");
    } catch (_) {
      paintCopyButton(btn, "failed");
    }
  }
  setTimeout(() => paintCopyButton(btn, "idle"), 1600);
}

/* --------------------------- curl preview --------------------------- */

// Read-path curl. Writes surface their own curl in the confirm modal; this
// covers the GET, which otherwise has no equivalent-command to copy. Uses the
// same placeholder token as buildCurl, so the real token is never exposed.
function renderCurlPreview() {
  const p = profile();
  $("curlBox").textContent = p.stack
    ? buildCurl({ ...p, method: "GET", subnets: [] })
    : "Enter a stack above to see the command.";
}

function refreshCurlIfVisible() {
  if (!$("curlPreview").classList.contains("hidden")) renderCurlPreview();
}

function toggleCurlPreview(show) {
  const preview = $("curlPreview");
  const open = show === undefined ? preview.classList.contains("hidden") : show;
  preview.classList.toggle("hidden", !open);
  $("curlToggle").setAttribute("aria-expanded", String(open));
  $("curlToggle").textContent = open ? "Hide curl" : "Show curl";
  if (open) renderCurlPreview();
}

/* ------------------------------ tabs ------------------------------ */

// role="tablist" + roving tabindex + arrow-key navigation, per the design
// system's accessibility note on the tabs component. Shared by the top-level
// section tabs and the IP allow list's View/Add/Delete tabs.
function wireTabs(pairs) {
  const select = (index) => {
    pairs.forEach(({ tab, pane }, i) => {
      const active = i === index;
      $(tab).classList.toggle("is-active", active);
      $(tab).setAttribute("aria-selected", String(active));
      $(tab).tabIndex = active ? 0 : -1;
      $(pane).classList.toggle("hidden", !active);
    });
  };

  pairs.forEach(({ tab }, i) => {
    $(tab).addEventListener("click", () => select(i));
    $(tab).addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      e.preventDefault();
      const next = (i + (e.key === "ArrowRight" ? 1 : pairs.length - 1)) % pairs.length;
      select(next);
      $(pairs[next].tab).focus();
    });
  });

  return select;
}

/* ------------------------------ modal ------------------------------ */

let confirmHandler = null;

function openModal({ title, warnings, subnets, curl, confirmLabel, danger, challenge, onConfirm }) {
  $("modalTitle").textContent = title;
  const body = $("modalBody");
  body.innerHTML = "";

  for (const w of warnings) {
    const div = document.createElement("div");
    div.className = "callout callout--warn callout--tight";
    div.textContent = w;
    body.appendChild(div);
  }

  const pre = document.createElement("div");
  pre.className = "code-block";
  pre.textContent = subnets.join("\n");
  body.appendChild(pre);

  const head = document.createElement("div");
  head.className = "code-block__head";
  const copy = makeCopyButton();
  copy.addEventListener("click", () => copyCurl(curl, copy));
  head.appendChild(copy);
  body.appendChild(head);

  const box = document.createElement("div");
  box.className = "code-block code-block--wrap";
  box.textContent = curl;
  body.appendChild(box);

  const confirmBtn = $("modalConfirm");
  confirmBtn.textContent = confirmLabel;
  confirmBtn.className = `btn ${danger ? "btn--danger" : "btn--primary"}`;
  confirmHandler = onConfirm;

  // Type-to-confirm challenge for destructive actions: the confirm button
  // stays disabled until the operator types the challenge word exactly.
  confirmBtn.disabled = Boolean(challenge);
  if (challenge) {
    const wrap = document.createElement("label");
    wrap.className = "field";
    wrap.append(`Type ${challenge} to confirm`);
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = challenge;
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("aria-label", `Type ${challenge} to enable the ${confirmLabel} button`);
    input.addEventListener("input", () => {
      confirmBtn.disabled = input.value.trim() !== challenge;
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !confirmBtn.disabled && confirmHandler) confirmHandler();
    });
    wrap.appendChild(input);
    body.appendChild(wrap);
    setTimeout(() => input.focus(), 0);
  }

  $("modal").classList.remove("hidden");
}

function closeModal() {
  $("modal").classList.add("hidden");
  confirmHandler = null;
}

/* ------------------------------ write ops ------------------------------ */

function confirmRemove(subnets) {
  const p = profile();
  const f = featureById(p.feature);
  const { warnings, remainingCount } = assessRemoval({
    feature: p.feature,
    subnets,
    currentList,
  });

  openModal({
    title: `Remove from ${f.label}?`,
    warnings,
    subnets,
    curl: buildCurl({ ...p, method: "DELETE", subnets }),
    confirmLabel: `Remove ${subnets.length}`,
    danger: true,
    challenge: "DELETE",
    onConfirm: async () => {
      closeModal();
      setStatus($("listStatus"), "Removing…", "info");
      const res = await callAcs("DELETE", subnets);
      if (!res.ok) {
        setStatus($("listStatus"), res.error, "err");
        await refreshLog();
        return;
      }
      // Re-GET to confirm the change actually landed.
      const ok = await loadList(true);
      if (ok) {
        setStatus(
          $("listStatus"),
          `Removed ${subnets.length} subnet(s). ${remainingCount} remaining — verified by re-read.`,
          "ok"
        );
      }
    },
  });
}

function confirmAdd() {
  const p = profile();
  const f = featureById(p.feature);
  const { valid, errors, warnings: parseWarnings } = parseSubnetList(
    $("addInput").value,
    p.ipVersion
  );

  // Validation failures block the request entirely — nothing is sent to ACS.
  if (errors.length) {
    setStatus($("listStatus"), errors.join("  •  "), "err");
    return;
  }
  if (!valid.length) {
    setStatus($("listStatus"), "Enter at least one subnet.", "err");
    return;
  }

  const dupes = valid.filter((s) => currentList.includes(s));
  const fresh = valid.filter((s) => !currentList.includes(s));
  if (!fresh.length) {
    setStatus($("listStatus"), "Those subnets are already on the allow list.", "info");
    return;
  }

  const { warnings } = assessAddition({ subnets: fresh, envId: p.envId });
  warnings.unshift(...parseWarnings);
  warnings.push(
    "These passed public-address validation. Confirm they are the correct egress IPs before applying."
  );
  if (dupes.length) {
    warnings.push(`Already present, skipping: ${dupes.join(", ")}`);
  }

  openModal({
    title: `Add to ${f.label}?`,
    warnings,
    subnets: fresh,
    curl: buildCurl({ ...p, method: "POST", subnets: fresh }),
    confirmLabel: `Add ${fresh.length}`,
    danger: false,
    onConfirm: async () => {
      closeModal();
      setStatus($("listStatus"), "Adding…", "info");
      const res = await callAcs("POST", fresh);
      if (!res.ok) {
        setStatus($("listStatus"), res.error, "err");
        await refreshLog();
        return;
      }
      $("addInput").value = "";
      const ok = await loadList(true);
      if (ok) {
        const landed = fresh.filter((s) => currentList.includes(s));
        setStatus(
          $("listStatus"),
          landed.length === fresh.length
            ? `Added ${fresh.length} subnet(s) — verified present on re-read.`
            : `ACS accepted the request, but only ${landed.length}/${fresh.length} appear on re-read. Check the list.`,
          landed.length === fresh.length ? "ok" : "err"
        );
      }
    },
  });
}

/* ------------------------------ activity log ------------------------------ */

async function refreshLog() {
  const res = await send({ type: "getLog" });
  const ul = $("logList");
  ul.innerHTML = "";
  if (!res || !res.log.length) {
    const li = document.createElement("li");
    li.className = "log__row";
    li.textContent = "No requests this session.";
    ul.appendChild(li);
    return;
  }
  const fmtTime = (ts) => {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, "0");
    return (
      `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
      `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    );
  };

  for (const e of res.log) {
    const li = document.createElement("li");
    li.className = "log__row";
    const when = document.createElement("span");
    when.className = "log__time";
    when.textContent = e.ts ? fmtTime(e.ts) : "";
    li.appendChild(when);
    const m = document.createElement("span");
    m.className = "log__method";
    m.textContent = e.method;
    const s = document.createElement("span");
    s.className = `log__status log__status--${
      e.status >= 200 && e.status < 300 ? "ok" : "err"
    }`;
    s.textContent = e.status || "ERR";
    const u = document.createElement("span");
    u.className = "log__url";
    u.textContent = e.url.replace(/^https:\/\/[^/]+/, "");
    const t = document.createElement("span");
    t.textContent = e.ms != null ? `${e.ms}ms` : "";
    li.append(m, s, u, t);
    ul.appendChild(li);

    // Expandable curl equivalent. The token in it is the buildCurl
    // placeholder, never the real bearer token.
    if (e.curl) {
      const toggle = document.createElement("button");
      toggle.className = "link";
      toggle.textContent = "curl";
      toggle.setAttribute("aria-expanded", "false");
      toggle.setAttribute("aria-label", `Show curl for ${e.method} ${e.url}`);
      li.appendChild(toggle);

      const detail = document.createElement("li");
      detail.className = "log__detail hidden";
      const head = document.createElement("div");
      head.className = "code-block__head";
      const copy = makeCopyButton();
      copy.addEventListener("click", () => copyCurl(e.curl, copy));
      head.appendChild(copy);
      const box = document.createElement("div");
      box.className = "code-block code-block--wrap";
      box.textContent = e.curl;
      detail.append(head, box);
      ul.appendChild(detail);

      toggle.addEventListener("click", () => {
        const nowHidden = detail.classList.toggle("hidden");
        toggle.setAttribute("aria-expanded", String(!nowHidden));
      });
    }
  }
}

/* ------------------------------ wiring ------------------------------ */

async function init() {
  $("docUsage").href = ACS_USAGE_URL;
  $("docKcs").href = KCS_ARTICLE_URL;
  $("docCaps").href = ACS_CAPABILITIES_URL;
  $("docShTargeting").href = ACS_SH_TARGETING_URL;

  // Version comes from the manifest at runtime, so the footer can never
  // disagree with the build actually installed.
  const manifest = chrome.runtime.getManifest && chrome.runtime.getManifest();
  const ver = (manifest && manifest.version) || "dev";
  $("version").textContent = /^\d/.test(ver) ? `v${ver}` : ver;

  // Windowed mode: same page, hosted in a resizable window. The token stays
  // in the worker either way — this only changes which surface shows the UI.
  if (new URLSearchParams(location.search).has("windowed")) {
    document.documentElement.classList.add("windowed");
    $("openWindow").classList.add("hidden");
  }
  $("openWindow").addEventListener("click", () => {
    const qs = new URLSearchParams(location.search);
    qs.set("windowed", "1");
    const rel = `popup.html?${qs}`;
    if (chrome.windows && chrome.windows.create) {
      chrome.windows.create({
        url: chrome.runtime.getURL(rel),
        type: "popup",
        width: 680,
        height: 860,
      });
      window.close(); // the action popup has served its purpose
    } else {
      // Dev harness — no chrome.windows; a plain window keeps the layout testable.
      window.open(rel, "sam-windowed", "width=680,height=860");
    }
  });

  await loadProfile();
  await refreshLog();

  $("env").addEventListener("change", async () => {
    applyEnvChrome();
    invalidateList();
    updateConnSummary();
    refreshCurlIfVisible();
    await saveProfile();
  });

  $("feature").addEventListener("change", async () => {
    applyFeatureNote();
    invalidateList();
    refreshCurlIfVisible();
    await saveProfile();
  });

  $("stack").addEventListener("input", () => {
    invalidateList();
    updateConnSummary();
    refreshCurlIfVisible();
  });

  $("connToggle").addEventListener("click", () =>
    collapseConn(!$("connBody").classList.contains("hidden"))
  );

  $("logToggle").addEventListener("click", async () => {
    const hidden = $("logBody").classList.toggle("hidden");
    $("logToggle").querySelector(".panel__chev").textContent = hidden ? "▸" : "▾";
    if (!hidden) await refreshLog();
  });

  $("saveConn").addEventListener("click", async () => {
    const token = $("token").value.trim();
    if (!profile().stack) {
      setStatus($("connStatus"), "Enter a stack name.", "err");
      return;
    }
    if (token) {
      const saved = await send({ type: "saveToken", token });
      if (saved && saved.ok === false) {
        setStatus($("connStatus"), saved.error || "Could not save the token.", "err");
        return;
      }
      $("token").value = "";
      $("token").placeholder = "•••••••• token in session";
      const status = await send({ type: "hasToken" });
      if (status && status.expiresAt) startTokenTimer(status.expiresAt, status.ttlMs);
      if (status) showSplunkExpiry(status.splunkExpiresAt);
    } else {
      const has = await send({ type: "hasToken" });
      if (!has.hasToken) {
        setStatus($("connStatus"), "Enter an API token.", "err");
        return;
      }
    }
    await saveProfile();
    updateConnSummary();
    setStatus($("connStatus"), "Testing connection…", "info");
    const ok = await loadList(true, $("connStatus"));
    if (ok) collapseConn(true);
  });

  $("clearToken").addEventListener("click", async () => {
    await send({ type: "clearToken" });
    $("token").value = "";
    $("token").placeholder = "eyJhbGciOi...";
    invalidateList();
    stopTokenTimer();
    setStatus($("connStatus"), "Token cleared from session memory.", "info");
  });

  wireTabs([
    { tab: "tabManage", pane: "paneManage" },
    { tab: "tabHowTo", pane: "paneHowTo" },
  ]);
  wireTabs([
    { tab: "tabView", pane: "paneView" },
    { tab: "tabAdd", pane: "paneAdd" },
    { tab: "tabDelete", pane: "paneDelete" },
  ]);

  const openAbout = (show) => $("aboutModal").classList.toggle("hidden", !show);
  $("aboutVersion").textContent = `Version: ${$("version").textContent}`;
  $("aboutRepo").href = REPO_URL;
  $("aboutBtn").addEventListener("click", () => openAbout(true));
  $("aboutClose").addEventListener("click", () => openAbout(false));
  $("aboutModal").addEventListener("click", (e) => {
    if (e.target === $("aboutModal")) openAbout(false);
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "tokenCleared") onTokenCleared(msg.reason);
  });
  // A windowed view stays open across a lock, so re-verify on focus.
  window.addEventListener("focus", syncTokenState);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) syncTokenState();
  });

  $("curlToggle").addEventListener("click", () => toggleCurlPreview());
  paintCopyButton($("curlCopy"), "idle");
  $("curlCopy").addEventListener("click", () =>
    copyCurl($("curlBox").textContent, $("curlCopy"))
  );

  $("loadList").addEventListener("click", () => loadList());
  $("refresh").addEventListener("click", () => loadList());
  $("addBtn").addEventListener("click", confirmAdd);
  $("modalCancel").addEventListener("click", closeModal);
  $("modalClose").addEventListener("click", closeModal);
  $("modalConfirm").addEventListener("click", () => confirmHandler && confirmHandler());
  $("modal").addEventListener("click", (e) => {
    if (e.target === $("modal")) closeModal();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("modal").classList.contains("hidden")) closeModal();
    else if (!$("aboutModal").classList.contains("hidden")) openAbout(false);
  });
}

// This file loads as a module, so it is deferred and DOMContentLoaded has
// usually already fired by the time it runs. Guard on readyState instead of
// listening unconditionally — otherwise init never executes.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
