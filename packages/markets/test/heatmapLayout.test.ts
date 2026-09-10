import assert from "node:assert/strict";
import test from "node:test";
import { layoutWeightedRects } from "../widgets/heatmapLayout.ts";

test("binary heatmap layout preserves proportional area and bounds", () => {
  const rects = layoutWeightedRects([
    { weight: 3, data: "large" },
    { weight: 1, data: "small" },
  ], 400, 200);
  assert.equal(rects.length, 2);
  const large = rects.find((rect) => rect.data === "large")!;
  const small = rects.find((rect) => rect.data === "small")!;
  const largeArea = large.width * large.height;
  const smallArea = small.width * small.height;
  assert.ok(Math.abs((largeArea / smallArea) - 3) < 1e-9);
  assert.ok(rects.every((rect) => rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= 400 && rect.y + rect.height <= 200));
  assert.ok(Math.abs(rects.reduce((sum, rect) => sum + rect.width * rect.height, 0) - 80_000) < 1e-6);
});

test("heatmap layout ignores invalid weights and empty geometry", () => {
  assert.deepEqual(layoutWeightedRects([{ weight: 0, data: "zero" }, { weight: Number.NaN, data: "nan" }], 100, 100), []);
  assert.deepEqual(layoutWeightedRects([{ weight: 1, data: "one" }], 0, 100), []);
});
