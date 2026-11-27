import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildRows,
  classifyAsset,
  collectSnapshot,
  CSV_COLUMNS,
  dailySeries,
  feedChannel,
  firstWeekDownloads,
  installerPlatform,
  mergeSnapshot,
  normalizeWeeklyNote,
  parseEvents,
  parseGoals,
  parseLines,
  parseWeeklyNote,
  releaseDelta,
  renderCsv,
  renderText,
  renderUi,
  setGoal,
  summarizeDashboard,
  summarizeReleases,
  weeklyBrief,
} from "../community-metrics.mjs";

const release = (tag: string, assets: Record<string, number>, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  published_at: "2026-11-20T10:00:00Z",
  prerelease: false,
  assets: Object.entries(assets).map(([name, download_count]) => ({ name, download_count })),
  ...extra,
});

test("assets are classified; blockmaps, SBOMs and sums are not counted", () => {
  assert.equal(classifyAsset("Polyth-1.2.3-mac-arm64.dmg"), "installer");
  assert.equal(classifyAsset("Polyth-1.2.3-android.apk"), "installer");
  assert.equal(classifyAsset("latest-mac.yml"), "feed");
  assert.equal(classifyAsset("Polyth-1.2.3-mac-arm64.dmg.blockmap"), "other");
  assert.equal(classifyAsset("SHA256SUMS-workstation.txt"), "other");
  assert.equal(classifyAsset("Polyth-1.2.3-workstation-sbom-linux-x64.cdx.json"), "other");
});

test("releases are summed per tag and the channel comes from the tag or prerelease flag", () => {
  const summary = summarizeReleases([
    release("v1.2.3", { "Polyth-1.2.3-mac-arm64.dmg": 5, "Polyth-1.2.3-win-x64.exe": 2, "latest.yml": 9, "x.blockmap": 100 }),
    release("v1.2.4-nightly", { "Polyth-1.2.4-nightly-mac-arm64.dmg": 3 }, { prerelease: true }),
    release("v9.9.9", { "a.dmg": 50 }, { draft: true }),
  ]);
  assert.deepEqual(summary["v1.2.3"], {
    installers: 7, feed: 9, channel: "stable", published: "2026-11-20", platforms: { mac: 5, windows: 2 }, feedChannels: { stable: 9 },
  });
  assert.equal(summary["v1.2.4-nightly"].channel, "nightly");
  assert.equal(summary["v9.9.9"], undefined);
});

test("installers map to a platform and feed files to an updater channel", () => {
  assert.equal(installerPlatform("Polyth-1.2.3-mac-arm64.dmg"), "mac");
  assert.equal(installerPlatform("Polyth-1.2.3-darwin-x64.tar.gz"), "mac");
  assert.equal(installerPlatform("Polyth-Setup-1.2.3-x64.exe"), "windows");
  assert.equal(installerPlatform("Polyth-1.2.3-x86_64.AppImage"), "linux");
  assert.equal(installerPlatform("Polyth-1.2.3-android.apk"), "android");
  assert.equal(installerPlatform("polyth-server-1.2.3-linux-x64.tar.gz"), "server");
  assert.equal(installerPlatform("mystery.tgz"), "other");
  assert.equal(feedChannel("latest-mac.yml"), "stable");
  assert.equal(feedChannel("beta-linux.yml"), "beta");
  assert.equal(feedChannel("workstation-mac.yml"), "workstation");
});

test("a pruned release never makes the delta negative, and a new tag counts from zero", () => {
  const before = { old: { installers: 100, feed: 50, channel: "stable" }, kept: { installers: 10, feed: 4, channel: "stable" } };
  const now = {
    kept: { installers: 13, feed: 8, channel: "stable" },
    fresh: { installers: 6, feed: 2, channel: "nightly" },
  };
  // Snapshots without the per-platform split leave it unknown (null), never zero.
  assert.deepEqual(releaseDelta(before, now), { installers: 9, feed: 6, nightlyInstallers: 6, stableInstallers: 3, platforms: null, feedChannels: null });
  // A replaced asset resets its counter: that tag contributes zero, not a negative number.
  assert.equal(releaseDelta({ kept: { installers: 10, feed: 0, channel: "stable" } }, { kept: { installers: 2, feed: 0, channel: "stable" } }).installers, 0);
});

