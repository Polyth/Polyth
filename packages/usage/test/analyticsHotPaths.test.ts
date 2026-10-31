import test from "node:test";
import assert from "node:assert/strict";
import type { JsonObject, Project, SessionEvent, SessionProjection, SpaceContext } from "@polyth/contracts";
import { createLocalDateKeyer, localDateKey } from "../src/analytics/time.ts";
import { deriveUsageTiming, type UsageInterval } from "../src/analytics/timing.ts";
import { createUsageAnalyticsService } from "../src/analytics/service.ts";

/** Deterministic PRNG so a failure reproduces. */
const random = (seed: number) => () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
  return seed / 2 ** 31;
};

test("slot-cached local dates match exact conversion across DST, half-hour and 45-minute offsets", () => {
  const zones = ["UTC", "Europe/Kyiv", "America/New_York", "America/St_Johns", "Asia/Kathmandu", "Australia/Lord_Howe", "Pacific/Chatham", "America/Santiago"];
  const transitions = [Date.UTC(2026, 2, 8), Date.UTC(2026, 2, 29), Date.UTC(2026, 3, 5), Date.UTC(2026, 8, 6), Date.UTC(2026, 9, 25), Date.UTC(2026, 10, 1)];
  const next = random(7);
  for (const timezone of zones) {
    const keyer = createLocalDateKeyer(timezone);
    // Every 7 minutes for two days around each transition, then random instants over five years.
    for (const day of transitions) {
      for (let at = day - 86_400_000; at < day + 86_400_000; at += 7 * 60_000 + 13) {
        assert.equal(keyer(at), localDateKey(at, timezone), `${timezone} @ ${new Date(at).toISOString()}`);
      }
    }
    for (let index = 0; index < 2_000; index += 1) {
      const at = Date.UTC(2022, 0, 1) + Math.floor(next() * 5 * 365 * 86_400_000);
      assert.equal(keyer(at), localDateKey(at, timezone), `${timezone} @ ${new Date(at).toISOString()}`);
    }
  }
});

/** The previous quadratic definition, kept as the oracle. */
const referenceTtft = (start: number, end: number, tools: readonly UsageInterval[], times: readonly number[]): number | null => {
  const sorted = tools.filter((tool) => tool.end > tool.start).sort((a, b) => a.start - b.start);
  const segments: UsageInterval[] = [];
  let cursor = start;
  for (const tool of sorted) {
    const from = Math.max(start, tool.start);
    const to = Math.min(end, tool.end);
    if (to <= from) continue;
    if (from > cursor) segments.push({ start: cursor, end: from });
    cursor = Math.max(cursor, to);
  }
  if (cursor < end) segments.push({ start: cursor, end });
  const ttfts = segments
    .map((segment) => times.filter((time) => time >= segment.start && time < segment.end).sort((a, b) => a - b)[0])
    .map((first, index) => first === undefined ? undefined : first - segments[index]!.start)
    .filter((value): value is number => value !== undefined);
  return ttfts.length ? ttfts.reduce((sum, value) => sum + value, 0) / ttfts.length : null;
};

test("time-to-first-token is unchanged by the sorted search", () => {
  const next = random(11);
  for (let round = 0; round < 400; round += 1) {
    const start = 1_000;
    const end = start + 1 + Math.floor(next() * 60_000);
    const tools = Array.from({ length: Math.floor(next() * 12) }, () => {
      const at = start - 2_000 + Math.floor(next() * (end - start + 4_000));
      return { start: at, end: at + Math.floor(next() * 8_000) - 500 };
    });
    // Unsorted, duplicated and out-of-turn chunk times.
    const times = Array.from({ length: Math.floor(next() * 300) }, () => start - 1_000 + Math.floor(next() * (end - start + 2_000)));
    const timing = deriveUsageTiming({ start, end, toolIntervals: tools, assistantTimes: times });
    assert.equal(timing?.ttftMs ?? null, referenceTtft(start, end, tools, times), `round ${round}`);
  }
});

const space: SpaceContext = {
  spaceId: "space-cache",
  spaceSlug: "space-cache",
  userId: "user",
  role: "owner",
  deployment: "local-trusted",
  storageDir: "/unused",
};
const projects: Project[] = [{ id: "project-a", name: "Project A", path: "/a", createdAt: 1 }];
const event = (seq: number, time: number, type: string, data: JsonObject): SessionEvent => ({
  id: `a-${seq}`, sessionId: "a", seq, time, type, data, v: 1,
});

test("an unchanged scope reuses its built report and a new event or a new day rebuilds it", async () => {
  const day = Date.UTC(2026, 6, 10, 9);
  let clock = day;
  const projection: SessionProjection = {
    id: "a", projectId: "project-a", title: "A", status: "idle", createdAt: 1, updatedAt: 5, resolvedHarnessId: "claude",
  };
  const events: SessionEvent[] = [
    event(1, day - 60_000, "turn/started", { turnId: "t1" }),
    event(2, day - 50_000, "usage/recorded", { tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } }),
    event(3, day - 40_000, "turn/stopped", { turnId: "t1", reason: "completed" }),
  ];
  const service = createUsageAnalyticsService({
    source: {
      projections: async () => [projection],
      events: async () => [...events],
      latestSeq: async () => events.at(-1)!.seq,
    },
    now: () => clock,
    serverInstanceId: "server",
  });
  const query = { range: "30d" as const, timezone: "UTC", detailLimit: 10, detailSort: "activity" as const };
  const first = await service.query(space, projects, query);
  clock += 60_000;
  const second = await service.query(space, projects, query);
  assert.equal(second.totals, first.totals, "the same build is served");
  assert.equal(second.generatedAt, clock, "but its clock is current");
  assert.equal(second.coverage.syncedAt, clock);

  events.push(event(4, clock - 1_000, "usage/recorded", { turnId: "t1", tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }));
  const third = await service.query(space, projects, query);
  assert.notEqual(third.totals, second.totals);
  assert.equal(third.totals.tokens.total, 17);

  clock = day + 86_400_000;
  const nextDay = await service.query(space, projects, query);
  assert.notEqual(nextDay.totals, third.totals, "a new local day moves the preset range");
  assert.ok(nextDay.effective.from > third.effective.from);

  // All-time reports reuse their build too, with the open end following the clock.
  const all = await service.query(space, projects, { ...query, range: "all" });
  clock += 1_000;
  const allAgain = await service.query(space, projects, { ...query, range: "all" });
  assert.equal(allAgain.totals, all.totals);
  assert.equal(allAgain.effective.to, clock + 1);
  assert.equal(allAgain.chart.buckets.at(-1)?.end, clock + 1);
  service.stop();
});

test("a renamed session invalidates the cached report that lists it", async () => {
  const day = Date.UTC(2026, 6, 10, 9);
  const projection: SessionProjection = {
    id: "a", projectId: "project-a", title: "Before", status: "idle", createdAt: 1, updatedAt: 5,
  };
  const events = [
    event(1, day - 60_000, "turn/started", { turnId: "t1" }),
    event(2, day - 50_000, "usage/recorded", { tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } }),
  ];
  const service = createUsageAnalyticsService({
    source: { projections: async () => [{ ...projection }], events: async () => events, latestSeq: async () => 2 },
    now: () => day,
    serverInstanceId: "server",
  });
  const query = { range: "30d" as const, timezone: "UTC" };
  assert.equal((await service.query(space, projects, query)).sessions[0]?.title, "Before");
  projection.title = "After";
  assert.equal((await service.query(space, projects, query)).sessions[0]?.title, "After");
  service.stop();
});
