import { test } from "node:test";
import assert from "node:assert/strict";
import type { JsonObject, SessionEvent } from "@polyth/contracts";
import { conversationMessages, literalTextMatches } from "@polyth/session/conversation";
import { buildModel } from "../src/reduce.ts";

const event = (seq: number, type: string, data: JsonObject): SessionEvent => ({
  id: String(seq), sessionId: "conversation-text", seq, time: seq, type, data, v: 1,
});
const comparable = (events: SessionEvent[]) => {
  const actual = conversationMessages(events).map(({ role, eventSeq, text }) => ({ role, eventSeq, text }));
  const rendered = buildModel(events).messages
    .filter((message) => !message.undone && (message.kind === "user" || message.kind === "assistant") && message.text !== "")
    .map((message) => ({
      role: message.kind, eventSeq: message.eventSeq,
      text: message.kind === "user" || message.kind === "assistant" ? message.text : "",
    }));
  assert.deepEqual(actual, rendered);
  return actual;
};

test("literal search escapes syntax and keeps original Unicode offsets", () => {
  const text = "🙂 (a+b) CAFÉ σ ς";
  assert.deepEqual([...literalTextMatches(text, "(a+b)")], [{ start: 3, end: 8 }]);
  assert.deepEqual([...literalTextMatches(text, "café")].map((match) => text.slice(match.start, match.end)), ["CAFÉ"]);
  assert.deepEqual([...literalTextMatches(text, "Σ")].map((match) => text.slice(match.start, match.end)), ["σ", "ς"]);
  assert.deepEqual([...literalTextMatches(text, ".*")], []);
  assert.deepEqual([...literalTextMatches(text, "")], []);
});

test("conversation text agrees with rendered messages and hides runtime prompts and recovery metadata", () => {
  const wrapper = "<polyth-runtime-epoch-recovery>internal instructions</polyth-runtime-epoch-recovery>";
  const events = [
    event(1, "user/message", { text: wrapper + "\nvisible request" }),
    event(2, "user/message", { text: "hidden retry", hiddenUserMessage: true }),
    event(3, "user/message", { text: "hidden conflict", githubConflictResolution: true }),
    event(4, "user/message", { text: "hidden resume", autoResume: true }),
    event(5, "tool/result", { output: "private-looking tool metadata" }),
    event(6, "assistant/message", { partId: "answer", text: "visible answer", reasoning: "not displayed answer text" }),
    event(7, "user/message", { text: "Quoted\n" + wrapper }),
  ];
  assert.deepEqual(comparable(events).map((message) => message.text),
    ["visible request", "visible answer", "Quoted\n" + wrapper]);
});

test("canonical final answers replace chunks without duplicate search results and retain live text", () => {
  const events = [
    event(1, "user/message", { text: "request" }),
    event(2, "assistant/reasoning-chunk", { partId: "temporary", text: "thinking" }),
    event(3, "assistant/chunk", { partId: "temporary", text: "first " }),
    event(4, "assistant/chunk", { partId: "temporary", text: "answer" }),
    event(5, "assistant/message", { partId: "final", text: "first answer corrected" }),
    event(6, "assistant/message", { partId: "final", text: "first answer corrected again" }),
    event(7, "user/message", { text: "another request" }),
    event(8, "assistant/chunk", { partId: "live", text: "live " }),
    event(9, "assistant/chunk", { partId: "live", text: "text" }),
  ];
  const messages = comparable(events);
  assert.equal(messages.length, 4);
  assert.equal(messages[1]?.eventSeq, 6);
  assert.equal(messages[3]?.eventSeq, 8);
  assert.equal(conversationMessages(events)[3]?.finalized, false);
});

test("searchable conversation follows rewind, late output, redo and replacement exactly", () => {
  const events = [
    event(1, "user/message", { text: "keep" }),
    event(2, "assistant/message", { partId: "keep", text: "kept answer" }),
    event(3, "user/message", { text: "rewind me" }),
    event(4, "assistant/message", { partId: "old", text: "old answer" }),
    event(5, "session/rewound", { atSeq: 3 }),
    event(6, "assistant/chunk", { partId: "late", text: "late hidden output" }),
  ];
  assert.deepEqual(comparable(events).map((message) => message.text), ["keep", "kept answer"]);
  const redo = [...events, event(7, "session/rewind-cleared", { rewindSeq: 5 })];
  assert.ok(comparable(redo).some((message) => message.text === "late hidden output"));
  const replacement = [...events, event(7, "session/rewind-cleared", { rewindSeq: 5, replaced: true }),
    event(8, "user/message", { text: "replacement" }),
    event(9, "assistant/message", { partId: "new", text: "new answer" })];
  assert.deepEqual(comparable(replacement).map((message) => message.text),
    ["keep", "kept answer", "replacement", "new answer"]);
});
