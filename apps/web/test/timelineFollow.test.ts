import test from "node:test";
import assert from "node:assert/strict";
import {
  freshTurnContextOffset,
  requiredTurnSheetPadding,
  timelineFollowState,
} from "../src/timelineFollow.ts";

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

test("fresh-turn space holds a contextual prompt anchor and yields to growing activity", () => {
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

test("a fresh turn keeps a typographic fragment of the previous agent answer", () => {
  assert.equal(freshTurnContextOffset({
    viewportHeight: 600,
    promptHeight: 48,
    responseHeight: 520,
    responseToPromptGap: 60,
    responseLineHeight: 24,
  }), 132, "60px of footer/gap plus three visible answer lines");

  assert.equal(freshTurnContextOffset({
    viewportHeight: 600,
    promptHeight: 48,
    responseHeight: 30,
    responseToPromptGap: 20,
    responseLineHeight: 24,
  }), 50, "a short previous answer remains visible in full");
});

test("the previous-answer peek yields to the prompt and next answer on a short viewport", () => {
  assert.equal(freshTurnContextOffset({
    viewportHeight: 220,
    promptHeight: 40,
    responseHeight: 400,
    responseToPromptGap: 68,
    responseLineHeight: 24,
  }), 108);

  assert.equal(freshTurnContextOffset({
    viewportHeight: 220,
    promptHeight: 160,
    responseHeight: 400,
    responseToPromptGap: 68,
    responseLineHeight: 24,
  }), 0, "a tall prompt gets the available reading room");

  assert.equal(freshTurnContextOffset({
    viewportHeight: 600,
    promptHeight: 48,
    responseHeight: 0,
    responseToPromptGap: 60,
    responseLineHeight: 24,
  }), 0, "the first prompt does not reserve nonexistent history");
});
