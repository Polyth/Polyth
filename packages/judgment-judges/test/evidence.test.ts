import test from "node:test";
import assert from "node:assert/strict";
import type { SessionEvent } from "@polyth/contracts";
import { completedTurns, currentTurnEvidence, isPersonRequest, judgeRounds, latestTurnEvidence, permissionEvidence, pickEvidence, redact } from "../src/evidence.ts";

let seq = 0;
const e = (type: string, data: Record<string, unknown>, ignorable = false) =>
  ({ id: `e${++seq}`, sessionId: "s", seq, time: seq, type, data, v: 1, ...(ignorable ? { ignorable } : {}) }) as unknown as SessionEvent;

test("only a completed latest turn yields evidence", () => {
  const aborted = [e("user/message", { text: "Do it" }), e("assistant/message", { text: "Working" }), e("turn/stopped", { reason: "aborted" })];
  assert.equal(latestTurnEvidence(aborted), undefined);
  assert.equal(latestTurnEvidence([e("user/message", { text: "Still running" })]), undefined);
  assert.equal(latestTurnEvidence([e("assistant/message", { text: "No request" }), e("turn/stopped", { reason: "completed" })]), undefined);
});

test("patch files, command outcomes, the raw request and picked caps", () => {
  const events = [
    e("user/message", { text: "Context…\n\nFix it", raw: "Fix it" }),
    e("tool/call", { callId: "a", tool: "apply_patch", input: { patch: "*** Begin Patch\n*** Update File: src/a.ts\n*** Add File: src/b.ts\n*** End Patch" } }),
    e("tool/call", { callId: "b", tool: "shell", input: { command: ["npm", "test"] } }),
    e("tool/error", { callId: "b", tool: "shell", error: "exit 1" }),
    e("assistant/message", { text: `${"a".repeat(500)}END` }),
    e("assistant/message", { text: "ignored note" }, true),
    e("turn/stopped", { reason: "completed" }),
  ];
  const turn = latestTurnEvidence(events)!;
  assert.equal(turn.request, "Fix it");
  assert.deepEqual(turn.changedFiles, ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(turn.commands, [{ command: "npm test", status: "error" }]);
  const state = pickEvidence(turn, [{ pick: "last-answer", maxChars: 100 }, { pick: "open-todos", maxChars: 100 }]);
  assert.equal(state.lastAnswer!.length, 100); assert.ok(state.lastAnswer!.endsWith("END"));
  assert.equal(state.openTodos, "(none)");
  assert.deepEqual(Object.keys(state), ["lastAnswer", "openTodos"], "nothing outside the picks is sent");
  assert.equal(completedTurns([...events, ...events.map((event) => ({ ...event, seq: event.seq + 100 }))], 25).length, 2);
});

test("credentials are redacted from evidence", () => {
  const text = redact("key sk-abcdefghijklmnopqrstuv and ghp_abcdefghijklmnopqrstuvwxyz12 PASSWORD=hunter22 Authorization: Bearer abcdefghijklmnop");
  assert.doesNotMatch(text, /abcdefghijklmnopqrstuv|hunter22|ghp_abc|Bearer abcdef/);
  assert.match(text, /PASSWORD=\[redacted\]/);
});

test("judge messages are counted as rounds and never read as the person's request", () => {
  const judgeSaid = (text: string) => e("user/message", { text, author: { userId: "u", via: "judge" } });
  const events = [
    e("user/message", { text: "Add the export button", author: { userId: "u" } }),
    e("assistant/message", { text: "Started." }), e("turn/stopped", { reason: "completed" }),
    judgeSaid("Continue."), e("assistant/message", { text: "More." }), e("turn/stopped", { reason: "completed" }),
    e("user/message", { text: "child finished", hiddenUserMessage: true }), e("turn/stopped", { reason: "completed" }),
    judgeSaid("Continue."), e("assistant/message", { text: "Nearly." }), e("turn/stopped", { reason: "completed" }),
  ];
  assert.equal(judgeRounds(events), 2, "hidden wakes neither count nor reset the rounds");
  assert.equal(latestTurnEvidence(events)!.request, "Add the export button");
  assert.equal(latestTurnEvidence(events)!.answer, "Nearly.");
  assert.equal(judgeRounds([...events, e("user/message", { text: "Thanks, now the import" })]), 0, "the person writing resets the count");
  assert.equal(isPersonRequest(events[0]!), true); assert.equal(isPersonRequest(events[3]!), false); assert.equal(isPersonRequest(events[6]!), false);
});

test("a turn in progress and its permission request are evidence; an answered request is closed", () => {
  const events = [
    e("user/message", { text: "Run the tests" }),
    e("tool/call", { callId: "a", tool: "bash", input: { command: "npm test" } }),
    e("assistant/message", { text: "Running the suite." }),
    e("permission/requested", { requestId: "r1", permission: "bash", tool: "shell",
      preview: { title: "bash via shell", lines: ["rm -rf build", "API_KEY=sk-abcdefghijklmnopqrstuv"], risk: "high", reasons: ["destructive"] } }),
  ];
  assert.equal(latestTurnEvidence(events), undefined, "not completed");
  const turn = currentTurnEvidence(events)!;
  assert.equal(turn.request, "Run the tests"); assert.equal(turn.answer, "Running the suite.");
  assert.deepEqual(turn.commands, [{ command: "npm test", status: "unknown" }]);
  const request = permissionEvidence(events, "r1")!;
  assert.equal(request.open, true); assert.equal(request.risk, "high"); assert.deepEqual(request.reasons, ["destructive"]);
  const state = pickEvidence(turn, [{ pick: "permission-request", maxChars: 400 }], request);
  assert.match(state.permissionRequest!, /^Asks for: bash via shell\nRisk: high \(destructive\)\nrm -rf build/);
  assert.doesNotMatch(state.permissionRequest!, /sk-abcdefghijklmnopqrstuv/);
  assert.equal(permissionEvidence([...events, e("permission/resolved", { requestId: "r1", reply: "reject" })], "r1")!.open, false);
  assert.equal(permissionEvidence([...events, e("permission/expired", { requestId: "r1" })], "r1")!.open, false);
  assert.equal(permissionEvidence(events, "missing"), undefined);
});
