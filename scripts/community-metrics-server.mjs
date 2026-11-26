#!/usr/bin/env node
// Closed team dashboard for the community-metrics snapshots
// (docs/operations/community-metrics.md). One dependency-free file next to
// community-metrics.mjs; it serves a script-free HTML page behind a password
// and nothing else. Closed by default: without a valid `password.scrypt` every
// request is answered 503, and a wrong password is never told apart from none.
//
//   node scripts/community-metrics-server.mjs serve              # METRICS_KEYS_DIR=/keys METRICS_DATA_DIR=/data
//   node scripts/community-metrics-server.mjs hash-password      # password from stdin -> the line password.scrypt holds
//
// Configuration: METRICS_HOST/METRICS_PORT (default 127.0.0.1:8789). A
// non-loopback host needs METRICS_TLS_TERMINATED=1 (a TLS proxy in front).
// METRICS_TRUSTED_PROXY is not read: the lockout is service-wide, so no client
// address is ever needed, kept or logged.
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { UPDATE_CHECKS_PER_DAY, buildRows, parseLines } from "./community-metrics.mjs";

const PREFIX = "scrypt";
const COST = { N: 16_384, r: 8, p: 1 };
const HASH_BYTES = 32;
const MAX_PASSWORD = 200;
const MAX_MEMORY = 64 * 1024 * 1024;
const LOCK_AFTER = 10;
const LOCK_WINDOW_MS = 15 * 60_000;

/** `scrypt$N$r$p$<salt>$<hash>`, the same line the report relay keeps. */
export function hashPassword(password) {
  if (!/^[\x21-\x7e]{1,200}$/.test(password)) throw new Error("password must be 1-200 printable ASCII characters without spaces");
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, HASH_BYTES, { ...COST, maxmem: MAX_MEMORY });
  return [PREFIX, COST.N, COST.r, COST.p, salt.toString("base64"), hash.toString("base64")].join("$");
}

export function parsePasswordLine(line) {
  const parts = String(line).trim().split("$");
  if (parts.length !== 6 || parts[0] !== PREFIX) return null;
  const [N, r, p] = parts.slice(1, 4).map((part) => (/^\d{1,7}$/.test(part) ? Number(part) : Number.NaN));
  if (![N, r, p].every(Number.isInteger) || N < 1024 || N > 1_048_576 || (N & (N - 1)) !== 0 || r < 1 || r > 32 || p < 1 || p > 16) return null;
  const salt = Buffer.from(parts[4], "base64");
  const hash = Buffer.from(parts[5], "base64");
  return salt.length >= 8 && salt.length <= 64 && hash.length === HASH_BYTES ? { N, r, p, salt, hash } : null;
}

export function verifyPassword(record, password) {
  if (!record || !password || password.length > MAX_PASSWORD) return false;
  try {
    const derived = scryptSync(password, record.salt, record.hash.length, { N: record.N, r: record.r, p: record.p, maxmem: MAX_MEMORY });
    return timingSafeEqual(derived, record.hash);
  } catch {
    return false;
  }
}

/** The password out of `Authorization: Basic …`; the user name is ignored. */
export function basicPassword(header) {
  const match = /^Basic ([A-Za-z0-9+/=]{1,400})$/.exec(header ?? "");
  if (!match) return "";
  const text = Buffer.from(match[1], "base64").toString("utf8");
  const colon = text.indexOf(":");
  return colon < 0 ? "" : text.slice(colon + 1);
}

