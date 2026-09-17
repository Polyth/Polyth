import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyProviderLimit,
  classifyProviderLimitNotice,
  isModelUnavailableError,
  parseRetryAfterSec,
} from "../src/providerLimit.ts";
import { modelUnavailableOf } from "../src/events.ts";

const NOW = 1_700_000_000_000;

test("Anthropic 429 rate limit with retry-after header", () => {
  const result = classifyProviderLimit(
    {
      name: "APIError",
      data: {
        message: "429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\"}}",
        providerID: "anthropic",
        statusCode: 429,
        responseHeaders: { "retry-after": "42" },
      },
    },
    NOW,
  );
  assert.deepEqual(result, {
    scope: "rate",
    provider: "anthropic",
    retryAfterSec: 42,
    resetAt: NOW + 42_000,
  });
});

test("Anthropic 529 overloaded_error", () => {
  const result = classifyProviderLimit(
    { name: "APIError", data: { message: "Overloaded", statusCode: 529 } },
    NOW,
  );
  assert.equal(result?.scope, "overloaded");
});

test("OpenAI insufficient_quota is a quota stop", () => {
  const result = classifyProviderLimit(
    {
      name: "APIError",
      data: {
        message:
          "You exceeded your current quota, please check your plan and billing details.",
        providerID: "openai",
        statusCode: 429,
      },
    },
    NOW,
  );
  assert.equal(result?.scope, "quota");
  assert.equal(result?.provider, "openai");
});

test("OpenAI 'Please try again in 20s' message wait", () => {
  const result = classifyProviderLimit(
    "Rate limit reached for gpt-4o. Please try again in 20s.",
    NOW,
  );
  assert.deepEqual(result, {
    scope: "rate",
    provider: "openai",
    retryAfterSec: 20,
    resetAt: NOW + 20_000,
  });
});

test("Google RESOURCE_EXHAUSTED with retryDelay", () => {
  const result = classifyProviderLimit(
    {
      name: "APIError",
      data: {
        message:
          "[429] Resource has been exhausted (e.g. check quota). \"retryDelay\": \"57s\"",
        providerID: "google",
      },
    },
    NOW,
  );
  assert.equal(result?.scope, "quota");
  assert.equal(result?.retryAfterSec, 57);
});

test("generic 429 with no advised delay still classifies (server picks backoff)", () => {
  const result = classifyProviderLimit({ data: { message: "HTTP 429 Too Many Requests" } }, NOW);
  assert.deepEqual(result, { scope: "rate" });
});

test("a bad API key is NOT a limit stop even if it mentions quota", () => {
  assert.equal(
    classifyProviderLimit({ data: { message: "Invalid API key provided; no quota available" } }, NOW),
    null,
  );
});

test("an ordinary tool failure is not a limit stop", () => {
  assert.equal(classifyProviderLimit({ data: { message: "ENOENT: no such file" } }, NOW), null);
  assert.equal(classifyProviderLimit("session error", NOW), null);
});

test("retry-after HTTP-date header resolves to a delta", () => {
  const inSixtySec = new Date(NOW + 60_000).toUTCString();
  assert.equal(
    parseRetryAfterSec("", { responseHeaders: { "retry-after": inSixtySec } }, NOW),
    60,
  );
});

test("x-ratelimit-reset epoch header resolves to a delta", () => {
  assert.equal(
    parseRetryAfterSec("", { headers: { "x-ratelimit-reset": String((NOW + 90_000) / 1000) } }, NOW),
    90,
  );
});

test("'try again in 1m30s' parses compound durations", () => {
  assert.equal(parseRetryAfterSec("try again in 1m30s", undefined, NOW), 90);
});

test("no parseable wait returns 0", () => {
  assert.equal(parseRetryAfterSec("please slow down", undefined, NOW), 0);
});

test("Command Code rate-limit reasoning gives the normal retry hint", () => {
  assert.deepEqual(
    classifyProviderLimitNotice("[rate-limit] Claude · five hour · 99% of window used · resets in 2h 53m."),
    { scope: "rate", provider: "anthropic", retryAfterSec: 10_380 },
  );
  assert.equal(classifyProviderLimitNotice("I mention a rate limit in passing"), null);
});

// A model the account/plan may not use is a selection failure, not capacity:
// it must never arm a wait-and-retry, and it must be recognizable generically.
const INCIDENT_ERROR = {
  name: "ProviderError",
  data: {
    message: "POST /alpha/generate → 403 {\"success\":false,\"error\":{\"code\":\"FORBIDDEN\","
      + "\"status\":403,\"message\":\"MODEL_NOT_IN_PLAN: Muse Spark 1.3 available in GOAT and "
      + "above plans or extra on demand usage\"}}",
    statusCode: 403,
  },
};

test("a provider model-entitlement refusal is recognized and never auto-retried", () => {
  assert.equal(isModelUnavailableError(INCIDENT_ERROR), true);
  assert.equal(classifyProviderLimit(INCIDENT_ERROR, NOW), null);
  assert.equal(
    modelUnavailableOf({ type: "session.error", properties: { error: INCIDENT_ERROR } }),
    true,
  );
});

test("model-unavailable recognition is provider-neutral and stays narrow", () => {
  for (const message of [
    "The model `gpt-5-preview` does not exist or you do not have access to it. model_not_found",
    "Your organization does not have access to the model claude-opus-5",
    "This model is not available on your current plan",
    "unknown model: meta/muse-spark-1.3",
    "model requires a higher plan",
  ]) {
    assert.equal(isModelUnavailableError({ data: { message } }), true, message);
  }
  for (const message of [
    "429 rate_limit_error: too many requests",
    "Overloaded",
    "ENOENT: no such file",
    "Invalid API key provided",
    "the model returned an empty response",
  ]) {
    assert.equal(isModelUnavailableError({ data: { message } }), false, message);
  }
  assert.equal(isModelUnavailableError(undefined), false);
  assert.equal(modelUnavailableOf({ type: "session.idle", properties: {} }), false);
});
