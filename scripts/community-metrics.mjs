#!/usr/bin/env node
// Public-signal metrics for the team: no Polyth telemetry, only counters the
// platforms already keep (docs/operations/community-metrics.md).
//
//   node scripts/community-metrics.mjs snapshot [--out <file.jsonl>] [--repo Polyth/Polyth] [--npm polyth]
//   node scripts/community-metrics.mjs report   [--in <file.jsonl>] [--days 14] [--format ui|text|csv]
//   node scripts/community-metrics.mjs brief    [--dir <data dir>]                  # JSON digest for the weekly note
//   node scripts/community-metrics.mjs note     [--dir <data dir>] < note.json      # the agent's weekly note -> weekly.json
//   node scripts/community-metrics.mjs goal     [--dir <data dir>] --month YYYY-MM --metric downloads|active|stars --target N
//
// `snapshot` reads GitHub releases and repository counters, the npm daily
// downloads and (when `gh` is signed in as a maintainer) the 14-day traffic
// numbers, and keeps one JSON line per UTC day in the file (a second run on
// the same day replaces that day's line). `report` turns the kept lines into
// per-day deltas. Nothing is sent anywhere; nothing identifies a person.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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

export const PLATFORMS = ["mac", "windows", "linux", "android", "ios", "server", "other"];
export const FEED_CHANNELS = ["stable", "beta", "nightly", "workstation"];

/** The platform an installer is for, from its file name ("darwin" is a Mac, so it is matched before "win"). */
export function installerPlatform(name) {
  if (/android|\.apk$/i.test(name)) return "android";
  if (/\.ipa$/i.test(name)) return "ios";
  if (/server/i.test(name)) return "server";
  if (/mac|darwin|\.dmg$/i.test(name)) return "mac";
  if (/win|\.exe$|\.msi$/i.test(name)) return "windows";
  if (/linux|\.appimage$|\.deb$|\.rpm$/i.test(name)) return "linux";
  return "other";
}

/** The updater channel a feed file serves: `beta-mac.yml` → beta, `latest.yml`/`legacy-mac.yml` → stable. */
export function feedChannel(name) {
  const match = /^(beta|nightly|workstation)/i.exec(name);
  return match ? match[1].toLowerCase() : "stable";
}

const bump = (map, key, count) => {
  if (count > 0) map[key] = (map[key] ?? 0) + count;
};

/**
 * Per-release counters: GitHub keeps one download counter per asset, and a release disappears when it is pruned.
 * `platforms` (installers per platform) and `feedChannels` (feed requests per updater channel) were added later;
 * snapshots written before that lack them, and every reader treats their absence as "unknown", never as zero.
 */
export function summarizeReleases(releases) {
  const byTag = {};
  for (const release of releases) {
    if (release.draft) continue;
    let installers = 0;
    let feed = 0;
    const platforms = {};
    const feedChannels = {};
    for (const asset of release.assets ?? []) {
      const name = String(asset.name);
      const kind = classifyAsset(name);
      const count = Number(asset.download_count) || 0;
      if (kind === "installer") {
        installers += count;
        bump(platforms, installerPlatform(name), count);
      } else if (kind === "feed") {
        feed += count;
        bump(feedChannels, feedChannel(name), count);
      }
    }
    byTag[release.tag_name] = {
      installers,
      feed,
      channel: /-nightly/.test(release.tag_name) || release.prerelease ? "nightly" : "stable",
      published: String(release.published_at ?? "").slice(0, 10),
      platforms,
      feedChannels,
    };
  }
  return byTag;
}

/** Per-key growth of one release between two snapshots; each key is clamped at zero like the totals. */
function keyedDelta(before, now, keys) {
  const out = {};
  for (const key of keys) bump(out, key, Math.max(0, (now?.[key] ?? 0) - (before?.[key] ?? 0)));
  return out;
}

const addInto = (target, source) => {
  for (const [key, count] of Object.entries(source)) bump(target, key, count);
};

