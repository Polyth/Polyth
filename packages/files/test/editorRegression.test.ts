import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const filePane = await readFile(new URL("../widgets/editor/FilePane.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../widgets/styles.css", import.meta.url), "utf8");

test("editor reveal callback stays stable across FilePane rerenders", () => {
  assert.match(filePane, /const onRevealConsumed = useCallback\(\(\) => setReveal\(null\), \[\]\);/);
  assert.match(filePane, /onRevealConsumed=\{onRevealConsumed\}/);
  assert.doesNotMatch(filePane, /onRevealConsumed=\{\(\) => setReveal\(null\)\}/);
});

test("resource pane owns the remaining Files surface", () => {
  assert.match(styles, /\.editor-view\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*row/s);
  assert.match(styles, /\.editor-pane\s*\{[^}]*flex:\s*1 1 0[^}]*display:\s*flex[^}]*flex-direction:\s*column[^}]*overflow:\s*hidden/s);
  assert.match(styles, /\.pane-body\s*\{[^}]*flex:\s*1 1 0[^}]*min-width:\s*0[^}]*min-height:\s*0[^}]*display:\s*flex[^}]*flex-direction:\s*column/s);
  assert.match(styles, /\.pane-body\[hidden\]\s*\{[^}]*display:\s*none/s);
});
