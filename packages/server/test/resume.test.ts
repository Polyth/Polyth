import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createResumeScheduler,
  planResume,
  rateLimitNoticeHint,
  RESUME_FALLBACK_BACKOFF_SEC,
  RESUME_MIN_WAIT_SEC,
} from "../src/resume.ts";

const NOW = 1_700_000_000_000;

test("planResume honours a provider-advised wait in full", () => {
  const state = planResume({
    hint: { scope: "rate", provider: "anthropic", retryAfterSec: 3600 },
    userMessageSeq: 12,
    now: NOW,
  });
  assert.deepEqual(state, {
    resumeAt: NOW + 3600_000,
    scope: "rate",
    provider: "anthropic",
    retryAfterSec: 3600,
    attempt: 1,
    userMessageSeq: 12,
  });
});

test("planResume honours retryAfterSec 90", () => {
  const state = planResume({
    hint: { scope: "rate", retryAfterSec: 90 },
    userMessageSeq: 1,
    now: NOW,
  });
  assert.ok(state);
  assert.equal(state!.resumeAt, NOW + 90_000);
});

test("planResume uses resetAt with buffer", () => {
  const resetAt = NOW + 60_000;
  const state = planResume({
    hint: { scope: "rate", resetAt },
    userMessageSeq: 2,
    now: NOW,
  });
  assert.ok(state);
  assert.equal(state!.resetAt, resetAt);
  assert.equal(state!.resumeAt, resetAt + 2000);
});

test("planResume returns null when retryable is false", () => {
  assert.equal(
    planResume({ hint: { scope: "rate", retryable: false }, userMessageSeq: 1, now: NOW }),
    null,
  );
});

test("planResume floors a tiny advised wait so it cannot hot-loop", () => {
  const state = planResume({
    hint: { scope: "rate", retryAfterSec: 1 },
    userMessageSeq: 3,
    now: NOW,
  });
  assert.ok(state);
  assert.equal(state!.resumeAt, NOW + RESUME_MIN_WAIT_SEC * 1000);
});

test("planResume escalates the backoff across attempts when no wait is advised", () => {
  const first = planResume({ hint: { scope: "overloaded" }, userMessageSeq: 5, now: NOW });
  assert.ok(first);
  assert.equal(first!.attempt, 1);
  assert.equal(first!.resumeAt, NOW + RESUME_FALLBACK_BACKOFF_SEC[0]! * 1000);

  const second = planResume({
    hint: { scope: "overloaded" },
    userMessageSeq: 5,
    previous: { attempt: first!.attempt, userMessageSeq: 5 },
    now: NOW,
  });
  assert.ok(second);
  assert.equal(second!.attempt, 2);
  assert.equal(second!.resumeAt, NOW + RESUME_FALLBACK_BACKOFF_SEC[1]! * 1000);
});

test("planResume resets the attempt counter for a different message", () => {
  const state = planResume({
    hint: { scope: "rate" },
    userMessageSeq: 9,
    previous: { attempt: 4, userMessageSeq: 5 },
    now: NOW,
  });
  assert.ok(state);
  assert.equal(state!.attempt, 1);
});

test("Command Code rate-limit notices retain their provider wait", () => {
  assert.deepEqual(
    rateLimitNoticeHint("[rate-limit] Claude · five hour · 99% of window used · resets in 2h 53m."),
    { scope: "rate", provider: "anthropic", retryAfterSec: 10_380 },
  );
  assert.equal(rateLimitNoticeHint("rate limits are worth monitoring"), null);
});

test("scheduler fires once after the delay and can be cancelled", async () => {
  const fired: string[] = [];
  const scheduler = createResumeScheduler({ fire: (id) => { fired.push(id); } });

  scheduler.arm("s1", Date.now() + 15);
  assert.equal(scheduler.has("s1"), true);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(fired, ["s1"]);
  assert.equal(scheduler.has("s1"), false);

  scheduler.arm("s2", Date.now() + 20);
  scheduler.cancel("s2");
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(fired, ["s1"]);
  scheduler.stop();
});

test("scheduler re-arm replaces the previous timer", async () => {
  const fired: string[] = [];
  const scheduler = createResumeScheduler({ fire: (id) => { fired.push(id); } });
  scheduler.arm("s1", Date.now() + 10);
  scheduler.arm("s1", Date.now() + 40);
  await new Promise((r) => setTimeout(r, 25));
  assert.deepEqual(fired, []);
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(fired, ["s1"]);
  scheduler.stop();
});
