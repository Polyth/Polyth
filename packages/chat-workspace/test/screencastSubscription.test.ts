import test from "node:test";
import assert from "node:assert/strict";
import {
  acceptsFrames,
  buildSubscribeMessage,
  initialScreencastState,
  shouldSubscribe,
  transitionScreencast,
} from "../widgets/lib/screencastSubscription.ts";

test("tab switch resets revision and enters subscribing when visible", () => {
  let state = initialScreencastState();
  state = transitionScreencast(state, { type: "select-tab", tabId: "t1" });
  assert.equal(state.phase, "subscribing");
  assert.equal(state.revision, 0);
  state = transitionScreencast(state, { type: "frame", revision: 3 });
  assert.equal(state.phase, "active");
  state = transitionScreencast(state, { type: "select-tab", tabId: "t2" });
  assert.equal(state.tabId, "t2");
  assert.equal(state.revision, 0);
  assert.equal(state.phase, "subscribing");
});

test("hiding pauses and blocks frames; showing resumes subscribe", () => {
  let state = transitionScreencast(initialScreencastState(), { type: "select-tab", tabId: "t1" });
  state = transitionScreencast(state, { type: "set-visible", visible: false });
  assert.equal(state.phase, "paused");
  assert.equal(acceptsFrames(state), false);
  state = transitionScreencast(state, { type: "set-visible", visible: true });
  assert.equal(shouldSubscribe(state), true);
  assert.deepEqual(buildSubscribeMessage("t1", true, 0), {
    type: "chat-workspace/subscribe",
    tabId: "t1",
    visible: true,
    afterRevision: 0,
    quality: 60,
  });
});

test("unmount closes and rejects frames", () => {
  let state = transitionScreencast(initialScreencastState(), { type: "select-tab", tabId: "t1" });
  state = transitionScreencast(state, { type: "unmount" });
  assert.equal(state.phase, "closed");
  assert.equal(acceptsFrames(state), false);
  state = transitionScreencast(state, { type: "frame", revision: 9 });
  assert.equal(state.revision, 0);
});
