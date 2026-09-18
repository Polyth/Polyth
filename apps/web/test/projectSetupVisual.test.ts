import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("new-project mobile surfaces follow theme glass and compact phone geometry", async () => {
  const [setupCss, compositionCss, composition] = await Promise.all([
    readFile(new URL("../src/components/ProjectSetupFlowDialog.css", import.meta.url), "utf8"),
    readFile(new URL("../src/components/ProjectCompositionEditor.css", import.meta.url), "utf8"),
    readFile(new URL("../src/components/ProjectCompositionEditor.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(setupCss, /body:not\(\[data-glass="off"\]\):not\(\[data-desktop-low-resource="true"\]\)[\s\S]*dialog-backdrop:has\(\.project-setup-flow-dialog\)[\s\S]*background:\s*transparent/s);
  assert.match(setupCss, /body\[data-glass="off"\][\s\S]*\.folder-dialog \.folder-list[\s\S]*background:\s*var\(--sunken\)/s);
  assert.doesNotMatch(setupCss, /project-setup-actions[^{]*\{[^}]*material-glass-strong/s);
  assert.match(setupCss, /color-mix\(in srgb, var\(--accent\) 11%, transparent\)/);

  assert.match(compositionCss, /@container project-composition \(max-width: 620px\)[\s\S]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/s);
  assert.match(compositionCss, /body:not\(\[data-glass="off"\]\):not\(\[data-desktop-low-resource="true"\]\)[\s\S]*--material-glass-control-fill/s);
  assert.match(compositionCss, /body\[data-glass="off"\][\s\S]*background:\s*var\(--elevated\)/s);
  assert.match(composition, /project-direction-icon/);
  assert.match(composition, /CodeIcon/);
  assert.match(composition, /CoachIcon/);
});
