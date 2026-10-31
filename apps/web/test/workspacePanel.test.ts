import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PROJECT_DIRECTIONS } from "@polyth/contracts/project-composition";
import type { ResolvedCapability } from "../src/capabilities.ts";
import type { WidgetDef } from "../src/widgets/catalog.ts";
import {
  addPanelItem,
  createWorkspacePanelLayout,
  defaultPanelWidgetIds,
  insertPanelItem,
  MAX_DEFAULT_PANEL_WIDGETS,
  movePanelItem,
  panelGallerySections,
  panelInsertionIndex,
  panelItemCatalog,
  panelItemKind,
  panelWidgetAvailable,
  parseWorkspacePanelLayout,
  permutePanelItems,
  removePanelItem,
  searchPanelItems,
  stablePanelCatalog,
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
const capabilities = ["files", "browser", "terminal", "git", "goals", "knowledge", "workspace-edit", "multirun", "schedule", "usage"]
  .map(capability);
const widgets: WidgetDef[] = [
  { id: "usage.project", pluginId: "usage", title: "Usage", description: "Real project usage", panelSizes: ["wide", "large"], panelDefaultSize: "large", render },
  { id: "usage.limits", pluginId: "usage", title: "Usage limits", description: "Provider limits", render },
  { id: "session.activity", pluginId: "session", title: "Activity", description: "Recent events", render },
  { id: "session.work-status", pluginId: "session", title: "Tasks", description: "Current work", render },
];

test("capabilities, widgets, and layout elements share one panel item catalog", () => {
  const catalog = panelItemCatalog(capabilities, widgets);
  assert.equal(catalog.find((item) => item.id === "launcher:files")?.type, "launcher");
  assert.equal(catalog.find((item) => item.id === "launcher:workspace-edit")?.type, "launcher");
  assert.equal(catalog.find((item) => item.id === "widget:usage.project")?.type, "widget");
  assert.equal(catalog.find((item) => item.id === "layout:labeled-divider")?.type, "labeled-divider");
  assert.deepEqual(catalog.find((item) => item.id === "widget:usage.project")?.supportedSizes, ["wide", "large"]);
});

test("a widget that reports itself unavailable leaves the Workspace outside edit mode", () => {
  const gated: WidgetDef = {
    id: "usage.session",
    pluginId: "usage",
    title: "Session usage",
    description: "Usage for the active session",
    isAvailable: ({ sessionId }) => sessionId !== null,
    render,
  };
  const catalog = panelItemCatalog(capabilities, [gated]);
  const definition = catalog.find((item) => item.id === "widget:usage.session")!;
  const context = (sessionId: string | null) => ({ projectId: "project-a", sessionId, config: {} });
  assert.equal(panelWidgetAvailable(definition, gated, false, context(null)), false);
  assert.equal(panelWidgetAvailable(definition, gated, false, context("session-a")), true);
  assert.equal(panelWidgetAvailable(definition, gated, true, context(null)), true, "edit mode keeps it movable and removable");
  assert.equal(panelWidgetAvailable(definition, undefined, false, context(null)), true, "an unresolved definition never hides");
  assert.equal(panelWidgetAvailable(catalog.find((item) => item.id === "launcher:files")!, gated, false, context(null)), true, "only widget items gate");
});

test("Add page search needs every word, in any order and case, and ranks title hits first", () => {
  const catalog = panelItemCatalog(capabilities, widgets);
  // Title starts with the word, then a title word, then description/package only.
  assert.deepEqual(searchPanelItems(catalog, "usage").map((item) => item.id).slice(0, 3), [
    "launcher:usage", "widget:usage.project", "widget:usage.limits",
  ]);
  assert.deepEqual(searchPanelItems(catalog, "LIMITS provider").map((item) => item.id), ["widget:usage.limits"]);
  assert.deepEqual(searchPanelItems(catalog, "files project").map((item) => item.id), ["launcher:files"]);
  assert.deepEqual(searchPanelItems(catalog, "files nonsense"), []);
  assert.equal(searchPanelItems(catalog, "   ").length, catalog.length, "a blank query keeps everything, in catalog order");
  assert.deepEqual(searchPanelItems(catalog, "  ").map((item) => item.id), catalog.map((item) => item.id));
});

test("Add page sections: every app together, then widgets per package A–Z, layout elements last", () => {
  const catalog = panelItemCatalog(capabilities, widgets);
  assert.equal(panelItemKind(catalog.find((item) => item.id === "launcher:git")!), "app");
  assert.equal(panelItemKind(catalog.find((item) => item.id === "widget:usage.limits")!), "widget");
  assert.equal(panelItemKind(catalog.find((item) => item.id === "layout:divider")!), "layout");
  const sections = panelGallerySections(catalog);
  assert.deepEqual(sections.map((section) => [section.id, section.kind]), [
    ["apps", "app"],
    ["package:session", "widget"],
    ["package:usage", "widget"],
    ["layout", "layout"],
  ]);
  assert.deepEqual(sections[0]!.items.map((item) => item.id), catalog.filter((item) => item.type === "launcher").map((item) => item.id));
  assert.deepEqual(sections[2]!.items.map((item) => item.id), ["widget:usage.project", "widget:usage.limits"]);
  assert.deepEqual(sections[3]!.items.map((item) => item.type), ["header", "divider", "labeled-divider"]);
  assert.deepEqual(panelGallerySections(catalog.filter((item) => item.type === "widget")).map((section) => section.id), [
    "package:session", "package:usage",
  ], "a filtered catalog drops the empty sections");
});

test("a new app joins the other apps; widgets and layout elements go to the end", () => {
  const catalog = panelItemCatalog(capabilities, widgets);
  const get = (id: string) => catalog.find((item) => item.id === id)!;
  const layout = createWorkspacePanelLayout(catalog, ["files", "git"], ["usage.limits"]);
  assert.equal(panelInsertionIndex(layout, get("launcher:terminal")), 2);
  assert.equal(panelInsertionIndex(layout, get("widget:session.activity")), 3);
  const app = insertPanelItem(layout, get("launcher:terminal"));
  assert.deepEqual(app.layout.items.map((item) => item.id), ["launcher:files", "launcher:git", "launcher:terminal", "widget:usage.limits"]);
  assert.equal(app.id, "launcher:terminal");
  const widget = insertPanelItem(app.layout, get("widget:session.activity"));
  assert.equal(widget.layout.items.at(-1)?.id, "widget:session.activity");
  // A Workspace without apps puts the first one at the top.
  const noApps = createWorkspacePanelLayout(catalog, ["files"], ["usage.limits"]);
  const onlyWidgets = removePanelItem(noApps, "launcher:files");
  assert.deepEqual(insertPanelItem(onlyWidgets, get("launcher:git")).layout.items.map((item) => item.id), ["launcher:git", "widget:usage.limits"]);
  // A single-use item that is already there is not added twice; repeatable ones are.
  const again = insertPanelItem(app.layout, get("launcher:terminal"));
  assert.equal(again.id, null);
  assert.equal(again.layout, app.layout);
  const headed = insertPanelItem(insertPanelItem(app.layout, get("layout:header")).layout, get("layout:header"));
  assert.equal(headed.id, "layout:header#2");
});

test("rearranging moves only the items this device draws; the rest keep their exact slots", () => {
  const catalog = panelItemCatalog(capabilities, widgets);
  const saved = createWorkspacePanelLayout(catalog, ["files", "usage", "git"], ["usage.limits"]);
  // Say the usage package is missing on this phone: it draws files, git only.
  const next = permutePanelItems(saved, ["launcher:git", "launcher:files"]);
  assert.deepEqual(next.items.map((item) => item.id), ["launcher:git", "launcher:usage", "launcher:files", "widget:usage.limits"]);
  assert.equal(permutePanelItems(saved, saved.items.map((item) => item.id)), saved, "the same order is the same layout");
  assert.deepEqual(permutePanelItems(saved, ["launcher:git", "unknown", "launcher:git", "launcher:files"]).items.map((item) => item.id),
    ["launcher:git", "launcher:usage", "launcher:files", "widget:usage.limits"], "unknown and repeated ids are ignored");
});

test("the panel catalog keeps unchanged definitions identical across reads", () => {
  const first = panelItemCatalog(capabilities, widgets);
  const second = panelItemCatalog(capabilities, widgets);
  assert.notEqual(first[0], second[0], "the registries hand out fresh objects");
  assert.equal(stablePanelCatalog(first, second), first);
  const renamed = panelItemCatalog(capabilities, widgets.map((widget) => widget.id === "usage.limits" ? { ...widget, title: "Limits" } : widget));
  const merged = stablePanelCatalog(first, renamed);
  assert.notEqual(merged, first);
  assert.equal(merged.find((item) => item.id === "launcher:files"), first.find((item) => item.id === "launcher:files"));
  assert.equal(merged.find((item) => item.id === "widget:usage.limits")?.title, "Limits");
});

test("an unarranged workspace lists the standard launchers, then the General summary widget", () => {
  const layout = createWorkspacePanelLayout(panelItemCatalog(capabilities, widgets));
  assert.deepEqual(layout.items.map((item) => item.definitionId), [
    "launcher:files", "launcher:browser", "launcher:terminal", "launcher:git", "launcher:goals", "launcher:knowledge",
    "launcher:schedule", "widget:usage.limits",
  ]);
  assert.equal(layout.items.some((item) => item.type === "labeled-divider"), false);
});

test("Agent actions and Activity timeline are never a default for any project kind", () => {
  const catalog = panelItemCatalog(capabilities, widgets);
  for (const kind of [...PROJECT_DIRECTIONS, "general"] as const) {
    const ids = defaultPanelWidgetIds([kind]);
    assert.ok(ids.length <= MAX_DEFAULT_PANEL_WIDGETS, kind);
    assert.equal(ids.includes("session.work-status"), false, kind);
    assert.equal(ids.includes("session.activity"), false, kind);
    const layout = createWorkspacePanelLayout(catalog, [], ids);
    assert.equal(layout.items.some((item) => item.definitionId === "widget:session.work-status"), false, kind);
    assert.equal(layout.items.some((item) => item.definitionId === "widget:session.activity"), false, kind);
  }
  // Still available to add by hand.
  assert.ok(catalog.some((item) => item.id === "widget:session.work-status"));
  assert.ok(catalog.some((item) => item.id === "widget:session.activity"));
});

test("default widgets follow the project kind, round-robin across directions", () => {
  assert.deepEqual(defaultPanelWidgetIds(["finance"]), ["markets.watchlist", "markets.portfolio-summary", "markets.news"]);
  assert.deepEqual(defaultPanelWidgetIds(["wellbeing"]), ["personal-coach.today", "personal-coach.check-in", "personal-coach.goal"]);
  assert.deepEqual(defaultPanelWidgetIds(["home"]), []);
  assert.deepEqual(defaultPanelWidgetIds(["engineering", "finance"]), [
    "github.pr-summary", "markets.watchlist", "task-trackers.overview", "markets.portfolio-summary",
  ]);
  // Shared ids appear once.
  assert.deepEqual(defaultPanelWidgetIds(["engineering", "operations"]), [
    "github.pr-summary", "task-trackers.overview", "usage.limits",
  ]);
});

test("widgets of a disabled package are skipped, launchers stay first", () => {
  const catalog = panelItemCatalog(capabilities, widgets);
  const layout = createWorkspacePanelLayout(catalog, ["schedule", "files"], ["markets.watchlist", "usage.limits"]);
  assert.deepEqual(layout.items.map((item) => item.definitionId), ["launcher:schedule", "launcher:files", "widget:usage.limits"]);
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

test("an arranged project lists its rail launchers, then its kind's widgets", () => {
  const catalog = panelItemCatalog(capabilities, widgets);
  const fresh = parseWorkspacePanelLayout(null, catalog, ["knowledge", "files", "git"], []);
  assert.deepEqual(fresh.items.map((item) => item.definitionId), ["launcher:knowledge", "launcher:files", "launcher:git"]);
  const general = parseWorkspacePanelLayout(null, catalog, ["knowledge"]);
  assert.deepEqual(general.items.map((item) => item.definitionId), ["launcher:knowledge", "widget:usage.limits"]);
});

test("a saved layout keeps the person's widgets, including technical ones they chose", () => {
  const catalog = panelItemCatalog(capabilities, widgets);
  const saved = createWorkspacePanelLayout(catalog, ["files"], ["session.activity"]);
  const restored = parseWorkspacePanelLayout(JSON.stringify(saved), catalog, ["git"], ["usage.limits"]);
  assert.deepEqual(restored.items.map((item) => item.definitionId), ["launcher:files", "widget:session.activity"]);
});

test("a device without an item's package keeps that item through its own edits", () => {
  const full = panelItemCatalog(capabilities, widgets);
  const saved = createWorkspacePanelLayout(full, ["files", "usage"], ["usage.limits"]);
  // The phone app's catalog before the usage package has loaded (or with it
  // unavailable on this device).
  const partial = panelItemCatalog(
    capabilities.filter(({ descriptor }) => descriptor.id !== "usage"),
    widgets.filter((widget) => widget.pluginId !== "usage"),
  );
  const onPhone = parseWorkspacePanelLayout(JSON.stringify(saved), partial);
  assert.deepEqual(onPhone.items.map((item) => item.definitionId), ["launcher:files", "launcher:usage", "widget:usage.limits"]);
  const header = partial.find((item) => item.id === "layout:header")!;
  const edited = movePanelItem(addPanelItem(onPhone, header), "layout:header", 0);
  const elsewhere = parseWorkspacePanelLayout(JSON.stringify(edited), full);
  assert.deepEqual(elsewhere.items.map((item) => item.definitionId), [
    "layout:header", "launcher:files", "launcher:usage", "widget:usage.limits",
  ]);
  assert.equal(elsewhere.items.find((item) => item.id === "widget:usage.limits")?.type, "widget");
});

test("a saved item with no definition and no valid type is dropped", () => {
  const catalog = panelItemCatalog(capabilities, widgets);
  const raw = JSON.stringify({ version: 1, items: [
    { id: "widget:gone", definitionId: "widget:gone", type: "bogus", size: "compact", config: {} },
    { id: "launcher:files", definitionId: "launcher:files", type: "launcher", size: "compact", config: {} },
  ] });
  assert.deepEqual(parseWorkspacePanelLayout(raw, catalog).items.map((item) => item.id), ["launcher:files"]);
});

test("adding is a full page of the same Sheet; arranging edits in place; neither opens settings", async () => {
  const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");
  const [panel, editor, gallery, oldTools] = await Promise.all([
    read("../src/components/mobile/WorkspacePanel.tsx"),
    read("../src/components/mobile/WorkspaceEditor.tsx"),
    read("../src/components/mobile/WorkspaceGallery.tsx"),
    read("../src/components/mobile/MobileSessionHeader.tsx"),
  ]);
  assert.equal((panel.match(/<Sheet/g) ?? []).length, 1);
  assert.match(panel, /title=\{editing \? tr\("workspace\.panel\.editTitle"\) : tr\("workspace\.panel\.title"\)\}/);
  assert.match(panel, /<WorkspaceEditor/);
  assert.match(panel, /<WorkspaceGallery/);
  assert.match(panel, /insertPanelItem/);
  assert.match(panel, /removePanelItem/);
  assert.match(editor, /permutePanelItems/);
  // The page is drawn as the sheet's own top layer, not as a second sheet.
  assert.match(gallery, /createPortal\(page, host\)/);
  assert.doesNotMatch(gallery, /<Sheet/);
  assert.match(panel, /capabilityId === "workspace-edit"[\s\S]*?toggleCapability\(capabilityId, capability\.open\)/);
  // A full-screen destination: Back leads; Edit is a mode switch, not a place.
  assert.match(panel, /dismiss="back"/);
  assert.match(panel, /action=\{\{ kind: "switch", label: tr\("common\.edit"\), pressed: editing/);
  for (const source of [panel, editor, gallery]) assert.doesNotMatch(source, /WidgetLibraryPanel|setOverlay\("settings"\)/);
  assert.doesNotMatch(oldTools, /Customize tools|\["Workspace"|\["Agent"|\["System"/);
});

test("edit mode and the Add page draw metadata only; live widgets render in the plain Workspace", async () => {
  const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");
  const [panel, editor, gallery] = await Promise.all([
    read("../src/components/mobile/WorkspacePanel.tsx"),
    read("../src/components/mobile/WorkspaceEditor.tsx"),
    read("../src/components/mobile/WorkspaceGallery.tsx"),
  ]);
  assert.match(panel, /widget\.render\(\{ projectId, sessionId, editing: false/);
  assert.match(panel, /widget\.render\(\{[^}]*panelSize: item\.size \}\)/, "the widget learns the size the person chose");
  for (const source of [editor, gallery]) assert.doesNotMatch(source, /\.render\(/);
  assert.doesNotMatch(editor, /<MoveControls|workspace-panel-edit-controls|selection-bar|application\/x-polyth/);
});

test("phone Workspace owns full-width navigation geometry with bidirectional motion", async () => {
  const styles = await readFile(new URL("../src/workspacePanelPremium.css", import.meta.url), "utf8");
  const coreStyles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const sheet = await readFile(new URL("../src/components/mobile/Sheet.tsx", import.meta.url), "utf8");

  assert.match(styles, /body \.sheet-backdrop:has\(> \.workspace-panel-sheet\.sheet\)\s*\{[^}]*padding:\s*0;/s);
  assert.match(styles, /\.workspace-panel-sheet\.sheet\s*\{[^}]*width:\s*100%;[^}]*border-radius:\s*0;/s);
  assert.doesNotMatch(styles, /\.workspace-panel-sheet\.sheet::before/);
  assert.match(coreStyles, /\.mobile-tools-sheet\.sheet\s*\{[^}]*width:\s*100%;[^}]*height:\s*var\(--visual-vh,\s*100dvh\);/s);
  const stack = await readFile(new URL("../src/stackNavigation.css", import.meta.url), "utf8");
  assert.match(stack, /@keyframes stack-in\s*\{[^}]*translate3d\(calc\(var\(--stack-dir, 1\) \* 100%\),\s*0,\s*0\)/s);
  assert.match(stack, /@keyframes stack-out\s*\{[\s\S]*?to\s*\{[^}]*translate3d\(calc\(var\(--stack-dir, 1\) \* 100%\),\s*0,\s*0\)/);
  assert.match(stack, /\.sheet-backdrop\[data-stack\]\.is-closing > \.workspace-panel-sheet\.sheet\.is-closing\s*\{\s*animation:\s*stack-out/s);
  assert.match(sheet, /dismiss === "close"[\s\S]*className="sheet-grabber"/);
  assert.match(sheet, /dismiss === "back"[\s\S]*className="sheet-back"/);
  assert.match(sheet, /dismiss === "close"[\s\S]*className="sheet-close"/);
});

test("Workspace editor and Add page CSS load after the widget fixes and keep the Workspace's tile grid", async () => {
  const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");
  const [main, editor, gallery] = await Promise.all([
    read("../src/main.tsx"),
    read("../src/workspacePanelEditor.css"),
    read("../src/workspaceGallery.css"),
  ]);
  assert.ok(main.indexOf("workspacePanelEditor.css") > main.indexOf("workspacePanelWidgetFixes.css"));
  assert.ok(main.indexOf("workspaceGallery.css") > main.indexOf("workspacePanelEditor.css"));
  // The arrangement is drawn as it will look: four tiles to a line (three narrow, six wide).
  assert.match(editor, /\.workspace-editor-grid\s*\{[^}]*repeat\(4,/s);
  assert.match(editor, /@container workspace-panel \(max-width: 340px\)[\s\S]*?repeat\(3,/);
  assert.match(editor, /@container workspace-panel \(min-width: 560px\)[\s\S]*?repeat\(6,/);
  // A grip picks up at once; anywhere else a vertical swipe still scrolls.
  assert.match(editor, /\.workspace-editor-grip\s*\{[^}]*touch-action:\s*none/s);
  assert.match(editor, /\.workspace-editor-item\s*\{[^}]*touch-action:\s*pan-y/s);
  // Every per-item control keeps a full touch target.
  assert.match(editor, /\.workspace-editor-remove::after\s*\{[^}]*inset:\s*calc\(\(var\(--icon-xl\) - var\(--tap\)\) \/ 2\)/s);
  assert.match(editor, /\.workspace-editor-grip\s*\{[^}]*width:\s*var\(--tap\)/s);
  // Glides stay compositor-only during a drag; the drag style is scoped to the sheet.
  assert.match(editor, /\[data-arranging\] \.workspace-editor-item\s*\{\s*will-change:\s*transform;/);
  assert.match(editor, /\.workspace-panel-sheet\[data-arrange-dragging="true"\] \*/);
  assert.doesNotMatch(editor, /body\[data-arrange-dragging/);
  // The Add page travels with the phone stack grammar and hands a swipe release over.
  assert.match(gallery, /\.workspace-gallery\s*\{[^}]*animation:\s*stack-in var\(--motion-stack\) var\(--motion-stack-ease\) backwards/s);
  assert.match(gallery, /\.workspace-gallery\.is-closing\s*\{[^}]*animation-duration:\s*var\(--stack-out-settle, var\(--motion-stack\)\)/s);
  assert.match(gallery, /\.is-gallery-open > :is\(\.sheet-head, \.sheet-body\)\s*\{[^}]*visibility:\s*hidden;[^}]*stack-cover/s);
  assert.match(gallery, /\.is-gallery-open\[data-peek\] > :is\(\.sheet-head, \.sheet-body\)/);
  // A large, 16px search field (no iOS zoom on focus).
  assert.match(gallery, /\.workspace-gallery-search\s*\{[^}]*min-height:\s*var\(--control-h-lg\)/s);
  assert.match(gallery, /\.workspace-gallery-search input\s*\{[^}]*font-size:\s*var\(--font-input\)/s);
  assert.doesNotMatch(gallery, /\b\d{3,}ms\b/, "motion takes its timing from the tokens");
});

test("the Canvas keeps the package-grouped picker; the phone Workspace no longer uses it", async () => {
  const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");
  const [panel, canvas, css] = await Promise.all([
    read("../src/components/mobile/WorkspacePanel.tsx"),
    read("../src/widgets/WidgetCanvas.tsx"),
    read("../src/workspaceCatalog.css"),
  ]);
  assert.match(canvas, /<CatalogPicker/);
  assert.match(canvas, /packageId: widget\.ownerPackageId \?\? widget\.pluginId/);
  assert.match(canvas, /panelPackageLabel/);
  assert.match(css, /\.catalog-picker-group-head\s*\{/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.widget-menu-single\.catalog-picker/);
  assert.doesNotMatch(css, /workspace-panel-library/);
  assert.doesNotMatch(panel, /catalog-picker|CatalogPicker/);
});

test("every kind default names a widget its package really registers", async () => {
  const { readdir } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  const { DEFAULT_PANEL_WIDGETS } = await import("../src/workspacePanel.ts");
  const sources = new Map<string, string>();
  // A package removed from this checkout no longer ships its widgets; the host
  // default stays unresolved for that kind and there is nothing to scan.
  const packageSource = async (pkg: string): Promise<string | null> => {
    const dir = new URL(`../../../packages/${pkg}/widgets/`, import.meta.url);
    if (!existsSync(dir)) return null;
    if (!sources.has(pkg)) {
      const files = (await readdir(dir, { recursive: true })).filter((file) => /\.tsx?$/.test(file));
      sources.set(pkg, (await Promise.all(files.map((file) => readFile(new URL(file, dir), "utf8")))).join("\n"));
    }
    return sources.get(pkg)!;
  };
  let verified = 0;
  for (const id of new Set(Object.values(DEFAULT_PANEL_WIDGETS).flat())) {
    const source = await packageSource(id.slice(0, id.indexOf(".")));
    if (source === null) continue;
    assert.match(source, new RegExp(`id: "${id.replace(/\./g, "\\.")}"`), id);
    verified += 1;
  }
  // Non-vacuous even when the removable packages in the defaults are absent.
  assert.ok(verified > 0, "a present package backs at least one kind default");
});
