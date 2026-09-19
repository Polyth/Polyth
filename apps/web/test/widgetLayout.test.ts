import test from "node:test";
import assert from "node:assert/strict";
import {
  BUILTIN_WIDGET_IDS,
  MAX_GRID_ROWS,
  WIDGET_LAYOUT_KEY,
  WIDGET_ZONES,
  applyWidgetLayoutMutations,
  canPlaceWidget,
  createDefaultWidgetLayout,
  duplicateWidget,
  ensureWidgets,
  getWidgetLayout,
  getWidgetSaveStatus,
  moveWidget,
  moveWidgetToSlot,
  parseWidgetLayout,
  recommendedWidgetSize,
  serializeWidgetLayout,
  setWidgetConfig,
  setWidgetSize,
  setWidgetPosition,
  setWidgetVisible,
  updateWidgetLayout,
  updateWidgetLayoutForProject,
  widgetLayoutStorageKey,
  widgetZoneOf,
  widgetSlotOf,
} from "../src/widgets/widgetLayout.ts";
import { activateProject } from "../src/store.ts";

test("dragged widgets displace collisions and resting widgets snap back", () => {
  const definitions = [
    { id: "a", defaultSize: { w: 6, h: 3 } },
    { id: "b", defaultSize: { w: 6, h: 3 } },
  ];
  let layout = createDefaultWidgetLayout(definitions);
  layout = setWidgetVisible(layout, "a", true);
  layout = setWidgetVisible(layout, "b", true);
  // Adding lands b beside a on the top row; this case is about dragging it
  // onto an occupied cell, so stack the two first.
  layout = setWidgetPosition(layout, "b", { x: 0, y: 3 });
  const moved = setWidgetPosition(layout, "b", { x: 0, y: 0 }, layout);
  assert.deepEqual(moved.widgets.a?.position, { x: 0, y: 3 });
  assert.deepEqual(moved.widgets.b?.position, { x: 0, y: 0 });

  const snappedBack = setWidgetPosition(
    moved,
    "b",
    layout.widgets.b!.position,
    layout,
  );
  assert.deepEqual(snappedBack.widgets.a?.position, { x: 0, y: 0 });
  assert.deepEqual(snappedBack.widgets.b?.position, { x: 0, y: 3 });

  const parsed = parseWidgetLayout(serializeWidgetLayout(moved), definitions);
  assert.deepEqual(parsed.widgets.a?.position, { x: 0, y: 3 });
});

test("added widgets take the nearest free space at the top of the canvas", () => {
  const definitions = [
    { id: "wide", defaultSize: { w: 12, h: 4 } },
    { id: "left", defaultSize: { w: 4, h: 3 } },
    { id: "gap", defaultSize: { w: 4, h: 3 } },
    { id: "late", defaultSize: { w: 4, h: 2 } },
  ];
  let layout = createDefaultWidgetLayout(definitions);
  layout = setWidgetVisible(layout, "wide", true);
  layout = setWidgetVisible(layout, "left", true);
  // A full-width widget owns rows 0-3, so the next one starts the row below it
  // instead of being pushed under the whole canvas.
  assert.deepEqual(layout.widgets.wide?.position, { x: 0, y: 0 });
  assert.deepEqual(layout.widgets.left?.position, { x: 0, y: 4 });

  // The first gap in that row is used before anything is appended lower down.
  layout = setWidgetVisible(layout, "gap", true);
  assert.deepEqual(layout.widgets.gap?.position, { x: 4, y: 4 });

  // A widget dragged far down the grid and then removed comes back at the top
  // when it is added again, instead of reappearing off-screen.
  layout = setWidgetVisible(layout, "late", true);
  layout = setWidgetPosition(layout, "late", { x: 0, y: 30 });
  assert.deepEqual(layout.widgets.late?.position, { x: 0, y: 30 });
  layout = setWidgetVisible(layout, "late", false);
  layout = setWidgetVisible(layout, "late", true);
  assert.deepEqual(layout.widgets.late?.position, { x: 8, y: 4 });
});

