// People talking in a session: reducer items, unknown-shape safety, prompt
// history/first-message exclusion, and the navigator's @ attention badge.
import test from "node:test";
import assert from "node:assert/strict";
import type { JsonObject, SessionEvent } from "@polyth/contracts";
import { buildModel } from "../src/reduce.ts";
import { firstUserText, promptIndex } from "../src/utils.ts";
import { chatDividerParts, emojiOnlyCount } from "../src/format.ts";
import { hasMentionAttention, personMentionToken } from "../src/sessionPeople.ts";

function ev(seq: number, type: string, data: JsonObject): SessionEvent {
  return { id: `e${seq}`, sessionId: "s1", seq, time: 1_700_000_000_000 + seq, type, data, v: 1 };
}

test("person/message reduces to a person-message row with author, mentions and markers", () => {
  const model = buildModel([
    ev(1, "person/message", {
      text: "hi @Alice, look at this",
      author: { userId: "u1", name: "Bob" },
      mentions: [{ userId: "u2", name: "Alice" }, { userId: "u3", name: "Carol" }],
      carryToAgent: true,
      replyToSeq: 7,
    }),
  ]);
  assert.equal(model.messages.length, 1);
  const row = model.messages[0]!;
  assert.equal(row.kind, "person-message");
  if (row.kind !== "person-message") return;
  assert.equal(row.text, "hi @Alice, look at this");
  assert.deepEqual(row.author, { userId: "u1", name: "Bob" });
  assert.deepEqual(row.mentions.map((m) => m.userId), ["u2", "u3"]);
  assert.equal(row.carryToAgent, true);
  assert.equal(row.replyToSeq, 7);
});

test("conversation/session-started reduces to a link card with validated fields", () => {
  const model = buildModel([
    ev(1, "conversation/session-started", {
      sessionId: "agent-session",
      title: "Fix the bug",
      sourceSeqs: [3, 4],
      startedBy: { userId: "u1", name: "Bob" },
    }),
  ]);
  const row = model.messages[0]!;
  assert.equal(row.kind, "conversation-started");
  if (row.kind !== "conversation-started") return;
  assert.equal(row.sessionId, "agent-session");
  assert.equal(row.title, "Fix the bug");
  assert.deepEqual(row.sourceSeqs, [3, 4]);
  assert.deepEqual(row.startedBy, { userId: "u1", name: "Bob" });
});

test("unknown or malformed people event shapes never crash and are ignored", () => {
  const events: SessionEvent[] = [
    ev(1, "person/message", {}),
    ev(2, "person/message", { text: 42 }),
    ev(3, "person/message", { text: "ok", mentions: "not-an-array", author: { bad: true } }),
    ev(4, "conversation/session-started", {}),
    ev(5, "conversation/session-started", { sessionId: 7 }),
    ev(6, "person/message/extra", { text: "future" }),
  ];
  const model = buildModel(events);
  // Only the well-formed text row survives; malformed payloads are dropped.
  assert.equal(model.messages.length, 1);
  const row = model.messages[0]!;
  assert.equal(row.kind, "person-message");
  if (row.kind !== "person-message") return;
  assert.equal(row.text, "ok");
  assert.deepEqual(row.mentions, []);
  assert.equal(row.author, undefined);
});

test("person messages are never the first user prompt and never enter prompt history", () => {
  const events = [
    ev(1, "person/message", { text: "hello people", author: { userId: "u1", name: "Bob" }, mentions: [] }),
    ev(2, "conversation/session-started", { sessionId: "s2", title: "Agent", sourceSeqs: [1], startedBy: { userId: "u1", name: "Bob" } }),
  ];
  assert.equal(firstUserText(events), undefined);
  assert.deepEqual(promptIndex(buildModel(events).messages), []);
  // A real user prompt after them is still the first prompt.
  const withPrompt = [...events, ev(3, "user/message", { text: "the real prompt" })];
  assert.equal(firstUserText(withPrompt), "the real prompt");
  assert.equal(promptIndex(buildModel(withPrompt).messages).length, 1);
});

test("the @ attention badge appears only when attention.mentions is positive", () => {
  assert.equal(hasMentionAttention({ attention: { mentions: 1 } }), true);
  assert.equal(hasMentionAttention({ attention: { mentions: 0 } }), false);
  assert.equal(hasMentionAttention({ attention: {} }), false);
  assert.equal(hasMentionAttention(null), false);
});

