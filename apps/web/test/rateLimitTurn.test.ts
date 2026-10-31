import test from "node:test";
import assert from "node:assert/strict";
import type { JsonObject, SessionEvent } from "@polyth/contracts";
import { buildModel } from "../src/reduce.ts";
import { resumeOptionsForModel } from "../src/rateLimitRecovery.ts";

let seq = 0;
const ev = (type: string, data: JsonObject): SessionEvent => ({
  id: `e${++seq}`,
  sessionId: "s1",
  seq,
  time: seq * 1000,
  type,
  data,
  v: 1,
});

test("a rate-limit turn/stopped carries a resume plan onto the turn", () => {
  const model = buildModel([
    ev("user/message", { text: "do the thing" }),
    ev("turn/started", { turnId: "t1" }),
    ev("turn/stopped", {
      turnId: "t1",
      reason: "error",
      error: "429 rate limit",
      retry: { scope: "rate", provider: "anthropic", retryAfterSec: 42, resumeAt: 99_000, attempt: 2 },
    }),
  ]);
  assert.equal(model.turn?.status, "failed");
  assert.deepEqual(model.turn?.limit, {
    scope: "rate",
    provider: "anthropic",
    retryAfterSec: 42,
    resumeAt: 99_000,
    attempt: 2,
  });
});

test("a refused request carries its bounded retry budget onto the turn", () => {
  const model = buildModel([
    ev("user/message", { text: "do the thing" }),
    ev("turn/started", { turnId: "t1" }),
    ev("turn/stopped", {
      turnId: "t1",
      reason: "error",
      error: '400: {"message":"{\\"message\\":\\"invalid request error\\"}"}',
      retry: { scope: "request", provider: "commandcode", resumeAt: 99_000, attempt: 2, maxAttempts: 3 },
    }),
  ]);
  assert.deepEqual(model.turn?.limit, {
    scope: "request",
    provider: "commandcode",
    maxAttempts: 3,
    resumeAt: 99_000,
    attempt: 2,
  });
  // The inline retry surface owns the turn, not the generic failure toast.
  assert.equal(model.turn?.providerLimited, true);
});

test("the provider's limit line that closed a rate-limited turn is not an answer", () => {
  const model = buildModel([
    ev("user/message", { text: "do the thing" }),
    ev("turn/started", { turnId: "t1" }),
    ev("assistant/message", { partId: "n:0", text: "You've hit your session limit · resets 10:10pm (Europe/Kyiv)" }),
    ev("usage/recorded", { model: { providerID: "anthropic", modelID: "claude-opus-5-5" }, tokens: { input: 0, output: 0 }, aggregate: true }),
    ev("turn/stopped", { turnId: "t1", reason: "error", code: "rate-limited", retry: { scope: "rate", resumeAt: 99_000, attempt: 1 } }),
    ev("turn/resume-cancelled", { reason: "user" }),
  ]);
  const notice = model.messages.find((message) => message.kind === "assistant");
  assert.equal(notice?.kind === "assistant" && notice.providerNotice, true, "stays hidden after the wait ends");
});

test("a rate-limited turn keeps its earlier answer and an ordinary error keeps its last line", () => {
  const limited = buildModel([
    ev("user/message", { text: "do the thing" }),
    ev("turn/started", { turnId: "t1" }),
    ev("assistant/message", { partId: "a:0", text: "Checking the files." }),
    ev("tool/started", { callId: "c1", tool: "Read", input: {} }),
    ev("tool/result", { callId: "c1", tool: "Read", output: "ok" }),
    ev("turn/stopped", { turnId: "t1", reason: "error", retry: { scope: "rate", resumeAt: 99_000, attempt: 1 } }),
  ]);
  const answer = limited.messages.find((message) => message.kind === "assistant");
  assert.equal(answer?.kind === "assistant" && answer.providerNotice, undefined);

  const failed = buildModel([
    ev("user/message", { text: "hi" }),
    ev("turn/started", { turnId: "t1" }),
    ev("assistant/message", { partId: "a:0", text: "API Error: 500" }),
    ev("turn/stopped", { turnId: "t1", reason: "error", error: "boom" }),
  ]);
  const line = failed.messages.find((message) => message.kind === "assistant");
  assert.equal(line?.kind === "assistant" && line.providerNotice, undefined);
});

