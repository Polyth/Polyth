import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRows,
  classifyAsset,
  collectSnapshot,
  mergeSnapshot,
  parseLines,
  releaseDelta,
  renderText,
  renderUi,
  summarizeReleases,
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
  assert.deepEqual(summary["v1.2.3"], { installers: 7, feed: 9, channel: "stable", published: "2026-11-20" });
  assert.equal(summary["v1.2.4-nightly"].channel, "nightly");
  assert.equal(summary["v9.9.9"], undefined);
});

test("a pruned release never makes the delta negative, and a new tag counts from zero", () => {
  const before = { old: { installers: 100, feed: 50, channel: "stable" }, kept: { installers: 10, feed: 4, channel: "stable" } };
  const now = {
    kept: { installers: 13, feed: 8, channel: "stable" },
    fresh: { installers: 6, feed: 2, channel: "nightly" },
  };
  assert.deepEqual(releaseDelta(before, now), { installers: 9, feed: 6, nightlyInstallers: 6, stableInstallers: 3 });
  // A replaced asset resets its counter: that tag contributes zero, not a negative number.
  assert.equal(releaseDelta({ kept: { installers: 10, feed: 0, channel: "stable" } }, { kept: { installers: 2, feed: 0, channel: "stable" } }).installers, 0);
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
