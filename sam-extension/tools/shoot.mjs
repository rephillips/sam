#!/usr/bin/env node
/**
 * Screenshot harness — drives the dev server and captures every UI state.
 *
 *   node tools/shoot.mjs <outDir>
 *
 * Used two ways:
 *   1. Visual reference for the design system.
 *   2. Before/after proof that a refactor changed nothing, via tools/diff.mjs.
 *
 * Starts its own dev server on a private port so it never collides with a
 * `npm run dev` you already have running.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.resolve(process.argv[2] || "/tmp/sam-shots");
const PORT = Number(process.env.SHOT_PORT || 8911);
const BASE = `http://localhost:${PORT}`;

fs.mkdirSync(outDir, { recursive: true });

const server = spawn(process.execPath, [path.join(ROOT, "tools/dev.mjs")], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: "ignore",
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/popup.html`);
      if (r.ok) return;
    } catch (_) {
      /* not up yet */
    }
    await wait(100);
  }
  throw new Error("dev server did not start");
}

const STACK = "csms-2io6tw-47150";
const TOKEN = "eyJraWQiOiJzcGx1bmsuc2VjcmV0IiwiYWxnIjoiSFM1MTIifQ.devtoken";

/** Drive the popup into a connected, list-loaded state. */
async function configure(page) {
  await page.fill("#stack", STACK);
  await page.fill("#token", TOKEN);
  await page.click("#saveConn");
  await page.waitForSelector("#listWrap:not(.hidden)", { timeout: 5000 }).catch(() => {});
  await wait(250);
}

const STATES = [
  {
    name: "01-first-run",
    url: "/popup.html?scenario=fresh&shot=1",
  },
  {
    name: "02-connected",
    url: "/popup.html?scenario=populated&shot=1&reset=1",
    async act(page) {
      await configure(page);
    },
  },
  {
    name: "03-connection-expanded",
    url: "/popup.html?scenario=populated&shot=1",
    async act(page) {
      await configure(page);
      await page.click("#connToggle");
      await wait(150);
    },
  },
  {
    name: "04-add-confirm",
    url: "/popup.html?scenario=populated&shot=1",
    async act(page) {
      await configure(page);
      // Must be genuinely public — 203.0.113.0/24 is TEST-NET-3 and is
      // rejected by the validator before any modal opens.
      await page.fill("#addInput", "52.24.109.10/32");
      await page.click("#addBtn");
      await wait(250);
    },
  },
  {
    name: "05-remove-confirm",
    url: "/popup.html?scenario=populated&shot=1",
    async act(page) {
      await configure(page);
      await page.click(".item-list__row .icon-btn");
      await wait(250);
    },
  },
  {
    name: "06-validation-error",
    url: "/popup.html?scenario=populated&shot=1",
    async act(page) {
      await configure(page);
      await page.fill("#addInput", "10.0.10.6/32");
      await page.click("#addBtn");
      await wait(200);
    },
  },
  {
    name: "07-empty-list",
    url: "/popup.html?scenario=empty&shot=1",
    async act(page) {
      await configure(page);
    },
  },
  {
    name: "08-acs-error",
    url: "/popup.html?scenario=error&shot=1",
    async act(page) {
      await configure(page);
    },
  },
  {
    name: "09-activity-log",
    url: "/popup.html?scenario=populated&shot=1",
    async act(page) {
      await configure(page);
      await page.click("#logToggle");
      await wait(250);
    },
  },
  {
    name: "10-commercial-env",
    url: "/popup.html?scenario=populated&shot=1",
    async act(page) {
      await page.selectOption("#env", "commercial");
      await wait(150);
    },
  },
];

const errors = [];

try {
  await waitForServer();
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });

  for (const state of STATES) {
    const ctx = await browser.newContext({ viewport: { width: 430, height: 640 } });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(`${state.name}: ${e.message}`));
    page.on("console", (m) => {
      // favicon.ico is not part of the extension; its 404 is expected here.
      if (m.type() === "error" && !m.text().includes("favicon")) {
        errors.push(`${state.name}: console ${m.text()}`);
      }
    });
    page.on("requestfailed", (r) => {
      if (!r.url().includes("favicon")) {
        errors.push(`${state.name}: request failed ${r.url()}`);
      }
    });

    await page.goto(`${BASE}${state.url}`, { waitUntil: "networkidle" });
    await wait(300);
    if (state.act) await state.act(page);

    await page.screenshot({ path: path.join(outDir, `${state.name}.png`), fullPage: true });
    await ctx.close();
    console.log(`  captured ${state.name}`);
  }

  await browser.close();
} finally {
  server.kill();
}

if (errors.length) {
  console.log(`\n  ${errors.length} page error(s):`);
  for (const e of errors) console.log(`    ${e}`);
} else {
  console.log("\n  No page errors.");
}
console.log(`\n  ${STATES.length} states → ${outDir}\n`);
process.exit(errors.length ? 1 : 0);
