import test from "node:test";
import assert from "node:assert/strict";
import { exhaustedUntil, isSteerable, meterTiming, metersOf, phaseOf, type LimitSource, type LimitWindow } from "../src/windows.ts";

const HOUR = 60 * 60_000;
const NOW = Date.parse("2026-11-05T04:10:00Z");
const win = (id: string, used: number, periodHours: number | undefined, resetIn?: number): LimitWindow => ({
  id,
  label: id,
  used,
  limit: 100,
  unit: "percent",
  ...(periodHours !== undefined ? { periodMs: periodHours * HOUR } : {}),
  ...(resetIn !== undefined ? { resetsAt: NOW + resetIn } : {}),
});
const source = (providerId: string, windows: LimitWindow[], family?: string): LimitSource => ({
  providerId,
  windows,
  fetchedAt: NOW,
  stale: false,
  ...(family ? { account: { family, harnessId: providerId, label: "Work" } } : {}),
});

// The readings below repeat what the live providers reported on 2026-11-05.

test("Claude: no reset on an empty window means it has not started", () => {
  assert.equal(phaseOf(win("5h", 0, 5), NOW, NOW), "idle");
});

test("Claude: a started window has a fixed reset", () => {
  assert.equal(phaseOf(win("5h", 1, 5, 3.7 * HOUR), NOW, NOW), "running");
});

test("Antigravity and OpenCode Go: an empty window's reset slides with the clock", () => {
  assert.equal(phaseOf(win("google-5h", 0, 5, 5 * HOUR), NOW, NOW), "idle");
});

test("a request leaves the sliding band soon after: the same reset reads as running", () => {
  const window = win("google-5h", 0, 5, 5 * HOUR);
  assert.equal(phaseOf(window, NOW + 150_000, NOW + 150_000), "running");
});

test("a fixed calendar reset is not sliding, even on an empty window", () => {
  // OpenCode Go's weekly window resets on Monday 00:00.
  assert.equal(phaseOf(win("weekly", 0, 168, 92 * HOUR), NOW, NOW), "running");
});

test("a reset that passed reads as idle; a used window without one as unknown", () => {
  assert.equal(phaseOf(win("5h", 40, 5, -1), NOW, NOW), "idle");
  assert.equal(phaseOf(win("5h", 40, 5), NOW, NOW), "unknown");
});

test("only account-wide windows with a known length can be started", () => {
  assert.equal(isSteerable(win("5h", 0, 5)), true);
  assert.equal(isSteerable(win("fable/7d", 0, 168)), false);
  assert.equal(isSteerable(win("premium", 39, undefined, 600 * HOUR)), false);
  assert.equal(isSteerable(win("burst", 0, 0.5)), false);
  assert.equal(isSteerable({ ...win("credits", 0, 5), limit: 0 }), false);
});

test("a source has one meter, led by its shortest window", () => {
  const meters = metersOf(source("claude", [win("7d", 82, 168, 12 * HOUR), win("5h", 1, 5, 3 * HOUR), win("fable/7d", 0, 168, 12 * HOUR)]));
  assert.equal(meters.length, 1);
  assert.equal(meters[0]!.primary.id, "5h");
  assert.deepEqual(meters[0]!.windows.map((window) => window.id), ["5h", "7d"]);
});

test("Antigravity meters its two model groups apart, on every account", () => {
  const windows = [win("google-weekly", 4, 168, 86 * HOUR), win("google-5h", 0, 5, 5 * HOUR), win("third-party-weekly", 100, 168, 111 * HOUR), win("third-party-5h", 0, 5, 5 * HOUR)];
  for (const row of [source("antigravity", windows), source("antigravity-iryna", windows, "antigravity")]) {
    const meters = metersOf(row);
    assert.deepEqual(meters.map((meter) => meter.id), ["google", "third-party"]);
    assert.deepEqual(meters.map((meter) => meter.primary.id), ["google-5h", "third-party-5h"]);
  }
});

test("a source with only a monthly window still counts; one with no period does not", () => {
  assert.equal(metersOf(source("codex", [win("30d", 2, 720, 650 * HOUR)]))[0]?.primary.id, "30d");
  assert.deepEqual(metersOf(source("github-copilot", [win("premium", 39, undefined, 600 * HOUR)])), []);
});

test("a chosen hour follows the shortest window; resets follow whichever comes first", () => {
  const meter = metersOf(source("claude", [win("5h", 30, 5, 3 * HOUR), win("7d", 80, 168, HOUR)]))[0]!;
  assert.deepEqual(meterTiming(meter, "hour", NOW, NOW), { window: meter.primary, idleFrom: NOW + 3 * HOUR });
  assert.equal(meterTiming(meter, "reset", NOW, NOW).idleFrom, NOW + HOUR);
});

test("an idle weekly window is due at once while the short one runs", () => {
  const meter = metersOf(source("claude", [win("5h", 30, 5, 3 * HOUR), win("7d", 0, 168)]))[0]!;
  assert.deepEqual(meterTiming(meter, "reset", NOW, NOW).idleFrom, 0);
});

test("the reading without an end time says nothing about when", () => {
  const meter = metersOf(source("claude", [win("5h", 30, 5)]))[0]!;
  assert.equal(meterTiming(meter, "hour", NOW, NOW).idleFrom, undefined);
});

test("a used-up window holds its meter until its reset", () => {
  const google = win("google-weekly", 4, 168, 86 * HOUR);
  const meters = metersOf(source("antigravity", [google, win("google-5h", 0, 5, 5 * HOUR), win("third-party-weekly", 100, 168, 111 * HOUR), win("third-party-5h", 0, 5, 5 * HOUR)]));
  assert.equal(exhaustedUntil(meters[0]!, NOW), undefined);
  assert.equal(exhaustedUntil(meters[1]!, NOW), NOW + 111 * HOUR);
});

test("a used-up window past its reset holds nothing; without a reset it holds indefinitely", () => {
  assert.equal(exhaustedUntil(metersOf(source("a", [win("5h", 100, 5, -1)]))[0]!, NOW), undefined);
  assert.equal(exhaustedUntil(metersOf(source("a", [win("5h", 100, 5)]))[0]!, NOW), Infinity);
});
