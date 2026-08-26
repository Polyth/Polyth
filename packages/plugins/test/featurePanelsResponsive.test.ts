import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("slot-backed feature panels share the responsive surface stylesheet", async () => {
  const [
    app,
    styles,
    goals,
    files,
    git,
    terminal,
    browser,
    settingsView,
    builtinWidgets,
  ] = await Promise.all([
    source("../../../apps/web/src/App.tsx"),
    source("../widgets/styles.css"),
    source("../../goals/widgets/index.tsx"),
    source("../../files/widgets/index.tsx"),
    source("../../git/widgets/index.tsx"),
    source("../../terminal/widgets/index.tsx"),
    source("../../browser/widgets/index.tsx"),
    source("../../../apps/web/src/components/SettingsView.tsx"),
    source("../../../apps/web/src/widgets/builtinWidgets.tsx"),
  ]);

  assert.match(await source("../widgets/index.tsx"), /import "\.\/styles\.css";/);
  assert.doesNotMatch(app, /registerSlot\(|registerWorkspaceSurface\(|registerSurface\(/);
  assert.match(goals, /host\.workspaceSurfaces\.register/);
  for (const entry of [files, git, terminal, browser]) assert.match(entry, /host\.surfaces\.register/);
  assert.match(settingsView, /listSlots\("settings\.pages"\)/);
  assert.doesNotMatch(builtinWidgets, /GoalsView|GitView|TerminalView|GithubView/);

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
  const styles = await source("../widgets/styles.css");
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
