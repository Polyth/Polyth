import test from "node:test";
import assert from "node:assert/strict";
import type { JsonObject, SessionEvent } from "@polyth/contracts";
import { modelForAutoAccept, reduceSessionModel } from "../src/store.ts";

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

test("Auto-Approve hydration never exposes an already-cached pending permission", () => {
  const permission: SessionEvent = {
    id: "permission-1",
    sessionId: "s1",
    seq: 1,
    time: 1,
    type: "permission/requested",
    data: { requestId: "p1", permission: "bash", patterns: ["npm test"] },
    v: 1,
  };
  const pending = reduceSessionModel("s1", [permission]);
  assert.equal(pending.permissions[0]?.status, "pending");
  assert.equal(modelForAutoAccept(pending, { autoAccept: true }).permissions.length, 0);
  assert.strictEqual(modelForAutoAccept(pending, { autoAccept: false }), pending);
});

test("requests the policy holds for a person stay visible while Auto-Approve is on", () => {
  const requested = (seq: number, requestId: string, data: JsonObject, producerPlugin?: string): SessionEvent => ({
    id: `held-${seq}`,
    sessionId: "s-held",
    seq,
    time: seq,
    type: "permission/requested",
    data: { requestId, ...data },
    ...(producerPlugin ? { producerPlugin } : {}),
    v: 1,
  });
  const model = reduceSessionModel("s-held", [
    requested(1, "routine", { permission: "bash", patterns: ["npm test"], preview: { title: "bash", lines: ["npm test"], risk: "medium" } }),
    requested(2, "held", { permission: "bash", patterns: ["git push --force"], preview: { title: "bash", lines: ["git push --force"], risk: "high", reasons: ["history-rewrite"] } }),
    requested(3, "shell", { permission: "shell", patterns: ["ls"], tool: "shell" }, "composer-shell"),
  ]);
  const visible = (flags: { autoAccept?: boolean; autoAcceptAll?: boolean }) =>
    modelForAutoAccept(model, flags).permissions.map((permission) => permission.requestId);

  assert.deepEqual(visible({ autoAccept: false }), ["routine", "held", "shell"]);
  // Routine Auto-Approve never answers the high-risk request, and no policy
  // answers a composer-shell confirmation.
  assert.deepEqual(visible({ autoAccept: true }), ["held", "shell"]);
  assert.deepEqual(visible({ autoAccept: true, autoAcceptAll: true }), ["shell"]);
  assert.equal(model.permissions.find((permission) => permission.requestId === "shell")?.manual, true);
});

test("a parent's Full access never hides a workflow node's mirrored request", () => {
  // Workflow nodes run under their own approval policy. The server mirrors a
  // node's request into the chat that spawned it only when that policy needs
  // a person, so the parent's own policy must not hide the card.
  const model = reduceSessionModel("s-parent", [{
    id: "mirror-1",
    sessionId: "s-parent",
    seq: 1,
    time: 1,
    type: "permission/requested",
    data: {
      requestId: "node-request",
      permission: "bash",
      patterns: ["npm test"],
      preview: { title: "bash", lines: ["npm test"], risk: "medium" },
      sourceSessionId: "s-workflow-node",
    },
    ignorable: true,
    v: 1,
  }]);
  for (const flags of [{ autoAccept: true }, { autoAccept: true, autoAcceptAll: true }]) {
    assert.deepEqual(
      modelForAutoAccept(model, flags).permissions.map((permission) => permission.requestId),
      ["node-request"],
    );
  }
});
