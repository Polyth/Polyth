#!/usr/bin/env node
// Public-signal metrics for the team: no Polyth telemetry, only counters the
// platforms already keep (docs/operations/community-metrics.md).
//
//   node scripts/community-metrics.mjs snapshot [--out <file.jsonl>] [--repo Polyth/Polyth] [--npm polyth]
//   node scripts/community-metrics.mjs report   [--in <file.jsonl>] [--days 14] [--format ui|text]
//
// `snapshot` reads GitHub releases and repository counters, the npm daily
// downloads and (when `gh` is signed in as a maintainer) the 14-day traffic
// numbers, and keeps one JSON line per UTC day in the file (a second run on
// the same day replaces that day's line). `report` turns the kept lines into
// per-day deltas. Nothing is sent anywhere; nothing identifies a person.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_REPOSITORY = "Polyth/Polyth";
export const DEFAULT_NPM_PACKAGE = "polyth";
export const DEFAULT_OUT = ".scratch/community-metrics/snapshots.jsonl";
/** The desktop updater asks for its feed once at start and then every 6 hours (docs/security/workstation-edition.md). */
export const UPDATE_CHECKS_PER_DAY = 4;

const FEED_FILE = /\.ya?ml$/i;
const INSTALLER_FILE = /\.(dmg|exe|appimage|apk|ipa|deb|rpm|msi|tar\.gz|tgz)$/i;

/** installer | feed | other: only these two are counted; blockmaps, SBOMs and sums are ignored. */
export function classifyAsset(name) {
  if (FEED_FILE.test(name)) return "feed";
  if (/\.(blockmap|sig|txt|json|zip)$/i.test(name)) return "other";
  return INSTALLER_FILE.test(name) ? "installer" : "other";
}

/** Per-release counters: GitHub keeps one download counter per asset, and a release disappears when it is pruned. */
export function summarizeReleases(releases) {
  const byTag = {};
  for (const release of releases) {
    if (release.draft) continue;
    let installers = 0;
    let feed = 0;
    for (const asset of release.assets ?? []) {
      const kind = classifyAsset(String(asset.name));
      const count = Number(asset.download_count) || 0;
      if (kind === "installer") installers += count;
      else if (kind === "feed") feed += count;
    }
    byTag[release.tag_name] = {
      installers,
      feed,
      channel: /-nightly/.test(release.tag_name) || release.prerelease ? "nightly" : "stable",
      published: String(release.published_at ?? "").slice(0, 10),
    };
  }
  return byTag;
}

/**
 * Downloads since the previous snapshot. The sum over all releases is not
 * monotonic (old releases are pruned, workstation assets are replaced), so each
 * tag is compared with itself: a new tag counts from zero, a counter that went
 * down counts as zero.
 */
export function releaseDelta(previous, current) {
  const out = { installers: 0, feed: 0, nightlyInstallers: 0, stableInstallers: 0 };
  for (const [tag, now] of Object.entries(current)) {
    const before = previous?.[tag];
    const installers = Math.max(0, now.installers - (before?.installers ?? 0));
    const feed = Math.max(0, now.feed - (before?.feed ?? 0));
    out.installers += installers;
    out.feed += feed;
    if (now.channel === "nightly") out.nightlyInstallers += installers;
    else out.stableInstallers += installers;
  }
  return out;
}

const dayOf = (iso) => String(iso).slice(0, 10);

/** The run on day N replaces an earlier run the same day; lines stay sorted by day. */
export function mergeSnapshot(lines, snapshot) {
  const kept = lines.filter((line) => line.day !== snapshot.day);
  kept.push(snapshot);
  return kept.sort((a, b) => a.day.localeCompare(b.day));
}

export function parseLines(text) {
  const out = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      const value = JSON.parse(raw);
      if (value && typeof value.day === "string" && value.releases) out.push(value);
    } catch {
      // A damaged line is skipped; the next snapshot rewrites the file.
    }
  }
  return out;
}

/** One row per snapshot interval. `days` is the real gap, so a missed day shows as one wider row. */
export function buildRows(lines) {
  const rows = [];
  for (let index = 1; index < lines.length; index += 1) {
    const before = lines[index - 1];
    const now = lines[index];
    const gap = Math.max(1, Math.round((Date.parse(now.day) - Date.parse(before.day)) / 86_400_000));
    const delta = releaseDelta(before.releases, now.releases);
    rows.push({
      day: now.day,
      gap,
      ...delta,
      updateChecksPerDay: Math.round(delta.feed / gap),
      activeUpdatersEstimate: Math.round(delta.feed / gap / UPDATE_CHECKS_PER_DAY),
      npm: now.npm?.lastDay ?? null,
      stars: now.repo?.stars ?? null,
      forks: now.repo?.forks ?? null,
      viewsUnique: now.traffic?.viewsUnique ?? null,
    });
  }
  return rows;
}

const spark = (rows, key) => rows.map((row) => row[key] ?? 0).join(",");
const signed = (n) => (n > 0 ? `+${n}` : String(n));

