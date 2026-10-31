import assert from "node:assert/strict";
import test from "node:test";
import type { SessionCacheFacts } from "../src/analytics/sessionCache.ts";
import {
  createKeepWarmController,
  estimateKeepAlives,
  keepAliveLeadMs,
  planKeepWarm,
  PING_SETTLE_MS,
  type KeepWarmEntry,
} from "../src/keepWarm.ts";

const MIN = 60_000;
const TTL = 5 * MIN;

const facts = (lastActivityAt: number, extra: Partial<SessionCacheFacts> = {}, ttlMs: number | null = TTL): SessionCacheFacts => ({
  health: { lastActivityAt, ttlMs, ttlBasis: "provider-default", cachedTokens: 80_000, burn: { rewrites: 0, tokens: 0 } },
  lastRead: 80_000,
  ...extra,
});
const entry = (patch: Partial<KeepWarmEntry> = {}): KeepWarmEntry => ({
  sessionId: "s1", startedAt: 0, until: 60 * MIN, sent: 0, misses: 0, ...patch,
});

test("the lead covers a long last answer after a person's turn and a measured ping after our own", () => {
  assert.equal(keepAliveLeadMs(TTL, false), 90_000);
  assert.equal(keepAliveLeadMs(TTL, true, 3_000), 20_000, "a fast OK keeps the 20 s floor");
  assert.equal(keepAliveLeadMs(TTL, true, 15_000), 40_000);
  assert.equal(keepAliveLeadMs(TTL, true, 50_000), 60_000, "capped at a minute");
  assert.equal(keepAliveLeadMs(90_000, false), 30_000, "never more than a third of a short lifetime");
});

test("a keep-alive goes out only once the cache is about to lapse", () => {
  // Person's turn ended at t=0: cache lapses at 5 min, ping due 90 s before.
  assert.deepEqual(planKeepWarm(entry(), facts(0), MIN), { action: "wait", at: TTL - 90_000 });
  assert.deepEqual(planKeepWarm(entry(), facts(0), TTL - 90_000), { action: "ping" });
  // After our own measured ping the next one waits until 20 s before expiry.
  const afterPing = entry({ lastPingActivityAt: 10 * MIN, latencyMs: 4_000 });
  assert.deepEqual(planKeepWarm(afterPing, facts(10 * MIN), 11 * MIN), { action: "wait", at: 15 * MIN - 20_000 });
});

test("nothing is sent when the cache outlives the period, is cold, or has no known lifetime", () => {
  assert.deepEqual(planKeepWarm(entry({ until: 4 * MIN }), facts(0), MIN), { action: "wait", at: 4 * MIN });
  assert.deepEqual(planKeepWarm(entry(), facts(0), 6 * MIN), { action: "wait", at: 7 * MIN, cold: true });
  assert.deepEqual(planKeepWarm(entry(), facts(0, {}, null), MIN), { action: "stop", reason: "unknown-ttl" });
  assert.deepEqual(planKeepWarm(entry(), null, MIN), { action: "stop", reason: "no-cache" });
  assert.deepEqual(planKeepWarm(entry({ until: MIN }), facts(0), MIN), { action: "stop", reason: "period-ended" });
});

test("a sent keep-alive settles on its observed cache read, or as a miss", () => {
  const pending = entry({ pendingPingAt: 4 * MIN });
  assert.deepEqual(planKeepWarm(pending, facts(0), 4 * MIN + 2_000), { action: "wait", at: 4 * MIN + 7_000 });
  assert.deepEqual(planKeepWarm(pending, facts(4 * MIN + 3_000, { previousCached: 80_000 }), 4 * MIN + 5_000),
    { action: "settled", activityAt: 4 * MIN + 3_000, latencyMs: 3_000, miss: false });
  assert.equal((planKeepWarm(pending, facts(4 * MIN + 3_000, { previousCached: 80_000, lastRead: 1_000 }), 4 * MIN + 5_000) as { miss: boolean }).miss, true,
    "a response that re-wrote the prefix missed the cache");
  assert.deepEqual(planKeepWarm(pending, facts(0), 4 * MIN + PING_SETTLE_MS),
    { action: "settled", activityAt: 4 * MIN, latencyMs: PING_SETTLE_MS, miss: true });
});

