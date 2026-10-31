import test from "node:test";
import assert from "node:assert/strict";
import type { JsonObject, SessionEvent } from "@polyth/contracts";
import { findConversation, FIND_PAGE_SIZE, FIND_QUERY_MAX } from "../src/search.ts";

const event = (seq: number, type: string, data: JsonObject): SessionEvent => ({
  id: String(seq), sessionId: "conversation", seq, time: seq, type, data, v: 1,
});

test("counts occurrences beyond a render window and pages without duplicates", () => {
  const events = Array.from({ length: 500 }, (_, index) => event(index + 1, "user/message", { text: `Message ${index}: Needle then needle` }));
  const first = findConversation("conversation", events, "needle");
  const second = findConversation("conversation", events, "needle", FIND_PAGE_SIZE);
  const last = findConversation("conversation", events, "needle", 900);
  assert.equal(first.total, 1000);
  assert.equal(first.matches.length, 100);
  assert.deepEqual(first.matches.map((match) => match.index), Array.from({ length: 100 }, (_, index) => index));
  assert.equal(first.matches[0]?.eventSeq, 1);
  assert.equal(second.matches[0]?.eventSeq, 51);
  assert.equal(last.matches.at(-1)?.eventSeq, 500);
  assert.equal(new Set([...first.matches, ...second.matches].map((match) => `${match.eventSeq}:${match.start}`)).size, 200);
});

test("literal Unicode matches retain source offsets and bounded safe snippets", () => {
  const text = "🙂".repeat(40) + "(a+b) CAFÉ σ ς " + "🙂".repeat(40);
  const events = [event(1, "user/message", { text })];
  const match = findConversation("conversation", events, "(a+b)").matches[0]!;
  assert.equal(text.slice(match.start, match.end), "(a+b)");
  assert.equal(match.before.length, 65);
  assert.equal(match.hit, "(a+b)");
  assert.equal(findConversation("conversation", events, ".*").total, 0);
  assert.equal(findConversation("conversation", events, "café").matches[0]?.hit, "CAFÉ");
  assert.equal(findConversation("conversation", events, "Σ").total, 2);
  assert.ok(!/[\uD800-\uDBFF]$/.test(match.after));
});

test("final messages replace chunks and hidden/runtime/rewound content is excluded", () => {
  const events = [
    event(1, "user/message", { text: "needle" }),
    event(2, "user/message", { text: "needle internal", hiddenUserMessage: true }),
    event(3, "tool/result", { text: "needle tool", output: "needle output" }),
    event(4, "assistant/reasoning-chunk", { partId: "temporary", text: "needle reasoning" }),
    event(5, "assistant/chunk", { partId: "temporary", text: "needle live" }),
    event(6, "assistant/message", { partId: "final", text: "needle live corrected" }),
    event(7, "user/message", { text: "needle rewind" }),
    event(8, "session/rewound", { atSeq: 7 }),
    event(9, "assistant/message", { partId: "late", text: "needle late" }),
  ];
  const found = findConversation("conversation", events, "needle");
  assert.equal(found.total, 2);
  assert.deepEqual(found.matches.map((match) => match.eventSeq), [1, 6]);
  assert.equal(found.throughSeq, 9);
  assert.equal(findConversation("conversation", [...events, event(10, "session/rewind-cleared", { rewindSeq: 8 })], "needle").total, 4);
  assert.equal(findConversation("conversation", [...events, event(10, "session/rewind-cleared", { rewindSeq: 8, replaced: true })], "needle").total, 2);
});

test("empty queries are empty and invalid inputs are rejected", () => {
  assert.equal(findConversation("conversation", [], "").total, 0);
  assert.throws(() => findConversation("conversation", [], "x".repeat(FIND_QUERY_MAX + 1)), { code: "invalid-input" });
  assert.throws(() => findConversation("conversation", [], "x", -1), { code: "invalid-input" });
});