test("a visible header mini-widget never pushes canvas adds below the grid", () => {
  const definitions = [
    { id: "shell.badge", defaultSlot: "app.header.center" as const, kind: "mini-widget" as const },
    { id: "canvas.panel", defaultSize: { w: 6, h: 4 } },
  ];
  let layout = createDefaultWidgetLayout(definitions);
  layout = setWidgetVisible(layout, "shell.badge", true);
  layout = setWidgetVisible(layout, "canvas.panel", true);
  assert.equal(widgetSlotOf(layout, "shell.badge"), "app.header.center");
  assert.deepEqual(
    layout.widgets["canvas.panel"]?.position,
    { x: 0, y: 0 },
    "slot-placed widgets hold no canvas cells",
  );
});

test("a widget moved from a shell slot onto the canvas lands in a free cell", () => {
  const definitions = [
    { id: "resident", defaultSize: { w: 8, h: 4 } },
    {
      id: "roamer",
      defaultSlot: "app.header.center" as const,
      supportedSlots: ["app.header.center", "workspace.main"] as const,
      defaultSize: { w: 6, h: 3 },
    },
  ];
  let layout = createDefaultWidgetLayout(definitions);
  layout = setWidgetVisible(layout, "resident", true);
  layout = setWidgetVisible(layout, "roamer", true);
  layout = moveWidgetToSlot(layout, "roamer", "workspace.main");
  assert.equal(widgetZoneOf(layout, "roamer"), "main");
  assert.deepEqual(layout.widgets.roamer?.position, { x: 0, y: 4 });
});

test("default widget layout contains every built-in exactly once", () => {
  const layout = createDefaultWidgetLayout();
  const placed = [
    ...WIDGET_ZONES.flatMap((zone) => layout.zones[zone]),
    ...Object.values(layout.slotPlacements).flatMap((ids) => ids ?? []),
  ];
  assert.deepEqual(new Set(placed), new Set(BUILTIN_WIDGET_IDS));
  assert.equal(placed.length, BUILTIN_WIDGET_IDS.length);
  assert.equal((BUILTIN_WIDGET_IDS as readonly string[]).includes("core.composer"), false);
  assert.equal(widgetZoneOf(layout, "core.chat"), "main");
  assert.equal(widgetZoneOf(layout, "terminal.shell"), "bottom");
  assert.equal(widgetSlotOf(layout, "usage.session"), "session.composer.before");
  assert.equal(widgetSlotOf(layout, "github.pr-summary"), "session.composer.before");
  assert.equal(layout.widgets["core.chat"]?.visible, true);
  assert.equal(layout.widgets["browser.app"]?.visible, false);
  for (const id of [
    "core.chat", "goals.current", "files.project-map", "git.recent",
    "session.work-status", "knowledge.notes", "session.activity", "core.quick-actions",
  ]) {
    assert.equal(layout.widgets[id]?.visible, true, `${id} should be visible in the default canvas`);
  }
});

test("catalog definitions provide plugin default zones and sizes", () => {
  const layout = createDefaultWidgetLayout([{
    id: "sample.widget",
    zone: "right",
    defaultSize: { w: 5, h: 3 },
  }]);
  assert.deepEqual(layout.zones.right, ["sample.widget"]);
  assert.deepEqual(layout.widgets["sample.widget"]?.size, { w: 5, h: 3 });
  assert.equal(layout.widgets["sample.widget"]?.visible, false);
});

test("package-required widgets repair hidden persistence and reject hide mutations", () => {
  const definition = {
    id: "sample.required-composer",
    pluginId: "sample",
    kind: "mini-widget" as const,
    defaultSlot: "composer.trailing" as const,
    defaultVisible: true,
    requiredVisible: true,
  };
  const initial = createDefaultWidgetLayout([definition]);
  assert.equal(initial.widgets[definition.id]?.visible, true);
  assert.equal(initial.widgets[definition.id]?.requiredVisible, true);
  assert.equal(setWidgetVisible(initial, definition.id, false), initial);

  const stale = JSON.parse(serializeWidgetLayout(initial)) as typeof initial;
  stale.widgets[definition.id]!.visible = false;
  const repaired = parseWidgetLayout(JSON.stringify(stale), [definition]);
  assert.equal(repaired.widgets[definition.id]?.visible, true);
  assert.equal(repaired.widgets[definition.id]?.requiredVisible, true);
  assert.equal(widgetSlotOf(repaired, definition.id), "composer.trailing");
});

