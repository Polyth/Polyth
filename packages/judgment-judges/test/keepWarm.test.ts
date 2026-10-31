import test from "node:test";
import assert from "node:assert/strict";
import type { SessionEvent, SessionProjection } from "@polyth/contracts";
import { sessionCacheFacts, type SessionCacheFacts } from "@polyth/usage/session-cache";
import { isKeepAlive, latestTurnEvidence } from "../src/evidence.ts";
import { createKeepWarm, KEEP_ALIVE_PROMPT, keepAliveBudget, planKeepAlive, type ArmedSession } from "../src/keepWarm.ts";

const MIN = 60_000;
const facts = (patch: Partial<SessionCacheFacts["health"]> = {}, extra: Partial<SessionCacheFacts> = {}): SessionCacheFacts => ({
  health: { lastActivityAt: 0, providerId: "anthropic", ttlMs: 5 * MIN, ttlBasis: "provider-default", cachedTokens: 80_000, burn: { rewrites: 0, tokens: 0 }, ...patch },
  lastRead: 80_000, ...extra,
});
const armed = (patch: Partial<ArmedSession> = {}): ArmedSession => ({
  sessionId: "s1", spaceId: "space-a", turnSeq: 10, probability: 0.9, armedAt: 0, budget: 3, minCachedTokens: 20_000, dailyLimit: 40, sent: 0, ...patch,
});

test("the budget is what the chance of coming back pays for, capped by the user", () => {
  // p × (1.25 − 0.1) / (0.1 + 0.02): 0.9 → 8, 0.5 → 4, 0.1 → 0.
  assert.equal(keepAliveBudget(0.9, 12), 8);
  assert.equal(keepAliveBudget(0.5, 12), 4);
  assert.equal(keepAliveBudget(0.1, 12), 0);
  assert.equal(keepAliveBudget(0.9, 3), 3);
});

test("a keep-alive is due just before expiry and never after it", () => {
  assert.deepEqual(planKeepAlive(armed(), facts(), 2 * MIN), { action: "wait", at: 4 * MIN });
  assert.deepEqual(planKeepAlive(armed(), facts(), 4 * MIN), { action: "ping" });
  assert.deepEqual(planKeepAlive(armed(), facts(), 5 * MIN), { action: "stop", reason: "expired" }, "a cold cache is not re-warmed: that is the cold start");
  // A 1-hour cache is pinged a minute ahead; a short one a fifth of its life ahead.
  assert.deepEqual(planKeepAlive(armed(), facts({ ttlMs: 60 * MIN }), 0), { action: "wait", at: 59 * MIN });
  assert.deepEqual(planKeepAlive(armed(), facts({ ttlMs: 2 * MIN }), 0), { action: "wait", at: 2 * MIN - 24_000 });
});

test("it stops instead of pinging forever", () => {
  assert.deepEqual(planKeepAlive(armed({ sent: 3 }), facts(), 4 * MIN), { action: "stop", reason: "budget" });
  assert.deepEqual(planKeepAlive(armed(), null, 4 * MIN), { action: "stop", reason: "no-cache" });
  assert.deepEqual(planKeepAlive(armed(), facts({ ttlMs: null, ttlBasis: "unknown" }), 4 * MIN), { action: "stop", reason: "unknown-ttl" });
  assert.deepEqual(planKeepAlive(armed(), facts({ cachedTokens: 5_000 }), 4 * MIN), { action: "stop", reason: "small-cache" });
  // The last keep-alive's response re-wrote the prefix instead of reading it: pinging is not holding this cache.
  const missed = facts({ lastActivityAt: 4 * MIN }, { lastRead: 1_000, previousCached: 80_000 });
  assert.deepEqual(planKeepAlive(armed({ sent: 1, lastPingAt: 4 * MIN }), missed, 5 * MIN), { action: "stop", reason: "miss" });
  assert.deepEqual(planKeepAlive(armed({ sent: 1, lastPingAt: 4 * MIN }), facts(), 4 * MIN + 30_000), { action: "stop", reason: "miss" },
    "a settled keep-alive that reported no cache use proves nothing is being held");
  const hit = facts({ lastActivityAt: 4 * MIN }, { lastRead: 80_000, previousCached: 80_000 });
  assert.deepEqual(planKeepAlive(armed({ sent: 1, lastPingAt: 4 * MIN }), hit, 5 * MIN), { action: "wait", at: 8 * MIN });
});

