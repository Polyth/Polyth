import test from "node:test";
import assert from "node:assert/strict";
import type { JsonObject, SessionEvent } from "@polyth/contracts";
import { buildModel } from "../src/reduce.ts";

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
});

test("a plain error stop has no limit", () => {
  const model = buildModel([
    ev("user/message", { text: "hi" }),
    ev("turn/started", { turnId: "t1" }),
    ev("turn/stopped", { turnId: "t1", reason: "error", error: "boom" }),
  ]);
  assert.equal(model.turn?.status, "failed");
  assert.equal(model.turn?.limit, undefined);
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
});
