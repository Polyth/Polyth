import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("slot-backed feature panels share the responsive surface stylesheet", async () => {
  const [
    main,
    app,
    styles,
    workspaceSurfaces,
    railSurfaces,
    settingsView,
    builtinWidgets,
  ] = await Promise.all([
    source("../src/bootstrap.tsx"),
    source("../src/App.tsx"),
    source("../src/featurePanels.css"),
    source("../src/components/workspace/builtinSurfaces.tsx"),
    source("../src/components/railSurfaces.tsx"),
    source("../src/components/SettingsView.tsx"),
    source("../src/widgets/builtinWidgets.tsx"),
  ]);

  assert.match(main, /import "\.\/featurePanels\.css";/);
  assert.doesNotMatch(app, /registerSlot\(|registerWorkspaceSurface\(|registerSurface\(/);

  for (const panel of [
    "GoalsView",
    "MultiRunView",
    "WorkflowView",
    "FusionView",
    "WalkthroughView",
    "ScheduleView",
    "GithubView",
  ]) {
    assert.match(workspaceSurfaces, new RegExp(`component: ${panel}`), `${panel} remains registry-backed`);
  }
  for (const panel of ["EditorView", "GitView", "TerminalView", "PreviewView", "KnowledgePanel"]) {
    assert.match(railSurfaces, new RegExp(`component: ${panel}`), `${panel} remains surface-registry-backed`);
  }
  assert.match(settingsView, /listSlots\("settings\.pages"\)/);
  assert.match(builtinWidgets, /registerSlot\(\s*"widget\.catalog"/s);

  assert.match(styles, /container:\s*feature-panel\s*\/\s*inline-size/);
  assert.match(styles, /@container feature-panel \(max-width: 700px\)/);
  assert.match(styles, /min-height:\s*var\(--tap\)/);
  assert.match(styles, /font-size:\s*var\(--font-input\)/);
  assert.match(styles, /overscroll-behavior:\s*contain/);
  assert.match(styles, /@media \(max-width: 700px\), \(pointer: coarse\)/);

  for (const selector of [
    ".goals-head",
    ".permission-toast",
    ".sched-form",
    ".knowledge-panel",
    ".gh-list",
    ".usage-stat-grid",
    ".provider-list",
    ".hotkey-capture",
    ".plugin-card-grid",
    ".multirun-grid",
    ".fusion-layout",
    ".walkthrough-source",
    ".workflow-layout",
    ".ha-settings",
    ".ntc-list",
  ]) {
    assert.ok(styles.includes(selector), `${selector} has a responsive refinement`);
  }
});

test("feature forms stack and dense lists scroll at narrow panel widths", async () => {
  const styles = await source("../src/featurePanels.css");
  const narrow = styles.slice(
    styles.indexOf("@container feature-panel (max-width: 700px)"),
    styles.indexOf("@media (max-width: 700px), (pointer: coarse)"),
  );

  assert.match(narrow, /\.sched-form \.view-toolbar-row,[\s\S]*flex-direction:\s*column/);
  assert.match(narrow, /\.knowledge-panel > \.view-toolbar-row,[\s\S]*flex-direction:\s*column/);
  assert.match(narrow, /\.settings-pane-body \.set-row\s*\{[\s\S]*flex-direction:\s*column/);
  assert.match(narrow, /\.provider-chips\s*\{[\s\S]*overflow-x:\s*auto/);
  assert.match(narrow, /\.step-dots\s*\{[\s\S]*overflow-x:\s*auto/);
  assert.match(narrow, /\.fusion-model-picks\s*\{[\s\S]*overflow-y:\s*auto/);
});
