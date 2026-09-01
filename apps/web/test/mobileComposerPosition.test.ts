import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("the phone composer stays in visual-viewport flow and expands inside the visible band", async () => {
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

  assert.match(
    css,
    /\.composer-chat\.composer-mobile \{\s*\/\*[^]*?padding: var\(--space-1\) var\(--screen-gutter\) 0;/,
    "the composer does not duplicate the dock or navigator safe-area inset",
  );
  assert.match(
    css,
    /\.composer-mobile\.composer-expanded \.composer-card textarea \{ min-height: calc\(var\(--tap\) \* 2\); \}/,
    "the expanded editor keeps two touch rows without a fixed card height",
  );
  assert.doesNotMatch(
    css,
    /body\[data-keyboard="open"\][\s\S]{0,180}\.composer-chat\.composer-mobile\s*\{[^}]*position:\s*fixed/s,
    "keyboard-open composition remains in visualViewport flow",
  );
});
