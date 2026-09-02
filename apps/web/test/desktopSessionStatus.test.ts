import test from "node:test";
import assert from "node:assert/strict";
import { nextSessionSwitcherIndex } from "../src/sessionSwitcher.ts";

test("session switcher cycles up then back down", () => {
  let index = 0;
  let direction: 1 | -1 = 1;
  const cycle = [index];
  for (let count = 0; count < 4; count++) {
    [index, direction] = nextSessionSwitcherIndex(index, direction, 3);
    cycle.push(index);
  }
  assert.deepEqual(cycle, [0, 1, 2, 1, 0]);
});
