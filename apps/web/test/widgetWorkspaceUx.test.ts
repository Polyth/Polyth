import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { WidgetDef } from "../src/widgets/catalog.ts";
import {
  filterWidgetLibrary,
  groupWidgetsByPlugin,
  missingWidgetPlaceholders,
  widgetPluginOptions,
} from "../src/widgets/widgetLibrary.ts";
import {
  createDefaultWidgetLayout,
  setWidgetVisible,
  widgetZoneOf,
} from "../src/widgets/widgetLayout.ts";
import {
  applyProjectSetup,
  createSetupDraft,
  MAX_SETUP_WIDGETS,
  MIN_SETUP_WIDGETS,
  validSetupWidgetCount,
  workflowOption,
} from "../src/widgets/projectSetupLayout.ts";
import { planWorkspaceCustomization } from "../src/widgets/workspaceCustomize.ts";

const render = () => null;
const WIDGETS: WidgetDef[] = [
  {
    id: "core.chat",
    pluginId: "session",
    title: "Conversation",
    description: "The active conversation timeline and composer",
    zone: "main",
    supportedZones: ["main", "bottom"],
    defaultSize: { w: 12, h: 5 },
    audience: "simple",
    recommended: true,
    render,
  },
  {
    id: "git.recent",
    pluginId: "git",
    title: "Recent changes",
    description: "Review source control changes",
    zone: "right",
    supportedZones: ["left", "right", "main"],
    defaultSize: { w: 5, h: 4 },
    audience: "standard",
    capabilities: ["diff", "history"],
    render,
  },
  {
    id: "terminal.shell",
    pluginId: "terminal",
    title: "Terminal",
    description: "Run project commands",
    zone: "bottom",
    supportedZones: ["main", "bottom"],
    defaultSize: { w: 12, h: 6 },
    audience: "power",
    render,
  },
];

test("canvas exposes one simple add-widget menu and no placement-zone controls", async () => {
  const source = await readFile(new URL("../src/widgets/WidgetCanvas.tsx", import.meta.url), "utf8");
  assert.equal((source.match(/<WidgetMenu /g) ?? []).length, 1);
  assert.ok(!source.includes("WIDGET_ZONES"));
  assert.ok(!source.includes("layout preset"));
  assert.ok(!source.includes("Recommended"));
  assert.ok(!source.includes("Recent"));
  assert.ok(!source.includes("Project canvas"));
  assert.ok(!source.includes("Drag widgets to rearrange"));
});

test("canvas top row is placeable and editing borders use theme colors", async () => {
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(styles, /\.widget-canvas-grid\s*\{[^}]*padding:\s*0 18px 24px;/s);
  assert.match(styles, /\.widget-menu-trigger\s*\{[^}]*bottom:\s*18px;/s);
  assert.match(styles, /\.widget-card\.editing\s*\{[^}]*border:\s*1px solid var\(--border\);/s);
  assert.doesNotMatch(styles, /\.widget-card\.editing\s*\{[^}]*accent-line/s);
});

test("settings uses named button places without canvas layout controls", async () => {
  const source = await readFile(new URL("../src/components/settings/WidgetsPage.tsx", import.meta.url), "utf8");
  for (const place of [
    "Focus header",
    "More tools / right rail",
    "Technical menu",
    "Composer actions",
    "Session header actions",
    "App header actions",
  ]) {
    assert.ok(source.includes(place), `${place} is a named settings place`);
  }
  for (const removed of [
    "Choose a starting layout",
    "Workspace preview",
    "Help me set up my workspace",
    "WidgetLibraryOverlay",
    "Build & Debug",
    "Who is this for",
  ]) {
    assert.ok(!source.includes(removed), `${removed} stays out of widget settings`);
  }
});

test("widget library searches capabilities and combines plugin, size, zone, and tab filters", () => {
  const hits = filterWidgetLibrary(WIDGETS, {
    query: "diff",
    pluginId: "git",
    size: "medium",
    zone: "right",
    category: "all",
    tab: "plugin",
  }, "power");
  assert.deepEqual(hits.map((widget) => widget.id), ["git.recent"]);

  const recommended = filterWidgetLibrary(WIDGETS, {
    query: "",
    pluginId: "all",
    size: "all",
    zone: "all",
    category: "all",
    tab: "recommended",
  }, "standard");
  assert.deepEqual(recommended.map((widget) => widget.id), ["core.chat", "git.recent"]);
  assert.deepEqual([...groupWidgetsByPlugin(WIDGETS).keys()], ["Core workspace", "Git tools"]);
});

