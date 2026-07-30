#!/usr/bin/env node
/**
 * Build the loadable extension zip.
 *
 *   npm run package   →  sam-extension.zip
 *
 * Development-only material is excluded: the dev server, the mock chrome API,
 * the screenshot and lint tooling, tests, node_modules, and the style guide.
 * The style guide is documentation, not part of the shipped surface — but
 * tokens.css and components.css ARE shipped, because popup.html loads them.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "sam-extension.zip");

const EXCLUDE = [
  "node_modules/*",
  "tools/*",
  "test/*",
  "design/styleguide.*",
  "design/DESIGN-SYSTEM.md",
  "package.json",
  "package-lock.json",
  "*.zip",
  ".DS_Store",
  "*/.DS_Store",
];

// The manifest is the contract: everything it references must survive the
// exclusion list, so verify rather than assume.
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const required = ["popup.html", "popup.js", "popup.css", "acs.js", "background.js",
  "offscreen.html", "offscreen.js",
  "design/tokens.css", "design/components.css"];

fs.rmSync(OUT, { force: true });
execFileSync("zip", ["-r", OUT, ".", "-x", ...EXCLUDE, "-q"], { cwd: ROOT });

const listed = execFileSync("unzip", ["-Z1", OUT], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

const missing = required.filter((f) => !listed.includes(f));
if (missing.length) {
  console.error(`\n  Package is missing required files: ${missing.join(", ")}\n`);
  process.exit(1);
}

const leaked = listed.filter(
  (f) => f.startsWith("tools/") || f.startsWith("node_modules/") || f.startsWith("test/")
);
if (leaked.length) {
  console.error(`\n  Development files leaked into the package: ${leaked.join(", ")}\n`);
  process.exit(1);
}

const bytes = fs.statSync(OUT).size;
console.log(`\n  sam-extension.zip — v${manifest.version}`);
console.log(`  ${listed.length} files, ${(bytes / 1024).toFixed(1)} KB\n`);
for (const f of listed.sort()) console.log(`    ${f}`);
console.log("");
