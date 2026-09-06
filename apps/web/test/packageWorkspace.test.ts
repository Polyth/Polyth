import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { WidgetDef } from "../src/widgets/catalog.ts";
import {
  filterWidgetLibrary,
  RECOMMENDED_WIDGET_IDS,
} from "../src/widgets/widgetLibrary.ts";
import {
  createDefaultWidgetLayout,
  parseWidgetLayout,
  serializeWidgetLayout,
  setWidgetVisible,
} from "../src/widgets/widgetLayout.ts";

const render = () => null;
const widget = (
  id: string,
  extras: Partial<WidgetDef> = {},
): WidgetDef => ({
  id,
  pluginId: id.split(".")[0] ?? "core",
  title: id,
  description: id,
  zone: "main",
  render,
  ...extras,
});

const recommendedTab = (widgets: readonly WidgetDef[], extraIds: readonly string[] = []) =>
  filterWidgetLibrary(widgets, {
    query: "",
    pluginId: "all",
    size: "all",
    zone: "all",
    category: "all",
    tab: "recommended",
    recommendedIds: extraIds,
  }, "power").map((item) => item.id);

const allTab = (widgets: readonly WidgetDef[]) =>
  filterWidgetLibrary(widgets, {
    query: "",
    pluginId: "all",
    size: "all",
    zone: "all",
    category: "all",
    tab: "all",
  }, "power").map((item) => item.id).sort();

const visibleIds = (layout: ReturnType<typeof createDefaultWidgetLayout>) =>
  Object.entries(layout.widgets)
    .flatMap(([id, placement]) => placement.visible ? [id] : [])
    .sort();

test("two package widget contributions recommend simultaneously", () => {
  const git = widget("git.recent", { pluginId: "git", recommended: true });
  const knowledge = widget("knowledge.notes", { pluginId: "knowledge", recommended: true });
  const extra = widget("terminal.shell", { pluginId: "terminal" });
  const ids = recommendedTab([git, knowledge, extra]);
  assert.ok(ids.includes("git.recent"));
  assert.ok(ids.includes("knowledge.notes"));
  assert.equal(ids.includes("terminal.shell"), false);
  assert.deepEqual(allTab([git, knowledge, extra]), ["git.recent", "knowledge.notes", "terminal.shell"]);
});

test("three package recommendations merge without a winner", () => {
  const widgets = [
    widget("git.recent", { pluginId: "git", recommended: true }),
    widget("knowledge.notes", { pluginId: "knowledge", recommended: true }),
    widget("github.pr-summary", { pluginId: "github", recommended: true }),
    widget("browser.app", { pluginId: "browser" }),
  ];
  const ids = recommendedTab(widgets);
  assert.deepEqual([...ids].sort(), ["git.recent", "github.pr-summary", "knowledge.notes"].sort());
  assert.equal(ids.includes("browser.app"), false);
});

test("disabling one package removes only that package's live recommendations from a widget list", () => {
  const git = widget("git.recent", { pluginId: "git", recommended: true });
  const knowledge = widget("knowledge.notes", { pluginId: "knowledge", recommended: true });
  const both = recommendedTab([git, knowledge]);
  assert.ok(both.includes("git.recent") && both.includes("knowledge.notes"));
  const afterDisable = recommendedTab([knowledge]);
  assert.deepEqual(afterDisable.filter((id) => id === "git.recent" || id === "knowledge.notes"), [
    "knowledge.notes",
  ]);
});

test("missing optional recommended widgets degrade without hiding the catalog", () => {
  const widgets = [
    widget("git.recent", { pluginId: "git", recommended: true }),
    widget("core.chat"),
  ];
  const ids = recommendedTab(widgets, ["git.recent", "marketing.board"]);
  assert.ok(ids.includes("git.recent"));
  assert.equal(ids.includes("marketing.board"), false);
  assert.ok(allTab(widgets).includes("core.chat"));
});

test("core recommended ids remain available alongside package recommendations", () => {
  const widgets = RECOMMENDED_WIDGET_IDS.map((id) => widget(id));
  const ids = recommendedTab(widgets);
  for (const id of RECOMMENDED_WIDGET_IDS) assert.ok(ids.includes(id), id);
});

test("absent local layout seeds defaults; existing layout is preserved", () => {
  const widgets = [widget("a"), widget("b", { defaultVisible: true }), widget("req", { requiredVisible: true })];
  const seeded = parseWidgetLayout(null, widgets);
  assert.equal(seeded.widgets.b?.visible, true);
  assert.equal(seeded.widgets.req?.visible, true);

  const customized = setWidgetVisible(seeded, "a", true);
  const restored = parseWidgetLayout(serializeWidgetLayout(customized), widgets);
  assert.equal(restored.widgets.a?.visible, true);
  assert.equal(JSON.stringify(restored.widgets.a), JSON.stringify(customized.widgets.a));
});

