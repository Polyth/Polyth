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
import {
  getWorkspaceContentMode,
  getWorkspaceMode,
  setWorkspaceEditing,
  setWorkspaceMode,
  setWorkspaceModeProject,
} from "../src/widgets/workspaceMode.ts";

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

test("Edit preserves the selected conversation surface while its toggle is on", () => {
  const priorStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    },
  });
  try {
    setWorkspaceModeProject("workspace-edit-test");
    setWorkspaceMode("widgets");
    setWorkspaceEditing(true);
    assert.equal(getWorkspaceMode(), "edit");
    assert.equal(getWorkspaceContentMode(), "widgets");
    assert.equal(values.get("polyth.workspaceMode.v1.workspace-edit-test"), "widgets",
      "the shared project selection remains Canvas");
    assert.equal(values.get("polyth.workspaceEditing.v1.workspace-edit-test"), "true",
      "Edit is stored separately on this device");
    setWorkspaceEditing(false);
    assert.equal(getWorkspaceMode(), "widgets");
    assert.equal(getWorkspaceContentMode(), "widgets");
  } finally {
    setWorkspaceModeProject(null);
    setWorkspaceMode("chat");
    if (priorStorage) Object.defineProperty(globalThis, "localStorage", priorStorage);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

test("canvas exposes one simple add-widget menu and no placement-zone controls", async () => {
  const source = await readFile(new URL("../src/widgets/WidgetCanvas.tsx", import.meta.url), "utf8");
  assert.equal((source.match(/<WidgetMenu /g) ?? []).length, 1);
  assert.match(source, /<CatalogPicker/);
  assert.match(source, /widget-menu-single catalog-picker/);
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
  const viewTabs = await readFile(new URL("../src/viewTabs.ts", import.meta.url), "utf8");
  assert.match(viewTabs, /label: tr\("header\.chat"\)/);
  assert.doesNotMatch(source, />More tools</);
  assert.doesNotMatch(source, /More workspace tools/);
  assert.doesNotMatch(source, /CapabilityMenu/);
});

test("Edit workspace is a configurable capability pinned to the header profile menu", async () => {
  const canvas = await readFile(new URL("../src/widgets/WidgetCanvas.tsx", import.meta.url), "utf8");
  const header = await readFile(new URL("../src/components/Header.tsx", import.meta.url), "utf8");
  const capabilities = await readFile(new URL("../src/capabilities.ts", import.meta.url), "utf8");
  const sessionSurface = await readFile(new URL("../src/components/workspace/builtinSurfaces.tsx", import.meta.url), "utf8");
  const workspaceMode = await readFile(new URL("../src/widgets/workspaceMode.ts", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.doesNotMatch(canvas, /className=\{`widget-card editing/);
  assert.match(canvas, /canvasEditing = editing \|\| workspaceMode === "edit"/);
  assert.match(canvas, /editing=\{canvasEditing\}/);
  assert.match(canvas, /aria-label=\{widget\.title\}/);
  assert.match(canvas, /\{editing && \(\s*<header className="widget-card-head widget-card-head-draggable"/);
  assert.doesNotMatch(canvas, /<header className=\{`widget-card-head/);
  assert.doesNotMatch(header, /workspace-edit-(?:control|switch)/);
  assert.doesNotMatch(header, /tr\("common\.edit"\)/);
  assert.match(header, /id: "edit-workspace"[\s\S]*label: tr\("header\.editMode"\)[\s\S]*kind: "switch"[\s\S]*onSelect: \(\) => setWorkspaceEditing\(!editing\)/);
  assert.match(header, /className="header-profile"/);
  assert.match(capabilities, /id: "workspace-edit"[\s\S]*standardTier: "technical"/);
  assert.match(header, /workspaceContentMode === "chat"/);
  // The Canvas switch must sit in a hook-free wrapper: returning the canvas
  // part-way through the chat surface's hooks crashed with React #300.
  assert.match(sessionSurface, /function SessionSurface\(\) \{\s*return useWorkspaceContentMode\(\) === "chat" \? <SessionSplitHost focused=\{<ChatSessionSurface \/>\} \/> : <WidgetCanvas \/>;\s*\}/);
  assert.doesNotMatch(sessionSurface.slice(sessionSurface.indexOf("function ChatSessionSurface")), /return <WidgetCanvas/);
  assert.match(workspaceMode, /const WORKSPACE_EDITING_KEY = "polyth\.workspaceEditing\.v1"/);
  assert.doesNotMatch(header, /tr\("common\.done"\)/);
  assert.match(app, /document\.body\.dataset\.uiEditing = "true"/);
  assert.match(styles, /\.widget-drag\s*\{[^}]*display:\s*none/s);
  assert.match(styles, /\.widget-resize-handle\s*\{[^}]*display:\s*none/s);
  assert.match(styles, /\.widget-card\.editing \.widget-resize-handle/);
  assert.match(styles, /\.widget-card\.editing \.widget-drag/);
  assert.doesNotMatch(styles, /workspace-edit-(?:control|switch)/);
});

test("base canvas widgets respond to their own card box", async () => {
  const sources = await Promise.all([
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../../../packages/files/widgets/index.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../../packages/files/widgets/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../../../packages/git/widgets/styles.css", import.meta.url), "utf8"),
  ]);
  const [web, filesEntry, files, git] = sources;
  assert.match(web, /\.widget-conversation\s*\{[^}]*container:\s*conversation-widget \/ size/s);
  assert.match(web, /@container conversation-widget \(max-height:\s*360px\)/);
  assert.match(filesEntry, /className: "files-widget"/);
  assert.match(files, /\.files-widget\s*\{[^}]*container:\s*feature-panel \/ inline-size/s);
  assert.match(files, /@container feature-panel \(min-width:\s*421px\)/);
  assert.match(git, /@container git-recent \(max-height:\s*220px\)/);
});

test("desktop header is the title bar and Linux clips the frameless window to the sheet radius", async () => {
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const desktop = await readFile(new URL("../src/desktop.tsx", import.meta.url), "utf8");
  const header = await readFile(new URL("../src/components/Header.tsx", import.meta.url), "utf8");
  const chrome = await readFile(new URL("../../desktop/src/windowChrome.ts", import.meta.url), "utf8");
  assert.match(styles, /html\[data-desktop-app\]/);
  assert.match(styles, /--desktop-chrome-radius:\s*var\(--radius-sheet\)/);
  assert.match(styles, /--desktop-controls-island-width:\s*calc\(/);
  assert.match(styles, /body\.desktop-app\s*\{[^}]*border-radius:\s*var\(--desktop-chrome-radius\)/s);
  assert.match(styles, /body\.desktop-app \.app\s*\{[^}]*border-radius:\s*var\(--desktop-chrome-radius\)/s);
  // One title-bar band shared with the main process's native control geometry.
  const titlebar = /--desktop-titlebar-h:\s*(\d+)px/.exec(styles)?.[1];
  assert.equal(titlebar, /DESKTOP_TITLEBAR_HEIGHT = (\d+);/.exec(chrome)?.[1]);
  assert.match(styles, /body\.desktop-app \.app > \.header\s*\{[^}]*height:\s*var\(--desktop-titlebar-h\)/s);
  // The caption controls centre on the caption band: the title bar unless a
  // layout hangs its first row lower (shellLayout.css).
  assert.match(styles, /--desktop-caption-h:\s*var\(--desktop-titlebar-h\)/);
  assert.match(styles, /\.desktop-window-controls\s*\{[^}]*height:\s*var\(--desktop-caption-h\)/s);
  // Controls share the header row; no notch/pocket clip remains.
  assert.doesNotMatch(styles, /--desktop-controls-wrap-arc|--desktop-controls-island-height/);
  assert.match(styles, /body\.desktop-app\[data-desktop-controls-position="right"\] \.app > \.header\s*\{[^}]*padding-right:\s*var\(--desktop-controls-island-width\)/s);
  assert.match(styles, /body\.desktop-app\[data-desktop-controls-position="left"\] \.app > \.header\s*\{[^}]*padding-left:\s*var\(--desktop-controls-island-width\)/s);
  assert.match(styles, /body\.desktop-app:is\(\[data-desktop-maximized="true"\], \[data-desktop-fullscreen="true"\]\) \.app\s*\{[^}]*border-radius:\s*0/s);
  assert.match(desktop, /dataset\.desktopMaximized/);
  assert.match(desktop, /dataset\.desktopFullscreen/);
  assert.match(desktop, /createPortal\(controls, document\.body\)/);
  // Crisp vector glyphs, not font characters.
  assert.match(desktop, /className="desktop-window-glyph" viewBox="0 0 10 10"/);
  assert.doesNotMatch(desktop, /[□❐×−]<\/span>/);
  assert.match(header, /<\/header>\s*\{windowControls\}/s);
  assert.match(header, /slot="app.window.controls"/);
});

test("macOS and Windows keep native caption controls without stealing renderer clicks", async () => {
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const desktop = await readFile(new URL("../src/desktop.tsx", import.meta.url), "utf8");
  const chrome = await readFile(new URL("../../desktop/src/windowChrome.ts", import.meta.url), "utf8");

  assert.match(chrome, /platform === "darwin"[\s\S]*?titleBarStyle: "hidden",\s*trafficLightPosition/);
  assert.match(chrome, /platform === "win32"[\s\S]*?titleBarStyle: "hidden",\s*titleBarOverlay/);
  assert.match(chrome, /return \{ frame: false, transparent: true/);
  assert.match(desktop, /dataset\.desktopPlatform = platform/);
  assert.match(desktop, /NATIVE_CONTROL_PLATFORMS = new Set\(\["darwin", "win32"\]\)/);
  assert.match(desktop, /if \(info\.platform === "win32"\) return <>\{captionZone\}<NativeTitleBarSync \/><\/>/);
  assert.match(desktop, /\{info && !NATIVE_CONTROL_PLATFORMS\.has\(info\.platform\) && \(/);
  assert.match(
    styles,
    /body\.desktop-app :is\([\s\S]*?\.scrim,[\s\S]*?\)\s*\{[^}]*-webkit-app-region:\s*no-drag/s,
  );
  assert.match(styles, /\.desktop-window-controls\s*\{[^}]*pointer-events:\s*none/s);
  assert.match(styles, /\.desktop-window-button\s*\{[^}]*pointer-events:\s*auto/s);
  assert.match(
    styles,
    /body\.desktop-app:is\(\[data-desktop-platform="darwin"\], \[data-desktop-platform="win32"\]\) \.desktop-window-controls\s*\{[^}]*display:\s*none/s,
  );
  // The traffic-light inset is the caption zone, which desktop.tsx drops in
  // fullscreen; Windows sizes the zone from the overlay rectangle.
  assert.match(styles, /\[data-desktop-platform="darwin"\]\[data-desktop-caption="left"\]\s*\{[^}]*--desktop-caption-left:\s*var\(--desktop-macos-titlebar-inset\)/s);
  assert.match(styles, /\[data-desktop-platform="darwin"\]\[data-desktop-controls-position\] \.app > \.header\s*\{[^}]*padding-left:\s*max\(18px, var\(--desktop-caption-left\)\)/s);
  assert.match(styles, /env\(titlebar-area-x, 0px\) - env\(titlebar-area-width/);
  assert.match(styles, /\[data-desktop-platform="win32"\]\[data-desktop-controls-position\] \.app > \.header\s*\{[^}]*padding-right:\s*max\(var\(--space-3\), var\(--desktop-caption-right\)\)/s);
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
  const resourceLink = await readFile(new URL("../src/components/resource-link.css", import.meta.url), "utf8");
  for (const [name, pattern] of [
    ["settings chip", /\.widget-order-chip\s*\{[^}]*min-height:\s*var\(--tap\)/s],
    ["drag handle", /\.widget-drag-handle,[\s\S]*?\{[^}]*height:\s*var\(--tap\)/s],
    ["settings checkbox", /\.widget-order-chip input\[type="checkbox"\]\s*\{[^}]*height:\s*var\(--tap\)/s],
    // P2-W3A: model and effort share one config-chip touch contract.
    ["config chips", /\.composer-mobile \.composer-config \.config-chip,[\s\S]*?\.composer-mobile \.composer-config \.picker-chip\s*\{[^}]*min-height:\s*var\(--tap\)/s],
  ] as const) {
    assert.match(css, pattern, `${name} uses the shared 44px target`);
  }
  // The reference link owns its own stylesheet. Its touch box grows with
  // symmetric padding and removes that padding again with the matching
  // negative margin, so the box never claims less height than the reference
  // occupies — a wrapped path keeps the prose line box instead of painting
  // over its neighbours.
  assert.match(
    resourceLink,
    /\.resource-link\.file-ref\s*\{[^}]*min-width:\s*var\(--tap\)[^}]*padding-block:\s*calc\(\(var\(--tap\) - 1em\) \/ 2\)[^}]*margin-block:\s*calc\(\(1em - var\(--tap\)\) \/ 2\)/s,
    "file reference uses the shared 44px target without collapsing its line box",
  );
  assert.doesNotMatch(
    resourceLink,
    /\.resource-link\.file-ref\s*\{[^}]*min-height:\s*var\(--tap\)/s,
    "a fixed one-line height would paint a wrapped reference over the prose around it",
  );
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

test("compact headers and header clusters stay above session status", async () => {
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

  // .header-left-cluster must be relative with z-index >= 3 to stay above .desktop-session-status (z-index: 2)
  assert.match(css, /\.header-left-cluster\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*3;/s);
  // .header-trailing-cluster also stays above centered overlays
  assert.match(css, /\.header-trailing-cluster\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*3;/s);
  // .workspace-mode-switch has explicit stacking
  assert.match(css, /\.workspace-mode-switch\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*1;/s);
  // .header-compact ensures session status stays in relative flex flow (not absolute)
  assert.match(css, /\.header-compact \.desktop-session-status\s*\{[^}]*position:\s*relative;[^}]*inset:\s*auto;[^}]*flex:\s*1 1 auto;[^}]*z-index:\s*auto;/s);
});
