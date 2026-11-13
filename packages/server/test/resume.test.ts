import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createResumeScheduler,
  planResume,
  providerStatedWait,
  rateLimitNoticeHint,
  REQUEST_RETRY_BACKOFF_SEC,
  REQUEST_RETRY_MAX_ATTEMPTS,
  RESUME_FALLBACK_BACKOFF_SEC,
  RESUME_MIN_WAIT_SEC,
  withProviderStatedWait,
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

test("a refused request retries on the quick ladder and keeps one chain across a resend", () => {
  const first = planResume({ hint: { scope: "request" }, userMessageSeq: 5, now: NOW });
  assert.ok(first);
  assert.equal(first!.attempt, 1);
  assert.equal(first!.maxAttempts, REQUEST_RETRY_MAX_ATTEMPTS);
  assert.equal(first!.resumeAt, NOW + REQUEST_RETRY_BACKOFF_SEC[0]! * 1000);

  // The auto-resume resend appends a new (hidden) user message. The anchor is
  // what keeps it the same chain, so the counter still advances past it.
  const second = planResume({
    hint: { scope: "request" },
    userMessageSeq: 9,
    anchorSeq: 5,
    previous: { attempt: first!.attempt, userMessageSeq: 5 },
    now: NOW,
  });
  assert.ok(second);
  assert.equal(second!.attempt, 2);
  assert.equal(second!.resumeAt, NOW + REQUEST_RETRY_BACKOFF_SEC[1]! * 1000);
  assert.equal(second!.userMessageSeq, 9);
});

test("a refused request stops retrying once its bounded budget is spent", () => {
  assert.equal(
    planResume({
      hint: { scope: "request" },
      userMessageSeq: 5,
      previous: { attempt: REQUEST_RETRY_MAX_ATTEMPTS, userMessageSeq: 5 },
      now: NOW,
    }),
    null,
  );
  // The bound is a hint property too, so an adapter can tighten or widen it.
  assert.equal(
    planResume({
      hint: { scope: "request", maxAttempts: 2 },
      userMessageSeq: 5,
      previous: { attempt: 2, userMessageSeq: 5 },
      now: NOW,
    }),
    null,
  );
});

test("provider capacity retries stay unbounded past the request budget", () => {
  const state = planResume({
    hint: { scope: "quota" },
    userMessageSeq: 5,
    previous: { attempt: REQUEST_RETRY_MAX_ATTEMPTS + 6, userMessageSeq: 5 },
    now: NOW,
  });
  assert.ok(state);
  assert.equal(state!.attempt, REQUEST_RETRY_MAX_ATTEMPTS + 7);
  assert.equal(state!.maxAttempts, undefined);
});

test("Command Code rate-limit notices retain their provider wait", () => {
  assert.deepEqual(
    rateLimitNoticeHint("[rate-limit] Claude · five hour · 99% of window used · resets in 2h 53m."),
    { scope: "rate", provider: "anthropic", retryAfterSec: 10_380 },
  );
  assert.deepEqual(
    rateLimitNoticeHint("Error: You've reached your 5-hour usage limit. Resets in 28m (11:15 AM)."),
    { scope: "rate", provider: "commandcode", retryAfterSec: 1680 },
  );
  assert.deepEqual(
    rateLimitNoticeHint("You've reached your weekly usage limit. Resets in 2d 5h (Sat 11:15 AM)."),
    { scope: "rate", provider: "commandcode", retryAfterSec: 190_800 },
  );
  assert.deepEqual(
    rateLimitNoticeHint("[rate-limit] Commandcode · resets in 0:28"),
    { scope: "rate", provider: "commandcode", retryAfterSec: 28 },
  );
  assert.equal(rateLimitNoticeHint("rate limits are worth monitoring"), null);
});

test("a provider-stated reset in the error text replaces the blind fallback ladder", () => {
  // Live OpenCode Go 429 relayed by Pi: the adapter classified the failure but
  // carried no wait, so attempt 29 used to wait 15 min against a ~2 h window.
  const error = '429: {"type":"GoUsageLimitError","message":"OpenCode Go usage limit reached (5-hour, resets in 1h 51m). To keep going now, turn on Extra Usage."}';
  const hint = withProviderStatedWait({ scope: "rate", provider: "opencode-go", retryable: true }, error, NOW);
  assert.deepEqual(hint, { scope: "rate", provider: "opencode-go", retryable: true, retryAfterSec: 6660 });
  const state = planResume({ hint, userMessageSeq: 5, previous: { attempt: 28, userMessageSeq: 5 }, now: NOW });
  assert.equal(state!.resumeAt, NOW + 6660_000);
  assert.equal(state!.attempt, 29);
});

test("providerStatedWait reads the common provider phrasings and ignores vague ones", () => {
  assert.deepEqual(providerStatedWait("Rate limit reached. Please try again in 20s.", NOW), { retryAfterSec: 20 });
  assert.deepEqual(providerStatedWait("Too many requests; retry after 2 minutes and 30 seconds", NOW), { retryAfterSec: 150 });
  assert.deepEqual(providerStatedWait("quota window resets in 1:05:00", NOW), { retryAfterSec: 3900 });
  assert.deepEqual(providerStatedWait("Please try again in 500ms", NOW), { retryAfterSec: 1 });
  const at = new Date(NOW + 90 * 60_000).toISOString();
  assert.deepEqual(providerStatedWait(`usage limit hit, resets at ${at}`, NOW), { resetAt: NOW + 90 * 60_000, retryAfterSec: 5400 });
  assert.equal(providerStatedWait("Upstream provider is temporarily unavailable. Please try again in a moment.", NOW), undefined);
  assert.equal(providerStatedWait("429 too many requests", NOW), undefined);
  assert.equal(providerStatedWait(`resets at ${new Date(NOW - 60_000).toISOString()}`, NOW), undefined);
});

test("an adapter-parsed wait, a bounded request retry or a final stop keep their own hint", () => {
  const text = "rate limited, resets in 2h";
  const parsed = { scope: "rate" as const, retryAfterSec: 30 };
  assert.equal(withProviderStatedWait(parsed, text, NOW), parsed);
  const reset = { scope: "rate" as const, resetAt: NOW + 1000 };
  assert.equal(withProviderStatedWait(reset, text, NOW), reset);
  const request = { scope: "request" as const, retryable: true };
  assert.equal(withProviderStatedWait(request, text, NOW), request);
  const final = { scope: "quota" as const, retryable: false };
  assert.equal(withProviderStatedWait(final, text, NOW), final);
  assert.deepEqual(withProviderStatedWait({ scope: "rate" }, undefined, NOW), { scope: "rate" });
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