test("recommended spawn size fits title chrome without becoming a hard minimum", () => {
  const definition = {
    id: "sample.verbose",
    title: "A deliberately verbose widget heading",
    defaultSize: { w: 2, h: 3 },
    minSize: { w: 1, h: 1 },
  };
  const recommended = recommendedWidgetSize(definition);
  assert.deepEqual(recommended, { w: 9, h: 3 });

  const layout = createDefaultWidgetLayout([definition]);
  assert.deepEqual(layout.widgets[definition.id]?.size, recommended);
  assert.deepEqual(
    setWidgetSize(layout, definition.id, { w: 1, h: 1 }, definition).widgets[definition.id]?.size,
    { w: 1, h: 1 },
  );
});

test("layout serializes and parses visibility, size, audience, and zone order", () => {
  let layout = createDefaultWidgetLayout(["core.chat", "terminal.shell", "browser.app"]);
  layout = moveWidget(layout, "terminal.shell", "main", 0);
  layout = setWidgetVisible(layout, "browser.app", true);
  layout = setWidgetSize(layout, "browser.app", { w: 9, h: 7 });
  layout = { ...layout, audience: "power" };

  const parsed = parseWidgetLayout(
    serializeWidgetLayout(layout),
    ["core.chat", "terminal.shell", "browser.app"],
  );
  assert.deepEqual(parsed, layout);
  assert.deepEqual(parsed.zones.main.slice(0, 2), ["terminal.shell", "core.chat"]);
});

test("per-instance widget config persists and updates independently", () => {
  const definition = {
    id: "sample.metrics",
    pluginId: "sample",
    title: "Metrics",
    defaultSlot: "session.composer.before" as const,
    supportedSlots: ["session.composer.before", "workspace.main"] as const,
    duplicatable: true,
  };
  let layout = createDefaultWidgetLayout([definition]);
  layout = setWidgetConfig(layout, definition.id, { showCost: false, label: "primary" });
  layout = duplicateWidget(layout, definition.id, definition);
  layout = setWidgetConfig(layout, "sample.metrics#2", { showCost: true, label: "copy" });

  const parsed = parseWidgetLayout(serializeWidgetLayout(layout), [definition]);
  assert.deepEqual(parsed.widgets[definition.id]?.config, { showCost: false, label: "primary" });
  assert.deepEqual(parsed.widgets["sample.metrics#2"]?.config, { showCost: true, label: "copy" });
  assert.equal(widgetSlotOf(parsed, definition.id), "session.composer.before");
  assert.equal(widgetSlotOf(parsed, "sample.metrics#2"), "session.composer.before");
});

test("moves reorder between zones, reveal widgets, and ignore unknown ids", () => {
  const initial = setWidgetVisible(
    createDefaultWidgetLayout(["core.chat", "terminal.shell"]),
    "terminal.shell",
    false,
  );
  const moved = moveWidget(initial, "terminal.shell", "header", 0);
  assert.deepEqual(moved.zones.header, ["terminal.shell"]);
  assert.equal(moved.zones.bottom.includes("terminal.shell"), false);
  assert.equal(moved.widgets["terminal.shell"]?.visible, true);
  assert.equal(moveWidget(moved, "unknown.widget", "left"), moved);
});

test("parser drops unknown and duplicate widget ids and restores missing known ids", () => {
  const parsed = parseWidgetLayout(JSON.stringify({
    version: 1,
    audience: "simple",
    zones: {
      top: ["ghost.widget", "core.chat"],
      left: ["core.chat"],
      main: [],
      right: [],
      bottom: [],
    },
    widgets: {
      "ghost.widget": { visible: true, size: { w: 99, h: 99 } },
      "core.chat": { visible: false, size: { w: 99, h: -4 } },
    },
  }), ["core.chat", "terminal.shell"]);

  assert.deepEqual(parsed.zones.header, ["core.chat"]);
  assert.deepEqual(parsed.zones.bottom, ["terminal.shell"]);
  assert.equal("ghost.widget" in parsed.widgets, false);
  assert.deepEqual(parsed.widgets["core.chat"]?.size, { w: 12, h: 1 });
  assert.equal(parsed.widgets["core.chat"]?.visible, false);
  assert.equal(parsed.audience, "simple");
});

test("widget heights support tall canvases up to the grid row limit", () => {
  let layout = createDefaultWidgetLayout(["core.chat"]);
  layout = setWidgetSize(layout, "core.chat", { w: 12, h: 40 });
  assert.deepEqual(layout.widgets["core.chat"]?.size, { w: 12, h: 40 });

  layout = setWidgetSize(layout, "core.chat", { w: 12, h: MAX_GRID_ROWS + 1 });
  assert.deepEqual(layout.widgets["core.chat"]?.size, { w: 12, h: MAX_GRID_ROWS });
});