test("plugin filters disambiguate colliding display names", () => {
  const colliding = [
    { pluginId: "alpha-tools", pluginName: "Tools" },
    { pluginId: "alpha-tools", pluginName: "Tools" },
    { pluginId: "beta-tools", pluginName: "Tools" },
    { pluginId: "git", pluginName: "Git" },
  ];
  const options = widgetPluginOptions(colliding);
  assert.deepEqual(options, [
    { id: "git", label: "Git" },
    { id: "alpha-tools", label: "Tools — alpha-tools" },
    { id: "beta-tools", label: "Tools — beta-tools" },
  ]);

  const grouped = groupWidgetsByPlugin(colliding.map((plugin, index): WidgetDef => ({
    ...plugin,
    id: `widget-${index}`,
    title: `Widget ${index}`,
    description: "test",
    zone: "main",
    render,
  })));
  assert.deepEqual([...grouped.keys()], ["Tools — alpha-tools", "Tools — beta-tools", "Git"]);
  assert.equal(grouped.get("Tools — alpha-tools")?.length, 2);
});

test("project setup applies audience and exact widget visibility", async () => {
  const layout = setWidgetVisible(createDefaultWidgetLayout(WIDGETS), "terminal.shell", true);
  const draft = {
    ...createSetupDraft("build-debug"),
    audience: "power" as const,
    widgetIds: ["git.recent"],
  };
  const next = applyProjectSetup(layout, draft, WIDGETS);
  assert.equal(next.audience, "power");
  assert.equal(next.widgets["core.chat"]?.visible, false);
  assert.equal(next.widgets["git.recent"]?.visible, true);
  assert.equal(next.widgets["terminal.shell"]?.visible, false);
  assert.equal(workflowOption("build-debug").suggestedWidgetIds.length, 7);

  const source = await readFile(new URL("../src/widgets/projectSetupLayout.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /type:\s*"preset"|applyWidgetLayoutPreset/);
});

test("guided setup enforces its advertised five-to-eight unique widget range", () => {
  assert.equal(MIN_SETUP_WIDGETS, 5);
  assert.equal(MAX_SETUP_WIDGETS, 8);
  assert.equal(validSetupWidgetCount(["1", "2", "3", "4"]), false);
  assert.equal(validSetupWidgetCount(["1", "2", "3", "4", "5"]), true);
  assert.equal(validSetupWidgetCount(["1", "2", "3", "4", "5", "5"]), false);
  assert.equal(validSetupWidgetCount(["1", "2", "3", "4", "5", "6", "7", "8", "9"]), false);
});

test("missing plugin placeholders retain identity and placement without rendering plugin code", () => {
  const initial = createDefaultWidgetLayout([{
    id: "sample.status",
    pluginId: "sample",
    title: "Sample status",
    description: "Project status",
    zone: "right",
  }]);
  const visible = setWidgetVisible(initial, "sample.status", true);
  const placeholders = missingWidgetPlaceholders(visible, []);
  assert.equal(placeholders.length, 1);
  assert.equal(placeholders[0]?.pluginId, "sample");
  assert.equal(placeholders[0]?.zone, "right");
});

test("AI customization plans use the same validated mutation vocabulary as manual editing", () => {
  const plan = planWorkspaceCustomization(
    "Use power mode, move Recent changes to left, and make it compact",
    WIDGETS,
  );
  assert.equal(plan.density, "compact");
  assert.ok(plan.mutations.some((mutation) => mutation.type === "audience" && mutation.audience === "power"));
  assert.ok(plan.mutations.some((mutation) =>
    mutation.type === "move" && mutation.id === "git.recent" && mutation.zone === "left"));

  const layout = createDefaultWidgetLayout(WIDGETS);
  assert.equal(widgetZoneOf(layout, "git.recent"), "right");
});