test("mention tokens join display names into one grammar-safe token", () => {
  assert.equal(personMentionToken("Alice"), "@Alice");
  assert.equal(personMentionToken("  Bob  Smith "), "@Bob_Smith");
  assert.equal(personMentionToken(""), "@someone");
});

test("a run marks its last bubble, and time dividers open each new stretch", () => {
  const minute = 60_000;
  const start = new Date(2026, 9, 20, 15, 19).getTime();
  const at = (seq: number, offset: number, type: string, data: JsonObject): SessionEvent =>
    ({ id: `e${seq}`, sessionId: "s1", seq, time: start + offset, type, data, v: 1 });
  const ann = { userId: "u1", name: "Ann" };
  const bea = { userId: "u2", name: "Bea" };
  const model = buildModel([
    at(1, 0, "person/message", { text: "one", author: ann, mentions: [] }),
    at(2, minute, "person/message", { text: "two", author: ann, mentions: [] }),
    at(3, 2 * minute, "person/message", { text: "three", author: bea, mentions: [] }),
    // A quiet stretch breaks the run even for the same author.
    at(4, 20 * minute, "person/message", { text: "four", author: bea, mentions: [] }),
    at(5, 21 * minute, "assistant/message", { text: "agent work" }),
    // After agent work no divider: the person message reads in that flow.
    at(6, 60 * minute, "person/message", { text: "five", author: ann, mentions: [] }),
  ]);
  const rows = model.messages.flatMap((row) => row.kind === "person-message"
    ? [{ text: row.text, continuation: !!row.continuation, continued: !!row.continued, timeBreak: !!row.timeBreak }]
    : []);
  assert.deepEqual(rows, [
    { text: "one", continuation: false, continued: true, timeBreak: true },
    { text: "two", continuation: true, continued: false, timeBreak: false },
    { text: "three", continuation: false, continued: false, timeBreak: false },
    { text: "four", continuation: false, continued: false, timeBreak: true },
    { text: "five", continuation: false, continued: false, timeBreak: false },
  ]);
});

test("a new day opens with a divider even within minutes", () => {
  const late = new Date(2026, 9, 20, 23, 59).getTime();
  const author = { userId: "u1", name: "Ann" };
  const model = buildModel([
    { id: "e1", sessionId: "s1", seq: 1, time: late, type: "person/message", data: { text: "night", author, mentions: [] }, v: 1 },
    { id: "e2", sessionId: "s1", seq: 2, time: late + 2 * 60_000, type: "person/message", data: { text: "morning", author, mentions: [] }, v: 1 },
  ]);
  const second = model.messages[1]!;
  assert.equal(second.kind, "person-message");
  if (second.kind !== "person-message") return;
  assert.equal(second.timeBreak, true);
  assert.equal(second.continuation, undefined);
});

test("time dividers read like a phone's messages", () => {
  const now = new Date(2026, 9, 20, 18, 0).getTime();
  const at = (day: number, h: number, m: number) => new Date(2026, 9, day, h, m).getTime();
  assert.deepEqual(chatDividerParts(at(20, 15, 19), now, "en-US"), { day: "Today", time: "3:19 PM" });
  assert.deepEqual(chatDividerParts(at(19, 9, 2), now, "en-US"), { day: "Yesterday", time: "9:02 AM" });
  assert.deepEqual(chatDividerParts(at(16, 9, 2), now, "en-US"), { day: "Friday", time: "9:02 AM" });
  assert.equal(chatDividerParts(at(2, 9, 2), now, "en-US").day, "Fri, Oct 2");
  assert.equal(chatDividerParts(new Date(2025, 9, 2, 9, 2).getTime(), now, "en-US").day, "Thu, Oct 2, 2025");
  // Other languages capitalize their own words.
  assert.equal(chatDividerParts(at(20, 15, 19), now, "uk").day, "Сьогодні");
});

test("only one to three emoji count as an emoji message", () => {
  assert.equal(emojiOnlyCount("👍"), 1);
  assert.equal(emojiOnlyCount(" 👍🏽 🎉 "), 2);
  assert.equal(emojiOnlyCount("👨‍👩‍👧🇺🇦1️⃣"), 3);
  assert.equal(emojiOnlyCount("👍👍👍👍"), 0);
  assert.equal(emojiOnlyCount("ok 👍"), 0);
  assert.equal(emojiOnlyCount("123"), 0);
  assert.equal(emojiOnlyCount(""), 0);
});
