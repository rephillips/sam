/**
 * Style guide — renders token documentation from the live stylesheet.
 *
 * Nothing here is hardcoded from the token file. Every value is read back out
 * of the cascade at runtime, so the guide cannot drift from the system: if a
 * token changes, this page changes with it, and the contrast figures below are
 * recomputed rather than copied from a spreadsheet somebody forgot to update.
 */

const root = document.documentElement;

/* ── token resolution ────────────────────────────────────────────────────── */

function raw(name) {
  return getComputedStyle(root).getPropertyValue(name).trim();
}

/** Follow var() chains until an actual colour literal falls out. */
function resolve(value, depth = 0) {
  if (depth > 10) return value;
  const v = value.trim();
  const m = v.match(/^var\((--[a-z0-9-]+)\)$/i);
  return m ? resolve(raw(m[1]), depth + 1) : v;
}

const token = (name) => resolve(raw(name));

/* ── colour maths (mirrors tools/contrast.mjs) ───────────────────────────── */

function parse(color) {
  const c = color.trim();
  if (c.startsWith("#")) {
    let h = c.slice(1);
    if (h.length === 3) h = h.split("").map((x) => x + x).join("");
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: 1,
    };
  }
  const n = c.match(/-?[\d.]+/g);
  if (!n) return { r: 0, g: 0, b: 0, a: 1 };
  return { r: +n[0], g: +n[1], b: +n[2], a: n[3] === undefined ? 1 : +n[3] };
}

const over = (fg, bg) => ({
  r: Math.round(fg.r * fg.a + bg.r * (1 - fg.a)),
  g: Math.round(fg.g * fg.a + bg.g * (1 - fg.a)),
  b: Math.round(fg.b * fg.a + bg.b * (1 - fg.a)),
  a: 1,
});

function luminance({ r, g, b }) {
  const f = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function ratio(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/* ── swatches ────────────────────────────────────────────────────────────── */

function renderSwatches(containerId, items) {
  const el = document.getElementById(containerId);
  if (!el) return;

  el.innerHTML = items
    .map(({ fg, bg, base, min = 4.5, label }) => {
      const bgResolved = parse(token(bg));
      const baseResolved = base ? parse(token(base)) : null;
      const bgFinal = baseResolved ? over(bgResolved, baseResolved) : bgResolved;
      const fgFinal = over(parse(token(fg)), bgFinal);
      const r = ratio(fgFinal, bgFinal);
      const pass = r >= min;

      return `
        <div class="swatch">
          <div class="swatch__chip" style="background:${
            base ? `${token(base)}` : "transparent"
          }">
            <div style="background:${token(bg)};padding:var(--space-5);border-radius:var(--radius-sm)">
              <span style="color:${token(fg)}">${label}</span>
            </div>
          </div>
          <div class="swatch__meta">
            <span>${fg}</span>
            <span class="swatch__ratio swatch__ratio--${pass ? "pass" : "fail"}">
              ${r.toFixed(2)}:1 ${pass ? "AA" : "FAIL"}
            </span>
          </div>
        </div>`;
    })
    .join("");
}

renderSwatches("textSwatches", [
  { label: "Body text", fg: "--text", bg: "--bg" },
  { label: "Body text on panel", fg: "--text", bg: "--panel" },
  { label: "Secondary text", fg: "--muted", bg: "--panel" },
  { label: "Hint text", fg: "--text-faint", bg: "--panel" },
  { label: "Link / action", fg: "--accent", bg: "--panel" },
  { label: "Success", fg: "--ok-fg", bg: "--panel" },
  { label: "Error", fg: "--danger-fg", bg: "--panel" },
]);

renderSwatches("intentSwatches", [
  { label: "Primary button", fg: "--accent-soft-fg", bg: "--accent-soft", base: "--panel" },
  { label: "Danger button", fg: "--danger-fg", bg: "--danger-soft", base: "--panel" },
  { label: "Info callout", fg: "--text", bg: "--info-bg", base: "--panel" },
  { label: "Warning callout", fg: "--warn-fg", bg: "--warn-bg", base: "--panel" },
  { label: "Danger callout", fg: "--danger-fg", bg: "--danger-bg", base: "--panel" },
  { label: "GovCloud notice", fg: "--gov-fg", bg: "--gov-bg", base: "--bg" },
  { label: "GovCloud badge", fg: "--gov-badge-fg", bg: "--gov-bg", base: "--panel" },
]);

renderSwatches("surfaceSwatches", [
  { label: "App background", fg: "--text", bg: "--bg" },
  { label: "Panel", fg: "--text", bg: "--panel" },
  { label: "Raised panel", fg: "--text", bg: "--panel-2" },
  { label: "Inset / code", fg: "--text", bg: "--surface-code" },
  { label: "Control border", fg: "--line-strong", bg: "--panel", min: 3 },
  { label: "Divider", fg: "--line", bg: "--panel", min: 1 },
]);

/* ── scales ──────────────────────────────────────────────────────────────── */

const TYPE = [
  ["--fs-xl", "App title"],
  ["--fs-lg", "Modal title"],
  ["--fs-md", "Body, inputs, buttons"],
  ["--fs-sm", "Labels, status, list rows"],
  ["--fs-xs", "Hints, log, footer"],
  ["--fs-2xs", "Badges, micro labels"],
];

document.getElementById("typeScale").innerHTML = TYPE.map(
  ([name, use]) => `
    <div class="scale-row">
      <span class="scale-row__token">${name}</span>
      <span class="scale-row__value">${token(name)}</span>
      <span style="font-size:${token(name)}">${use}</span>
    </div>`
).join("");

const SPACE = Array.from({ length: 10 }, (_, i) => `--space-${i + 1}`).filter(
  (n) => token(n)
);

document.getElementById("spaceScale").innerHTML = SPACE.map(
  (name) => `
    <div class="scale-row">
      <span class="scale-row__token">${name}</span>
      <span class="scale-row__value">${token(name)}</span>
      <span class="scale-row__bar" style="width:${token(name)}"></span>
    </div>`
).join("");

document.getElementById("radiusScale").innerHTML = [
  "--radius-xs",
  "--radius-sm",
  "--radius-md",
  "--radius-lg",
]
  .map(
    (name) => `
      <div class="guide__cell">
        <div class="guide__box" style="border-radius:${token(name)};padding:var(--space-8)">
          ${token(name)}
        </div>
        <span>${name}</span>
      </div>`
  )
  .join("");

/* ── token count ─────────────────────────────────────────────────────────── */

// The standalone snapshot has no separate tokens.css to fetch, so the builder
// stamps the count in directly.
if (typeof window.__SAM_TOKEN_COUNT__ === "number") {
  document.getElementById("tokenCount").textContent = `${window.__SAM_TOKEN_COUNT__} TOKENS`;
} else {
  fetch("tokens.css")
    .then((r) => r.text())
    .then((css) => {
      const count = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1])).size;
      document.getElementById("tokenCount").textContent = `${count} TOKENS`;
    })
    .catch(() => {
      document.getElementById("tokenCount").textContent = "TOKENS";
    });
}
