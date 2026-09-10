import test from "node:test";
import assert from "node:assert/strict";
import { requiredTurnSheetPadding, timelineFollowState } from "../src/timelineFollow.ts";

test("explicit reader intent detaches immediately and is not reclaimed by tail proximity", () => {
  const detached = timelineFollowState({
    scrollTop: 998.5,
    previousScrollTop: 1000,
    distanceFromEnd: 1.5,
    readerDetached: false,
    // Wheel/touch/keyboard intent is captured before the browser scrolls.
    readerIntent: "toward-history",
  });
  assert.deepEqual(detached, { readerDetached: true, following: false, showJump: true });

  const stillDetached = timelineFollowState({
    scrollTop: 998.75,
    previousScrollTop: 998.5,
    distanceFromEnd: 12,
    readerDetached: true,
  });
  assert.deepEqual(stillDetached, { readerDetached: true, following: false, showJump: true });
});

test("browser reflow cannot impersonate an upward reader gesture", () => {
  assert.deepEqual(timelineFollowState({
    // Shrinking the fresh-turn spacer or growing the composer can clamp the
    // scroll position upward even though the reader supplied no input.
    scrollTop: 920,
    previousScrollTop: 1000,
    distanceFromEnd: 80,
    readerDetached: false,
  }), { readerDetached: false, following: true, showJump: false });
});

test("a detached reader reconnects only after moving down to the real tail", () => {
  assert.deepEqual(timelineFollowState({
    scrollTop: 950,
    previousScrollTop: 940,
    distanceFromEnd: 50,
    readerDetached: true,
    readerIntent: "toward-tail",
  }), { readerDetached: true, following: false, showJump: true });

  assert.deepEqual(timelineFollowState({
    scrollTop: 1000,
    previousScrollTop: 950,
    distanceFromEnd: 0,
    readerDetached: true,
    readerIntent: "toward-tail",
  }), { readerDetached: false, following: true, showJump: false });
});

test("a detached reader is not reattached by tailward layout correction", () => {
  assert.deepEqual(timelineFollowState({
    scrollTop: 1000,
    previousScrollTop: 950,
    distanceFromEnd: 0,
    readerDetached: true,
  }), { readerDetached: true, following: false, showJump: true });
});

test("fresh-turn space aligns a prompt at the top and yields to growing activity", () => {
  const initial = requiredTurnSheetPadding({
    scrollHeight: 1800,
    currentPadding: 0,
    clientHeight: 600,
    desiredScrollTop: 1500,
  });
  assert.equal(initial, 300);

  const afterGrowth = requiredTurnSheetPadding({
    scrollHeight: 2220,
    currentPadding: initial,
    clientHeight: 600,
    desiredScrollTop: 1500,
  });
  assert.equal(afterGrowth, 180);

  const exhausted = requiredTurnSheetPadding({
    scrollHeight: 2520,
    currentPadding: afterGrowth,
    clientHeight: 600,
    desiredScrollTop: 1500,
  });
  assert.equal(exhausted, 0);
});
