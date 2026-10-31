import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("coarse-pointer Files controls keep the 44px hit-box floor, scoped under the package root", async () => {
  const css = await readFile(new URL("../widgets/styles.css", import.meta.url), "utf8");
  const start = css.indexOf("@media (pointer: coarse) {", css.indexOf("Touch-target floor"));
  assert.ok(start >= 0, "a coarse-pointer block exists");
  const coarse = css.slice(start, css.indexOf("@container", start));
  assert.match(coarse, /\.editor-view :where\(\s*button:not\(\.file-ref\)[^,]*,[\s\S]*?\[role="switch"\]\s*\)\s*\{\s*min-height:\s*var\(--tap\)\s*!important/);
  assert.match(coarse, /\.editor-view :where\(\s*button:not\(\.file-ref\)[^,]*,\s*summary,[\s\S]*?\[role="switch"\]\s*\)\s*\{\s*min-width:\s*var\(--tap\)\s*!important/);
  // Change bars and Undo/Keep chips sit inside code lines and never get the box.
  assert.match(coarse, /button:not\(\.file-ref\):not\(\.cm-change-bar\):not\(\.cm-change-action\)/);
});
