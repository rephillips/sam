import {
  ENVIRONMENTS,
  FEATURES,
  featureById,
  parseSubnetList,
  assessRemoval,
  assessAddition,
  buildCurl,
  ACS_USAGE_URL,
  KCS_ARTICLE_URL,
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
  const env = ENVIRONMENTS[$("env").value];
  const badge = $("envBadge");
  badge.textContent = env.badge;
  badge.className = `badge ${env.restricted ? "badge--gov" : "badge--accent"}`;
  $("govNotice").classList.toggle("hidden", !env.restricted);
}

function applyFeatureNote() {
  const f = featureById($("feature").value);
  // Some features (ACS itself) have no stack port to open.
  $("featureNote").textContent = f ? (f.ports ? `Opens port ${f.ports}. ${f.note}` : f.note) : "";
}

function updateConnSummary() {
  const p = profile();
  $("connSummary").textContent = p.stack
    ? `${p.stack} · ${ENVIRONMENTS[p.envId].badge}`
    : "not configured";
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
  } else if (p && p.stack) {
    setStatus($("connStatus"), "Stack saved. Enter your API token to continue.", "info");
  } else {
    // First run — point at the token help rather than making them hunt.
    setStatus($("connStatus"), "Hover ⓘ next to API Token for how to generate one.", "info");
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

function stopTokenTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
  $("timerRow").classList.add("hidden");
  $("tokenFuse").classList.remove("fuse--warn", "fuse--boom");
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

// Copy a runnable command: the worker swaps the placeholder for the live
// token on its way to the clipboard, so the pasted curl actually works. The
// credential never touches the DOM — what stays on screen is still redacted.
// With no token in session there is nothing to substitute, so the redacted
// form is copied and the button says so.
async function copyCurl(redactedCurl, btn) {
  const res = await send({ type: "curlWithToken", curl: redactedCurl });
  const runnable = res && res.ok && res.curl;
  await navigator.clipboard.writeText(runnable ? res.curl : redactedCurl);
  btn.textContent = runnable ? "Copied" : "Copied (no token)";
  setTimeout(() => (btn.textContent = "Copy"), 1600);
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

const TABS = [
  { tab: "tabView", pane: "paneView" },
  { tab: "tabAdd", pane: "paneAdd" },
  { tab: "tabDelete", pane: "paneDelete" },
];

function selectTab(index) {
  TABS.forEach(({ tab, pane }, i) => {
    const active = i === index;
    $(tab).classList.toggle("is-active", active);
    $(tab).setAttribute("aria-selected", String(active));
    $(tab).tabIndex = active ? 0 : -1;
    $(pane).classList.toggle("hidden", !active);
  });
}

// role="tablist" + roving tabindex + arrow-key navigation, per the design
// system's accessibility note on the tabs component.
function wireTabs() {
  TABS.forEach(({ tab }, i) => {
    $(tab).addEventListener("click", () => selectTab(i));
    $(tab).addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      e.preventDefault();
      const next = (i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length;
      selectTab(next);
      $(TABS[next].tab).focus();
    });
  });
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
  const label = document.createElement("span");
  label.textContent = "Equivalent curl · Copy includes your token";
  const copy = document.createElement("button");
  copy.className = "link";
  copy.textContent = "Copy";
  copy.addEventListener("click", () => copyCurl(curl, copy));
  head.append(label, copy);
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
      const label = document.createElement("span");
      label.textContent = "Equivalent curl · Copy includes your token";
      const copy = document.createElement("button");
      copy.className = "link";
      copy.textContent = "Copy";
      copy.addEventListener("click", () => copyCurl(e.curl, copy));
      head.append(label, copy);
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

  wireTabs();

  $("curlToggle").addEventListener("click", () => toggleCurlPreview());
  $("curlCopy").addEventListener("click", () =>
    copyCurl($("curlBox").textContent, $("curlCopy"))
  );

  $("loadList").addEventListener("click", () => loadList());
  $("refresh").addEventListener("click", () => loadList());
  $("addBtn").addEventListener("click", confirmAdd);
  $("modalCancel").addEventListener("click", closeModal);
  $("modalConfirm").addEventListener("click", () => confirmHandler && confirmHandler());
  $("modal").addEventListener("click", (e) => {
    if (e.target === $("modal")) closeModal();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("modal").classList.contains("hidden")) closeModal();
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
