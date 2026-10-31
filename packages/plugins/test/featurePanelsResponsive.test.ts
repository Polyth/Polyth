import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const packagesDir = resolve(import.meta.dirname, "../..");
const source = (path: string) => readFile(new URL(path, import.meta.url), "utf8");
const readOr = async (path: string): Promise<string> => {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
};

const packageStyles = async () => {
  const entries = await readdir(packagesDir, { withFileTypes: true });
  const styles = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => readOr(join(packagesDir, entry.name, "widgets/styles.css"))));
  return [
    await source("../../../apps/web/src/styles.css"),
    ...styles,
  ].join("\n");
};

/** Feature-panel entries the shell would discover from package manifests. A
 *  removed package simply stops being discovered; the host never names one. */
const featureEntries = async (): Promise<Array<{ id: string; text: string }>> => {
  const entries = await readdir(packagesDir, { withFileTypes: true });
  const found: Array<{ id: string; text: string }> = [];
  for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
    let webEntry: string | undefined;
    try {
      const manifest = JSON.parse(await readFile(join(packagesDir, entry.name, "package.json"), "utf8")) as {
        polyth?: { webEntry?: string };
      };
      webEntry = manifest.polyth?.webEntry;
    } catch {
      continue;
    }
    if (!webEntry) continue;
    const text = await readOr(resolve(packagesDir, entry.name, webEntry));
    if (text) found.push({ id: entry.name, text });
  }
  return found;
};

/** Directory ids under packages/. A removed package is simply absent, so
 *  package-specific style assertions are gated on membership here. */
const presentPackageIds = async (): Promise<Set<string>> =>
  new Set((await readdir(packagesDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name));

test("slot-backed feature panels share the responsive surface stylesheet", async () => {
  const [
    app,
    styles,
    panels,
    settingsView,
    builtinWidgets,
  ] = await Promise.all([
    source("../../../apps/web/src/App.tsx"),
    packageStyles(),
    featureEntries(),
    source("../../../apps/web/src/components/SettingsView.tsx"),
    source("../../../apps/web/src/widgets/builtinWidgets.tsx"),
  ]);

  assert.match(await source("../widgets/index.tsx"), /import "\.\/styles\.css";/);
  assert.doesNotMatch(app, /registerSlot\(|registerWorkspaceSurface\(|registerSurface\(/);

  // Every present package that registers a workspace surface also declares its
  // presentation; the host never hands the shell a bare surface.
  const surfacePanels = panels.filter((panel) => /host\.surfaces\.register/.test(panel.text));
  for (const panel of surfacePanels) {
    assert.match(panel.text, /presentation/, `${panel.id} declares its surface presentation`);
  }
  // The framework panels ship in every build, so the contract above cannot
  // pass vacuously when the removable feature packages are absent.
  for (const id of ["files", "git", "terminal"]) {
    assert.ok(surfacePanels.some((panel) => panel.id === id), `${id} registers a workspace surface`);
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

  // Framework and host selectors ship in every build. Package selectors are
  // asserted only while their owning package is present, so deleting a
  // removable folder leaves the framework assertions standing.
  for (const selector of [
    ".permission-toast",
    ".gh-list",
    ".provider-list",
    ".hotkey-capture",
    ".settings-list",
    ".ha-settings",
    ".ntc-list",
  ]) {
    assert.ok(styles.includes(selector), `${selector} has a responsive refinement`);
  }
  const present = await presentPackageIds();
  const packageSelectors: Array<[id: string, selector: string]> = [
    ["goals", ".goals-head"],
    ["agents", ".agent-filter-row"],
    ["knowledge", ".knowledge-panel"],
    ["multirun", ".multirun-controls"],
    ["fusion", ".fusion-result-head"],
    ["walkthrough", ".walkthrough-source"],
  ];
  for (const [id, selector] of packageSelectors) {
    if (!present.has(id)) continue;
    assert.ok(styles.includes(selector), `${id} ${selector} has a responsive refinement`);
  }
});

test("feature forms stack and dense lists scroll at narrow panel widths", async () => {
  const narrow = await packageStyles();
  const present = await presentPackageIds();

  // Framework and host refinements ship in every build.
  assert.match(narrow, /\.settings-pane-body \.set-row\s*\{[\s\S]*flex-direction:\s*column/);
  assert.match(narrow, /\.provider-list\s*\{[\s\S]*min-height:\s*0/);

  if (present.has("agents")) {
    // The agents' filter row puts its search on a row of its own.
    assert.match(narrow, /@container agents-page \(max-width: 520px\)[\s\S]*?\.agents-page \.agent-filter-row \{ grid-template-columns:/);
    assert.match(narrow, /\.agents-page \.agent-filter-row > \.ui-input \{ grid-column: 1 \/ 3; grid-row: 2; \}/);
  }
  if (present.has("knowledge")) {
    assert.match(narrow, /@container knowledge-panel \(max-width: 700px\)[\s\S]*?\.knowledge-panel > \.knowledge-toolbar,[\s\S]*?flex-direction:\s*column/);
  }
  if (present.has("walkthrough")) {
    assert.match(narrow, /\.step-dots\s*\{[\s\S]*overflow-x:\s*auto/);
  }
});
