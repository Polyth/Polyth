import test from "node:test";
import assert from "node:assert/strict";
import {
  noteNewSessionHandoffPending,
  resetNewSessionHandoffPending,
  takeNewSessionHandoffPending,
} from "../src/newSessionProvenance.ts";
import { hashText } from "../src/hash.ts";

const provenance = {
  sourceKind: "chat-workspace" as const,
  provider: "Kimi",
  profileName: "Personal",
  bundleLabel: "Review changes",
};

test("new-session handoff pending pairs only with matching project text", () => {
  resetNewSessionHandoffPending();
  const text = "imported answer";
  noteNewSessionHandoffPending("proj-a", provenance, text);
  assert.equal(takeNewSessionHandoffPending("proj-b", text), null);
  const pending = takeNewSessionHandoffPending("proj-a", text);
  assert.ok(pending);
  assert.equal(pending!.textHash, hashText(text));
  assert.equal(takeNewSessionHandoffPending("proj-a", text), null);
});

test("two pending new-session handoffs in the same project do not overwrite each other", () => {
  resetNewSessionHandoffPending();
  const first = "first imported answer";
  const second = "second imported answer";
  noteNewSessionHandoffPending("proj-a", { ...provenance, bundleLabel: "Review A" }, first);
  noteNewSessionHandoffPending("proj-a", { ...provenance, bundleLabel: "Review B" }, second);
  const takenSecond = takeNewSessionHandoffPending("proj-a", second);
  const takenFirst = takeNewSessionHandoffPending("proj-a", first);
  assert.ok(takenSecond);
  assert.ok(takenFirst);
  assert.equal(takenSecond!.provenance.bundleLabel, "Review B");
  assert.equal(takenFirst!.provenance.bundleLabel, "Review A");
  assert.equal(takeNewSessionHandoffPending("proj-a", first), null);
});
