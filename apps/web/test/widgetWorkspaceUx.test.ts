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
  assert.match(source, /className="widget-menu-item-copy"/);
  assert.match(source, /className="widget-menu-item-label"/);
  assert.match(source, /className="widget-menu-item-detail"/);
  assert.doesNotMatch(source, /<span><strong>\{widget\.title\}<\/strong><small>/);
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

test("canvas add menu is a single-column list with stacked title and description", async () => {
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(styles, /\.widget-menu-list\s*\{[^}]*flex-direction:\s*column;/s);
  assert.doesNotMatch(styles, /\.widget-menu-list\s*\{[^}]*grid-template-columns:\s*repeat\(2/);
  assert.doesNotMatch(styles, /\.widget-menu-list section > button > span:first-child/);
  assert.match(styles, /\.widget-menu-item-copy\s*\{[^}]*flex-direction:\s*column;/s);
  assert.match(styles, /\.widget-menu-item-detail\s*\{[^}]*overflow-wrap:\s*anywhere;/s);
});

test("settings has no workspace customizer; canvas owns add-widget and layout", async () => {
  const settings = await readFile(new URL("../src/components/SettingsView.tsx", import.meta.url), "utf8");
  const canvas = await readFile(new URL("../src/widgets/WidgetCanvas.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(settings, /WidgetsPage|WidgetLibraryPanel|workspace-customizer/);
  assert.match(canvas, /<WidgetMenu /);
  assert.match(canvas, /data-widget-surface="workspace-canvas"/);
});

test("chat top rail is configured directly without a More tools overflow", async () => {
  const source = await readFile(new URL("../src/components/Header.tsx", import.meta.url), "utf8");
  assert.match(source, />\{tr\("header\.chat"\)\}<\/button>/);
  assert.doesNotMatch(source, />More tools</);
  assert.doesNotMatch(source, /CapabilityMenu/);
});

test("canvas widget chrome stays hidden until workspace edit mode", async () => {
  const canvas = await readFile(new URL("../src/widgets/WidgetCanvas.tsx", import.meta.url), "utf8");
  const header = await readFile(new URL("../src/components/Header.tsx", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.doesNotMatch(canvas, /className=\{`widget-card editing/);
  assert.match(canvas, /canvasEditing = editing \|\| workspaceMode === "edit"/);
  assert.match(canvas, /editing=\{canvasEditing\}/);
  assert.match(canvas, /\{editing && \(/);
  assert.match(header, /switchWorkspaceMode\(workspaceMode === "edit" \? "widgets" : "edit"\)/);
  assert.match(header, /tr\("common\.edit"\)/);
  assert.match(header, /tr\("common\.done"\)/);
  assert.match(app, /document\.body\.dataset\.uiEditing = "true"/);
  assert.match(styles, /\.widget-drag\s*\{[^}]*display:\s*none/s);
  assert.match(styles, /\.widget-resize-handle\s*\{[^}]*display:\s*none/s);
  assert.match(styles, /\.widget-card\.editing \.widget-resize-handle/);
  assert.match(styles, /\.widget-card\.editing \.widget-drag/);
});

test("desktop shell clips the frameless window to the sheet radius", async () => {
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const desktop = await readFile(new URL("../src/desktop.tsx", import.meta.url), "utf8");
  const header = await readFile(new URL("../src/components/Header.tsx", import.meta.url), "utf8");
  assert.match(styles, /html:has\(body\.desktop-app\)/);
  assert.match(styles, /--desktop-chrome-radius:\s*var\(--radius-sheet\)/);
  assert.match(styles, /--desktop-controls-island-width:\s*calc\(/);
  assert.match(styles, /--desktop-controls-wrap-arc:\s*max\(0\.01px, var\(--desktop-chrome-radius\)\)/);
  assert.match(styles, /body\.desktop-app\s*\{[^}]*border-radius:\s*var\(--desktop-chrome-radius\)/s);
  assert.match(styles, /body\.desktop-app \.app\s*\{[^}]*border-radius:\s*var\(--desktop-chrome-radius\)/s);
  assert.match(
    styles,
    /body\.desktop-app \.app > \.header\s*\{[^}]*height:\s*calc\(var\(--desktop-controls-island-height\) \+ var\(--desktop-chrome-radius\)\)/s,
  );
  assert.match(
    styles,
    /body\.desktop-app\[data-desktop-controls-position="right"\] \.app > \.header\s*\{[^}]*clip-path:\s*shape\(/s,
  );
  assert.match(
    styles,
    /body\.desktop-app\[data-desktop-controls-position="left"\] \.app > \.header\s*\{[^}]*clip-path:\s*shape\(/s,
  );
  assert.match(styles, /of var\(--desktop-controls-wrap-arc\) cw/);
  assert.doesNotMatch(styles, /padding-right:\s*116px/);
  assert.match(styles, /body\.desktop-app\[data-desktop-maximized="true"\] \.app > \.header\s*\{[^}]*clip-path:\s*none/s);
  assert.match(desktop, /dataset\.desktopMaximized/);
  assert.match(desktop, /createPortal\(controls, document\.body\)/);
  assert.match(header, /<\/header>\s*\{windowControls\}/s);
  assert.match(header, /slot="app.window.controls"/);
});

test("canvas widget settings live on the widget, not a settings customizer", async () => {
  const canvas = await readFile(new URL("../src/widgets/WidgetCanvas.tsx", import.meta.url), "utf8");
  const chat = await readFile(new URL("../src/components/settings/pages.tsx", import.meta.url), "utf8");
  assert.match(canvas, /SchemaWidgetSettings|settingsRender/);
  assert.match(chat, /itemId="chat\.responseActions"/);
  assert.match(chat, /itemId="chat\.headerMetrics"/);
});

test("buttons stay on shell surfaces while the canvas accepts only full widgets", async () => {
  const canvas = await readFile(new URL("../src/widgets/WidgetCanvas.tsx", import.meta.url), "utf8");
  const slots = await readFile(new URL("../src/components/slots/SlotHost.ts", import.meta.url), "utf8");
  assert.match(canvas, /getDragWidget/);
  assert.match(canvas, /widget\.kind !== "mini-widget"/);
  assert.match(canvas, /onDropSlot/);
  assert.match(slots, /setDragWidget/);
  assert.match(slots, /getDragWidget/);
});

test("all placed widgets can be reordered while a panel is being customized", async () => {
  const slots = await readFile(new URL("../src/components/slots/SlotHost.ts", import.meta.url), "utf8");
  assert.match(slots, /const editable = context\.editing === true/);
  assert.match(slots, /draggable: true/);
  assert.doesNotMatch(slots, /widget\.kind === "mini-widget" && hostContext\.editing/);
});

test("critic-reported mobile controls use 44px hit boxes", async () => {
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  for (const [name, pattern] of [
    ["settings chip", /\.widget-order-chip\s*\{[^}]*min-height:\s*var\(--tap\)/s],
    ["drag handle", /\.widget-drag-handle,[\s\S]*?\{[^}]*height:\s*var\(--tap\)/s],
    ["settings checkbox", /\.widget-order-chip input\[type="checkbox"\]\s*\{[^}]*height:\s*var\(--tap\)/s],
    ["file reference", /\.file-ref\s*\{[^}]*min-height:\s*var\(--tap\)/s],
    // P2-W3A: model and effort share one config-chip touch contract.
    ["config chips", /\.composer-mobile \.composer-config \.config-chip,[\s\S]*?\.composer-mobile \.composer-config \.picker-chip\s*\{[^}]*min-height:\s*var\(--tap\)/s],
  ] as const) {
    assert.match(css, pattern, `${name} uses the shared 44px target`);
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