test("with the platform split a replaced asset no longer hides the other platforms' growth", () => {
  const before = { v1: { installers: 30, feed: 10, channel: "stable", platforms: { mac: 10, windows: 20 }, feedChannels: { stable: 10 } } };
  // The Windows installer was replaced (its counter restarted at 1) while the Mac one grew by 5.
  const now = { v1: { installers: 16, feed: 14, channel: "stable", platforms: { mac: 15, windows: 1 }, feedChannels: { stable: 12, beta: 2 } } };
  const delta = releaseDelta(before, now);
  assert.equal(delta.installers, 5);
  assert.deepEqual(delta.platforms, { mac: 5 });
  assert.deepEqual(delta.feedChannels, { stable: 2, beta: 2 });
  assert.equal(delta.feed, 4);
});

const day = (date: string, releases: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ day: date, takenAt: `${date}T06:10:00Z`, repo: { stars: 10, forks: 1 }, releases, ...extra });
const rel = (installers: number, platforms: Record<string, number> | undefined, published = "2026-11-01", channel = "stable") =>
  ({ installers, feed: installers * 4, channel, published, ...(platforms ? { platforms, feedChannels: { stable: installers * 4 } } : {}) });

test("the daily series counts each interval to the days before the snapshot and spreads a missed day", () => {
  const lines = [
    day("2026-11-20", { v1: rel(10, { mac: 10 }) }),
    day("2026-11-21", { v1: rel(14, { mac: 12, linux: 2 }) }, { npm: { lastDay: 3 } }),
    day("2026-11-23", { v1: rel(20, { mac: 16, linux: 4 }) }, { npm: { lastDay: 5 } }),
  ];
  const days = dailySeries(lines);
  assert.deepEqual(days.map((d: { day: string }) => d.day), ["2026-11-20", "2026-11-21", "2026-11-22"]);
  assert.equal(days[0].downloads, 4);
  assert.equal(days[0].npm, 3);
  assert.equal(days[0].spread, false);
  assert.deepEqual([days[1].downloads, days[2].downloads], [3, 3]);
  assert.deepEqual([days[1].spread, days[2].spread], [true, true]);
  // npm's "last full day" is the day just before the snapshot, so only that day carries it.
  assert.deepEqual([days[1].npm, days[2].npm], [null, 5]);
  assert.deepEqual(days[2].platforms, { mac: 2, linux: 1 });
  assert.equal(days[0].active, (16 / 4));
});

test("the dashboard summary compares weeks, keeps a running total and says where the platform split comes from", () => {
  const lines = [];
  for (let i = 0; i <= 15; i += 1) {
    const date = new Date(Date.parse("2026-11-01") + i * 86_400_000).toISOString().slice(0, 10);
    // 2 a day for the first 8 days, then 3 a day; the split exists only from 2026-11-09.
    const total = 100 + (i <= 8 ? 2 * i : 16 + 3 * (i - 8));
    lines.push(day(date, { v1: rel(total, i >= 8 ? { mac: total - 50, windows: 50 } : undefined, "2026-10-01") }, { repo: { stars: 10 + i, forks: 1 } }));
  }
  const summary = summarizeDashboard(lines, { events: [{ day: "2026-11-05", label: "Launch" }] });
  assert.equal(summary.days.length, 15);
  assert.equal(summary.week.downloads, 21);
  assert.equal(summary.week.previousDownloads, 14);
  assert.equal(summary.total.before, 100);
  assert.equal(summary.total.downloads, 100 + 16 + 3 * 7);
  assert.equal(summary.cumulative.at(-1).total, summary.total.downloads);
  assert.equal(summary.split.scope.kind, "window");
  assert.equal(summary.split.scope.days, 7);
  assert.deepEqual(summary.split.platforms, { mac: 21 });
  assert.equal(summary.repo.starsChange, 15);
  assert.equal(summary.repo.starsSince, "2026-11-01");
  assert.deepEqual(summary.markers.map((m: { label: string }) => m.label), ["v1", "Launch"]);
  // Fewer than a week of split days: the kept releases of the latest snapshot are shown instead.
  const early = summarizeDashboard(lines.slice(0, 11));
  assert.equal(early.split.scope.kind, "kept");
  assert.deepEqual(early.split.platforms, { mac: 72, windows: 50 });
  // No snapshot with the split at all: unknown, not empty.
  assert.equal(summarizeDashboard(lines.slice(0, 3)).split.platforms, null);
  assert.equal(summarizeDashboard(lines.slice(0, 3)).week.previousDownloads, null);
  assert.equal(summarizeDashboard([]), null);
});

