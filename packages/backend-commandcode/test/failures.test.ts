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
