import test from "node:test";
import assert from "node:assert/strict";
import {
  RAIL_ACTIVE_WIDTH,
  RAIL_BASE_WIDTH,
  RAIL_CURSOR_WIDTH,
  RAIL_MAX_TICKS,
  activePromptIndex,
  cursorTickIndex,
  railWindow,
  tickWidth,
} from "../src/promptRail.ts";

test("railWindow shows everything when it fits", () => {
  assert.deepEqual(railWindow(0, -1), { start: 0, end: 0 });
  assert.deepEqual(railWindow(5, 2), { start: 0, end: 5 });
  assert.deepEqual(railWindow(RAIL_MAX_TICKS, 0), { start: 0, end: RAIL_MAX_TICKS });
});

test("railWindow centers the active tick and clamps at both edges", () => {
  // 100 prompts, 30 ticks: active in the middle sits at the window center.
  const mid = railWindow(100, 50);
  assert.equal(mid.end - mid.start, RAIL_MAX_TICKS);
  assert.deepEqual(mid, { start: 35, end: 65 });
  // Near the start the window clamps to 0.
  assert.deepEqual(railWindow(100, 3), { start: 0, end: 30 });
  // Near the end it clamps so the last tick is the last prompt.
  assert.deepEqual(railWindow(100, 99), { start: 70, end: 100 });
  // No active prompt yet: window ends at the newest prompt.
  assert.deepEqual(railWindow(100, -1), { start: 70, end: 100 });
});

test("tickWidth: base, active, and cursor emphasis", () => {
  assert.equal(tickWidth(0, -1, -1), RAIL_BASE_WIDTH);
  assert.equal(tickWidth(4, 4, -1), RAIL_ACTIVE_WIDTH);
  assert.equal(tickWidth(4, -1, 4), RAIL_CURSOR_WIDTH);
  // Active + cursor on the same tick: the larger (cursor) wins.
  assert.equal(tickWidth(4, 4, 4), RAIL_CURSOR_WIDTH);
});

test("tickWidth proximity wave falls off with distance and floors at base", () => {
  const w0 = tickWidth(10, -1, 10);
  const w1 = tickWidth(11, -1, 10);
  const w2 = tickWidth(12, -1, 10);
  const w3 = tickWidth(13, -1, 10);
  const w4 = tickWidth(14, -1, 10);
  assert.ok(w0 > w1 && w1 > w2 && w2 > w3, `wave must decay: ${[w0, w1, w2, w3].join(",")}`);
  assert.ok(w3 > RAIL_BASE_WIDTH, "distance 3 still swells");
  assert.equal(w4, RAIL_BASE_WIDTH, "outside the falloff the tick stays at base");
  // The wave never shrinks the active tick below its own emphasis.
  assert.equal(tickWidth(14, 14, 10), RAIL_ACTIVE_WIDTH);
});

test("cursorTickIndex maps tape offsets to visible ticks", () => {
  assert.equal(cursorTickIndex(0, 10), 0);
  assert.equal(cursorTickIndex(11, 10), 0);
  assert.equal(cursorTickIndex(12, 10), 1);
  assert.equal(cursorTickIndex(119, 10), 9);
  assert.equal(cursorTickIndex(120, 10), -1, "below the last tick");
  assert.equal(cursorTickIndex(-1, 10), -1, "above the tape");
  assert.equal(cursorTickIndex(5, 0), -1, "no ticks");
});

test("activePromptIndex picks the last prompt at or above the reading line", () => {
  assert.equal(activePromptIndex([], 100), -1);
  // All rendered: last top <= line wins.
  assert.equal(activePromptIndex([10, 50, 90, 400], 100), 2);
  // Everything below the line: the first prompt is current.
  assert.equal(activePromptIndex([200, 300], 100), 0);
  // Earlier prompts windowed out (null): they count as "above", so when every
  // rendered prompt is below the line the newest hidden one is current.
  assert.equal(activePromptIndex([null, null, 200, 300], 100), 1);
  // A rendered prompt above the line beats hidden earlier ones.
  assert.equal(activePromptIndex([null, 40, 300], 100), 1);
});