test("a release's first week is measured, in progress, or unknown when it predates counting", () => {
  const counts = [{ day: "2026-11-10", installers: 4 }, { day: "2026-11-15", installers: 30 }, { day: "2026-11-17", installers: 41 }, { day: "2026-11-20", installers: 50 }];
  const measured = firstWeekDownloads({ tag: "v2", channel: "stable", published: "2026-11-10", counts }, "2026-11-20");
  assert.equal(measured.firstWeek, 41);
  assert.equal(measured.inProgress, false);
  assert.equal(measured.total, 50);
  const young = firstWeekDownloads({ tag: "v3", channel: "stable", published: "2026-11-18", counts: [{ day: "2026-11-20", installers: 9 }] }, "2026-11-20");
  assert.deepEqual([young.firstWeek, young.inProgress, young.daysMeasured], [9, true, 2]);
  const old = firstWeekDownloads({ tag: "v1", channel: "stable", published: "2026-10-01", counts }, "2026-11-20");
  assert.equal(old.firstWeek, null);
});

test("events are read leniently and bad entries are dropped", () => {
  assert.deepEqual(parseEvents('[{"day":"2026-10-31","label":" Launch "},{"day":"31.10","label":"x"},{"day":"2026-11-01"},7]'), [{ day: "2026-10-31", label: "Launch" }]);
  assert.deepEqual(parseEvents("not json"), []);
  assert.deepEqual(parseEvents('{"day":"2026-10-31"}'), []);
});

/** One snapshot a day from `from`, `perDay` new downloads (and as many active apps) each day; stars by index. */
const daily = (from: string, count: number, perDay: number, stars = (_i: number) => 10) => Array.from({ length: count }, (_, i) => {
  const date = new Date(Date.parse(from) + i * 86_400_000).toISOString().slice(0, 10);
  return day(date, { v1: rel(100 + perDay * i, undefined, "2026-10-01") }, { repo: { stars: stars(i), forks: 1 } });
});

test("goals are read leniently, one per month and metric, and set or removed", () => {
  assert.deepEqual(
    parseGoals('[{"month":"2026-12","metric":"downloads","target":1500.4},{"month":"2026-13","metric":"downloads","target":5},{"month":"2026-12","metric":"users","target":5},{"month":"2026-12","metric":"stars","target":0},{"month":"2026-12","metric":"downloads","target":1600}]'),
    [{ month: "2026-12", metric: "downloads", target: 1600 }],
  );
  assert.deepEqual(parseGoals("nope"), []);
  assert.deepEqual(parseGoals('{"month":"2026-12"}'), []);
  const set = setGoal([{ month: "2026-12", metric: "downloads", target: 1600 }], { month: "2026-11", metric: "stars", target: 30 });
  assert.deepEqual(set.map((g: { month: string; metric: string; target: number }) => `${g.month}/${g.metric}/${g.target}`), ["2026-11/stars/30", "2026-12/downloads/1600"]);
  assert.equal(setGoal(set, { month: "2026-11", metric: "stars", target: 0 }).length, 1);
});

test("monthly goals: downloads are projected at the month's own pace, levels are compared, the month's end is final", () => {
  // Snapshots Oct 31 .. Nov 11 count the days Oct 31 .. Nov 10: ten November days at 10 a day.
  const lines = daily("2026-10-31", 12, 10, (i) => 20 + i);
  const goals = parseGoals(JSON.stringify([
    { month: "2026-11", metric: "downloads", target: 330 },
    { month: "2026-11", metric: "active", target: 8 },
    { month: "2026-11", metric: "stars", target: 40 },
    { month: "2026-12", metric: "downloads", target: 999 },
  ]));
  const g = summarizeDashboard(lines, { goals }).goals;
  assert.deepEqual([g.month, g.through, g.remaining, g.since], ["2026-11", "2026-11-10", 20, null]);
  const [downloads, active, stars] = g.items;
  assert.deepEqual([downloads.current, downloads.projected, downloads.expected, downloads.perDay, downloads.status], [100, 300, 110, 11.5, "close"]);
  assert.deepEqual([active.current, active.status], [10, "done"]);
  // Stars are compared with the snapshot of the 1st: 21 then, 31 now.
  assert.deepEqual([stars.current, stars.gained, stars.status], [31, 10, "level"]);
  const status = (target: number) => summarizeDashboard(lines, { goals: [{ month: "2026-11", metric: "downloads", target }] }).goals.items[0].status;
  assert.deepEqual([status(300), status(400), status(100)], ["on", "behind", "done"]);
  // Counting began inside the month: the goal covers the counted part; two days are too few for a pace.
  const young = summarizeDashboard(daily("2026-11-20", 3, 10), { goals }).goals;
  assert.equal(young.since, "2026-11-20");
  assert.deepEqual([young.items[0].current, young.items[0].projected, young.items[0].status], [20, null, "wait"]);
  // On the 1st the finished month still shows, as its result.
  const ended = summarizeDashboard(daily("2026-10-31", 32, 10), { goals }).goals;
  assert.deepEqual([ended.month, ended.remaining, ended.items[0].current, ended.items[0].status], ["2026-11", 0, 300, "missed"]);
  assert.equal(summarizeDashboard(lines).goals, null);
});

