import test from "node:test";
import assert from "node:assert/strict";
import { scaleUiFontSizes } from "../fontScaleCss.ts";

test("UI font scaling transforms literal pixel font sizes only", () => {
  const css = ".label { font-size: 12.5px; padding: 8px; } .code { font-size: var(--editor-font-size); }";
  assert.equal(
    scaleUiFontSizes(css),
    ".label { font-size: calc(12.5px * var(--ui-font-scale, 1)); padding: 8px; } .code { font-size: var(--editor-font-size); }",
  );
});
