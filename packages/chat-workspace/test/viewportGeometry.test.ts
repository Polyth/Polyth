import test from "node:test";
import assert from "node:assert/strict";
import {
  clampViewport,
  pagePointFromNormalized,
} from "../widgets/lib/viewportGeometry.ts";

test("clampViewport enforces minimum size", () => {
  assert.deepEqual(clampViewport(100, 100), { width: 320, height: 240 });
});

test("pagePointFromNormalized maps normalized coords to css pixels", () => {
  assert.deepEqual(
    pagePointFromNormalized({ x: 0.5, y: 0.25 }, { width: 800, height: 600 }),
    { x: 400, y: 150 },
  );
});
