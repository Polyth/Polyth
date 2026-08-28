import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (path: string) => readFileSync(resolve(import.meta.dirname, path), "utf8");

test("developer surfaces keep narrow layouts and monospace overflow contained", () => {
  const editor = read("../../files/widgets/EditorView.tsx");
  const terminal = read("../../terminal/widgets/TerminalView.tsx");
  const refinement = [
    read("../../../apps/web/src/styles.css"),
    read("../../files/widgets/styles.css"),
    read("../../git/widgets/styles.css"),
    read("../../terminal/widgets/styles.css"),
  ].join("\n");

  assert.match(editor, /mobileStage/);
  assert.match(editor, /className="editor-mobile-tabs"/);
  assert.match(editor, /mobile-\$\{mobileStage\}/);
  assert.match(terminal, /className="term-tab-list ui-scroll-tabs" role="tablist"/);
  assert.match(terminal, /role="tab"/);

  assert.match(refinement, /\.ui-scroll-tabs\s*\{[^}]*overflow-x:\s*auto/s);
  assert.match(refinement, /\.term-body\s*\{[^}]*overflow-x:\s*auto/s);
  assert.match(refinement, /\.editor-body,[\s\S]*?max-width:\s*100%/);
  assert.match(refinement, /\.split-diff\s*\{[^}]*max-width:\s*100%/);
  assert.match(refinement, /@media \(max-width: 820px\)[\s\S]*?\.editor-view\.mobile-tree \.editor-pane\s*\{\s*display:\s*none/);
  assert.match(refinement, /@container source-surface \(max-width: 700px\)[\s\S]*?\.split-diff-row\s*\{\s*display:\s*block/);
  assert.match(refinement, /@media \(pointer: coarse\)[\s\S]*?\.sidebar-resize,[\s\S]*?\.rail-resize\s*\{\s*display:\s*none/);
});
