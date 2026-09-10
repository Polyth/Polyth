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

test("file tabs are the only file title and close chrome", () => {
  assert.doesNotMatch(filePane, /className="editor-head"/);
  assert.doesNotMatch(filePane, /editor\.filepane\.closeFile/);
});

test("Files uses the canonical compact type and spacing rhythm", () => {
  assert.match(styles, /\.editor-view\s*\{[^}]*font-family:\s*var\(--ui-font-family\)/s);
  assert.match(styles, /\.editor-toolbar\s*\{[^}]*min-height:\s*var\(--control-h-sm\)[^}]*padding:\s*0 var\(--space-2\)/s);
  assert.match(styles, /\.ft-row\s*\{[^}]*min-height:\s*max\(var\(--control-h-sm\), var\(--hit-min\)\)[^}]*font:\s*400 var\(--font-technical\)\/var\(--font-technical-lh\) var\(--mono\)/s);
  assert.match(styles, /\.ft-at\s*\{[^}]*opacity:\s*0[^}]*pointer-events:\s*none/s);
  assert.match(styles, /\.ft-row:focus-within \.ft-at/);
});
