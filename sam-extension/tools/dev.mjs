#!/usr/bin/env node
/**
 * SAM dev server — preview the extension without loading it into Chrome.
 *
 *   npm run dev        →  http://localhost:8910
 *
 * Two problems make "just open popup.html" fail, and this solves both:
 *
 *   1. popup.js is an ES module. Chrome blocks module scripts over file://
 *      with a CORS error, so the page loads but no script ever runs.
 *   2. chrome.storage / chrome.runtime don't exist outside an extension, so
 *      the popup renders inert even when served over HTTP.
 *
 * Rather than keep a duplicate dev copy of popup.html (which would drift from
 * what ships), this serves the REAL popup.html and injects the mock shim at
 * request time, immediately before the module script.
 *
 * Nothing here is packaged: tools/ is excluded from the zip.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT || 8910);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".md": "text/plain; charset=utf-8",
};

const SHIM = "/__dev__/mock-chrome.js";

const INDEX = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>SAM dev</title>
<style>
  body{background:#0e1117;color:#e6edf3;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;margin:0;padding:40px}
  main{max-width:640px;margin:0 auto}
  h1{font-size:20px;margin:0 0 4px}
  p.sub{color:#8b98a9;margin:0 0 28px;font-size:13px}
  h2{font-size:12px;text-transform:uppercase;letter-spacing:.6px;color:#8b98a9;margin:28px 0 10px;font-weight:650}
  a.card{display:block;padding:14px 16px;background:#161b24;border:1px solid #2a3242;border-radius:8px;margin-bottom:8px;text-decoration:none;color:#e6edf3}
  a.card:hover{border-color:#00b5a0}
  a.card b{display:block;font-size:14px;margin-bottom:2px}
  a.card span{color:#8b98a9;font-size:12px}
  code{font-family:ui-monospace,Menlo,monospace;font-size:12px;background:#0b0f16;border:1px solid #2a3242;border-radius:3px;padding:1px 5px}
</style></head>
<body><main>
  <h1>SAM dev harness</h1>
  <p class="sub">The real popup, running against a mock <code>chrome.*</code> API. Edit CSS and refresh.</p>

  <h2>Surfaces</h2>
  <a class="card" href="/popup.html"><b>Popup</b><span>The shipped UI, mock-backed</span></a>
  <a class="card" href="/design/styleguide.html"><b>Style guide</b><span>Every token and component, live from the same CSS</span></a>

  <h2>Popup scenarios</h2>
  <a class="card" href="/popup.html?scenario=fresh"><b>First run</b><span>No token, no profile — token help auto-opens</span></a>
  <a class="card" href="/popup.html?scenario=populated"><b>Populated</b><span>Three subnets on the Search API list</span></a>
  <a class="card" href="/popup.html?scenario=empty"><b>Empty list</b><span>Allow list returns zero subnets</span></a>
  <a class="card" href="/popup.html?scenario=error"><b>Error</b><span>ACS returns 403</span></a>
  <a class="card" href="/popup.html?scenario=slow"><b>Slow</b><span>2.5s latency — loading and disabled states</span></a>
  <a class="card" href="/popup.html?reset=1"><b>Reset fixtures</b><span>Clear stored profile, token, and subnet fixtures</span></a>
</main></body></html>`;

function send(res, status, body, type = "text/html; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let pathname = decodeURIComponent(url.pathname);

  if (pathname === "/") return send(res, 200, INDEX);

  if (pathname === SHIM) {
    const shim = fs.readFileSync(path.join(ROOT, "tools/mock-chrome.js"), "utf8");
    return send(res, 200, shim, MIME[".js"]);
  }

  const filePath = path.join(ROOT, pathname);
  // Keep the server inside the project directory.
  if (!filePath.startsWith(ROOT)) return send(res, 403, "Forbidden");
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return send(res, 404, `Not found: ${pathname}`);
  }

  const ext = path.extname(filePath);

  // Inject the mock chrome API ahead of the real module script.
  if (pathname === "/popup.html") {
    let html = fs.readFileSync(filePath, "utf8");
    if (!html.includes('<script type="module"')) {
      return send(res, 500, "popup.html no longer has a module script — update tools/dev.mjs");
    }
    html = html.replace(
      '<script type="module"',
      `<script src="${SHIM}"></script>\n    <script type="module"`
    );
    return send(res, 200, html);
  }

  send(res, 200, fs.readFileSync(filePath), MIME[ext] || "application/octet-stream");
});

server.listen(PORT, () => {
  console.log(`\n  SAM dev harness → http://localhost:${PORT}\n`);
  console.log(`  popup       http://localhost:${PORT}/popup.html`);
  console.log(`  style guide http://localhost:${PORT}/design/styleguide.html`);
  console.log(`\n  Scenarios: ?scenario=fresh|populated|empty|error|slow   ?reset=1\n`);
});
