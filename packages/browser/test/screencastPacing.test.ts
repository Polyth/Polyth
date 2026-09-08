import test from "node:test";
import assert from "node:assert/strict";
import {
  createScreencastPacing,
  noteScreencastActivity,
  screencastMinIntervalMs,
  setScreencastVisible,
  shouldEmitScreencastFrame,
  markScreencastFrameEmitted,
} from "../src/screencastPacing.ts";

test("idle pacing allows at most ~4 fps", () => {
  const state = createScreencastPacing(() => 0);
  noteScreencastActivity(state, -5000);
  assert.equal(screencastMinIntervalMs(state, 0), 250);
  assert.equal(shouldEmitScreencastFrame(state, 1), true);
  markScreencastFrameEmitted(state, 1);
  assert.equal(shouldEmitScreencastFrame(state, 100), false);
  assert.equal(shouldEmitScreencastFrame(state, 251), true);
});

test("recent activity caps at ~15 fps", () => {
  const state = createScreencastPacing(() => 0);
  noteScreencastActivity(state, 1000);
  assert.equal(screencastMinIntervalMs(state, 1500), 67);
});

test("hidden stream pauses frames", () => {
  const state = createScreencastPacing(() => 0);
  setScreencastVisible(state, false);
  assert.equal(screencastMinIntervalMs(state, 0), null);
  assert.equal(shouldEmitScreencastFrame(state, 0), false);
});

test("independent pacing states do not starve a second visual surface", () => {
  const main = createScreencastPacing(() => 0);
  const popup = createScreencastPacing(() => 0);
  noteScreencastActivity(main, 0);
  noteScreencastActivity(popup, 0);
  assert.equal(shouldEmitScreencastFrame(main, 1), true);
  markScreencastFrameEmitted(main, 1);
  assert.equal(shouldEmitScreencastFrame(popup, 1), true, "popup must not inherit main lastFrameAt");
  markScreencastFrameEmitted(popup, 1);
  assert.equal(shouldEmitScreencastFrame(main, 2), false);
  assert.equal(shouldEmitScreencastFrame(popup, 2), false);
});
