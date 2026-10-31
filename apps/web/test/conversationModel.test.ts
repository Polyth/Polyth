// People-first conversations: selection order, the one-time participant copy
// from sharing, and the exact payloads the two fixed routes receive.
import test from "node:test";
import assert from "node:assert/strict";
import type { SessionShareGrantDto } from "@polyth/contracts";
import {
  conversationOperationKey,
  conversationTitleFromMessage,
  createConversationPayload,
  participantsFromGrants,
  startSessionPayload,
  toggleSelectedSeq,
} from "../src/conversationModel.ts";
import { conversationPeople } from "../src/conversations.ts";

test("selection keeps click order and toggles off again", () => {
  let selected: number[] = [];
  selected = toggleSelectedSeq(selected, 9);
  selected = toggleSelectedSeq(selected, 4);
  selected = toggleSelectedSeq(selected, 7);
  assert.deepEqual(selected, [9, 4, 7]);
  selected = toggleSelectedSeq(selected, 4);
  assert.deepEqual(selected, [9, 7]);
});

test("the session title comes from the first selected message, trimmed and bounded", () => {
  assert.equal(conversationTitleFromMessage("  Fix the parser\nmore detail"), "Fix the parser");
  assert.equal(conversationTitleFromMessage("x".repeat(120)).length, 80);
  assert.ok(conversationTitleFromMessage("x".repeat(120)).endsWith("…"));
  assert.equal(conversationTitleFromMessage("   "), "");
});

test("create payload trims the title and message and carries the operation id", () => {
  assert.deepEqual(createConversationPayload({
    projectId: "p1",
    title: "  Design review  ",
    participants: ["u-alice", "u-bob"],
    text: "  Hello people  ",
    operationId: "op-1",
  }), {
    projectId: "p1",
    title: "Design review",
    participants: ["u-alice", "u-bob"],
    text: "Hello people",
    clientOperationId: "op-1",
  });
  const untitled = createConversationPayload({
    projectId: "p1", title: "  ", participants: ["u-alice"], text: "hi", operationId: "op-2",
  });
  assert.equal("title" in untitled, false);
});

test("participants are copied once from sharing grants, never the reader", () => {
  const grants: SessionShareGrantDto[] = [
    { userId: "u-alice", name: "Alice", access: "collaborate" },
    { userId: "u-bob", access: "view" },
    { userId: "me", name: "Me", access: "manage" },
  ];
  assert.deepEqual(participantsFromGrants(grants, "me"), [
    { userId: "u-alice", name: "Alice", access: "collaborate" },
    { userId: "u-bob", access: "view" },
  ]);
});

test("start payload preserves source seq order and an edited access level", () => {
  const participants = participantsFromGrants([
    { userId: "u-alice", name: "Alice", access: "view" },
    { userId: "u-bob", name: "Bob", access: "collaborate" },
  ], "me").map((row) => row.userId === "u-alice" ? { ...row, access: "manage" as const } : row);
  const payload = startSessionPayload({
    sourceSeqs: [12, 8, 15],
    title: "  Plan the fix  ",
    prompt: "  Use these notes.  ",
    participants,
    operationId: "op-start",
  });
  assert.deepEqual(payload.sourceSeqs, [12, 8, 15]);
  assert.equal(payload.title, "Plan the fix");
  assert.equal(payload.prompt, "Use these notes.");
  assert.deepEqual(payload.participants, [
    { userId: "u-alice", access: "manage" },
    { userId: "u-bob", access: "collaborate" },
  ]);
  assert.equal(payload.clientOperationId, "op-start");
  assert.equal("harness" in payload, false, "no harness selection means the server default");
});

test("operation keys differ when the intent changes and repeat when it does not", () => {
  const base = {
    kind: "create" as const,
    projectId: "p1",
    participants: ["u-alice"],
    title: "",
    text: "hello",
  };
  assert.equal(conversationOperationKey(base), conversationOperationKey({ ...base, participants: ["u-alice"] }));
  assert.notEqual(conversationOperationKey(base), conversationOperationKey({ ...base, text: "hello again" }));
});

test("Space people exclude the reader and fall back to ids when names are missing", () => {
  const people = conversationPeople([
    { userId: "me", spaceId: "s1", role: "member", createdAt: 1 },
    { userId: "u-bob", spaceId: "s1", role: "member", createdAt: 1 },
    { userId: "u-alice", spaceId: "s1", role: "member", createdAt: 1 },
  ], [
    { id: "me", name: "Me" },
    { id: "u-alice", name: "Alice" },
  ], "me");
  assert.deepEqual(people, [
    { userId: "u-alice", name: "Alice" },
    { userId: "u-bob", name: "u-bob" },
  ]);
});
