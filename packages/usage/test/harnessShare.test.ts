import test from "node:test";
import assert from "node:assert/strict";
import { buildUsageStatsReport } from "../src/analytics/aggregate.ts";
import type { UsageObservation } from "../src/analytics/contracts.ts";
import {
  HARNESS_TONES,
  harnessShares,
  ringSegmentPath,
  ringSegments,
} from "../widgets/usage/harnessShare.ts";

const observation = (
  id: string,
  harnessId: string | undefined,
  input: number,
  over: Partial<UsageObservation> = {},
): UsageObservation => ({
  id,
  timestamp: Date.UTC(2026, 6, 1, 12),
  projectId: "project-a",
  sessionId: `session-${id}`,
  turnId: `turn-${id}`,
  ...(harnessId ? { harnessId } : {}),
  tokens: { input, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  quality: "exact",
  ...over,
});

const groupsFor = (observations: UsageObservation[]) => buildUsageStatsReport({
  serverInstanceId: "server-test",
  spaceId: "space-test",
  query: { range: "custom", from: Date.UTC(2026, 6, 1), to: Date.UTC(2026, 6, 2), timezone: "UTC" },
  observations,
  projects: [{ id: "project-a", name: "Project A" }],
  sessions: new Map(),
  now: Date.UTC(2026, 6, 10),
}).harnesses;

test("shares are relative to the plotted total, ranked by value, and add up to one", () => {
  const shares = harnessShares(groupsFor([
    observation("a", "codex", 30),
    observation("b", "claude", 60),
    observation("c", "cursor", 10),
  ]), "tokens");
  assert.deepEqual(shares.rows.map((row) => row.id), ["claude", "codex", "cursor"]);
  assert.deepEqual(shares.rows.map((row) => row.share), [.6, .3, .1]);
  assert.equal(shares.total, 100);
  assert.equal(shares.totalComplete, true);
  assert.ok(Math.abs(shares.rows.reduce((sum, row) => sum + (row.share ?? 0), 0) - 1) < 1e-12);
  assert.equal(shares.rows[0]?.label, "Claude Code");
  assert.equal(shares.rows[0]?.sessions, 1);
});

test("a harness keeps its tone when the metric changes and the unknown harness stays neutral", () => {
  const groups = groupsFor([
    observation("a", "codex", 60),
    observation("b", "claude", 30, { turnId: undefined }),
    observation("c", undefined, 500),
  ]);
  const tones = (metric: "tokens" | "turns") =>
    Object.fromEntries(harnessShares(groups, metric).rows.map((row) => [row.id, row.tone]));
  // Ranked by tokens, not by id: codex is bigger than claude.
  assert.deepEqual(tones("tokens"), { unknown: 0, codex: 1, claude: 2 });
  // Turns rank differently (the claude turn ids are missing) but the tones do not move.
  assert.deepEqual(tones("turns"), tones("tokens"));
});

test("the neutral tone goes to the smallest harnesses once the palette runs out", () => {
  const ids = Array.from({ length: HARNESS_TONES + 2 }, (_, index) => `h${String(index).padStart(2, "0")}`);
  // h00 is the smallest and h09 the largest.
  const shares = harnessShares(groupsFor(ids.map((id, index) => observation(id, id, index + 1))), "tokens");
  const tones = new Map(shares.rows.map((row) => [row.id, row.tone]));
  assert.deepEqual(ids.map((id) => tones.get(id)), [0, 0, 8, 7, 6, 5, 4, 3, 2, 1]);
});

test("equal token totals rank by activity, then id, so tones stay deterministic", () => {
  const shares = harnessShares(groupsFor([
    observation("a", "zeta", 10),
    observation("b", "alpha", 10),
    observation("c", "busy", 5),
    observation("d", "busy", 5),
  ]), "tokens");
  assert.deepEqual(Object.fromEntries(shares.rows.map((row) => [row.id, row.tone])), { busy: 1, alpha: 2, zeta: 3 });
});

test("a harness with nothing to plot for the metric stays listed without a slice", () => {
  const shares = harnessShares(groupsFor([
    observation("a", "claude", 10, { cost: 2 }),
    observation("b", "codex", 20),
  ]), "cost");
  assert.deepEqual(shares.rows.map((row) => [row.id, row.value, row.share]), [
    ["claude", 2, 1],
    ["codex", null, null],
  ]);
  assert.equal(shares.total, 2);
  // Codex's unknown cost makes the plotted total a lower bound.
  assert.equal(shares.totalComplete, false);
  assert.equal(shares.rows[1]?.complete, false);
});

test("no plotted value leaves the rows without a total", () => {
  const shares = harnessShares(groupsFor([observation("a", "claude", 10)]), "cost");
  assert.equal(shares.total, null);
  assert.equal(shares.rows.length, 1);
  assert.equal(shares.rows[0]?.share, null);
  assert.deepEqual(harnessShares([], "tokens"), { rows: [], total: null, totalComplete: true });
});

test("ring segments are consecutive arcs from 12 o'clock and skip unplotted rows", () => {
  // A quarter turn: outer arc 12 → 3 o'clock, radial edge, inner arc back to 12 o'clock.
  assert.equal(
    ringSegmentPath(0, .25),
    "M 50 4 A 46 46 0 0 1 96 50 L 80 50 A 30 30 0 0 0 50 20 Z",
  );
  assert.match(ringSegmentPath(0, .75), /A 46 46 0 1 1 /);

  const shares = harnessShares(groupsFor([
    observation("a", "claude", 50, { cost: 1 }),
    observation("b", "codex", 50, { cost: 1 }),
    observation("c", "cursor", 5),
  ]), "cost");
  const segments = ringSegments(shares.rows);
  assert.deepEqual(segments.map((segment) => segment.row.id), ["claude", "codex"]);
  // The first half ends at 6 o'clock, exactly where the second begins.
  assert.match(segments[0]!.path, /^M 50 4 A 46 46 0 0 1 50 96 /);
  assert.match(segments[1]!.path, /^M 50 96 A 46 46 0 0 1 50 4 /);
});

test("a single harness is a full ring rather than a collapsed arc", () => {
  const [segment, ...rest] = ringSegments(harnessShares(groupsFor([observation("a", "claude", 5)]), "tokens").rows);
  assert.equal(rest.length, 0);
  assert.equal(segment?.path, ringSegmentPath(0, 1));
  // Two half arcs per edge; a lone arc with coinciding endpoints would draw nothing.
  assert.equal(segment?.path.match(/A /g)?.length, 4);
  assert.match(segment!.path, /Z$/);
});