test("the weekly note is plain text: 1-3 lines per language, control and bidi characters removed", () => {
  const { note } = normalizeWeeklyNote({ from: "2026-11-23", to: "2026-11-29", uk: ["  Перший\u202e  рядок\n", "Другий"], en: ["One"], extra: "<x>" });
  assert.deepEqual(note, { from: "2026-11-23", to: "2026-11-29", writtenAt: null, uk: ["Перший рядок", "Другий"], en: ["One"] });
  const week = { from: "2026-11-23", to: "2026-11-29" };
  for (const bad of [null, [], "x", { ...week, from: "2026-11-30", uk: ["x"] }, week, { ...week, uk: ["a", "b", "c", "d"] }, { ...week, uk: [] }, { ...week, uk: ["x".repeat(241)] }, { ...week, uk: [" \u0007 "] }, { ...week, uk: [7] }]) {
    assert.ok(normalizeWeeklyNote(bad).error, JSON.stringify(bad));
  }
  // The stored file carries the writer's stamp; a hand-made file without it is no note.
  assert.equal(parseWeeklyNote('{"from":"2026-11-23","to":"2026-11-29","uk":["x"]}'), null);
  assert.equal(parseWeeklyNote('{"from":"2026-11-23","to":"2026-11-29","uk":["x"],"writtenAt":"2026-11-30T07:00:00Z"}').writtenAt, "2026-11-30T07:00:00.000Z");
  assert.equal(parseWeeklyNote("{"), null);
});

const SCRIPT = fileURLToPath(new URL("../community-metrics.mjs", import.meta.url));
const cli = (args: string[], input = "") => spawnSync(process.execPath, [SCRIPT, ...args], { input, encoding: "utf8", timeout: 20_000 });

test("brief, note and goal work on a data directory and refuse bad input", (context) => {
  const dir = mkdtempSync(join(tmpdir(), "metrics-brief-"));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(weeklyBrief([]).ready, false);
  // The brief speaks in whole downloads: 11.5 still needed a day reads as 12.
  const pace = weeklyBrief(daily("2026-10-31", 12, 10), { goals: [{ month: "2026-11", metric: "downloads", target: 330 }] }).goals.items[0];
  assert.deepEqual([pace.expected, pace.perDay, pace.projected], [110, 12, 300]);
  // Snapshots Nov 1 .. Nov 16 count Nov 1 .. Nov 15: the brief's period is the last 7 counted days.
  writeFileSync(join(dir, "snapshots.jsonl"), daily("2026-11-01", 16, 10).map((l) => JSON.stringify(l)).join("\n"));
  assert.equal(cli(["goal", "--dir", dir, "--month", "2026-11", "--metric", "downloads", "--target", "300"]).status, 0);
  assert.equal(cli(["goal", "--dir", dir, "--month", "2026-11", "--metric", "users", "--target", "5"]).status, 2);
  assert.equal(cli(["goal", "--dir", dir, "--month", "2026-11", "--metric", "stars", "--target", "1.5"]).status, 2);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "goals.json"), "utf8")), [{ month: "2026-11", metric: "downloads", target: 300 }]);
  assert.equal(cli(["note", "--dir", dir], "not json").status, 2);
  assert.equal(cli(["note", "--dir", dir], '{"from":"2026-11-09","to":"2026-11-15","uk":[]}').status, 2);
  assert.equal(existsSync(join(dir, "weekly.json")), false);
  const written = cli(["note", "--dir", dir], '{"from":"2026-11-09","to":"2026-11-15","uk":["Перший"],"writtenAt":"2000-01-01T00:00:00Z"}');
  assert.equal(written.status, 0, written.stderr);
  const stored = parseWeeklyNote(readFileSync(join(dir, "weekly.json"), "utf8"));
  assert.deepEqual(stored.uk, ["Перший"]);
  assert.ok(Date.parse(stored.writtenAt) > Date.parse("2026-01-01"), "the writer stamps the time itself");
  const result = cli(["brief", "--dir", dir]);
  assert.equal(result.status, 0, result.stderr);
  const brief = JSON.parse(result.stdout);
  assert.equal(brief.ready, true);
  assert.deepEqual(brief.period, { from: "2026-11-09", to: "2026-11-15", days: 7 });
  assert.deepEqual(brief.previousPeriod, { from: "2026-11-02", to: "2026-11-08" });
  assert.deepEqual([brief.downloads.period, brief.downloads.previousPeriod, brief.activeApps.average], [70, 70, 10]);
  assert.deepEqual([brief.goals.items[0].current, brief.goals.items[0].status], [150, "on"]);
  assert.deepEqual(brief.currentNote.from, "2026-11-09");
  assert.match(brief.wording, /not people/);
});

