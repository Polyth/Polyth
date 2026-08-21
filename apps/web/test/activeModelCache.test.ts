import test from "node:test";
import assert from "node:assert/strict";
import type { JsonObject, SessionEvent } from "@polyth/contracts";
import { reduceSessionModel } from "../src/store.ts";

function event(sessionId: string, seq: number, text: string): SessionEvent {
  return {
    id: `${sessionId}-${seq}`,
    sessionId,
    seq,
    time: seq,
    type: "user/message",
    data: { text } satisfies JsonObject,
    v: 1,
  };
}

test("active model reduction is shared per session event batch", () => {
  const events = [event("s1", 1, "one")];
  const first = reduceSessionModel("s1", events);
  const shared = reduceSessionModel("s1", events);
  assert.strictEqual(shared, first, "subscribers reuse one reduced model");

  const appended = [...events, event("s1", 2, "two")];
  const next = reduceSessionModel("s1", appended);
  assert.notStrictEqual(next, first, "an appended event invalidates the batch");
  assert.equal(next.messages.length, 2);
});

test("active model reduction does not cross session switches", () => {
  const first = reduceSessionModel("s1", [event("s1", 1, "session one")]);
  const second = reduceSessionModel("s2", [event("s2", 1, "session two")]);
  assert.notStrictEqual(second, first);
  assert.equal(second.messages[0]?.kind === "user" && second.messages[0].text, "session two");
});