/**
 * Downloads since the previous snapshot. The sum over all releases is not
 * monotonic (old releases are pruned, workstation assets are replaced), so each
 * tag is compared with itself: a new tag counts from zero, a counter that went
 * down counts as zero. When both snapshots carry the per-platform breakdown, a
 * tag's growth is the sum of its clamped platform growths, so a replaced Windows
 * asset no longer hides the Mac downloads of the same release. `platforms` and
 * `feedChannels` are null when an older snapshot leaves the split unknown.
 */
export function releaseDelta(previous, current) {
  const out = { installers: 0, feed: 0, nightlyInstallers: 0, stableInstallers: 0, platforms: {}, feedChannels: {} };
  for (const [tag, now] of Object.entries(current)) {
    const before = previous?.[tag];
    let installers = Math.max(0, now.installers - (before?.installers ?? 0));
    let feed = Math.max(0, now.feed - (before?.feed ?? 0));
    if (out.platforms && now.platforms && (!before || before.platforms)) {
      const split = keyedDelta(before?.platforms, now.platforms, PLATFORMS);
      installers = Object.values(split).reduce((sum, n) => sum + n, 0);
      addInto(out.platforms, split);
    } else {
      out.platforms = null;
    }
    if (out.feedChannels && now.feedChannels && (!before || before.feedChannels)) {
      const split = keyedDelta(before?.feedChannels, now.feedChannels, FEED_CHANNELS);
      feed = Object.values(split).reduce((sum, n) => sum + n, 0);
      addInto(out.feedChannels, split);
    } else {
      out.feedChannels = null;
    }
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

const DAY_MS = 86_400_000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
export const addDays = (day, n) => new Date(Date.parse(day) + n * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);
const sumOf = (items, pick) => items.reduce((total, item) => total + (pick(item) ?? 0), 0);

function scaled(map, factor) {
  const out = {};
  for (const [key, count] of Object.entries(map)) out[key] = count * factor;
  return out;
}

/**
 * One entry per calendar day, for charts and the CSV. The snapshot runs early in the UTC morning, so the
 * interval ending on snapshot day D is counted to the days before it (D-gap … D-1). An interval wider than
 * one day (a missed run) is spread evenly over its days and marked `spread`, never shown as invented detail.
 * npm's "last full day" is exactly D-1, so it lands there and is null on the other days of a wide interval.
 */
export function dailySeries(lines) {
  const days = [];
  for (const row of buildRows(lines)) {
    const share = 1 / row.gap;
    for (let back = row.gap; back >= 1; back -= 1) {
      days.push({
        day: addDays(row.day, -back),
        downloads: row.installers * share,
        stable: row.stableInstallers * share,
        prerelease: row.nightlyInstallers * share,
        feed: row.feed * share,
        active: (row.feed * share) / UPDATE_CHECKS_PER_DAY,
        platforms: row.platforms ? scaled(row.platforms, share) : null,
        feedChannels: row.feedChannels ? scaled(row.feedChannels, share) : null,
        npm: back === 1 ? row.npm : null,
        spread: row.gap > 1,
      });
    }
  }
  return days;
}

/** Installers in the kept releases of one snapshot, per platform and per channel (null when the snapshot predates the split). */
function keptSplit(line) {
  const releases = Object.values(line?.releases ?? {});
  const known = releases.length > 0 && releases.every((r) => r.platforms);
  const platforms = {};
  if (known) for (const r of releases) addInto(platforms, r.platforms);
  return {
    platforms: known ? platforms : null,
    stable: sumOf(releases.filter((r) => r.channel !== "nightly"), (r) => r.installers),
    prerelease: sumOf(releases.filter((r) => r.channel === "nightly"), (r) => r.installers),
  };
}

/** Every release ever seen across the snapshots (pruned ones included), with its counter per snapshot day. */
function releaseHistory(lines) {
  const byTag = new Map();
  for (const line of lines) {
    for (const [tag, r] of Object.entries(line.releases ?? {})) {
      const entry = byTag.get(tag) ?? { tag, channel: r.channel, published: r.published, counts: [] };
      entry.counts.push({ day: line.day, installers: r.installers });
      byTag.set(tag, entry);
    }
  }
  return [...byTag.values()].filter((r) => ISO_DAY.test(String(r.published)));
}

/**
 * Downloads of a release in its first week: its counter at the last snapshot no later than
 * published + 7 days. A release younger than a week is `inProgress` with the days it has had; one
 * published more than a week before counting began has `firstWeek: null` (unknown, not zero).
 */
export function firstWeekDownloads(release, lastDay) {
  const age = daysBetween(release.published, lastDay);
  const inside = release.counts.filter((c) => daysBetween(release.published, c.day) <= 7);
  return {
    tag: release.tag,
    published: release.published,
    channel: release.channel,
    firstWeek: inside.length ? inside.at(-1).installers : null,
    daysMeasured: Math.max(0, Math.min(7, age)),
    inProgress: age < 7,
    total: release.counts.at(-1)?.installers ?? 0,
  };
}

/** Optional `events.json` next to the snapshots: `[{"day":"2026-10-31","label":"Public launch"}]`; bad entries are skipped. */
export function parseEvents(text) {
  let value;
  try { value = JSON.parse(text); } catch { return []; }
  if (!Array.isArray(value)) return [];
  return value
    .filter((e) => e && ISO_DAY.test(String(e.day)) && typeof e.label === "string" && e.label.trim())
    .map((e) => ({ day: e.day, label: e.label.trim().slice(0, 60) }))
    .slice(0, 200);
}

// ---- monthly goals and the weekly note --------------------------------------------------------------

const ISO_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
export const GOAL_METRICS = ["downloads", "active", "stars"];
const MAX_GOALS = 48;
const goalOrder = (a, b) => a.month.localeCompare(b.month) || GOAL_METRICS.indexOf(a.metric) - GOAL_METRICS.indexOf(b.metric);

/** Optional `goals.json`: `[{"month":"2026-12","metric":"downloads","target":1500}]`; one goal per month and metric, bad entries skipped. */
export function parseGoals(text) {
  let value;
  try { value = JSON.parse(text); } catch { return []; }
  if (!Array.isArray(value)) return [];
  const byKey = new Map();
  for (const g of value) {
    const target = Number(g?.target);
    if (!g || !ISO_MONTH.test(String(g.month)) || !GOAL_METRICS.includes(g.metric) || !Number.isFinite(target) || target < 1 || target > 1e9) continue;
    byKey.set(`${g.month}/${g.metric}`, { month: g.month, metric: g.metric, target: Math.round(target) });
  }
  return [...byKey.values()].sort(goalOrder).slice(-MAX_GOALS);
}

/** Sets (or, with target 0, removes) one month's goal for one metric; the newest MAX_GOALS are kept. */
export function setGoal(goals, { month, metric, target }) {
  const rest = goals.filter((g) => !(g.month === month && g.metric === metric));
  return (target > 0 ? [...rest, { month, metric, target: Math.round(target) }] : rest).sort(goalOrder).slice(-MAX_GOALS);
}

const daysInMonth = (month) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
const MIN_PACE_DAYS = 3;

/**
 * The goals of the month of the latest counted day, so on the 1st the finished month still shows its result.
 * Downloads are the month's counted days, projected at their own average to the month's end; `expected` is
 * where an even pace would be by now. When counting began inside the month the goal covers the counted part
 * (`since`). Active apps (the 7-day average) and stars are levels: compared with the target, never projected.
 */
function goalProgress(lines, summary, goals) {
  const through = summary.days.at(-1)?.day ?? summary.lastDay;
  const month = through.slice(0, 7);
  const mine = goals.filter((g) => g.month === month);
  if (mine.length === 0) return null;
  const monthEnd = `${month}-${String(daysInMonth(month)).padStart(2, "0")}`;
  const inMonth = summary.days.filter((d) => d.day.startsWith(month));
  const remaining = Math.max(0, daysBetween(through, monthEnd));
  const since = inMonth.length && inMonth[0].day > `${month}-01` ? inMonth[0].day : null;
  const status = (current, target, projected) => {
    if (current === null) return "wait";
    if (current >= target) return "done";
    if (remaining === 0) return "missed";
    if (projected === undefined) return "level";
    if (projected === null) return "wait";
    return projected >= target ? "on" : projected >= target * 0.85 ? "close" : "behind";
  };
  const items = mine.map(({ metric, target }) => {
    if (metric === "downloads") {
      const current = sumOf(inMonth, (d) => d.downloads);
      const counted = inMonth.length;
      const projected = counted >= MIN_PACE_DAYS ? current + (current / counted) * remaining : null;
      const expected = counted ? (target * counted) / (counted + remaining) : 0;
      const perDay = remaining > 0 && current < target ? (target - current) / remaining : null;
      return { metric, target, current, projected, expected, perDay, status: status(current, target, projected) };
    }
    if (metric === "active") {
      const current = summary.week.active;
      return { metric, target, current, status: status(current, target, undefined) };
    }
    const current = summary.repo.stars;
    const start = lines.findLast((line) => line.day <= `${month}-01` && typeof line.repo?.stars === "number")
      ?? lines.find((line) => line.day.startsWith(month) && typeof line.repo?.stars === "number");
    const gained = current !== null && start ? current - start.repo.stars : null;
    return { metric, target, current, gained, status: status(current, target, undefined) };
  });
  return { month, monthEnd, through, remaining, since, items };
}

const NOTE_LANGUAGES = ["uk", "en"];
const NOTE_LINES = 3;
const NOTE_LINE_CHARS = 240;
// Control, line-separator and bidi-override characters: a note is plain one-line text.
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g;

/**
 * The agent's weekly note: `{"from":"2026-11-23","to":"2026-11-29","uk":[…],"en":[…]}` with 1–3 plain lines
 * of at most 240 characters per language (either language may be left out). `**text**` is the only markup
 * and the page renders it as bold after escaping. Returns `{ note }` or `{ error }`.
 */
export function normalizeWeeklyNote(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "the note must be a JSON object" };
  const { from, to } = value;
  if (!ISO_DAY.test(String(from)) || !ISO_DAY.test(String(to)) || from > to) return { error: "from and to must be YYYY-MM-DD days, from not after to" };
  const note = { from, to, writtenAt: null };
  for (const lang of NOTE_LANGUAGES) {
    if (value[lang] === undefined) continue;
    const list = value[lang];
    if (!Array.isArray(list) || list.length < 1 || list.length > NOTE_LINES) return { error: `${lang} must be a list of 1-${NOTE_LINES} lines` };
    const clean = list.map((line) => (typeof line === "string" ? line.replace(UNSAFE_TEXT, " ").replace(/\s+/g, " ").trim() : ""));
    if (clean.some((line) => !line || line.length > NOTE_LINE_CHARS)) return { error: `each ${lang} line must be 1-${NOTE_LINE_CHARS} characters of text` };
    note[lang] = clean;
  }
  if (!NOTE_LANGUAGES.some((lang) => note[lang])) return { error: `give the lines as ${NOTE_LANGUAGES.join(" and/or ")}` };
  if (typeof value.writtenAt === "string" && !Number.isNaN(Date.parse(value.writtenAt))) note.writtenAt = new Date(value.writtenAt).toISOString();
  return { note };
}

/** `weekly.json` as written by `note`; anything damaged or unstamped reads as no note. */
export function parseWeeklyNote(text) {
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  const { note } = normalizeWeeklyNote(value);
  return note?.writtenAt ? note : null;
}

const MIN_PLATFORM_DAYS = 7;

/**
 * Everything the dashboard shows, computed once from the snapshot lines. Week figures compare the last
 * 7 days with the 7 before and are null until enough days exist. `total` is the downloads already in the
 * kept releases at the first snapshot (`before`) plus every daily delta since. The platform split covers
 * the last 30 days once at least a week of snapshots carries it, and otherwise the kept releases of the
 * latest snapshot (`scope.kind` says which); it is null only when no snapshot carries the split yet.
 */
export function summarizeDashboard(lines, { events = [], goals = [] } = {}) {
  const summary = summarizeSeries(lines, events);
  if (summary) summary.goals = goalProgress(lines, summary, goals);
  return summary;
}

function summarizeSeries(lines, events) {
  const last = lines.at(-1);
  if (!last) return null;
  const days = dailySeries(lines);
  const last7 = days.slice(-7);
  const prev7 = days.length >= 14 ? days.slice(-14, -7) : null;
  const before = keptSplit(lines[0]);
  const baseline = before.stable + before.prerelease;
  let running = baseline;
  const cumulative = days.map((d) => ({ day: d.day, total: (running += d.downloads) }));
  const window30 = days.slice(-30);
  const withPlatforms = window30.filter((d) => d.platforms);
  let split;
  if (withPlatforms.length >= MIN_PLATFORM_DAYS && sumOf(withPlatforms, (d) => d.downloads) > 0) {
    const platforms = {};
    for (const d of withPlatforms) addInto(platforms, d.platforms);
    split = { platforms, stable: sumOf(withPlatforms, (d) => d.stable), prerelease: sumOf(withPlatforms, (d) => d.prerelease), scope: { kind: "window", days: withPlatforms.length } };
  } else {
    const kept = keptSplit(last);
    split = { ...kept, scope: { kind: "kept", day: last.day } };
  }
  const history = releaseHistory(lines);
  const stableReleases = history.filter((r) => r.channel !== "nightly").sort((a, b) => b.published.localeCompare(a.published));
  const npmDays = last7.filter((d) => typeof d.npm === "number");
  const monthAgo = addDays(last.day, -30);
  const starsThen = lines.find((line) => line.day >= monthAgo && typeof line.repo?.stars === "number");
  return {
    firstDay: lines[0].day,
    lastDay: last.day,
    takenAt: last.takenAt ?? null,
    days,
    week: {
      days: last7.length,
      downloads: sumOf(last7, (d) => d.downloads),
      previousDownloads: prev7 ? sumOf(prev7, (d) => d.downloads) : null,
      active: last7.length ? sumOf(last7, (d) => d.active) / last7.length : null,
      previousActive: prev7 ? sumOf(prev7, (d) => d.active) / prev7.length : null,
      npm: npmDays.length ? sumOf(npmDays, (d) => d.npm) : null,
      npmDays: npmDays.length,
    },
    total: { downloads: cumulative.at(-1)?.total ?? baseline, before: baseline, since: lines[0].day },
    cumulative,
    split,
    releases: stableReleases.slice(0, 4).map((r) => firstWeekDownloads(r, last.day)),
    markers: [
      ...history.filter((r) => r.channel !== "nightly").map((r) => ({ day: r.published, label: r.tag, kind: "release" })),
      ...events.map((e) => ({ ...e, kind: "event" })),
    ].sort((a, b) => a.day.localeCompare(b.day)),
    repo: {
      stars: last.repo?.stars ?? null,
      forks: last.repo?.forks ?? null,
      starsChange: starsThen && typeof last.repo?.stars === "number" && starsThen !== last ? last.repo.stars - starsThen.repo.stars : null,
      starsSince: starsThen && starsThen !== last ? starsThen.day : null,
      starsSeries: lines.filter((line) => line.day >= monthAgo && typeof line.repo?.stars === "number").map((line) => line.repo.stars),
      viewsUnique: last.traffic?.viewsUnique ?? null,
    },
  };
}

export const CSV_COLUMNS = [
  "date", "downloads", "downloads_stable", "downloads_beta_nightly",
  ...PLATFORMS.map((p) => `downloads_${p}`),
  "update_checks", "active_apps_estimate", "npm_downloads", "spread_over_missed_days",
];

const csvNumber = (n) => (n === null || n === undefined ? "" : String(Math.round(n * 10) / 10));

/**
 * The daily series as CSV (one row per day, oldest first). Cells are only dates, numbers and yes/no, so no
 * cell can start a spreadsheet formula; `headers` may relabel the columns (the dashboard translates them).
 * A platform cell is empty when the split was not recorded that day; a spread day is marked `yes`.
 */
export function renderCsv(lines, { headers = {} } = {}) {
  const head = CSV_COLUMNS.map((key) => {
    const label = String(headers[key] ?? key);
    return /[",\n]/.test(label) ? `"${label.replace(/"/g, '""')}"` : label;
  });
  const body = dailySeries(lines).map((d) => [
    d.day, csvNumber(d.downloads), csvNumber(d.stable), csvNumber(d.prerelease),
    ...PLATFORMS.map((p) => (d.platforms ? csvNumber(d.platforms[p] ?? 0) : "")),
    csvNumber(d.feed), csvNumber(d.active), csvNumber(d.npm), d.spread ? "yes" : "no",
  ].join(","));
  return `${[head.join(","), ...body].join("\r\n")}\r\n`;
}

const round1 = (n) => (n === null || n === undefined ? null : Math.round(n * 10) / 10);

/**
 * What the weekly note is written from: the same figures the dashboard shows, rounded, with the period the
 * note must name (the last 7 counted days, fewer while counting is young). Downloads are installer fetches
 * and active apps an estimate; neither is a count of people.
 */
export function weeklyBrief(lines, { goals = [], events = [], note = null, now = new Date() } = {}) {
  const summary = summarizeDashboard(lines, { events, goals });
  if (!summary || summary.days.length === 0) {
    return { ready: false, reason: lines.length ? "one snapshot so far; daily figures start after the next one" : "no snapshots yet", lastSnapshot: lines.at(-1)?.takenAt ?? null };
  }
  const last7 = summary.days.slice(-7);
  const prev7 = summary.days.length >= 14 ? summary.days.slice(-14, -7) : null;
  const from = last7[0].day;
  const to = last7.at(-1).day;
  const within = (day) => day >= from && day <= to;
  const platforms = summary.split.platforms
    ? Object.fromEntries(Object.entries(summary.split.platforms).map(([k, n]) => [k, Math.round(n)]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]))
    : null;
  const channels = summary.split.stable + summary.split.prerelease;
  return {
    ready: true,
    wording: "Downloads are installer fetches, not people. activeApps is an estimate (update-feed requests / 4, desktop only). Never call either 'users'.",
    period: { from, to, days: last7.length },
    previousPeriod: prev7 ? { from: prev7[0].day, to: prev7.at(-1).day } : null,
    lastSnapshot: summary.takenAt,
    snapshotAgeHours: summary.takenAt ? Math.round((now.getTime() - Date.parse(summary.takenAt)) / 3_600_000) : null,
    downloads: {
      period: Math.round(summary.week.downloads),
      previousPeriod: summary.week.previousDownloads === null ? null : Math.round(summary.week.previousDownloads),
      total: Math.round(summary.total.downloads),
      countingSince: summary.total.since,
      beforeCounting: summary.total.before,
      daily: last7.map((d) => ({ day: d.day, downloads: Math.round(d.downloads), spreadOverMissedDays: d.spread })),
    },
    activeApps: { average: round1(summary.week.active), previousAverage: round1(summary.week.previousActive) },
    platforms: platforms ? { downloads: platforms, scope: summary.split.scope } : null,
    stableShare: channels > 0 ? Math.round((summary.split.stable / channels) * 100) : null,
    npm: summary.week.npm,
    github: { stars: summary.repo.stars, forks: summary.repo.forks, starsChange: summary.repo.starsChange, starsSince: summary.repo.starsSince },
    releasesInPeriod: summary.markers.filter((m) => m.kind === "release" && within(m.day)).map((m) => ({ tag: m.label, day: m.day })),
    eventsInPeriod: summary.markers.filter((m) => m.kind === "event" && within(m.day)).map((m) => ({ label: m.label, day: m.day })),
    recentReleases: summary.releases,
    goals: summary.goals && {
      ...summary.goals,
      // Whole numbers for counts (a still-needed pace rounds up); active apps keep one decimal like the page's estimate.
      items: summary.goals.items.map((g) => Object.fromEntries(Object.entries(g).map(([k, v]) => {
        if (typeof v !== "number" || k === "target") return [k, v];
        if (g.metric === "active") return [k, round1(v)];
        return [k, k === "perDay" ? Math.ceil(v) : Math.round(v)];
      }))),
    },
    currentNote: note ? { from: note.from, to: note.to, writtenAt: note.writtenAt } : null,
  };
}

function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, text);
  renameSync(temporary, file);
}

const readOptional = (file, fallback) => (existsSync(file) ? readFileSync(file, "utf8") : fallback);

const spark = (rows, key) => rows.map((row) => row[key] ?? 0).join(",");
const signed = (n) => (n > 0 ? `+${n}` : String(n));

export function renderUi(lines, days = 14) {
  const rows = buildRows(lines).slice(-days);
  const last = lines.at(-1);
  if (!last) return "No snapshots yet: run `snapshot` first.";
  const latest = rows.at(-1);
  const totals = Object.values(last.releases).reduce((sum, r) => ({ installers: sum.installers + r.installers, feed: sum.feed + r.feed }), { installers: 0, feed: 0 });
  const summary = summarizeDashboard(lines);
  const out = [`stats Community signals · ${last.day} · public counters, not users`];
  out.push(`- Installer downloads (kept releases) | ${totals.installers} | ${latest ? signed(latest.installers) : "n/a"} | ${spark(rows, "installers")}`);
  out.push(`- Installer downloads, last 7 days | ${Math.round(summary.week.downloads)} | ${summary.week.previousDownloads === null ? "" : signed(Math.round(summary.week.downloads - summary.week.previousDownloads))} |`);
  out.push(`- Installer downloads since ${summary.total.since} (incl. ${summary.total.before} before) | ${Math.round(summary.total.downloads)} | |`);
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
    const format = option(argv, "--format", "ui");
    if (format === "csv") process.stdout.write(renderCsv(lines));
    else console.log(format === "text" ? renderText(lines, days) : renderUi(lines, days));
    return 0;
  }
  // brief, note and goal work on a data directory: snapshots.jsonl, events.json, goals.json, weekly.json.
  const dir = resolve(option(argv, "--dir", dirname(file)));
  if (command === "brief") {
    const lines = parseLines(readOptional(join(dir, "snapshots.jsonl"), ""));
    const brief = weeklyBrief(lines, {
      goals: parseGoals(readOptional(join(dir, "goals.json"), "[]")),
      events: parseEvents(readOptional(join(dir, "events.json"), "[]")),
      note: parseWeeklyNote(readOptional(join(dir, "weekly.json"), "")),
    });
    console.log(JSON.stringify(brief, null, 2));
    return 0;
  }
  if (command === "note") {
    let value;
    try { value = JSON.parse(readFileSync(0, "utf8")); } catch { console.error("note: stdin is not JSON"); return 2; }
    const { note, error } = normalizeWeeklyNote(value);
    if (error) { console.error(`note: ${error}`); return 2; }
    note.writtenAt = new Date().toISOString();
    writeAtomic(join(dir, "weekly.json"), `${JSON.stringify(note, null, 2)}\n`);
    console.log(`note for ${note.from}..${note.to} written to ${join(dir, "weekly.json")}`);
    return 0;
  }
  if (command === "goal") {
    const month = option(argv, "--month", "");
    const metric = option(argv, "--metric", "");
    const target = Number(option(argv, "--target", ""));
    if (!ISO_MONTH.test(month) || !GOAL_METRICS.includes(metric) || !Number.isInteger(target) || target < 0 || target > 1e9) {
      console.error(`goal: --month YYYY-MM --metric ${GOAL_METRICS.join("|")} --target <whole number, 0 removes the goal>`);
      return 2;
    }
    const goals = setGoal(parseGoals(readOptional(join(dir, "goals.json"), "[]")), { month, metric, target });
    writeAtomic(join(dir, "goals.json"), `${JSON.stringify(goals, null, 2)}\n`);
    console.log(JSON.stringify(goals));
    return 0;
  }
  console.error("usage: community-metrics.mjs snapshot|report|brief|note|goal (see the header of this file)");
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error) => { console.error(error.message); process.exit(1); });
}
