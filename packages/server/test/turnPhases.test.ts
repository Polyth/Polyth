import assert from "node:assert/strict";
import test from "node:test";
import { createTurnPhaseRegistry } from "../src/turnPhases.ts";

test("a Stop latches only the turn currently in preparation", () => {
  const latches = createTurnPhaseRegistry();
  assert.equal(latches.get("s1"), undefined);
  const turn = latches.open("s1");
  assert.equal(turn.earlyAbortRequested(), false);
  latches.get("s1")?.requestEarlyAbort();
  assert.equal(turn.earlyAbortRequested(), true);
  assert.equal(latches.get("s2"), undefined);
});

test("re-opening a session starts from a clean latch", () => {
  const latches = createTurnPhaseRegistry();
  latches.open("s1").requestEarlyAbort();
  assert.equal(latches.open("s1").earlyAbortRequested(), false);
});

test("release drops only the exact latch it is given", () => {
  const latches = createTurnPhaseRegistry();
  const first = latches.open("s1");
  const second = latches.open("s1");
  latches.release("s1", first);
  assert.equal(latches.get("s1"), second, "a stale release must not clear a newer turn");
  latches.release("s1", second);
  assert.equal(latches.get("s1"), undefined);
});
