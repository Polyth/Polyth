import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const filePane = await readFile(new URL("../widgets/editor/FilePane.tsx", import.meta.url), "utf8");
const editorView = await readFile(new URL("../widgets/EditorView.tsx", import.meta.url), "utf8");
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
  assert.match(styles, /\.ft-row\s*\{[^}]*min-height:\s*max\(calc\(var\(--control-h-sm\) - var\(--space-2\)\), var\(--hit-min\)\)[^}]*font:\s*400 var\(--font-technical\)\/var\(--font-technical-lh\) var\(--ui-font-family\)/s);
  assert.match(styles, /\.files-row\s*\{[^}]*min-height:\s*max\(calc\(var\(--control-h-sm\) - var\(--space-2\)\), var\(--hit-min\)\)[^}]*padding:\s*0 var\(--space-1\)/s);
  assert.match(styles, /\.ft-row\s*\{[^}]*padding-inline-start:\s*calc\(4px \+ var\(--ft-depth, 0\) \* 8px\)/s);
  assert.doesNotMatch(filePane, /MoreIcon/);
  assert.doesNotMatch(editorView, /FileRowActions/);
  assert.match(styles, /\.ft-row\.ft-selected[^}]*box-shadow:\s*inset 2px 0 0 var\(--accent\)/s);
});

test("context menus portal click anchors to the document", async () => {
  const anchor = await readFile(new URL("../widgets/editor/contextMenuAnchor.tsx", import.meta.url), "utf8");
  const icons = await readFile(new URL("../widgets/editor/fileTreeIcons.tsx", import.meta.url), "utf8");
  assert.match(anchor, /createPortal\(/);
  assert.match(anchor, /document\.body/);
  assert.match(anchor, /position:\s*"fixed"/);
  assert.match(editorView, /ContextMenuAnchor/);
  assert.match(filePane, /ContextMenuAnchor/);
  assert.doesNotMatch(filePane, /setFileMenu\(clampMenuPosition/);
  assert.doesNotMatch(filePane, /openSelectionMenu[\s\S]{0,400}clampMenuPosition/);
  assert.doesNotMatch(filePane, /clientY \+ 8/);
  assert.match(filePane, /createPortal\([\s\S]*editor-explain-panel[\s\S]*document\.body/s);
  assert.match(filePane, /icon:\s*ChatIcon/);
  assert.match(filePane, /icon:\s*AssistIcon/);
  assert.match(filePane, /icon:\s*EditIcon/);
  assert.match(filePane, /editorview\.addToChat/);
  assert.match(icons, /viewBox:\s*"0 0 16 16"/);
  assert.match(icons, /fill:\s*"currentColor"/);
  assert.doesNotMatch(icons, /strokeWidth:\s*1\.8/);
});

test("editor surfaces use compact token padding across file kinds", () => {
  assert.match(styles, /\.editor-md-preview\s*\{[^}]*padding:\s*var\(--space-4\) var\(--space-5\)/s);
  assert.match(styles, /\.editor-json-preview\s*\{[^}]*padding:\s*var\(--space-2\) var\(--space-3\)/s);
  assert.match(styles, /\.code-lines\s*\{[^}]*font:\s*var\(--font-code\)\/1\.55 var\(--mono\)/s);
  assert.match(styles, /\.cl-ln\s*\{[^}]*min-width:\s*3\.25ch/s);
  assert.match(styles, /\.html-preview-note\s*\{[^}]*padding:\s*var\(--space-1\) var\(--space-3\)/s);
});
