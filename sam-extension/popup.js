import {
  ENVIRONMENTS,
  FEATURES,
  featureById,
  parseSubnetList,
  assessRemoval,
  assessAddition,
  buildCurl,
  PORT_DOC_URL,
  ACS_USAGE_URL,
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
    ipVersion: $("ipVersion").value,
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
  $("featureNote").textContent = f ? `Opens port ${f.ports}. ${f.note}` : "";
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
    $("experience").value = p.experience || "victoria";
    $("stack").value = p.stack || "";
    $("feature").value = p.feature || "search-api";
    $("ipVersion").value = p.ipVersion || "v4";
  }
  applyEnvChrome();
  applyFeatureNote();
  updateConnSummary();

  const res = await send({ type: "hasToken" });
  if (res && res.hasToken) {
    $("token").placeholder = "•••••••• token in session";
    setStatus($("connStatus"), "Token is loaded for this browser session.", "ok");
    collapseConn(true);
  } else if (p && p.stack) {
    setStatus($("connStatus"), "Stack saved. Enter your API token to continue.", "info");
  } else {
    // First run — open the token instructions rather than making them hunt.
    toggleTokenHelp(true);
  }
}

async function saveProfile() {
  await chrome.storage.local.set({ [PROFILE_KEY]: profile() });
}

function toggleTokenHelp(show) {
  const help = $("tokenHelp");
  const open = show === undefined ? help.classList.contains("hidden") : show;
  help.classList.toggle("hidden", !open);
  $("tokenHelpToggle").setAttribute("aria-expanded", String(open));
  $("tokenHelpToggle").textContent = open ? "× Hide" : "? How do I get one";
}

function collapseConn(collapse) {
  $("connBody").classList.toggle("hidden", collapse);
  $("connToggle").querySelector(".panel__chev").textContent = collapse ? "▸" : "▾";
  $("connToggle").setAttribute("aria-expanded", String(!collapse));
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

async function loadList(silent = false) {
  const btn = $("loadList");
  btn.disabled = true;
  btn.classList.add("is-loading");
  if (!silent) setStatus($("connStatus"), "Loading allow list…", "info");

  const res = await callAcs("GET", []);
  btn.disabled = false;
  btn.classList.remove("is-loading");

  if (!res || !res.ok) {
    setStatus($("connStatus"), res ? res.error : "No response from service worker.", "err");
    invalidateList();
    await refreshLog();
    return false;
  }

  renderList(res.data && res.data.subnets);
  const f = featureById(profile().feature);
  setStatus($("connStatus"), `Loaded ${f.label} allow list in ${res.ms}ms.`, "ok");
  await refreshLog();
  return true;
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

function openModal({ title, warnings, subnets, curl, confirmLabel, danger, onConfirm }) {
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
  label.textContent = "Equivalent curl";
  const copy = document.createElement("button");
  copy.className = "link";
  copy.textContent = "Copy";
  copy.addEventListener("click", async () => {
    await navigator.clipboard.writeText(curl);
    copy.textContent = "Copied";
    setTimeout(() => (copy.textContent = "Copy"), 1400);
  });
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
    onConfirm: async () => {
      closeModal();
      setStatus($("connStatus"), "Removing…", "info");
      const res = await callAcs("DELETE", subnets);
      if (!res.ok) {
        setStatus($("connStatus"), res.error, "err");
        await refreshLog();
        return;
      }
      // Re-GET to confirm the change actually landed.
      const ok = await loadList(true);
      if (ok) {
        setStatus(
          $("connStatus"),
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
    setStatus($("connStatus"), errors.join("  •  "), "err");
    return;
  }
  if (!valid.length) {
    setStatus($("connStatus"), "Enter at least one subnet.", "err");
    return;
  }

  const dupes = valid.filter((s) => currentList.includes(s));
  const fresh = valid.filter((s) => !currentList.includes(s));
  if (!fresh.length) {
    setStatus($("connStatus"), "Those subnets are already on the allow list.", "info");
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
      setStatus($("connStatus"), "Adding…", "info");
      const res = await callAcs("POST", fresh);
      if (!res.ok) {
        setStatus($("connStatus"), res.error, "err");
        await refreshLog();
        return;
      }
      $("addInput").value = "";
      const ok = await loadList(true);
      if (ok) {
        const landed = fresh.filter((s) => currentList.includes(s));
        setStatus(
          $("connStatus"),
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
  for (const e of res.log) {
    const li = document.createElement("li");
    li.className = "log__row";
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
  }
}

/* ------------------------------ wiring ------------------------------ */

async function init() {
  $("docPorts").href = PORT_DOC_URL;
  $("docUsage").href = ACS_USAGE_URL;

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

  $("ipVersion").addEventListener("change", async () => {
    invalidateList();
    $("addInput").placeholder =
      $("ipVersion").value === "v6" ? "2600:1f14:a3c::/48" : "52.24.108.7/32, 34.210.15.0/24";
    refreshCurlIfVisible();
    await saveProfile();
  });

  $("stack").addEventListener("input", () => {
    invalidateList();
    updateConnSummary();
    refreshCurlIfVisible();
  });

  $("tokenHelpToggle").addEventListener("click", () => toggleTokenHelp());

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
      toggleTokenHelp(false);
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
    const ok = await loadList(true);
    if (ok) collapseConn(true);
  });

  $("clearToken").addEventListener("click", async () => {
    await send({ type: "clearToken" });
    $("token").value = "";
    $("token").placeholder = "eyJhbGciOi...";
    invalidateList();
    setStatus($("connStatus"), "Token cleared from session memory.", "info");
  });

  wireTabs();

  $("curlToggle").addEventListener("click", () => toggleCurlPreview());
  $("curlCopy").addEventListener("click", async () => {
    await navigator.clipboard.writeText($("curlBox").textContent);
    $("curlCopy").textContent = "Copied";
    setTimeout(() => ($("curlCopy").textContent = "Copy"), 1400);
  });

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
