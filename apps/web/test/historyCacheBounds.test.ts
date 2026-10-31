import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionEvent } from "@polyth/contracts";
import { activateSession, applyEvents, getState, reduceSessionModel } from "../src/store.ts";

const event = (sessionId: string, seq: number): SessionEvent => ({ id: `${sessionId}:${seq}`, sessionId, seq, time: seq, type: "assistant/chunk", data: { partId: "part", text: "x" }, v: 1 });
test("live and history ingress bound inactive caches without truncating active pending semantics", () => {
  activateSession("active");
  const pending: SessionEvent = { ...event("active", 1), type: "question/asked", data: { requestId: "question", questions: [{ question: "pending" }] } };
  applyEvents([pending, ...Array.from({ length: 9_000 }, (_, i) => event("active", i + 2))]);
  for (let i = 0; i < 100; i++) applyEvents([event(`inactive-${i}`, 1)]);
  assert.ok(Object.keys(getState().events).length <= 12);
  assert.equal(getState().events.active?.length, 9_001);
  assert.equal(reduceSessionModel("active", getState().events.active!).questions[0]?.status, "pending");
  applyEvents(Array.from({ length: 8_001 }, (_, i) => event("oversized-inactive", i + 1)));
  assert.equal(getState().events["oversized-inactive"], undefined, "inactive eviction is whole-session, never a false empty semantic baseline");
  activateSession(null);
  assert.equal(getState().events.active, undefined);
});
