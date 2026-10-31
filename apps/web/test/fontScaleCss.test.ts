import test from "node:test";
import assert from "node:assert/strict";
import { scaleUiFontSizes } from "../fontScaleCss.ts";

test("UI font scaling transforms literal pixel font sizes only", () => {
  const css = ".label { font-size: 12.5px; padding: 8px; } .code { font-size: var(--editor-font-size); }";
  assert.equal(
    scaleUiFontSizes(css),
    ".label { font-size: calc(12.5px * var(--text-scale, var(--ui-font-scale, 1))); padding: 8px; } .code { font-size: var(--editor-font-size); }",
  );
});

test("transformed rules follow the scale of the surface they render in", () => {
  // `--text-scale` is the current text surface's multiplier, so a fixed-pixel
  // rule inside a conversation follows the chat size while the same rule in a
  // menu follows the menu size. The published `--ui-font-scale` stays as the
  // fallback for a sheet this transform never processed.
  const css = scaleUiFontSizes(".tab { font-size: 12px; }");
  assert.match(css, /var\(--text-scale, var\(--ui-font-scale, 1\)\)/);
  assert.equal((css.match(/var\(--text-scale/g) ?? []).length, 1);
});
