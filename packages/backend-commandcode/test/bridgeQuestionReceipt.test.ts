import assert from "node:assert/strict";
import test from "node:test";
import { COMMANDCODE_BRIDGE_SOURCE } from "../src/bridgeSource.ts";

test("question receipts are unique per native question entity", () => {
  assert.match(COMMANDCODE_BRIDGE_SOURCE, /const existingQuestion = mutations\.find/);
  assert.match(COMMANDCODE_BRIDGE_SOURCE, /entry\?\.entityId === entityId/);
  assert.match(COMMANDCODE_BRIDGE_SOURCE, /entry\.mutationKind === "question-reply" \|\| entry\.mutationKind === "question-reject"/);
  assert.match(COMMANDCODE_BRIDGE_SOURCE, /existingQuestion\.operationId !== operationId/);
  assert.match(COMMANDCODE_BRIDGE_SOURCE, /existingQuestion\.mutationKind !== mutationKind/);
  assert.match(COMMANDCODE_BRIDGE_SOURCE, /question already has a durable response receipt/);
});

test("question receipt uniqueness is checked inside the serialized binding update", () => {
  const functionStart = COMMANDCODE_BRIDGE_SOURCE.indexOf("const persistMutationReceipt =");
  const functionEnd = COMMANDCODE_BRIDGE_SOURCE.indexOf("const persistSteerReceipt =", functionStart);
  const body = COMMANDCODE_BRIDGE_SOURCE.slice(functionStart, functionEnd);
  const update = body.indexOf("await updateBinding((previous) =>");
  const uniqueness = body.indexOf("const existingQuestion = mutations.find");
  const accepted = body.indexOf("const acceptedMutations =");
  assert.ok(update >= 0 && uniqueness > update && accepted > uniqueness);
});

test("question response is released only after a durable receipt and receipt failure stays ambiguous", () => {
  const start = COMMANDCODE_BRIDGE_SOURCE.indexOf('if (request?.type === "answer_question")');
  const end = COMMANDCODE_BRIDGE_SOURCE.indexOf('reply(id, false, "unsupported control request")', start);
  const body = COMMANDCODE_BRIDGE_SOURCE.slice(start, end);

  const persist = body.indexOf("await persistMutationReceipt(operationId, mutationKind, requestId)");
  const destroy = body.indexOf("socket.destroy()", persist);
  const release = body.indexOf("pending.resolve(answer)", persist);
  const success = body.indexOf("reply(id, true)", release);

  assert.ok(persist >= 0 && destroy > persist && release > destroy && success > release);
  assert.doesNotMatch(body, /question response receipt could not be persisted/);
});
