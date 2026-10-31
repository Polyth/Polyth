import test from "node:test";
import assert from "node:assert/strict";
import {
  fillDownScrollTop,
  focusLineScrollTop,
  ratchetTimelineExtent,
  timelineFocusLine,
  timelineFollowState,
  timelineTurnReserve,
} from "../src/timelineFollow.ts";

test("the focus line and turn reserve are device-independent", () => {
  const visible = { top: 88, bottom: 600, height: 512 };
  assert.equal(timelineFocusLine(visible), 344);
  assert.equal(timelineTurnReserve(visible), 256);
  assert.equal(focusLineScrollTop({
    contentBottom: 1_500,
    viewportTop: 0,
    visibleTop: visible.top,
    visibleHeight: visible.height,
  }), 1_156);
  assert.equal(focusLineScrollTop({
    contentBottom: 200,
    viewportTop: 0,
    visibleTop: visible.top,
    visibleHeight: visible.height,
  }), 0, "a short transcript naturally clamps instead of inventing a gap");
});

test("the extent floor ratchets while following and yields only an explicit release", () => {
  assert.deepEqual(ratchetTimelineExtent({
    highWater: 1_000,
    naturalExtent: 940,
    visibleHeight: 600,
    following: true,
  }), { extent: 1_000, space: 60, released: false });
  assert.deepEqual(ratchetTimelineExtent({
    highWater: 1_000,
    naturalExtent: 600,
    visibleHeight: 600,
    following: true,
  }), { extent: 900, space: 300, released: true });
  assert.deepEqual(ratchetTimelineExtent({
    highWater: 1_000,
    naturalExtent: 600,
    visibleHeight: 600,
    following: false,
  }), { extent: 600, space: 0, released: true });
  assert.deepEqual(ratchetTimelineExtent({
    highWater: 1_000,
    naturalExtent: 1_200,
    visibleHeight: 600,
    following: true,
  }), { extent: 1_200, space: 0, released: false });
});

test("held blank on top of the live reserve never lifts the tail into the top quarter of the view", () => {
  // A live turn keeps 300px below the tail (reserve plus clearance) in a
  // 600px view: only 150px more may be held, or the tail would leave the
  // reading area. Without that reserve the half-view cap still applies.
  const fold = { highWater: 1_000, naturalExtent: 600, visibleHeight: 600, following: true };
  assert.deepEqual(ratchetTimelineExtent({ ...fold, tailReserve: 300 }), { extent: 750, space: 150, released: true });
  assert.deepEqual(ratchetTimelineExtent({ ...fold, naturalExtent: 880, tailReserve: 300 }),
    { extent: 1_000, space: 120, released: false }, "a fold within the room above the tail is still held");
  assert.deepEqual(ratchetTimelineExtent({ ...fold, tailReserve: 40 }), { extent: 900, space: 300, released: true });
});

test("growing prose fills down: still until the tail reaches the rest line, then it follows that edge", () => {
  // A live answer landed on the focus line with 300px of reserve below it.
  const view = { scrollTop: 1_000, maxScrollTop: 1_300, restLine: 560 };
  const sequence = [300, 420, 560, 600, 760, 900, 1_000].map((tailBottom) =>
    fillDownScrollTop({ ...view, tailBottom }));
  assert.deepEqual(sequence, [1_000, 1_000, 1_000, 1_040, 1_200, 1_300, 1_300],
    "rows stay still inside the reserve, then follow, never past the extent");
  for (let index = 1; index < sequence.length; index += 1) {
    assert.ok(sequence[index]! >= sequence[index - 1]!, "fill-down never moves the view down");
  }
  assert.equal(fillDownScrollTop({ scrollTop: 500, maxScrollTop: 420, tailBottom: 300, restLine: 560 }), 420,
    "a shrunken extent clamps like the browser would");
  assert.equal(fillDownScrollTop({ scrollTop: 10, maxScrollTop: 40, tailBottom: Number.NaN, restLine: 560 }), 10);
});

test("explicit reader intent detaches immediately and is not reclaimed by tail proximity", () => {
  const detached = timelineFollowState({
    scrollTop: 998.5,
    previousScrollTop: 1000,
    distanceFromEnd: 1.5,
    readerDetached: false,
    // Wheel/touch/keyboard intent is captured before the browser scrolls.
    readerIntent: "toward-history",
  });
  assert.deepEqual(detached, { readerDetached: true, following: false, showJump: true, softLocked: false });

  const stillDetached = timelineFollowState({
    scrollTop: 998.75,
    previousScrollTop: 998.5,
    distanceFromEnd: 12,
    readerDetached: true,
  });
  assert.deepEqual(stillDetached, { readerDetached: true, following: false, showJump: true, softLocked: false });
});

