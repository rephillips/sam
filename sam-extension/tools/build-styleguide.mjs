#!/usr/bin/env node
/**
 * Build a standalone, single-file copy of the style guide.
 *
 *   node tools/build-styleguide.mjs [outFile]
 *
 * The served version at /design/styleguide.html is the living one — it links
 * the real stylesheets, so it cannot drift. This produces a snapshot with
 * everything inlined, for sharing with someone who is not running the dev
 * server. It is a photograph of the system, not the system.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.resolve(process.argv[2] || path.join(ROOT, "design/styleguide.standalone.html"));
const read = (p) => fs.readFileSync(path.join(ROOT, "design", p), "utf8");

const tokens = read("tokens.css");
const components = read("components.css");
const guide = read("styleguide.css");
const script = read("styleguide.js");
let html = read("styleguide.html");

const tokenCount = new Set([...tokens.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1])).size;

html = html
  .replace('<link rel="stylesheet" href="tokens.css" />', `<style>\n${tokens}\n</style>`)
  .replace('<link rel="stylesheet" href="components.css" />', `<style>\n${components}\n</style>`)
  .replace('<link rel="stylesheet" href="styleguide.css" />', `<style>\n${guide}\n</style>`)
  .replace(
    '<script type="module" src="styleguide.js"></script>',
    `<script>window.__SAM_TOKEN_COUNT__ = ${tokenCount};</script>\n<script type="module">\n${script}\n</script>`
  )
  .replace('<a class="footer__link" href="../popup.html">Open the popup</a>', "<span>Standalone snapshot</span>");

if (html.includes("<link rel=\"stylesheet\"") || html.includes('src="styleguide.js"')) {
  console.error("\n  Inlining missed something — check the tag text in styleguide.html\n");
  process.exit(1);
}

fs.writeFileSync(out, html);
console.log(`\n  ${out}`);
console.log(`  ${(fs.statSync(out).size / 1024).toFixed(1)} KB, ${tokenCount} tokens inlined\n`);