const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function sparkline(values, label) {
  const data = values.map((v) => (Number.isFinite(v) ? v : 0));
  if (data.length < 2) return `<svg class="spark" viewBox="0 0 120 32" role="img" aria-label="${esc(label)}: not enough days yet"></svg>`;
  const max = Math.max(...data, 1);
  const points = data.map((v, i) => `${((i / (data.length - 1)) * 118 + 1).toFixed(1)},${(30 - (v / max) * 28).toFixed(1)}`).join(" ");
  return `<svg class="spark" viewBox="0 0 120 32" role="img" aria-label="${esc(label)}: ${data.join(", ")}"><polyline points="${points}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

const delta = (n) => (n > 0 ? `+${n}` : String(n));

/** A script-free page: stat tiles with sparklines, a daily table and the kept releases. */
export function renderDashboardHtml(lines, { days = 30 } = {}) {
  const rows = buildRows(lines).slice(-days);
  const last = lines.at(-1);
  const latest = rows.at(-1);
  const tile = (title, value, note, key) => `<section class="tile"><h2>${esc(title)}</h2><p class="value">${esc(value)}</p><p class="note">${esc(note)}</p>${sparkline(rows.map((r) => r[key]), title)}</section>`;
  let body;
  if (!last) {
    body = `<p class="empty">No snapshots yet. The daily run writes the first one.</p>`;
  } else {
    const totals = Object.values(last.releases).reduce((sum, r) => ({ installers: sum.installers + r.installers, feed: sum.feed + r.feed }), { installers: 0, feed: 0 });
    const releases = Object.entries(last.releases).sort((a, b) => String(b[1].published).localeCompare(String(a[1].published)));
    body = `<div class="tiles">
${tile("Installer downloads / day", latest ? latest.installers : "n/a", latest ? `${totals.installers} in the kept releases` : "needs a second day", "installers")}
${tile("Update-feed requests / day", latest ? latest.updateChecksPerDay : "n/a", "the app asks at start and every 6 h", "updateChecksPerDay")}
${tile("≈ active updaters (estimate)", latest ? latest.activeUpdatersEstimate : "n/a", `requests ÷ ${UPDATE_CHECKS_PER_DAY} per day; not users`, "activeUpdatersEstimate")}
${tile("npm downloads, last day", last.npm?.lastDay ?? "n/a", "includes CI and mirrors", "npm")}
</div>
<p class="meta">Repository: ${esc(last.repo?.stars ?? "?")} stars, ${esc(last.repo?.forks ?? "?")} forks${last.traffic ? `, ${esc(last.traffic.viewsUnique)} unique viewers in 14 days` : ""}. Last snapshot ${esc(last.day)}.</p>
<h2>Per day</h2>
<table><thead><tr><th>Day</th><th>Gap</th><th>Installers</th><th>Stable</th><th>Nightly</th><th>Feed</th><th>≈ Updaters</th><th>npm</th></tr></thead><tbody>
${rows.length ? rows.slice().reverse().map((r) => `<tr><td>${esc(r.day)}</td><td>${r.gap}</td><td>${delta(r.installers)}</td><td>${delta(r.stableInstallers)}</td><td>${delta(r.nightlyInstallers)}</td><td>${delta(r.feed)}</td><td>${r.activeUpdatersEstimate}</td><td>${esc(r.npm ?? "-")}</td></tr>`).join("\n") : `<tr><td colspan="8">One snapshot so far; deltas need a second day.</td></tr>`}
</tbody></table>
<h2>Kept releases</h2>
<table><thead><tr><th>Tag</th><th>Channel</th><th>Published</th><th>Installers</th><th>Feed</th></tr></thead><tbody>
${releases.map(([tag, r]) => `<tr><td>${esc(tag)}</td><td>${esc(r.channel)}</td><td>${esc(r.published)}</td><td>${r.installers}</td><td>${r.feed}</td></tr>`).join("\n")}
</tbody></table>`;
  }
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Polyth community signals</title>
<style>
:root{color-scheme:light dark;--bg:#fafafa;--fg:#1c1c1e;--mut:#6b6b70;--card:#fff;--line:#e3e3e6;--acc:#3b6cf6}
@media(prefers-color-scheme:dark){:root{--bg:#141416;--fg:#ececef;--mut:#9a9aa2;--card:#1c1c20;--line:#2c2c32;--acc:#7b9bff}}
*{box-sizing:border-box}body{margin:0;padding:24px;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}main{max-width:960px;margin:0 auto}
h1{font-size:22px;margin:0 0 4px}h2{font-size:14px;margin:24px 0 8px;color:var(--mut);font-weight:600}.lede,.meta,.note,.foot{color:var(--mut);font-size:13px}.lede{margin:0 0 16px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}.tile{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;color:var(--acc)}
.tile h2{margin:0 0 6px;color:var(--mut);font-size:12px}.value{margin:0;font-size:28px;font-weight:650;color:var(--fg)}.note{margin:2px 0 6px}.spark{width:100%;height:32px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;font-size:13px}th,td{padding:7px 10px;text-align:right;border-bottom:1px solid var(--line)}th:first-child,td:first-child{text-align:left}th{color:var(--mut);font-weight:600}
.foot{margin-top:24px}.empty{padding:32px;text-align:center;color:var(--mut)}
</style></head><body><main>
<h1>Polyth community signals</h1>
<p class="lede">Public counters from GitHub and npm, not telemetry and not user counts. Closed to the team.</p>
${body}
<p class="foot">Downloads are files fetched, not people. Update-feed requests come from the desktop app's own update check; the “active updaters” figure is an estimate. A release that was pruned or replaced counts as zero change.</p>
</main></body></html>
`;
}

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "x-robots-tag": "noindex, nofollow",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