test("the CSV has one row per day, empty platform cells when unknown and no formula-like cells", () => {
  const lines = [
    day("2026-11-20", { v1: rel(10, undefined) }),
    day("2026-11-21", { v1: rel(14, undefined) }),
    day("2026-11-22", { v1: rel(17, { mac: 17 }) }),
    day("2026-11-23", { v1: rel(20, { mac: 19, windows: 1 }) }),
  ];
  const [head, ...rows] = renderCsv(lines, { headers: { date: "Дата, день" } }).trimEnd().split("\r\n");
  assert.equal(head.split(",").length, CSV_COLUMNS.length + 1);
  assert.ok(head.startsWith('"Дата, день",downloads,'));
  assert.equal(rows.length, 3);
  assert.match(rows[0], /^2026-11-20,4,4,0,,,,,,,,16,4,,no$/);
  assert.match(rows[2], /^2026-11-22,3,3,0,2,1,0,0,0,0,0,12,3,,no$/);
  assert.ok(rows.every((row) => row.split(",").every((cell) => !/^[=+\-@]/.test(cell))));
});

test("a second run on the same day replaces that day and keeps the lines sorted", () => {
  const a = { day: "2026-11-24", releases: {} };
  const b = { day: "2026-11-25", releases: {}, marker: 1 };
  const merged = mergeSnapshot(mergeSnapshot([b], a), { ...b, marker: 2 });
  assert.deepEqual(merged.map((line: { day: string }) => line.day), ["2026-11-24", "2026-11-25"]);
  assert.equal((merged[1] as { marker: number }).marker, 2);
});

test("damaged lines are skipped when reading the file", () => {
  const text = `${JSON.stringify({ day: "2026-11-24", releases: {} })}\nnot json\n\n{"day":1}\n`;
  assert.equal(parseLines(text).length, 1);
});

test("rows use the real gap between snapshots and estimate updaters from feed requests", () => {
  const lines = [
    { day: "2026-11-22", releases: { v1: { installers: 0, feed: 0, channel: "stable" } }, repo: { stars: 1, forks: 1 } },
    { day: "2026-11-24", releases: { v1: { installers: 4, feed: 80, channel: "stable" } }, npm: { lastDay: 7 }, repo: { stars: 2, forks: 1 } },
  ];
  const [row] = buildRows(lines);
  assert.equal(row.gap, 2);
  assert.equal(row.updateChecksPerDay, 40);
  assert.equal(row.activeUpdatersEstimate, 10);
  assert.equal(row.npm, 7);
  assert.match(renderUi(lines), /^stats Community signals · 2026-11-24 · public counters, not users/);
  assert.match(renderUi(lines), /≈ active updaters \(estimate\) \| 10/);
  assert.match(renderText(lines), /2026-11-24/);
  assert.match(renderText(lines.slice(0, 1)), /second day/);
});

test("collectSnapshot reads public counters only and survives a missing npm or traffic source", async () => {
  const urls: string[] = [];
  const fetchImpl = (async (url: string) => {
    urls.push(url);
    if (url.includes("npmjs")) return { ok: false, status: 404, json: async () => ({}) };
    if (url.endsWith("/releases?per_page=100")) return { ok: true, json: async () => [release("v1.0.0", { "a.dmg": 3 })] };
    return { ok: true, json: async () => ({ stargazers_count: 4, forks_count: 2 }) };
  }) as unknown as typeof fetch;
  const snapshot = await collectSnapshot({ fetchImpl, now: new Date("2026-11-25T08:00:00Z"), ghApi: () => null, token: "" });
  assert.equal(snapshot.day, "2026-11-25");
  assert.deepEqual(snapshot.repo, { stars: 4, forks: 2 });
  assert.equal(snapshot.npm, null);
  assert.equal(snapshot.traffic, null);
  assert.ok(urls.every((url) => /^https:\/\/(api\.github\.com|api\.npmjs\.org)\//.test(url)));
});