test("persisted retired shell widgets are removed from header placements", () => {
  const parsed = parseWidgetLayout(JSON.stringify({
    version: 1,
    audience: "standard",
    zones: { header: [], left: [], main: [], right: [], bottom: [], floating: [] },
    slotPlacements: {
      "app.header.actions": ["shell.new-session", "terminal.open-action", "sample.search"],
    },
    widgets: {
      "shell.new-session": {
        visible: true,
        size: { w: 1, h: 1 },
        position: { x: 0, y: 0 },
        definitionId: "shell.new-session",
        pluginId: "shell-actions",
        title: "New session",
      },
      "terminal.open-action": {
        visible: true,
        size: { w: 1, h: 1 },
        position: { x: 0, y: 0 },
        definitionId: "terminal.open-action",
        pluginId: "terminal",
        title: "Open Terminal",
      },
      "sample.search": {
        visible: true,
        size: { w: 1, h: 1 },
        position: { x: 0, y: 0 },
      },
    },
  }), [{
    id: "sample.search",
    kind: "mini-widget",
    defaultSlot: "app.header.actions",
    defaultVisible: true,
  }]);

  assert.equal("shell.new-session" in parsed.widgets, false);
  assert.equal("terminal.open-action" in parsed.widgets, false);
  assert.deepEqual(parsed.slotPlacements["app.header.actions"], ["sample.search"]);
});

test("persisted composer widget migrates to the conversation widget", () => {
  const parsed = parseWidgetLayout(JSON.stringify({
    version: 1,
    audience: "standard",
    zones: {
      header: [],
      left: [],
      main: ["core.composer"],
      right: [],
      bottom: [],
      floating: [],
    },
    widgets: {
      "core.composer": {
        visible: true,
        size: { w: 10, h: 7 },
        position: { x: 1, y: 0 },
      },
    },
  }), ["core.chat"]);

  assert.equal("core.composer" in parsed.widgets, false);
  assert.deepEqual(parsed.zones.main, ["core.chat"]);
  assert.equal(parsed.widgets["core.chat"]?.visible, true);
  assert.deepEqual(parsed.widgets["core.chat"]?.position, { x: 1, y: 0 });
});

test("persisted preview widget migrates to the shared browser widget", () => {
  const parsed = parseWidgetLayout(JSON.stringify({
    version: 1,
    audience: "standard",
    zones: {
      header: [],
      left: [],
      main: [],
      right: [],
      bottom: ["preview.app"],
      floating: [],
    },
    widgets: {
      "preview.app": {
        visible: true,
        size: { w: 11, h: 8 },
        position: { x: 1, y: 2 },
      },
    },
  }), ["browser.app"]);

  assert.equal("preview.app" in parsed.widgets, false);
  assert.deepEqual(parsed.zones.bottom, ["browser.app"]);
  assert.equal(parsed.widgets["browser.app"]?.visible, true);
  assert.deepEqual(parsed.widgets["browser.app"]?.size, { w: 11, h: 8 });
});

test("invalid persisted layouts fall back to defaults", () => {
  assert.deepEqual(
    parseWidgetLayout("not json", ["core.chat"]),
    createDefaultWidgetLayout(["core.chat"]),
  );
  assert.deepEqual(
    parseWidgetLayout('{"version":2}', ["core.chat"]),
    createDefaultWidgetLayout(["core.chat"]),
  );
});

test("shared mutation engine allows any area while still clamping min/max sizes", () => {
  const definitions = [{
    id: "sample.widget",
    title: "Sample",
    zone: "main" as const,
    supportedZones: ["main", "right"] as const,
    defaultSize: { w: 6, h: 4 },
    minSize: { w: 4, h: 3 },
    maxSize: { w: 8, h: 6 },
  }];
  const initial = createDefaultWidgetLayout(definitions);

  // Widget-areas (WA1): a move into an unsupported zone now succeeds; the
  // engine no longer blocks placement.
  const moved = applyWidgetLayoutMutations(initial, [
    { type: "move", id: "sample.widget", zone: "header" },
  ], definitions);
  assert.equal(widgetZoneOf(moved, "sample.widget"), "header");
  const headerFit = canPlaceWidget(definitions[0], "header");
  assert.equal(headerFit.ok, true);
  assert.equal(headerFit.fit, "unusual");
  assert.match(headerFit.note ?? "", /fit|area/i);

  const changed = applyWidgetLayoutMutations(initial, [
    { type: "move", id: "sample.widget", zone: "right" },
    { type: "resize", id: "sample.widget", size: { w: 12, h: 1 } },
  ], definitions);
  assert.equal(widgetZoneOf(changed, "sample.widget"), "right");
  assert.equal(canPlaceWidget(definitions[0], "right").fit, "supported");
  assert.deepEqual(changed.widgets["sample.widget"]?.size, { w: 8, h: 3 });
});

