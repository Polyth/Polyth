import test from "node:test";
import assert from "node:assert/strict";
import type { JsonObject, SessionEvent } from "@polyth/contracts";
import { buildModel } from "../src/reduce.ts";
import { promptIndex } from "../src/utils.ts";

function event(seq: number, type: string, data: JsonObject): SessionEvent {
  return {
    id: `event-${seq}`,
    sessionId: "session-1",
    seq,
    time: seq,
    type,
    data,
    v: 1,
  };
}

test("conflict handoff renders a semantic card while hiding its model prompt", () => {
  const hiddenPrompt = "Resolve the merge conflicts for pull request #42.\n\nDo not push.";
  const model = buildModel([
    event(1, "user/message", { text: "Earlier visible prompt" }),
    event(2, "github/conflict-resolution-started", {
      prNumber: 42,
      title: "Rework session routing",
      url: "https://github.com/acme/polyth/pull/42",
      baseRefName: "main",
      headRefName: "feat/session-routing",
    }),
    event(3, "user/message", { text: hiddenPrompt, githubConflictResolution: true }),
  ]);

  assert.equal(model.messages.length, 2);
  assert.equal(model.messages[0]?.kind, "user");
  const card = model.messages[1];
  assert.equal(card?.kind, "github-conflict");
  if (card?.kind !== "github-conflict") assert.fail("expected GitHub conflict card");
  assert.equal(card.prNumber, 42);
  assert.equal(card.title, "Rework session routing");
  assert.equal(JSON.stringify(model.messages).includes(hiddenPrompt), false);
  assert.deepEqual(promptIndex(model.messages).map((prompt) => prompt.text), ["Earlier visible prompt"]);
});
