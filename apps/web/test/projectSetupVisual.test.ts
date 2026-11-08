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
  assert.match(setupCss, /\.dialog-backdrop:has\(\.project-setup-flow-dialog\)[\s\S]*\.dialog-backdrop:has\(\.folder-dialog\)[\s\S]*align-items:\s*stretch[\s\S]*padding:\s*0/s);
  assert.match(setupCss, /body\[data-glass="off"\][\s\S]*\.folder-dialog \.folder-list[\s\S]*background:\s*var\(--sunken\)/s);
  assert.doesNotMatch(setupCss, /project-setup-actions[^{]*\{[^}]*material-glass-strong/s);
  assert.match(setupCss, /color-mix\(in srgb, var\(--accent\) 11%, transparent\)/);

  assert.match(compositionCss, /@container project-composition \(max-width: 620px\)[\s\S]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/s);
  assert.doesNotMatch(compositionCss, /data-glass|data-desktop-low-resource|material-glass-control/);
  assert.match(compositionCss, /\.project-direction-card[\s\S]*background:\s*var\(--material-glass-medium\)/s);
  assert.match(compositionCss, /\.project-direction-card\.is-selected[\s\S]*background:\s*color-mix\(in srgb, var\(--accent\) 16%, var\(--material-glass\)\)/s);
  assert.match(composition, /project-direction-icon/);
  assert.match(composition, /CodeIcon/);
  assert.match(composition, /CoachIcon/);
});

test("new-project step 1 pins its primary action and shares step 2's head grid", async () => {
  const [setupCss, setupTsx, styles] = await Promise.all([
    readFile(new URL("../src/components/ProjectSetupFlowDialog.css", import.meta.url), "utf8"),
    readFile(new URL("../src/components/ProjectSetupFlowDialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
  ]);

  // Only the directions scroll; the Continue bar is a pinned sibling, exactly
  // like the picker's footer on step 2.
  assert.match(setupTsx, /<div className="project-setup-scroll">\s*<ProjectCompositionEditor[^>]*\/>\s*<\/div>\s*<div className="project-setup-actions">/);
  assert.match(setupCss, /\.project-setup-scroll \{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/s);

  // One head anatomy: flow label and the single X on an icon-height line,
  // then the title, then the hint. Never a bottom Cancel.
  assert.match(setupTsx, /<div className="project-setup-head-top">\s*<span className="project-setup-step">[\s\S]*?<IconButton icon=\{CloseIcon\} label=\{tr\("common\.close"\)\} onClick=\{cancel\} \/>\s*<\/div>\s*<h2 className="project-setup-title">[\s\S]*?<p className="project-setup-hint">/);
  assert.match(setupTsx, /<div className="project-setup-actions">\s*<Button size="sm" variant="primary"[^>]*>[\s\S]*?<\/div>/);
  assert.doesNotMatch(setupTsx, /<div className="project-setup-actions">\s*<Button[^>]*onClick=\{cancel\}/);

  // The picker is step 2 of the same flow: same head classes, same fixed height.
  // The step count is interpolated because Engineering takes three steps and
  // everything else two; the picker is always the second one.
  assert.match(setupTsx, /stepLabel: tr\("projectcomposition\.setupStep", \{ step: 2, total: totalSteps \}\)/);
  assert.match(setupTsx, /subtitle=\{tr\("projectcomposition\.pickerHint"\)\}/);
  assert.match(styles, /\.project-setup-flow-step,\s*\n\s*\.folder-dialog-stepped \{ height:\s*min\(608px, calc\(100dvh - 96px\)\); \}/);

  // The expanded Workspace list must not become a nested scroll box here:
  // in a half-height window it collapsed to 0px.
  assert.match(setupCss, /\.project-setup-scroll \.project-package-list \{[^}]*max-height:\s*none;[^}]*overflow:\s*visible;/s);
  assert.doesNotMatch(setupCss, /\.project-setup-flow-dialog > \.project-composition-editor/);
});

test("the new-project window uses the flow's own head and keeps its footer pinned", async () => {
  const [identity, setupCss] = await Promise.all([
    readFile(new URL("../src/components/ProjectIdentityStep.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/ProjectSetupFlowDialog.css", import.meta.url), "utf8"),
  ]);
  // No head of its own: a markup class without styles once put the title under
  // the iPhone status bar, flush with the panel's edges.
  assert.match(identity, /<div className="project-setup-head">[\s\S]*?className="project-setup-title project-identity-heading"[\s\S]*?className="project-setup-hint"/);
  assert.doesNotMatch(identity + setupCss, /project-setup-intro/);
  // The footer is a sibling of the scroll region, as on every other step.
  assert.match(identity, /<\/div>\s*<\/div>\s*\{\/\*[^]*?\*\/\}\s*<div className="project-setup-actions project-identity-actions">/);
});
