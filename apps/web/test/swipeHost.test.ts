// The host gate for Polyth's own navigation swipes (swipeHost.ts): in a phone
// browser the browser owns the edge gesture, so the shell must stand down; in
// the installed app (and on a fine-pointer desktop browser) it stays on.
import test from "node:test";
import assert from "node:assert/strict";

const { hostOwnsEdgeGestures } = await import("../src/swipeHost.ts");

test("a coarse-pointer web browser owns the edge gesture", () => {
  assert.equal(hostOwnsEdgeGestures({ nativeApp: false, coarsePointer: true }), true);
});

test("the installed app never yields to a browser gesture", () => {
  assert.equal(hostOwnsEdgeGestures({ nativeApp: true, coarsePointer: true }), false);
  assert.equal(hostOwnsEdgeGestures({ nativeApp: true, coarsePointer: false }), false);
});

test("a fine-pointer desktop browser keeps its swipes (no competing system gesture)", () => {
  assert.equal(hostOwnsEdgeGestures({ nativeApp: false, coarsePointer: false }), false);
});