test("duplicatable widgets create independent instances through the same layout model", () => {
  const definition = {
    id: "knowledge.note",
    pluginId: "knowledge",
    title: "Note",
    zone: "left" as const,
    defaultSize: { w: 5, h: 4 },
    duplicatable: true,
  };
  const initial = createDefaultWidgetLayout([definition]);
  const compact = setWidgetSize(initial, definition.id, { w: 1, h: 1 }, definition);
  const duplicated = duplicateWidget(compact, definition.id, definition);
  assert.ok(duplicated.widgets["knowledge.note#2"]);
  assert.equal(duplicated.widgets["knowledge.note#2"]?.definitionId, "knowledge.note");
  assert.deepEqual(duplicated.widgets[definition.id]?.size, { w: 1, h: 1 });
  assert.deepEqual(duplicated.widgets["knowledge.note#2"]?.size, { w: 5, h: 4 });
  assert.deepEqual(duplicated.zones.left, ["knowledge.note", "knowledge.note#2"]);
});

test("mini-widgets persist and move across first-class panel and toolbar slots", () => {
  const definition = {
    id: "sample.refresh",
    pluginId: "sample",
    title: "Refresh",
    description: "Refresh data",
    kind: "mini-widget" as const,
    defaultSlot: "session.header.actions" as const,
    supportedSlots: ["session.header.actions", "app.header.actions", "composer.trailing"] as const,
    defaultVisible: true,
    defaultSize: { w: 1, h: 1 },
    resizable: false,
  };
  const initial = createDefaultWidgetLayout([definition]);
  assert.equal(widgetSlotOf(initial, definition.id), "session.header.actions");
  assert.equal(initial.widgets[definition.id]?.visible, true);

  const moved = moveWidgetToSlot(initial, definition.id, "composer.trailing", 0, definition);
  assert.equal(widgetSlotOf(moved, definition.id), "composer.trailing");
  assert.deepEqual(moved.slotPlacements["session.header.actions"], []);
  assert.deepEqual(moved.slotPlacements["composer.trailing"], [definition.id]);

  const parsed = parseWidgetLayout(serializeWidgetLayout(moved), [definition]);
  assert.equal(widgetSlotOf(parsed, definition.id), "composer.trailing");
  assert.equal(parsed.widgets[definition.id]?.kind, "mini-widget");
  // Widget-areas (WA1): a mini-widget can still be dropped onto a canvas zone;
  // the placement lands and is only flagged as an "unusual" fit.
  const ontoCanvas = moveWidgetToSlot(parsed, definition.id, "workspace.main", 0, definition);
  assert.equal(widgetSlotOf(ontoCanvas, definition.id), "workspace.main");
  assert.equal(canPlaceWidget(definition, "workspace.main").fit, "unusual");
});

test("drag order inside an icon zone survives serialization", () => {
  const definitions = ["first", "second"].map((id) => ({
    id: `sample.${id}`,
    title: id,
    kind: "mini-widget" as const,
    defaultSlot: "composer.trailing" as const,
    defaultVisible: true,
  }));
  const reordered = moveWidgetToSlot(
    createDefaultWidgetLayout(definitions),
    "sample.second",
    "composer.trailing",
    0,
    definitions[1],
  );
  const restored = parseWidgetLayout(serializeWidgetLayout(reordered), definitions);
  assert.deepEqual(restored.slotPlacements["composer.trailing"], ["sample.second", "sample.first"]);
});

test("self-describing plugin placements survive parsing as missing-plugin placeholders", () => {
  const parsed = parseWidgetLayout(JSON.stringify({
    version: 1,
    audience: "standard",
    zones: { header: [], left: [], main: [], right: ["sample.status"], bottom: [], floating: [] },
    widgets: {
      "sample.status": {
        visible: true,
        size: { w: 4, h: 3 },
        definitionId: "sample.status",
        pluginId: "sample",
        title: "Sample status",
        description: "Plugin status",
      },
    },
  }), ["core.chat"]);
  assert.equal(parsed.widgets["sample.status"]?.pluginId, "sample");
  assert.equal(widgetZoneOf(parsed, "sample.status"), "right");
});

