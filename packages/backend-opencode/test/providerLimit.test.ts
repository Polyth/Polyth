import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyProviderLimit,
  classifyProviderLimitNotice,
  parseRetryAfterSec,
} from "../src/providerLimit.ts";

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
  assert.deepEqual(result, { scope: "rate", provider: "anthropic", retryAfterSec: 42 });
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
  assert.deepEqual(result, { scope: "rate", provider: "openai", retryAfterSec: 20 });
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
