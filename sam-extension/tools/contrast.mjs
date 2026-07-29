#!/usr/bin/env node
/**
 * WCAG contrast audit for the SAM design system.
 *
 * Reads CSS custom properties out of a stylesheet's :root block, resolves the
 * pairs declared below, and checks each against its WCAG 2.1 threshold.
 *
 *   node tools/contrast.mjs                    # audits design/tokens.css
 *   node tools/contrast.mjs popup.css          # audits any other file
 *
 * Pair syntax:
 *   "var(--text)"                     -> token lookup
 *   "#ecc57a"                         -> literal
 *   "rgba(217,164,65,0.12) over var(--bg)"  -> alpha composite before compare
 *
 * Exits non-zero if any pair fails, so this is CI-able.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2] || "design/tokens.css";

// ── colour maths ──────────────────────────────────────────────────────────
function parseHex(hex) {
  let h = hex.replace("#", "").trim();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
    a: 1,
  };
}

function parseRgba(str) {
  const nums = str.match(/-?[\d.]+/g).map(Number);
  return { r: nums[0], g: nums[1], b: nums[2], a: nums[3] === undefined ? 1 : nums[3] };
}

function composite(fg, bg) {
  return {
    r: Math.round(fg.r * fg.a + bg.r * (1 - fg.a)),
    g: Math.round(fg.g * fg.a + bg.g * (1 - fg.a)),
    b: Math.round(fg.b * fg.a + bg.b * (1 - fg.a)),
    a: 1,
  };
}

function relLuminance({ r, g, b }) {
  const f = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function ratio(fg, bg) {
  const a = relLuminance(fg);
  const b = relLuminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

// ── token resolution ──────────────────────────────────────────────────────
function readTokens(file) {
  const css = fs.readFileSync(path.join(ROOT, file), "utf8");
  const tokens = {};
  for (const m of css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    tokens[m[1]] = m[2].trim();
  }
  return tokens;
}

function resolve(expr, tokens, depth = 0) {
  if (depth > 10) throw new Error(`token cycle resolving "${expr}"`);
  const s = expr.trim();

  const over = s.match(/^(.+?)\s+over\s+(.+)$/i);
  if (over) {
    return composite(resolve(over[1], tokens, depth + 1), resolve(over[2], tokens, depth + 1));
  }

  const v = s.match(/^var\((--[a-z0-9-]+)\)$/i);
  if (v) {
    const raw = tokens[v[1]];
    if (!raw) throw new Error(`unknown token ${v[1]}`);
    return resolve(raw, tokens, depth + 1);
  }

  if (s.startsWith("#")) return parseHex(s);
  if (s.startsWith("rgb")) return parseRgba(s);
  throw new Error(`cannot parse colour "${s}"`);
}

// ── the pairs we promise to hold ──────────────────────────────────────────
// AA normal text = 4.5, AA large/bold >=18.66px = 3.0, UI boundaries = 3.0.
const PAIRS = [
  ["body text on app background",      "var(--text)",      "var(--bg)",       4.5],
  ["body text on panel",               "var(--text)",      "var(--panel)",    4.5],
  ["body text on raised panel",        "var(--text)",      "var(--panel-2)",  4.5],
  ["muted text on app background",     "var(--muted)",     "var(--bg)",       4.5],
  ["muted text on panel",              "var(--muted)",     "var(--panel)",    4.5],
  ["hint text on app background",      "var(--text-faint)","var(--bg)",       4.5],
  ["hint text on panel",               "var(--text-faint)","var(--panel)",    4.5],
  ["link / ghost action on panel",     "var(--accent)",    "var(--panel)",    4.5],
  ["success status on panel",          "var(--ok-fg)",     "var(--panel)",    4.5],
  ["error status on panel",            "var(--danger-fg)", "var(--panel)",    4.5],
  // Tonal buttons: the label sits on a translucent fill over the panel it
  // lives on (the Load button's panel body, the confirm modal's card), so the
  // effective background is the composite, not the raw hue.
  ["primary button label",             "var(--accent-soft-fg)", "var(--accent-soft) over var(--panel)", 4.5],
  ["danger button label",              "var(--danger-fg)", "var(--danger-soft) over var(--panel)", 4.5],
  ["primary button border",            "var(--accent-soft-line) over var(--panel)", "var(--panel)", 3.0],
  ["danger button border",             "var(--danger-soft-line) over var(--panel)", "var(--panel)", 3.0],
  ["warning text on warning surface",  "var(--warn-fg)",   "var(--warn-bg) over var(--panel)", 4.5],
  ["gov badge label",                  "var(--gov-fg)",    "var(--gov-bg) over var(--panel)",  4.5],
  ["gov notice text",                  "var(--gov-fg)",    "var(--gov-bg) over var(--bg)",     4.5],
  ["info callout text",                "var(--text)",      "var(--info-bg) over var(--panel)", 4.5],
  ["info callout title",               "var(--accent-hi)", "var(--info-bg) over var(--panel)", 4.5],
  ["code surface text",                "var(--text)",      "var(--surface-code)",              4.5],
  // WCAG 1.4.11 applies to boundaries a user needs in order to identify a
  // control. `--line` only separates regions, so it is exempt; `--line-strong`
  // outlines inputs and must clear 3:1 on every surface it can land on.
  ["control border vs panel",          "var(--line-strong)", "var(--panel)",   3.0],
  ["control border vs raised panel",   "var(--line-strong)", "var(--panel-2)", 3.0],
  ["control border vs inset surface",  "var(--line-strong)", "var(--surface-input)", 3.0],
  ["focus ring vs panel",              "var(--focus)",     "var(--panel)",    3.0],
  ["focus ring vs inset surface",      "var(--focus)",     "var(--surface-input)", 3.0],
];

const tokens = readTokens(target);
let failed = 0;

console.log(`\nWCAG contrast audit — ${target}\n`);
console.log("  ratio   min   status  pair");
console.log("  ─────   ───   ──────  ────────────────────────────────────────");

for (const [label, fgExpr, bgExpr, min] of PAIRS) {
  let line;
  try {
    const fg = resolve(fgExpr, tokens);
    const bg = resolve(bgExpr, tokens);
    const r = ratio(fg, bg);
    const pass = r >= min;
    if (!pass) failed++;
    line = `  ${r.toFixed(2).padStart(5)}  ${min.toFixed(1).padStart(4)}   ${
      pass ? "PASS  " : "FAIL  "
    }  ${label}`;
  } catch (err) {
    failed++;
    line = `      —     —   ERROR   ${label} (${err.message})`;
  }
  console.log(line);
}

console.log(
  `\n${PAIRS.length - failed}/${PAIRS.length} pairs pass.${
    failed ? `  ${failed} FAILING.\n` : "  All good.\n"
  }`
);

process.exit(failed ? 1 : 0);
