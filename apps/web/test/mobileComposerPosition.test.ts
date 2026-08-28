import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("the phone composer is dock-owned and expands inside the visible band", async () => {
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
  assert.match(
    css,
    /body\[data-keyboard="open"\] \.app\.mode-chat\.view-session \.composer-chat\.composer-mobile\s*\{[^}]*position:\s*fixed[^}]*bottom:\s*max\(var\(--keyboard-inset\), var\(--safe-bottom\)\)/s,
    "the keyboard-open composer follows the native keyboard inset",
  );
});