test("layouts persist independently under project-specific keys", () => {
  const stored = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { stored.set(key, value); },
      removeItem: (key: string) => { stored.delete(key); },
    },
  });

  ensureWidgets([{
    id: "shell.search",
    pluginId: "shell-actions",
    kind: "mini-widget",
    defaultSlot: "app.header.actions",
    defaultVisible: true,
  }]);
  activateProject("layout-project-alpha");
  assert.equal(getWidgetLayout().widgets["shell.search"]?.visible, true);
  assert.deepEqual(
    getWidgetLayout().slotPlacements["app.header.actions"]?.includes("shell.search"),
    true,
    "registered mini-widget actions survive the first project activation",
  );
  updateWidgetLayout((current) => ({
    ...current,
    audience: "power",
  }), { immediate: true });
  const alphaKey = widgetLayoutStorageKey("layout-project-alpha");
  assert.equal(parseWidgetLayout(stored.get(alphaKey) ?? null).audience, "power");
  assert.equal(stored.has(WIDGET_LAYOUT_KEY), false);

  activateProject("layout-project-beta");
  assert.equal(getWidgetLayout().audience, "standard", "a new project starts from defaults");
  updateWidgetLayout((current) => ({ ...current, audience: "simple" }), { immediate: true });
  const betaKey = widgetLayoutStorageKey("layout-project-beta");
  assert.equal(parseWidgetLayout(stored.get(betaKey) ?? null).audience, "simple");

  activateProject("layout-project-alpha");
  assert.equal(getWidgetLayout().audience, "power", "switching back restores that project's canvas");
  assert.equal(getWidgetSaveStatus(), "saved");

  updateWidgetLayoutForProject("layout-project-beta", (current) => ({
    ...current,
    audience: "power",
  }), { immediate: true });
  assert.equal(getWidgetLayout().audience, "power", "resetting another project does not switch the active layout");
  assert.equal(
    parseWidgetLayout(stored.get(widgetLayoutStorageKey("layout-project-beta")) ?? null).audience,
    "power",
  );
});

test("registered mini-widgets remain placed when the active project changes", () => {
  const definition = {
    id: "workflow.chat-launcher",
    pluginId: "workflow",
    title: "Run workflow",
    description: "Run the current chat draft through a workflow.",
    kind: "mini-widget" as const,
    defaultSlot: "composer.trailing" as const,
    supportedSlots: ["composer.leading", "composer.trailing"] as const,
    defaultVisible: true,
    audience: "simple" as const,
  };
  ensureWidgets([definition]);

  activateProject("layout-project-with-workflow");
  const first = getWidgetLayout();
  assert.equal(first.widgets[definition.id]?.visible, true);
  assert.ok(first.slotPlacements["composer.trailing"]?.includes(definition.id));

  activateProject("layout-second-project-with-workflow");
  const second = getWidgetLayout();
  assert.equal(second.widgets[definition.id]?.visible, true);
  assert.ok(
    second.slotPlacements["composer.trailing"]?.includes(definition.id),
    "project-scoped layout parsing keeps registered composer actions",
  );
});

test("the legacy global layout migrates to only the first project that loads it", () => {
  const stored = new Map<string, string>();
  const legacy = {
    ...createDefaultWidgetLayout(),
    audience: "power" as const,
  };
  stored.set(WIDGET_LAYOUT_KEY, serializeWidgetLayout(legacy));
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { stored.set(key, value); },
      removeItem: (key: string) => { stored.delete(key); },
    },
  });

  activateProject("layout-legacy-project");
  const migratedKey = widgetLayoutStorageKey("layout-legacy-project");
  assert.equal(getWidgetLayout().audience, "power");
  assert.equal(stored.get(migratedKey), serializeWidgetLayout(legacy));
  assert.equal(stored.has(WIDGET_LAYOUT_KEY), false, "the global key is retired after migration");

  activateProject("layout-fresh-project");
  assert.equal(getWidgetLayout().audience, "standard", "later projects do not inherit the migrated canvas");
  assert.equal(stored.has(widgetLayoutStorageKey("layout-fresh-project")), false);
});
