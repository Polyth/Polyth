import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { ResolvedCapability } from "../src/capabilities.ts";
import type { WidgetDef } from "../src/widgets/catalog.ts";
import {
  addPanelItem,
  createWorkspacePanelLayout,
  movePanelItem,
  panelItemCatalog,
  parseWorkspacePanelLayout,
  removePanelItem,
  updatePanelItem,
} from "../src/workspacePanel.ts";

const capability = (id: string, rank: number): ResolvedCapability => ({
  descriptor: {
    id,
    label: id === "files" ? "Project files" : id,
    plainDescription: `Open ${id}`,
    keywords: [id],
    standardTier: "more",
    standardRank: rank,
    open() {},
    available: () => true,
  },
  tier: "more",
  rank,
});
const render = () => null;
const capabilities = ["files", "browser", "terminal", "git", "goals", "knowledge", "multirun", "schedule", "usage"]
  .map(capability);
const widgets: WidgetDef[] = [
  { id: "usage.project", pluginId: "usage", title: "Usage", description: "Real project usage", panelSizes: ["wide", "large"], panelDefaultSize: "large", render },
  { id: "session.activity", pluginId: "session", title: "Activity", description: "Recent events", render },
  { id: "session.work-status", pluginId: "session", title: "Tasks", description: "Current work", render },
];

test("capabilities, widgets, and layout elements share one panel item catalog", () => {
  const catalog = panelItemCatalog(capabilities, widgets);
  assert.equal(catalog.find((item) => item.id === "launcher:files")?.type, "launcher");
  assert.equal(catalog.find((item) => item.id === "widget:usage.project")?.type, "widget");
  assert.equal(catalog.find((item) => item.id === "layout:labeled-divider")?.type, "labeled-divider");
  assert.deepEqual(catalog.find((item) => item.id === "widget:usage.project")?.supportedSizes, ["wide", "large"]);
});

test("new workspace defaults to six launchers, real Usage, compact items, and a configurable divider", () => {
  const layout = createWorkspacePanelLayout(panelItemCatalog(capabilities, widgets));
  assert.deepEqual(layout.items.slice(0, 6).map((item) => item.definitionId), [
    "launcher:files", "launcher:browser", "launcher:terminal", "launcher:git", "launcher:goals", "launcher:knowledge",
  ]);
  assert.equal(layout.items[6]?.definitionId, "widget:usage.project");
  assert.equal(layout.items[6]?.size, "large");
  assert.equal(layout.items.find((item) => item.definitionId === "layout:labeled-divider")?.config.label, "Project progress");
});

test("add, remove, reorder, resize, labels, and multi-instance layout survive parsing", () => {
  const catalog = panelItemCatalog(capabilities, widgets);
  let layout = createWorkspacePanelLayout(catalog, ["files", "terminal"]);
  const header = catalog.find((item) => item.id === "layout:header")!;
  layout = addPanelItem(layout, header);
  layout = addPanelItem(layout, header);
  layout = movePanelItem(layout, "layout:header#2", 0);
  layout = updatePanelItem(layout, "layout:header#2", { config: { label: "Development" } });
  layout = removePanelItem(layout, "launcher:terminal");
  const restored = parseWorkspacePanelLayout(JSON.stringify(layout), catalog);
  assert.equal(restored.items[0]?.config.label, "Development");
  assert.equal(restored.items.filter((item) => item.definitionId === "layout:header").length, 2);
  assert.equal(restored.items.some((item) => item.definitionId === "launcher:terminal"), false);
});

test("legacy customized capability order migrates to launcher panel items", () => {
  const catalog = panelItemCatalog(capabilities, widgets);
  const migrated = parseWorkspacePanelLayout(null, catalog, ["knowledge", "files", "git"]);
  assert.deepEqual(migrated.items.map((item) => item.definitionId), ["launcher:knowledge", "launcher:files", "launcher:git"]);
});

test("Workspace edit library remains in the same Sheet and does not open customization UI", async () => {
  const source = await readFile(new URL("../src/components/mobile/WorkspacePanel.tsx", import.meta.url), "utf8");
  const oldTools = await readFile(new URL("../src/components/mobile/MobileSessionHeader.tsx", import.meta.url), "utf8");
  assert.equal((source.match(/<Sheet/g) ?? []).length, 1);
  assert.match(source, /Available items/);
  assert.match(source, /addPanelItem/);
  assert.match(source, /removePanelItem/);
  assert.match(source, /movePanelItem/);
  assert.match(source, /dismiss="back"/);
  assert.doesNotMatch(source, /WidgetLibraryPanel|setOverlay\("settings"\)/);
  assert.doesNotMatch(oldTools, /Customize tools|\["Workspace"|\["Agent"|\["System"/);
});

test("phone Workspace owns full-width navigation geometry without sheet drag chrome", async () => {
  const styles = await readFile(new URL("../src/workspacePanelPremium.css", import.meta.url), "utf8");
  const coreStyles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const sheet = await readFile(new URL("../src/components/mobile/Sheet.tsx", import.meta.url), "utf8");

  assert.match(styles, /\.sheet-backdrop:has\(> \.workspace-panel-sheet\)\s*\{[^}]*padding:\s*0;/s);
  assert.match(styles, /\.workspace-panel-sheet\.sheet\s*\{[^}]*width:\s*100%;[^}]*border-radius:\s*0;/s);
  assert.doesNotMatch(styles, /\.workspace-panel-sheet\.sheet::before/);
  assert.match(coreStyles, /\.mobile-tools-sheet\.sheet\s*\{[^}]*width:\s*100%;[^}]*height:\s*var\(--visual-vh,\s*100dvh\);/s);
  assert.match(coreStyles, /@keyframes mobile-tools-in\s*\{[^}]*translate3d\(100%,\s*0,\s*0\)/s);
  assert.match(sheet, /dismiss === "close"[\s\S]*className="sheet-grabber"/);
  assert.match(sheet, /dismiss === "back"[\s\S]*className="sheet-back"/);
  assert.match(sheet, /dismiss === "close"[\s\S]*className="sheet-close"/);
});

test("available item cells use metadata previews, not live widget renderers", async () => {
  const source = await readFile(new URL("../src/components/mobile/WorkspacePanel.tsx", import.meta.url), "utf8");
  const library = source.slice(source.indexOf("workspace-panel-library-grid"));
  assert.doesNotMatch(library, /widget\.render/);
});
