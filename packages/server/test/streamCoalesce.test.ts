// Streamed deltas are journaled as checkpoints, not tokens (streamCoalesce.ts).
// These pin the merge rules the session ingress relies on: adjacency, per-part
// runs, the character cap, and the take/reset boundary.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  emptyStreamCheckpoints,
  isStreamChunk,
  pushStreamDelta,
  STREAM_CHECKPOINT_MAX_CHARS,
  STREAM_CHECKPOINT_MS,
  streamCheckpointDelay,
  takeStreamCheckpoints,
} from "../src/streamCoalesce.ts";

test("consecutive deltas of one part merge into a single checkpoint", () => {
  const state = emptyStreamCheckpoints();
  for (const text of ["a", "b", "c"]) {
    assert.equal(pushStreamDelta(state, { type: "assistant/chunk", partId: "p", text }), false);
  }
  assert.deepEqual(state.checkpoints, [{ type: "assistant/chunk", partId: "p", text: "abc" }]);
  assert.equal(state.deltas, 3);
});

test("only adjacent same-part deltas merge, so part order never moves", () => {
  const state = emptyStreamCheckpoints();
  pushStreamDelta(state, { type: "assistant/reasoning-chunk", partId: "r", text: "think-1" });
  pushStreamDelta(state, { type: "assistant/chunk", partId: "a", text: "answer" });
  pushStreamDelta(state, { type: "assistant/reasoning-chunk", partId: "r", text: "think-2" });
  assert.deepEqual(state.checkpoints, [
    { type: "assistant/reasoning-chunk", partId: "r", text: "think-1" },
    { type: "assistant/chunk", partId: "a", text: "answer" },
    { type: "assistant/reasoning-chunk", partId: "r", text: "think-2" },
  ]);
});

test("a different part id starts a new run even with the same type", () => {
  const state = emptyStreamCheckpoints();
  pushStreamDelta(state, { type: "assistant/chunk", partId: "one", text: "a" });
  pushStreamDelta(state, { type: "assistant/chunk", partId: "two", text: "b" });
  pushStreamDelta(state, { type: "assistant/chunk", partId: "two", text: "c" });
  assert.deepEqual(state.checkpoints.map((entry) => [entry.partId, entry.text]), [["one", "a"], ["two", "bc"]]);
});

test("the character cap asks the caller to flush without waiting the window", () => {
  const state = emptyStreamCheckpoints();
  assert.equal(pushStreamDelta(state, { type: "assistant/chunk", partId: "p", text: "x".repeat(STREAM_CHECKPOINT_MAX_CHARS - 1) }), false);
  assert.equal(pushStreamDelta(state, { type: "assistant/chunk", partId: "p", text: "x" }), true);
  assert.equal(state.checkpoints[0]!.text.length, STREAM_CHECKPOINT_MAX_CHARS);
});

test("take returns the runs once and resets the pending state", () => {
  const state = emptyStreamCheckpoints();
  pushStreamDelta(state, { type: "assistant/chunk", partId: "p", text: "a" });
  assert.deepEqual(takeStreamCheckpoints(state), [{ type: "assistant/chunk", partId: "p", text: "a" }]);
  assert.deepEqual(takeStreamCheckpoints(state), []);
  assert.equal(state.deltas, 0);
});

test("only the two streamed delta types are coalesced", () => {
  assert.equal(isStreamChunk({ type: "assistant/chunk" }), true);
  assert.equal(isStreamChunk({ type: "assistant/reasoning-chunk" }), true);
  assert.equal(isStreamChunk({ type: "assistant/message" }), false);
  assert.equal(isStreamChunk({ type: "tool/result" }), false);
});

test("checkpoint scheduling is measured from the previous flush", () => {
  assert.equal(streamCheckpointDelay(1_000, 1_010), STREAM_CHECKPOINT_MS - 10);
  assert.equal(streamCheckpointDelay(1_000, 1_249), 1);
  assert.equal(streamCheckpointDelay(1_000, 1_500), 0);
  assert.equal(streamCheckpointDelay(Number.NaN, 1_000), STREAM_CHECKPOINT_MS);
});
