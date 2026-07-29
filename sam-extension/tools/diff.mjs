#!/usr/bin/env node
/**
 * Pixel-diff two screenshot directories.
 *
 *   node tools/diff.mjs <beforeDir> <afterDir>
 *
 * Decodes PNGs with the browser's own image decoder (via Playwright) so there
 * is no image-library dependency. Reports the share of differing pixels per
 * state and exits non-zero if any state drifts past the threshold.
 *
 * Used to prove the design-system refactor is visually neutral.
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const [beforeDir, afterDir] = process.argv.slice(2);
if (!beforeDir || !afterDir) {
  console.error("usage: node tools/diff.mjs <beforeDir> <afterDir>");
  process.exit(2);
}

// Anti-aliasing of text can flip a channel by a point or two; ignore that.
const CHANNEL_TOLERANCE = 4;
const FAIL_ABOVE = 0.001; // 0.1% of pixels

const names = fs
  .readdirSync(beforeDir)
  .filter((f) => f.endsWith(".png"))
  .sort();

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await browser.newPage();

const results = [];

for (const name of names) {
  const a = path.join(beforeDir, name);
  const b = path.join(afterDir, name);
  if (!fs.existsSync(b)) {
    results.push({ name, status: "MISSING", pct: null });
    continue;
  }

  const [aB64, bB64] = [a, b].map((p) => fs.readFileSync(p).toString("base64"));

  const out = await page.evaluate(
    async ([aSrc, bSrc, tol]) => {
      const load = (src) =>
        new Promise((res, rej) => {
          const img = new Image();
          img.onload = () => res(img);
          img.onerror = rej;
          img.src = "data:image/png;base64," + src;
        });
      const [ia, ib] = await Promise.all([load(aSrc), load(bSrc)]);

      // Heights legitimately change when the type scale changes. Compare the
      // overlapping region so the result is a real number rather than a bail,
      // and report the size delta alongside it.
      const w = Math.min(ia.width, ib.width);
      const h = Math.min(ia.height, ib.height);
      const draw = (img) => {
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        c.getContext("2d").drawImage(img, 0, 0);
        return c.getContext("2d").getImageData(0, 0, w, h).data;
      };
      const da = draw(ia);
      const db = draw(ib);
      let diff = 0;
      for (let i = 0; i < da.length; i += 4) {
        if (
          Math.abs(da[i] - db[i]) > tol ||
          Math.abs(da[i + 1] - db[i + 1]) > tol ||
          Math.abs(da[i + 2] - db[i + 2]) > tol
        ) {
          diff++;
        }
      }
      return {
        diff,
        total: da.length / 4,
        sizeDelta:
          ia.width === ib.width && ia.height === ib.height
            ? null
            : `${ia.width}x${ia.height} → ${ib.width}x${ib.height}`,
      };
    },
    [aB64, bB64, CHANNEL_TOLERANCE]
  );

  const pct = out.diff / out.total;
  results.push({
    name,
    status: pct <= FAIL_ABOVE && !out.sizeDelta ? "SAME" : "DRIFT",
    pct,
    detail: out.sizeDelta,
  });
}

await browser.close();

console.log(`\nVisual diff — ${beforeDir} → ${afterDir}\n`);
console.log("  status   changed   state");
console.log("  ──────   ───────   ─────────────────────────");
let bad = 0;
for (const r of results) {
  if (r.status !== "SAME") bad++;
  const pct = r.pct === null ? "     —" : `${(r.pct * 100).toFixed(3)}%`.padStart(7);
  console.log(`  ${r.status.padEnd(7)}  ${pct}   ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
}
console.log(
  `\n${results.length - bad}/${results.length} states pixel-identical.${
    bad ? `  ${bad} changed.\n` : "\n"
  }`
);
process.exit(bad ? 1 : 0);