test("a second client with no local layout seeds independently of another client's customizations", () => {
  const widgets = [
    widget("core.chat", { defaultVisible: true }),
    widget("git.recent", { pluginId: "git", recommended: true }),
  ];
  const browserA = setWidgetVisible(parseWidgetLayout(null, widgets), "core.chat", false);
  const browserB = parseWidgetLayout(null, widgets);
  assert.equal(browserA.widgets["core.chat"]?.visible, false);
  assert.equal(browserB.widgets["core.chat"]?.visible, true);
  assert.deepEqual(visibleIds(browserB), visibleIds(parseWidgetLayout(null, widgets)));
});

test("clearing local layout reseeds defaults without inventing project identity", () => {
  const widgets = [
    widget("core.chat", { defaultVisible: true }),
    widget("git.recent", { pluginId: "git", defaultVisible: true }),
  ];
  const customized = setWidgetVisible(parseWidgetLayout(null, widgets), "git.recent", false);
  const cleared = parseWidgetLayout(null, widgets);
  assert.equal(customized.widgets["git.recent"]?.visible, false);
  assert.equal(cleared.widgets["git.recent"]?.visible, true);
  assert.equal(cleared.widgets["core.chat"]?.visible, true);
});

test("late package registration adds missing widgets without rewriting customized visibility", () => {
  const early = [widget("core.chat", { defaultVisible: true })];
  const customized = setWidgetVisible(createDefaultWidgetLayout(early), "core.chat", false);
  const late = widget("git.recent", { pluginId: "git", defaultVisible: true, title: "Recent changes" });
  const next = parseWidgetLayout(serializeWidgetLayout(customized), [...early, late]);
  assert.equal(next.widgets["core.chat"]?.visible, false);
  assert.ok(next.widgets["git.recent"]);
  assert.equal(next.widgets["git.recent"]?.visible, true);
});

test("opening before vs after package registration settles to the same visible widget set", () => {
  const core = widget("core.chat", { defaultVisible: true });
  const git = widget("git.recent", { pluginId: "git", defaultVisible: true, title: "Recent changes" });
  const afterRegistration = parseWidgetLayout(null, [core, git]);
  const openedEarly = parseWidgetLayout(null, [core]);
  const settled = parseWidgetLayout(serializeWidgetLayout(openedEarly), [core, git]);
  assert.deepEqual(visibleIds(settled), visibleIds(afterRegistration));
});

test("disabling a package keeps persisted layout placements for its widgets", () => {
  const git = widget("git.recent", { pluginId: "git", defaultVisible: true, title: "Recent changes" });
  const knowledge = widget("knowledge.notes", { pluginId: "knowledge", defaultVisible: true, title: "Notes" });
  const both = setWidgetVisible(createDefaultWidgetLayout([git, knowledge]), "git.recent", true);
  const afterDisable = parseWidgetLayout(serializeWidgetLayout(both), [knowledge]);
  assert.equal(afterDisable.widgets["git.recent"]?.visible, true, "layout is not rewritten when a contribution disappears");
  assert.equal(afterDisable.widgets["knowledge.notes"]?.visible, true);
});

test("explicit workspace reset replaces the visible set; recommendations do not hide unrelated widgets", () => {
  const widgets = [
    widget("core.chat", { defaultVisible: true }),
    widget("github.pr-summary", { pluginId: "github", recommended: true }),
    widget("marketing.board", { pluginId: "marketing", recommended: true }),
  ];
  const customized = setWidgetVisible(createDefaultWidgetLayout(widgets), "github.pr-summary", true);
  const recommended = recommendedTab(widgets);
  assert.ok(recommended.includes("github.pr-summary"));
  assert.ok(recommended.includes("marketing.board"));
  assert.ok(allTab(widgets).includes("core.chat"));
  assert.equal(customized.widgets["github.pr-summary"]?.visible, true);
  const reset = createDefaultWidgetLayout(widgets);
  assert.equal(reset.widgets["github.pr-summary"]?.visible, false);
  assert.equal(reset.widgets["marketing.board"]?.visible, false);
  assert.equal(reset.widgets["core.chat"]?.visible, true);
});

test("opening a project never classifies it and never infers creation from a client cache", async () => {
  const folder = await readFile(new URL("../src/components/ProjectFolderDialog.tsx", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const init = await readFile(new URL("../src/init.ts", import.meta.url), "utf8");
  const contracts = await readFile(new URL("../../../packages/contracts/src/index.ts", import.meta.url), "utf8");
  const sdk = await readFile(new URL("../../../packages/web-sdk/src/index.ts", import.meta.url), "utf8");
  const pages = await readFile(new URL("../src/components/settings/pages.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(folder, /projectType|knownProjectIds|persistAndApplyType/);
  assert.doesNotMatch(app, /ProjectSetup|project-setup|projectType/);
  assert.doesNotMatch(init, /projectTypeId|knownProjectIds/);
  assert.doesNotMatch(contracts, /projectTypeId/);
  assert.doesNotMatch(sdk, /projectTypes|ProjectTypeDefinition/);
  assert.doesNotMatch(pages, /projectType|ProjectType/);
});
