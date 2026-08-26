import test from "node:test";
import assert from "node:assert/strict";
import {
  BACK_SWIPE_DISTANCE,
  PULL_REFRESH_DISTANCE,
  SESSION_SWIPE_REVEAL,
  horizontalDistance,
  isEdgeBackSwipe,
  pullRefreshDistance,
} from "../src/mobileGestures.ts";

test("session swipes require deliberate horizontal movement", () => {
  assert.equal(horizontalDistance({ x: 180, y: 100 }, { x: 180 - SESSION_SWIPE_REVEAL, y: 106 }), -64);
  assert.equal(horizontalDistance({ x: 180, y: 100 }, { x: 174, y: 170 }), null);
  assert.equal(horizontalDistance({ x: 180, y: 100 }, { x: 176, y: 102 }), null);
});

test("back swipe starts at the leading edge and clears the distance threshold", () => {
  assert.equal(isEdgeBackSwipe({ x: 20, y: 120 }, { x: 20 + BACK_SWIPE_DISTANCE, y: 124 }), true);
  assert.equal(isEdgeBackSwipe({ x: 60, y: 120 }, { x: 60 + BACK_SWIPE_DISTANCE, y: 124 }), false);
  assert.equal(isEdgeBackSwipe({ x: 20, y: 120 }, { x: 20 + BACK_SWIPE_DISTANCE - 1, y: 124 }), false);
});

test("pull to refresh only arms from the top with vertical resistance", () => {
  assert.equal(pullRefreshDistance({ x: 80, y: 40 }, { x: 84, y: 40 + PULL_REFRESH_DISTANCE * 2 }, 0), PULL_REFRESH_DISTANCE);
  assert.equal(pullRefreshDistance({ x: 80, y: 40 }, { x: 84, y: 180 }, 1), 0);
  assert.equal(pullRefreshDistance({ x: 80, y: 40 }, { x: 180, y: 80 }, 0), 0);
  assert.equal(pullRefreshDistance({ x: 80, y: 40 }, { x: 80, y: 400 }, 0), 96);
});
