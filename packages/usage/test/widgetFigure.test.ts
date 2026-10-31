import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./tsxHooks.mjs", import.meta.url);
const { splitFigure } = await import("../widgets/usage/Figure.tsx");

test("a figure splits into its lower-bound sign, the number and the trailing unit", () => {
  const parts = (value: string) => {
    const split = splitFigure(value);
    return split ? [split.sign, split.number, split.unit] : null;
  };
  assert.deepEqual(parts("14%"), ["", "14", "%"]);
  assert.deepEqual(parts("≥22.6B"), ["≥", "22.6", "B"]);
  assert.deepEqual(parts("~25%"), ["~", "25", "%"]);
  assert.deepEqual(parts("134.2 tok/s"), ["", "134.2", " tok/s"]);
  assert.deepEqual(parts("61% used"), ["", "61", "% used"]);
  assert.deepEqual(parts("$7.52"), ["", "$7.52", ""], "a leading currency symbol stays with the number");
  assert.deepEqual(parts("≥$12.5K"), ["≥", "$12.5", "K"]);
  assert.deepEqual(parts("1,284"), ["", "1,284", ""]);
  assert.deepEqual(parts("12 480,37 $"), ["", "12 480,37", " $"], "a trailing currency reads as the unit");
});

test("a value that does not start with a number is left whole", () => {
  for (const value of ["—", "Unlimited", "In use", "Available", "US$5"]) {
    assert.equal(splitFigure(value), null, value);
  }
});