function readOnce(file, cache) {
  let stamp;
  try { stamp = `${statSync(file).mtimeMs}`; } catch { stamp = ""; }
  if (cache.stamp === stamp) return cache.value;
  cache.stamp = stamp;
  cache.value = null;
  if (stamp) {
    try { cache.value = readFileSync(file, "utf8"); } catch { cache.value = null; }
  }
  return cache.value;
}

/** Request handler; `keysDir/password.scrypt` and `dataDir/snapshots.jsonl` are re-read when their mtime changes. */
export function createHandler({ keysDir, dataDir, now = () => Date.now() }) {
  const passwordCache = {};
  const snapshotCache = {};
  const failures = [];
  const send = (res, status, body = "", extra = {}) => {
    res.writeHead(status, { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8", ...extra });
    res.end(body);
  };
  return (req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "", { allow: "GET, HEAD" });
    if (path === "/robots.txt") return send(res, 200, "User-agent: *\nDisallow: /\n", { "content-type": "text/plain; charset=utf-8" });
    if (path !== "/" && path !== "/healthz") return send(res, 404);
    const record = parsePasswordLine(readOnce(join(keysDir, "password.scrypt"), passwordCache) ?? "");
    if (!record) return send(res, 503, "Unavailable.");
    const t = now();
    while (failures.length && t - failures[0] > LOCK_WINDOW_MS) failures.shift();
    if (failures.length >= LOCK_AFTER) return send(res, 429, "Try again later.", { "retry-after": String(Math.ceil((failures[0] + LOCK_WINDOW_MS - t) / 1000)) });
    if (!verifyPassword(record, basicPassword(req.headers.authorization))) {
      if (req.headers.authorization) failures.push(t);
      return send(res, 401, "Sign in.", { "www-authenticate": 'Basic realm="Polyth community signals", charset="UTF-8"' });
    }
    if (path === "/healthz") return send(res, 200, "ok", { "content-type": "text/plain; charset=utf-8" });
    const text = readOnce(join(dataDir, "snapshots.jsonl"), snapshotCache);
    return send(res, 200, req.method === "HEAD" ? "" : renderDashboardHtml(parseLines(text ?? "")));
  };
}

function readStdin() {
  return readFileSync(0, "utf8").replace(/\r?\n$/, "");
}

export function main(argv, env = process.env) {
  if (argv[0] === "hash-password") {
    console.log(hashPassword(readStdin()));
    return null;
  }
  if (argv[0] !== "serve") {
    console.error("usage: community-metrics-server.mjs serve | hash-password");
    process.exitCode = 2;
    return null;
  }
  const host = env.METRICS_HOST || "127.0.0.1";
  const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
  if (!loopback && env.METRICS_TLS_TERMINATED !== "1") throw new Error("a non-loopback METRICS_HOST needs METRICS_TLS_TERMINATED=1");
  const server = createServer(createHandler({ keysDir: resolve(env.METRICS_KEYS_DIR || "/keys"), dataDir: resolve(env.METRICS_DATA_DIR || "/data") }));
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.maxHeadersCount = 32;
  const port = Number(env.METRICS_PORT || 8789);
  server.listen(port, host, () => console.log(`community metrics dashboard on ${host}:${port}`));
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exit(1); }
}