export function renderUi(lines, days = 14) {
  const rows = buildRows(lines).slice(-days);
  const last = lines.at(-1);
  if (!last) return "No snapshots yet: run `snapshot` first.";
  const latest = rows.at(-1);
  const totals = Object.values(last.releases).reduce((sum, r) => ({ installers: sum.installers + r.installers, feed: sum.feed + r.feed }), { installers: 0, feed: 0 });
  const out = [`stats Community signals · ${last.day} · public counters, not users`];
  out.push(`- Installer downloads (kept releases) | ${totals.installers} | ${latest ? signed(latest.installers) : "n/a"} | ${spark(rows, "installers")}`);
  out.push(`- Update-feed requests per day | ${latest?.updateChecksPerDay ?? "n/a"} | | ${spark(rows, "updateChecksPerDay")}`);
  out.push(`- ≈ active updaters (estimate) | ${latest?.activeUpdatersEstimate ?? "n/a"} | | ${spark(rows, "activeUpdatersEstimate")}`);
  out.push(`- npm downloads, last day | ${last.npm?.lastDay ?? "n/a"} | | ${spark(rows, "npm")}`);
  out.push(`- Stars / forks | ${last.repo?.stars ?? "?"} / ${last.repo?.forks ?? "?"} | |`);
  if (last.traffic) out.push(`- Unique repo viewers, 14 days | ${last.traffic.viewsUnique} | |`);
  return out.join("\n");
}

export function renderText(lines, days = 14) {
  const rows = buildRows(lines).slice(-days);
  if (rows.length === 0) return lines.length === 0 ? "No snapshots yet: run `snapshot` first." : "One snapshot so far; a second day is needed for deltas.";
  const head = "day         gap  installers  stable  nightly  feed  ≈updaters  npm  stars";
  const body = rows.map((r) => [r.day, r.gap, r.installers, r.stableInstallers, r.nightlyInstallers, r.feed, r.activeUpdatersEstimate, r.npm ?? "-", r.stars ?? "-"]
    .map((cell, i) => String(cell).padEnd([12, 5, 12, 8, 9, 6, 11, 5, 5][i])).join("").trimEnd());
  return [head, ...body].join("\n");
}

async function getJson(url, fetchImpl, headers = {}) {
  const response = await fetchImpl(url, { headers: { accept: "application/vnd.github+json", "user-agent": "polyth-community-metrics", ...headers } });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json();
}

/** Reads the public counters; `gh` (a maintainer's own sign-in) adds the 14-day traffic when present. */
export async function collectSnapshot({ repository = DEFAULT_REPOSITORY, npmPackage = DEFAULT_NPM_PACKAGE, fetchImpl = fetch, now = new Date(), ghApi = defaultGhApi, token = process.env.GITHUB_TOKEN } = {}) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const [repo, releases] = await Promise.all([
    getJson(`https://api.github.com/repos/${repository}`, fetchImpl, headers),
    getJson(`https://api.github.com/repos/${repository}/releases?per_page=100`, fetchImpl, headers),
  ]);
  let npm = null;
  try {
    const range = await getJson(`https://api.npmjs.org/downloads/range/last-week/${npmPackage}`, fetchImpl);
    const days = (range.downloads ?? []).filter((d) => d.day < dayOf(now.toISOString()));
    npm = { lastDay: days.at(-1)?.downloads ?? 0, lastDayOf: days.at(-1)?.day ?? null };
  } catch {
    npm = null;
  }
  let traffic = null;
  try {
    const views = ghApi(`repos/${repository}/traffic/views`);
    if (views && typeof views.uniques === "number") traffic = { viewsUnique: views.uniques, viewsTotal: views.count };
  } catch {
    traffic = null;
  }
  return {
    day: dayOf(now.toISOString()),
    takenAt: now.toISOString(),
    repo: { stars: repo.stargazers_count, forks: repo.forks_count },
    releases: summarizeReleases(releases),
    npm,
    traffic,
  };
}

function defaultGhApi(path) {
  try {
    return JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 }));
  } catch {
    return null;
  }
}

function option(argv, name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

export async function main(argv) {
  const [command] = argv;
  const file = resolve(option(argv, command === "snapshot" ? "--out" : "--in", process.env.POLYTH_METRICS_FILE ?? DEFAULT_OUT));
  if (command === "snapshot") {
    const snapshot = await collectSnapshot({ repository: option(argv, "--repo", DEFAULT_REPOSITORY), npmPackage: option(argv, "--npm", DEFAULT_NPM_PACKAGE) });
    const lines = mergeSnapshot(existsSync(file) ? parseLines(readFileSync(file, "utf8")) : [], snapshot);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    console.log(`snapshot ${snapshot.day} written to ${file} (${lines.length} days)`);
    return 0;
  }
  if (command === "report") {
    const lines = existsSync(file) ? parseLines(readFileSync(file, "utf8")) : [];
    const days = Number(option(argv, "--days", "14")) || 14;
    console.log(option(argv, "--format", "ui") === "text" ? renderText(lines, days) : renderUi(lines, days));
    return 0;
  }
  console.error("usage: community-metrics.mjs snapshot|report [--out|--in <file.jsonl>] [--days N] [--format ui|text]");
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error) => { console.error(error.message); process.exit(1); });
}