test("browser reflow cannot impersonate an upward reader gesture", () => {
  assert.deepEqual(timelineFollowState({
    // Shrinking the fresh-turn spacer or growing the composer can clamp the
    // scroll position upward even though the reader supplied no input.
    scrollTop: 920,
    previousScrollTop: 1000,
    distanceFromEnd: 80,
    readerDetached: false,
  }), { readerDetached: false, following: true, showJump: false, softLocked: false });
});

test("a detached reader reconnects only after moving down to the real tail", () => {
  assert.deepEqual(timelineFollowState({
    scrollTop: 950,
    previousScrollTop: 940,
    distanceFromEnd: 50,
    readerDetached: true,
    readerIntent: "toward-tail",
  }), { readerDetached: true, following: false, showJump: true, softLocked: false });

  assert.deepEqual(timelineFollowState({
    scrollTop: 1000,
    previousScrollTop: 950,
    distanceFromEnd: 0,
    readerDetached: true,
    readerIntent: "toward-tail",
  }), { readerDetached: false, following: true, showJump: false, softLocked: false });
});

test("a detached reader is not reattached by tailward layout correction", () => {
  assert.deepEqual(timelineFollowState({
    scrollTop: 1000,
    previousScrollTop: 950,
    distanceFromEnd: 0,
    readerDetached: true,
  }), { readerDetached: true, following: false, showJump: true, softLocked: false });
});

test("a detached reader reconnects once the live tail is revealed above its runway", () => {
  // A streamed answer fills down inside the reserve: the reader sees the whole
  // tail long before the blank end of the scroll extent.
  assert.deepEqual(timelineFollowState({
    scrollTop: 900,
    previousScrollTop: 860,
    distanceFromEnd: 240,
    readerDetached: true,
    readerIntent: "toward-tail",
    tailRevealed: true,
  }), { readerDetached: false, following: true, showJump: false, softLocked: true });

  assert.deepEqual(timelineFollowState({
    scrollTop: 900,
    previousScrollTop: 860,
    distanceFromEnd: 240,
    readerDetached: true,
    readerIntent: "toward-tail",
    tailRevealed: false,
  }), { readerDetached: true, following: false, showJump: true, softLocked: false },
  "rows still hidden below the composer edge keep the control");

  assert.deepEqual(timelineFollowState({
    scrollTop: 900,
    previousScrollTop: 860,
    distanceFromEnd: 240,
    readerDetached: true,
    tailRevealed: true,
  }), { readerDetached: true, following: false, showJump: true, softLocked: false },
  "layout correction without reader intent still cannot reattach");
});

test("moving up inside live runway soft-locks instead of detaching", () => {
  const locked = timelineFollowState({
    scrollTop: 940,
    previousScrollTop: 1000,
    distanceFromEnd: 60,
    readerDetached: true, // stopFollowing ran on the wheel/touch input
    readerIntent: "toward-history",
    tailRevealed: true,
  });
  assert.deepEqual(locked, { readerDetached: false, following: true, showJump: false, softLocked: true });

  assert.deepEqual(timelineFollowState({
    scrollTop: 945,
    previousScrollTop: 940,
    distanceFromEnd: 55,
    readerDetached: false,
    tailRevealed: true,
    softLocked: true,
  }), { readerDetached: false, following: true, showJump: false, softLocked: true },
  "reflow keeps the lock while blank runway remains");

  assert.deepEqual(timelineFollowState({
    scrollTop: 700,
    previousScrollTop: 940,
    distanceFromEnd: 300,
    readerDetached: false,
    readerIntent: "toward-history",
    tailRevealed: false,
    softLocked: true,
  }), { readerDetached: true, following: false, showJump: true, softLocked: false },
  "scrolling the tail out of view detaches as before");

  assert.deepEqual(timelineFollowState({
    scrollTop: 1000,
    previousScrollTop: 945,
    distanceFromEnd: 0,
    readerDetached: false,
    readerIntent: "toward-tail",
    tailRevealed: true,
    softLocked: true,
  }), { readerDetached: false, following: true, showJump: false, softLocked: false },
  "scrolling on into the true tail returns to live follow spacing");
});

test("without runway a slow upward tick still detaches at the true tail", () => {
  assert.deepEqual(timelineFollowState({
    scrollTop: 998.5,
    previousScrollTop: 1000,
    distanceFromEnd: 1.5,
    readerDetached: false,
    readerIntent: "toward-history",
    tailRevealed: true,
  }), { readerDetached: true, following: false, showJump: true, softLocked: false });
});