test("turn/resume-cancelled clears the pending limit but keeps the turn failed", () => {
  const model = buildModel([
    ev("user/message", { text: "hi" }),
    ev("turn/started", { turnId: "t1" }),
    ev("turn/stopped", {
      turnId: "t1",
      reason: "error",
      retry: { scope: "overloaded", resumeAt: 5_000, attempt: 1 },
    }),
    ev("turn/resume-cancelled", { reason: "user" }),
  ]);
  assert.equal(model.turn?.status, "failed");
  assert.equal(model.turn?.limit, undefined);
  assert.equal(model.turn?.providerLimited, true, "a cancelled wait is not a generic failure");
});

test("a plain error stop has no limit", () => {
  const model = buildModel([
    ev("user/message", { text: "hi" }),
    ev("turn/started", { turnId: "t1" }),
    ev("turn/stopped", { turnId: "t1", reason: "error", error: "boom" }),
  ]);
  assert.equal(model.turn?.status, "failed");
  assert.equal(model.turn?.limit, undefined);
  assert.equal(model.turn?.providerLimited, undefined);
});

test("the next turn/started clears a stale limit", () => {
  const model = buildModel([
    ev("user/message", { text: "hi" }),
    ev("turn/started", { turnId: "t1" }),
    ev("turn/stopped", {
      turnId: "t1",
      reason: "error",
      retry: { scope: "rate", resumeAt: 5_000, attempt: 1 },
    }),
    ev("user/message", { text: "hi", autoResume: true }),
    ev("turn/started", { turnId: "t2" }),
  ]);
  assert.equal(model.turn?.status, "working");
  assert.equal(model.turn?.limit, undefined);
  assert.equal(model.messages.filter((message) => message.kind === "user").length, 1);
});

test("rate-limit recovery keeps model and harness identities separate", () => {
  assert.deepEqual(
    resumeOptionsForModel({
      currentHarnessId: "claude",
      selectedHarnessId: "codex",
      model: { harnessId: "codex", providerID: "openai", modelID: "gpt-5.5-codex", variant: "high" },
    }),
    {
      harness: { mode: "pinned", harnessId: "codex" },
      model: { providerID: "openai", modelID: "gpt-5.5-codex", variant: "high" },
    },
  );
  assert.deepEqual(
    resumeOptionsForModel({
      currentHarnessId: "claude",
      selectedHarnessId: "claude",
      model: { harnessId: "claude", providerID: "anthropic", modelID: "sonnet" },
    }),
    { model: { providerID: "anthropic", modelID: "sonnet" } },
  );
  assert.equal(
    resumeOptionsForModel({
      currentHarnessId: "claude",
      selectedHarnessId: "codex",
      model: { harnessId: "claude", providerID: "anthropic", modelID: "stale" },
    }),
    null,
  );
});

test("a model-unavailable stop offers recovery without a countdown", () => {
  const model = buildModel([
    ev("user/message", { text: "hi" }),
    ev("turn/started", { turnId: "t1" }),
    ev("turn/stopped", {
      turnId: "t1",
      reason: "error",
      error: "403 MODEL_NOT_IN_PLAN",
      code: "model-unavailable",
    }),
  ]);
  assert.equal(model.turn?.status, "failed");
  assert.deepEqual(model.turn?.limit, {
    scope: "unknown",
    attempt: 1,
    code: "model-unavailable",
  });
  assert.equal(model.turn?.limit?.resumeAt, undefined, "an unavailable model has no wait to run out");
});
