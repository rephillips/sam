#!/usr/bin/env node
/**
 * Design system linter.
 *
 *   node tools/lint-system.mjs
 *
 * A design system decays one hardcoded hex at a time. These checks make that
 * decay a build failure rather than something noticed six months later:
 *
 *   1. No raw colours or durations outside tokens.css.
 *   2. Every var(--token) used anywhere is actually defined.
 *   3. Every class used in markup or scripts has a rule somewhere.
 *   4. Every CSS class defined is actually used (dead-rule detection).
 *   5. Every element id referenced by popup.js exists in popup.html.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const TOKENS = "design/tokens.css";
const COMPONENTS = "design/components.css";
const SHELL = "popup.css";
const HTML = "popup.html";
const JS = "popup.js";
const STYLEGUIDE = "design/styleguide.html";

const problems = [];
const notes = [];
const fail = (msg) => problems.push(msg);

const tokensCss = read(TOKENS);
const componentsCss = read(COMPONENTS);
const shellCss = read(SHELL);
const html = read(HTML);
const js = read(JS);
const styleguide = fs.existsSync(path.join(ROOT, STYLEGUIDE)) ? read(STYLEGUIDE) : "";

const allCss = [componentsCss, shellCss].join("\n");

/* ── 1. no raw values outside the token layer ───────────────────────────── */
{
  // Strip comments so documentation prose can mention hex values freely.
  const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const [name, css] of [
    [COMPONENTS, strip(componentsCss)],
    [SHELL, strip(shellCss)],
  ]) {
    for (const m of css.matchAll(/#[0-9a-f]{3,8}\b/gi)) {
      fail(`${name}: raw colour "${m[0]}" — move it to ${TOKENS}`);
    }
    for (const m of css.matchAll(/\brgba?\([^)]*\)/gi)) {
      fail(`${name}: raw colour "${m[0]}" — move it to ${TOKENS}`);
    }
    // Durations belong to the motion scale so reduced-motion can zero them.
    for (const m of css.matchAll(/(?:transition|animation)(?:-duration)?\s*:[^;]*?(\d+m?s)/gi)) {
      if (!m[0].includes("var(--dur")) {
        fail(`${name}: raw duration "${m[1]}" — use a --dur-* token`);
      }
    }
  }
}

/* ── 2. every referenced token exists ──────────────────────────────────── */
{
  const defined = new Set([...tokensCss.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]));
  const sources = [
    [COMPONENTS, componentsCss],
    [SHELL, shellCss],
    [TOKENS, tokensCss],
    [HTML, html],
  ];
  if (styleguide) sources.push([STYLEGUIDE, styleguide]);

  for (const [name, src] of sources) {
    for (const m of src.matchAll(/var\((--[a-z0-9-]+)/gi)) {
      if (!defined.has(m[1])) fail(`${name}: undefined token ${m[1]}`);
    }
  }
  notes.push(`${defined.size} tokens defined`);
}

/* ── 3 & 4. class usage vs definition ──────────────────────────────────── */
{
  const definedClasses = new Set(
    [...allCss.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/\.([a-z][a-z0-9_-]*)/gi)].map(
      (m) => m[1]
    )
  );

  const usedClasses = new Set();
  const dynamicPrefixes = [];

  for (const m of html.matchAll(/class="([^"]+)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c) usedClasses.add(c);
  }

  // Plain string assignments.
  for (const m of js.matchAll(/className\s*=\s*(["'])([^"']*)\1/g)) {
    for (const c of m[2].split(/\s+/)) if (c) usedClasses.add(c);
  }

  // Template literals. Substitutions are replaced by markers so a class built
  // as `status--${kind}` is recognised as a dynamic modifier rather than
  // shredded into fragments of the surrounding expression.
  const PLACEHOLDER = /\$\{[\s\S]*?\}/g;
  for (const m of js.matchAll(/className\s*=\s*`([\s\S]*?)`/g)) {
    const raw = m[1];
    const subs = raw.match(PLACEHOLDER) || [];
    let i = 0;
    const marked = raw.replace(PLACEHOLDER, () => `%%${i++}%%`);

    for (const part of marked.split(/\s+/)) {
      if (!part) continue;
      const hit = part.match(/^([a-z0-9_-]*)%%(\d+)%%$/i);
      if (!hit) {
        if (!part.includes("%%")) usedClasses.add(part);
        continue;
      }
      const base = hit[1];
      const expr = subs[Number(hit[2])] || "";
      // A ternary of string literals enumerates the real class names.
      const alts = [...expr.matchAll(/["']([a-z][a-z0-9_-]*)["']/gi)].map((x) => x[1]);
      if (alts.length) {
        for (const a of alts) usedClasses.add(base + a);
      } else if (base.endsWith("--")) {
        dynamicPrefixes.push(base);
      } else if (base) {
        usedClasses.add(base);
      }
    }
  }

  for (const m of js.matchAll(/classList\.(?:add|remove|toggle)\(\s*["']([^"']+)["']/g)) {
    usedClasses.add(m[1]);
  }
  for (const m of js.matchAll(/querySelector\(\s*["']\.([a-z][a-z0-9_-]*)/gi)) {
    usedClasses.add(m[1]);
  }

  for (const c of usedClasses) {
    if (!definedClasses.has(c)) fail(`${HTML}/${JS}: class "${c}" has no CSS rule`);
  }

  // Dead rules: defined but never referenced anywhere, including the guide.
  const guideClasses = new Set();
  for (const m of styleguide.matchAll(/class="([^"]+)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c) guideClasses.add(c);
  }
  const dead = [...definedClasses].filter((c) => {
    if (usedClasses.has(c) || guideClasses.has(c)) return false;
    // A dynamically-composed modifier counts as used.
    return !dynamicPrefixes.some((p) => c.startsWith(p));
  });
  if (dead.length) {
    notes.push(`${dead.length} class(es) defined but unused: ${dead.sort().join(", ")}`);
  }
  notes.push(`${definedClasses.size} classes defined, ${usedClasses.size} used in the popup`);
}

/* ── 5. ids referenced by the script exist in the markup ───────────────── */
{
  const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const jsIds = new Set([...js.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]));
  for (const id of jsIds) if (!htmlIds.has(id)) fail(`${JS}: #${id} not present in ${HTML}`);
  for (const id of htmlIds) {
    if (!jsIds.has(id) && !html.includes(`aria-controls="${id}"`) && !html.includes(`for="${id}"`)) {
      notes.push(`${HTML}: #${id} is never referenced by ${JS}`);
    }
  }
}

/* ── report ────────────────────────────────────────────────────────────── */
console.log("\nDesign system lint\n");
for (const n of notes) console.log(`  note  ${n}`);
if (notes.length) console.log("");
for (const p of problems) console.log(`  FAIL  ${p}`);

console.log(
  problems.length
    ? `\n${problems.length} problem(s).\n`
    : "\nNo problems. Tokens, classes, and ids are all consistent.\n"
);
process.exit(problems.length ? 1 : 0);
