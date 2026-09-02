import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const source = (path: string) => readFile(new URL(path, import.meta.url), "utf8");
const packageStyles = async () => {
  const packagesDir = resolve(import.meta.dirname, "../..");
  const entries = await readdir(packagesDir, { withFileTypes: true });
  const styles = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => {
      try {
        return await readFile(join(packagesDir, entry.name, "widgets/styles.css"), "utf8");
      } catch {
        return "";
      }
    }));
  return [
    await source("../../../apps/web/src/styles.css"),
    ...styles,
  ].join("\n");
};

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
    packageStyles(),
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
  for (const entry of [goals, files, git, terminal, browser]) {
    assert.match(entry, /host\.surfaces\.register/);
    assert.match(entry, /presentation/);
  }
  assert.match(settingsView, /listSlots\("settings\.pages"\)/);
  assert.doesNotMatch(builtinWidgets, /GoalsView|GitView|TerminalView|GithubView/);

  assert.match(styles, /container:\s*feature-panel\s*\/\s*inline-size/);
  assert.match(styles, /@container feature-panel \(max-width: 700px\)/);
  assert.match(styles, /min-height:\s*var\(--tap\)/);
  assert.match(styles, /font-size:\s*var\(--font-input\)/);
  assert.match(styles, /overscroll-behavior:\s*contain/);
  // Coarse-pointer input still gets explicit treatment; embedded panel widths
  // are handled by container queries (P2-W2 moved the last combined
  // 700px+coarse viewport query in package CSS to an @container rule).
  assert.match(styles, /\(pointer: coarse\)/);
  assert.match(styles, /@container feature-panel \(max-width: 480px\)/);

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
    ".multirun-controls",
    ".fusion-result-head",
    ".walkthrough-source",
    ".workflow-layout",
    ".ha-settings",
    ".ntc-list",
  ]) {
    assert.ok(styles.includes(selector), `${selector} has a responsive refinement`);
  }
});

test("feature forms stack and dense lists scroll at narrow panel widths", async () => {
  const narrow = await packageStyles();

  assert.match(narrow, /\.sched-form \.view-toolbar-row\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.match(narrow, /@container knowledge-panel \(max-width: 700px\)[\s\S]*?\.knowledge-panel > \.knowledge-toolbar,[\s\S]*?flex-direction:\s*column/);
  assert.match(narrow, /\.settings-pane-body \.set-row\s*\{[\s\S]*flex-direction:\s*column/);
  assert.match(narrow, /\.provider-chips\s*\{[\s\S]*overflow-x:\s*auto/);
  assert.match(narrow, /\.step-dots\s*\{[\s\S]*overflow-x:\s*auto/);
  assert.match(narrow, /\.fusion-model-picks\s*\{[\s\S]*overflow-y:\s*auto/);
});
