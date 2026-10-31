import assert from "node:assert/strict";
import test from "node:test";
import { commandCodeExitFailure } from "../src/runtime.ts";

test("Command Code classifies documented auth, rate and credit exits", () => {
  assert.deepEqual(commandCodeExitFailure(3, "", undefined), {
    error: "Command Code authentication is required",
    code: "auth-expired",
  });
  assert.deepEqual(commandCodeExitFailure(5, "", undefined), {
    error: "Command Code rate limit reached",
    code: "rate-limited",
    retry: { scope: "rate", provider: "commandcode" },
  });
  assert.deepEqual(commandCodeExitFailure(10, "", undefined), {
    error: "Command Code credits are insufficient",
    code: "quota-exhausted",
    retry: { scope: "quota", provider: "commandcode", retryable: false },
  });
});

test("generic server/network exits stay unknown instead of inventing capacity semantics", () => {
  for (const code of [1, 4, 6, 7, 8, 9]) {
    const failure = commandCodeExitFailure(code, "", undefined);
    assert.equal(failure.code, "unknown");
    assert.equal(failure.retry, undefined);
  }
});

test("a refused provider request is classified as a bounded retry", () => {
  const refused = commandCodeExitFailure(
    7,
    '400: {"message":"{\\"message\\":\\"invalid request error trace_id: abc\\"}"}',
    undefined,
  );
  assert.equal(refused.code, "unknown");
  assert.deepEqual(refused.retry, { scope: "request", provider: "commandcode", retryable: true });
  // The attempt cap belongs to the server's resume policy, not the adapter.
  assert.equal(refused.retry?.maxAttempts, undefined);

  // Resending cannot fix a payload that does not fit or a server-side refusal
  // that carries no request-error signature; both stay hard failures.
  assert.equal(
    commandCodeExitFailure(7, "context_length_exceeded: prompt is too large", undefined).retry,
    undefined,
  );
  assert.equal(
    commandCodeExitFailure(7, "402: upstream request failed: insufficient account funds", undefined).retry,
    undefined,
  );
});

test("native failure diagnostics are secret-redacted", () => {
  const failure = commandCodeExitFailure(5, "token=super-secret\nplease retry", undefined);
  assert.doesNotMatch(failure.error, /super-secret/);
  assert.match(failure.error, /token=\[redacted\]/i);
});

test("native result error wins over stderr while remaining redacted", () => {
  const failure = commandCodeExitFailure(10, "token=stderr-secret", {
    error: "api_key=result-secret",
  });
  assert.equal(failure.code, "quota-exhausted");
  assert.doesNotMatch(failure.error, /result-secret|stderr-secret/);
  assert.match(failure.error, /api_key=\[redacted\]/i);
});

test("Command Code exit 5 parses duration and reset timestamp from usage limit stderr", () => {
  const now = 1_700_000_000_000;
  const failure = commandCodeExitFailure(
    5,
    "Error: You've reached your 5-hour usage limit. Resets in 28m (11:15 AM).\nLearn more at https://example.com",
    undefined,
    undefined,
    now,
  );
  assert.equal(failure.code, "rate-limited");
  assert.deepEqual(failure.retry, {
    scope: "rate",
    provider: "commandcode",
    retryAfterSec: 1680,
    resetAt: now + 1680_000,
  });
});

test("Command Code exit 5 identifies provider from model limit error", () => {
  const now = 1_700_000_000_000;
  const failure = commandCodeExitFailure(
    5,
    "",
    { error: "You've reached today's limit on claude-3-5-sonnet. Resets in 2h 53m (4:00 PM)." },
    undefined,
    now,
  );
  assert.equal(failure.code, "rate-limited");
  assert.deepEqual(failure.retry, {
    scope: "rate",
    provider: "anthropic",
    retryAfterSec: 10_380,
    resetAt: now + 10_380_000,
  });
});

test("Command Code parses days, colon duration and ISO reset in rate limit notices", () => {
  const now = 1_700_000_000_000;
  const weekly = commandCodeExitFailure(5, "Resets in 2d 5h (Sat 11:15 AM).", undefined, undefined, now);
  assert.equal(weekly.retry?.retryAfterSec, 190_800);

  const daily = commandCodeExitFailure(5, "Resets in 1d (Thu 11:15 AM).", undefined, undefined, now);
  assert.equal(daily.retry?.retryAfterSec, 86_400);

  const seconds = commandCodeExitFailure(5, "Resets in 0:28", undefined, undefined, now);
  assert.equal(seconds.retry?.retryAfterSec, 28);

  const minutesColon = commandCodeExitFailure(5, "Resets in 28:00", undefined, undefined, now);
  assert.equal(minutesColon.retry?.retryAfterSec, 1680);

  const iso = commandCodeExitFailure(5, "resets at 2026-10-15T11:15:00.000Z", undefined, undefined, now);
  assert.equal(iso.retry?.resetAt, Date.parse("2026-10-15T11:15:00.000Z"));
});

test("Command Code uses failure fallback when stderr is empty", () => {
  const now = 1_700_000_000_000;
  const failure = commandCodeExitFailure(
    5,
    "",
    undefined,
    "Error: You've reached your 5-hour usage limit. Resets in 28m (11:15 AM).",
    now,
  );
  assert.equal(failure.code, "rate-limited");
  assert.equal(failure.retry?.retryAfterSec, 1680);
});

test("generic exit with rate limit message and reset time is classified as rate-limited", () => {
  const now = 1_700_000_000_000;
  const failure = commandCodeExitFailure(
    null,
    "429 Too Many Requests: usage limit reached, resets in 30s",
    undefined,
    undefined,
    now,
  );
  assert.equal(failure.code, "rate-limited");
  assert.equal(failure.retry?.retryAfterSec, 30);
});
