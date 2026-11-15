import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { SessionEvent } from "@polyth/contracts";

// A started chat in the event log: its first prompt reads as the prompt while
// the chat starts (also after a reload, with no local echo), and a failed
// start says why, never crashing on a malformed event.

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as Window & typeof globalThis,
  document: dom.document as unknown as Document,
  localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
register("./tsxHooks.mjs", import.meta.url);

const { buildModel } = await import("../src/reduce.ts");
const { startingQueuePrompts, sessionStartingFromServer } = await import("../src/sessionStart.ts");
const { retiredPendingSends, upsertSession, upsertSessions, getState } = await import("../src/store.ts");

let seq = 0;
const ev = (type: string, data: unknown): SessionEvent =>
  ({ id: `e${++seq}`, sessionId: "s1", seq, time: seq, v: 1, type, data } as unknown as SessionEvent);

const starting = () => {
  seq = 0;
  return [
    ev("session/created", { projectId: "p1" }),
    ev("delivery/fallback-queued", { queueId: "q1", reason: "session-starting" }),
    ev("queue/enqueued", {
      queueId: "q1", text: "build the thing", delivery: "normal",
      attachments: [{ id: "a1", name: "spec.md", mime: "text/markdown", size: 3, path: "spec.md" }],
    }),
  ];
};

test("a starting chat's queued first prompt is its one prompt row, also after a reload", () => {
  const events = starting();
  const rows = startingQueuePrompts(events, "s1");
  assert.equal(rows.length, 1);
  assert.deepEqual({ text: rows[0]!.text, attachments: rows[0]!.attachments.map((a) => a.id) },
    { text: "build the thing", attachments: ["a1"] });
  assert.equal(sessionStartingFromServer("reconciling", events), true, "the startup dock follows the server");
  // The runtime came up (`idle`, or a passing `unknown`) but the prompt is not
  // admitted yet: still starting, or the new-chat hero would flash back.
  assert.equal(sessionStartingFromServer("idle", events), true);
  assert.equal(sessionStartingFromServer("unknown", events), true);
  assert.equal(sessionStartingFromServer("failed", events), false);
  // The canonical user/message with the same queueId replaces it.
  const landed = [...events, ev("user/message", { queueId: "q1", text: "build the thing" })];
  assert.deepEqual(startingQueuePrompts(landed, "s1"), []);
  assert.equal(sessionStartingFromServer("reconciling", landed), false);
  // An ordinary queued follow-up is not a starting prompt.
  assert.deepEqual(startingQueuePrompts([
    ev("delivery/fallback-queued", { queueId: "q9", reason: "turn-active" }),
    ev("queue/enqueued", { queueId: "q9", text: "later", delivery: "queue" }),
  ], "s1"), []);
});

test("the submit-frame echo hands over to the queued prompt, and a failed start retires it", () => {
  const echo = { id: "echo", sessionId: "s1", text: "build the thing", attachments: [], afterSeq: 0 };
  // The start's queue/enqueued retires the echo; the starting row takes over.
  assert.equal(retiredPendingSends([echo], starting()).length, 1);
  seq = 0;
  assert.equal(retiredPendingSends([echo], [ev("session/start-failed", { code: "runtime", message: "no" })]).length, 1);
});

test("session/start-failed shows why; a later prompt clears it; malformed data does not crash", () => {
  const failed = buildModel([
    ...starting(),
    ev("queue/removed", { queueId: "q1" }),
    ev("session/start-failed", {
      code: "runtime-unavailable", message: "Claude could not start", text: "build the thing",
      attachments: [{ id: "a1", name: "spec.md", mime: "text/markdown", size: 3, path: "spec.md" }, { bogus: true }],
    }),
  ]);
  assert.deepEqual(failed.startFailure && {
    code: failed.startFailure.code,
    message: failed.startFailure.message,
    attachments: failed.startFailure.attachments.map((a) => a.id),
  }, { code: "runtime-unavailable", message: "Claude could not start", attachments: ["a1"] });
  assert.deepEqual(startingQueuePrompts([
    ...starting(),
    ev("queue/removed", { queueId: "q1" }),
  ], "s1"), [], "a removed first prompt is not shown as waiting");

  const retried = buildModel([
    ev("session/start-failed", { code: "x", message: "y" }),
    ev("user/message", { text: "again" }),
  ]);
  assert.equal(retried.startFailure, null);

  for (const data of [null, "oops", 42, [], { code: 5, message: { nested: true } }]) {
    const model = buildModel([ev("session/start-failed", data)]);
    assert.equal(model.startFailure?.code, "start-failed");
    assert.equal(model.startFailure?.message, "");
    assert.deepEqual(model.startFailure?.attachments, []);
  }
});

test("a chat whose start failed stays listed while it holds the prompt as a draft", () => {
  const row = (id: string, extra: Record<string, unknown>) =>
    ({ id, projectId: "p1", title: "New session", status: "unknown", createdAt: 1, updatedAt: 1, ...extra }) as never;
  const listed = (id: string) => getState().sessions.some((session) => session.id === id);
  upsertSession(row("failed-with-draft", { draft: "keep my words" }));
  upsertSessions([row("failed-summary-draft", { summary: true, draftPreview: "keep my words" }), row("failed-empty", {})]);
  assert.equal(listed("failed-with-draft"), true);
  assert.equal(listed("failed-summary-draft"), true);
  // Nothing of the person's is in it: still swept away.
  assert.equal(listed("failed-empty"), false);
  upsertSession(row("failed-empty-2", { status: "failed" }));
  assert.equal(listed("failed-empty-2"), false);
});
