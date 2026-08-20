// L13 timeline windowing: the rendered window is always a suffix, growing it
// is monotonic and capped at "everything", and a jump to a hidden row grows
// the limit exactly far enough. Pure math — the render model never changes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { grownLimit, hiddenCount, limitToInclude, windowStart, TIMELINE_CHUNK, TIMELINE_WINDOW } from "../src/timelineWindow.ts";

test("windowStart/hiddenCount: suffix window, nothing hidden for short sessions", () => {
  assert.equal(windowStart(10, TIMELINE_WINDOW), 0);
  assert.equal(hiddenCount(10, TIMELINE_WINDOW), 0);
  assert.equal(windowStart(500, 150), 350);
  assert.equal(hiddenCount(500, 150), 350);
  // degenerate limits stay safe
  assert.equal(windowStart(500, 0), 500);
  assert.equal(windowStart(500, -5), 500);
  assert.equal(windowStart(0, 150), 0);
});

test("grownLimit grows by a chunk and caps at everything", () => {
  assert.equal(grownLimit(500, 150), 150 + TIMELINE_CHUNK);
  assert.equal(grownLimit(160, 150), 160);
  assert.equal(grownLimit(150, 150), 150);
  assert.equal(grownLimit(500, 150, 25), 175);
});

test("limitToInclude: visible rows keep the limit, hidden rows grow it exactly", () => {
  // 500 rows, limit 150 → rows 350..499 visible
  assert.equal(limitToInclude(500, 150, 400), 150);
  assert.equal(limitToInclude(500, 150, 350), 150);
  // row 349 is the first hidden one: limit must become 151
  assert.equal(limitToInclude(500, 150, 349), 151);
  // the very first row needs everything
  assert.equal(limitToInclude(500, 150, 0), 500);
  // out-of-range indexes change nothing (unknown prompt id)
  assert.equal(limitToInclude(500, 150, -1), 150);
  assert.equal(limitToInclude(500, 150, 500), 150);
});