test("the controller pings when due, only when ready, within the daily limit, and drops a failed send", async () => {
  let now = 0, ready = true, cache: SessionCacheFacts | null = facts();
  const sent: string[] = [];
  let fail = false;
  const errors: unknown[] = [];
  const keep = createKeepWarm({
    now: () => now,
    facts: async () => cache,
    ready: async () => ready,
    send: async (id) => { if (fail) throw new Error("uncertain"); sent.push(id); },
    onError: (error) => errors.push(error),
  });
  keep.arm({ sessionId: "s1", spaceId: "space-a", turnSeq: 10, probability: 0.9, budget: 2, minCachedTokens: 20_000, dailyLimit: 3 });
  keep.arm({ sessionId: "zero", spaceId: "space-a", turnSeq: 10, probability: 0.1, budget: 0, minCachedTokens: 20_000, dailyLimit: 3 });
  assert.equal(keep.isArmed("zero"), false, "a zero budget never arms");
  await keep.tick();
  assert.deepEqual(sent, [], "not due yet");
  now = 4 * MIN; ready = false;
  await keep.tick();
  assert.deepEqual(sent, [], "a busy or waiting chat is skipped");
  ready = true;
  await keep.tick();
  assert.deepEqual(sent, ["s1"]);
  await keep.tick();
  assert.deepEqual(sent, ["s1"], "nothing more until our keep-alive's turn settles");
  assert.equal(keep.settlePing("s1"), true);
  assert.equal(keep.settlePing("s1"), false);
  cache = facts({ lastActivityAt: 4 * MIN });
  now = 8 * MIN;
  await keep.tick();
  assert.deepEqual(sent, ["s1", "s1"]);
  keep.settlePing("s1");
  cache = facts({ lastActivityAt: 8 * MIN });
  now = 12 * MIN;
  await keep.tick();
  assert.equal(keep.isArmed("s1"), false, "the budget is spent");
  assert.deepEqual(sent, ["s1", "s1"]);

  // Daily limit per Space.
  keep.arm({ sessionId: "s2", spaceId: "space-a", turnSeq: 10, probability: 0.9, budget: 5, minCachedTokens: 20_000, dailyLimit: 3 });
  cache = facts({ lastActivityAt: 12 * MIN }); now = 16 * MIN;
  await keep.tick(); keep.settlePing("s2");
  assert.equal(sent.length, 3);
  cache = facts({ lastActivityAt: 16 * MIN }); now = 20 * MIN;
  await keep.tick();
  assert.equal(sent.length, 3);
  assert.equal(keep.isArmed("s2"), false, "the Space's daily limit is reached");

  // A failed send is never retried.
  keep.arm({ sessionId: "s3", spaceId: "space-b", turnSeq: 10, probability: 0.9, budget: 5, minCachedTokens: 20_000, dailyLimit: 3 });
  fail = true;
  await keep.tick();
  assert.equal(keep.isArmed("s3"), false);
  assert.equal(errors.length, 1);
});

test("keep-alive turns are not the person's request", () => {
  const ev = (seq: number, type: string, data: Record<string, unknown>): SessionEvent =>
    ({ id: `e${seq}`, sessionId: "s1", seq, time: seq, type, data: data as never, v: 1 });
  const events = [
    ev(1, "user/message", { text: "Fix the bug" }),
    ev(2, "assistant/message", { text: "Should I also refactor it?" }),
    ev(3, "turn/stopped", { reason: "completed" }),
    ev(4, "user/message", { text: KEEP_ALIVE_PROMPT, hiddenUserMessage: true }),
    ev(5, "assistant/message", { text: "OK" }),
    ev(6, "turn/stopped", { reason: "completed" }),
  ];
  assert.equal(isKeepAlive(events[3]), true);
  assert.equal(isKeepAlive(ev(7, "user/message", { text: KEEP_ALIVE_PROMPT })), false, "only the hidden fixed prompt counts");
  const turn = latestTurnEvidence(events)!;
  assert.equal(turn.turnSeq, 3);
  assert.equal(turn.answer, "Should I also refactor it?");
});

test("usage exposes the facts the policy reads", () => {
  const projection = { id: "s1", projectId: "p", status: "idle", createdAt: 0, updatedAt: 0, model: { providerID: "anthropic", modelID: "claude" } } as unknown as SessionProjection;
  const usage = (seq: number, time: number, cacheRead: number, cacheWrite: number): SessionEvent =>
    ({ id: `u${seq}`, sessionId: "s1", seq, time, type: "usage/recorded", v: 1,
      data: { tokens: { input: 10, output: 5, cacheRead, cacheWrite }, model: { providerID: "anthropic", modelID: "claude" } } as never });
  const result = sessionCacheFacts(projection, [usage(1, 1_000, 0, 50_000), usage(2, 2_000, 50_000, 1_000)])!;
  assert.equal(result.health.ttlMs, 5 * MIN);
  assert.equal(result.health.cachedTokens, 51_000);
  assert.equal(result.lastRead, 50_000);
  assert.equal(result.previousCached, 50_000);
  assert.equal(sessionCacheFacts(projection, []), null);
});
