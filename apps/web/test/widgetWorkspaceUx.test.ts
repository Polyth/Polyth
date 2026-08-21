import test from "node:test";
import assert from "node:assert/strict";
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
  applyWorkspaceSetup,
  createSetupDraft,
  MAX_SETUP_WIDGETS,
  MIN_SETUP_WIDGETS,
  validSetupWidgetCount,
  workflowOption,
} from "../src/widgets/workspaceSetup.ts";
import { planWorkspaceCustomization } from "../src/widgets/workspaceCustomize.ts";

const render = () => null;
const WIDGETS: WidgetDef[] = [
  {
    id: "core.composer",
    pluginId: "session",
    title: "Composer",
    description: "Ask Polyth anything",
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
  assert.deepEqual(recommended.map((widget) => widget.id), ["core.composer", "git.recent"]);
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

test("guided setup applies workflow, audience, and selected widgets via shared mutations", () => {
  const layout = createDefaultWidgetLayout(WIDGETS);
  const draft = {
    ...createSetupDraft("build-debug"),
    audience: "power" as const,
    widgetIds: ["core.composer", "git.recent", "terminal.shell"],
  };
  const next = applyWorkspaceSetup(layout, draft, WIDGETS);
  assert.equal(next.audience, "power");
  assert.equal(next.widgets["core.composer"]?.visible, true);
  assert.equal(next.widgets["git.recent"]?.visible, true);
  assert.equal(next.widgets["terminal.shell"]?.visible, true);
  assert.equal(workflowOption("build-debug").suggestedWidgetIds.length, 7);
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