test("the estimate counts the pings a period needs", () => {
  assert.equal(estimateKeepAlives({ lastActivityAt: 0, ttlMs: TTL }, 4 * MIN, 0), 0);
  assert.equal(estimateKeepAlives({ lastActivityAt: 0, ttlMs: TTL }, 6 * MIN, 0), 1);
  // 1 hour: first at 3.5 min, then every 4 min 40 s until a cache reaches 60 min.
  assert.equal(estimateKeepAlives({ lastActivityAt: 0, ttlMs: TTL }, 60 * MIN, 0), 13);
  assert.equal(estimateKeepAlives({ lastActivityAt: 0, ttlMs: 60 * MIN }, 4 * 60 * MIN, 0), 4, "a one-hour cache needs a ping an hour");
  assert.equal(estimateKeepAlives({ lastActivityAt: 0, ttlMs: null }, 60 * MIN, 0), null);
});

test("the controller pings when due, skips a busy chat, verifies and stops at the end", async () => {
  let now = 0;
  let activity = 0;
  let busy = false;
  const sent: number[] = [];
  const stopped: string[] = [];
  const keepWarm = createKeepWarmController({
    now: () => now,
    facts: async () => facts(activity, { previousCached: 80_000 }),
    ready: async () => !busy,
    send: async () => { sent.push(now); },
    onStop: (id) => stopped.push(id),
  });
  keepWarm.start("s1", 12 * MIN);
  await keepWarm.tick();
  assert.equal(sent.length, 0, "nothing before the cache nears expiry");
  now = TTL - 90_000;
  busy = true;
  await keepWarm.tick();
  assert.equal(sent.length, 0, "a working chat keeps its own cache warm");
  busy = false;
  now += 5_000;
  await keepWarm.tick();
  assert.deepEqual(sent, [TTL - 85_000]);
  assert.equal(keepWarm.status("s1").sent, 1);
  // The OK lands 3 s later and read the cache; the next ping waits for its expiry.
  now += 5_000;
  activity = TTL - 82_000;
  await keepWarm.tick();
  assert.equal(sent.length, 1);
  const next = keepWarm.status("s1").nextAt!;
  assert.equal(next, activity + TTL - 20_000);
  now = next;
  await keepWarm.tick();
  assert.equal(sent.length, 2);
  activity = now + 3_000;
  now += 5_000;
  await keepWarm.tick();
  // That ping's cache outlives the 12-minute period: no third one.
  assert.equal(keepWarm.status("s1").nextAt, 12 * MIN);
  now = 12 * MIN;
  await keepWarm.tick();
  assert.deepEqual(keepWarm.status("s1"), { sessionId: "s1", active: false, stopped: { reason: "period-ended", at: 12 * MIN } });
  assert.deepEqual(stopped, ["s1"]);
});

test("a failed send is never retried and repeated misses stop the chat", async () => {
  let now = TTL - 90_000;
  const keepWarm = createKeepWarmController({
    now: () => now,
    facts: async () => facts(0),
    ready: async () => true,
    send: async () => { throw new Error("offline"); },
  });
  keepWarm.start("s1", 60 * MIN);
  await keepWarm.tick();
  assert.equal(keepWarm.status("s1").stopped?.reason, "send-failed");

  let sends = 0;
  const missing = createKeepWarmController({
    now: () => now,
    facts: async () => facts(0),
    ready: async () => true,
    send: async () => { sends += 1; },
  });
  missing.start("s2", 60 * MIN);
  now = TTL - 90_000;
  await missing.tick();
  now += PING_SETTLE_MS; // never observed: a miss; the cache is cold by now
  await missing.tick();
  assert.equal(missing.status("s2").active, true, "one miss is tolerated");
  assert.equal(missing.status("s2").cold, true);
  assert.equal(sends, 1);
  missing.cancel("s2");
  assert.equal(missing.status("s2").active, false);
  assert.equal(missing.status("s2").stopped?.reason, "cancelled");
});
