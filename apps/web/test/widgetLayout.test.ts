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
  getWidgetLayout,
  getWidgetSaveStatus,
  moveWidget,
  moveWidgetToSlot,
  parseWidgetLayout,
  serializeWidgetLayout,
  setWidgetSize,
  setWidgetPosition,
  setWidgetVisible,
  updateWidgetLayout,
  widgetLayoutStorageKey,
  widgetZoneOf,
  widgetSlotOf,
} from "../src/widgets/widgetLayout.ts";
import { activateProject } from "../src/store.ts";

test("free-form positions persist and collisions resolve with a grid gap", () => {
  const definitions = [
    { id: "a", defaultSize: { w: 6, h: 3 } },
    { id: "b", defaultSize: { w: 6, h: 3 } },
  ];
  let layout = createDefaultWidgetLayout(definitions);
  layout = setWidgetVisible(layout, "a", true);
  layout = setWidgetVisible(layout, "b", true);
  const moved = setWidgetPosition(layout, "b", { x: 0, y: 0 });
  assert.deepEqual(moved.widgets.a?.position, { x: 0, y: 0 });
  assert.deepEqual(moved.widgets.b?.position, { x: 0, y: 3 });

  const parsed = parseWidgetLayout(serializeWidgetLayout(moved), definitions);
  assert.deepEqual(parsed.widgets.b?.position, { x: 0, y: 3 });
});

test("default widget layout contains every built-in exactly once", () => {
  const layout = createDefaultWidgetLayout();
  const placed = WIDGET_ZONES.flatMap((zone) => layout.zones[zone]);
  assert.deepEqual(new Set(placed), new Set(BUILTIN_WIDGET_IDS));
  assert.equal(placed.length, BUILTIN_WIDGET_IDS.length);
  assert.equal(widgetZoneOf(layout, "core.composer"), "main");
  assert.equal(widgetZoneOf(layout, "terminal.shell"), "bottom");
  assert.equal(layout.widgets["core.composer"]?.visible, true);
  assert.equal(layout.widgets["core.chat"]?.visible, false);
  assert.equal(layout.widgets["preview.app"]?.visible, false);
  for (const id of [
    "core.composer", "goals.current", "files.project-map", "git.recent",
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

test("layout serializes and parses visibility, size, audience, and zone order", () => {
  let layout = createDefaultWidgetLayout(["core.chat", "terminal.shell", "preview.app"]);
  layout = moveWidget(layout, "terminal.shell", "main", 0);
  layout = setWidgetVisible(layout, "preview.app", true);
  layout = setWidgetSize(layout, "preview.app", { w: 9, h: 7 });
  layout = { ...layout, audience: "power" };

  const parsed = parseWidgetLayout(
    serializeWidgetLayout(layout),
    ["core.chat", "terminal.shell", "preview.app"],
  );
  assert.deepEqual(parsed, layout);
  assert.deepEqual(parsed.zones.main.slice(0, 2), ["terminal.shell", "core.chat"]);
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

test("persisted retired New session widget is removed from header placements", () => {
  const parsed = parseWidgetLayout(JSON.stringify({
    version: 1,
    audience: "standard",
    zones: { header: [], left: [], main: [], right: [], bottom: [], floating: [] },
    slotPlacements: {
      "app.header.actions": ["shell.new-session", "sample.search"],
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
  assert.deepEqual(parsed.slotPlacements["app.header.actions"], ["sample.search"]);
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

test("shared mutation engine enforces zones and min/max widget sizes", () => {
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
  const rejected = applyWidgetLayoutMutations(initial, [
    { type: "move", id: "sample.widget", zone: "header" },
  ], definitions);
  assert.equal(rejected, initial);
  assert.match(canPlaceWidget(definitions[0], "header").reason ?? "", /doesn’t fit/);

  const changed = applyWidgetLayoutMutations(initial, [
    { type: "move", id: "sample.widget", zone: "right" },
    { type: "resize", id: "sample.widget", size: { w: 12, h: 1 } },
  ], definitions);
  assert.equal(widgetZoneOf(changed, "sample.widget"), "right");
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
  const duplicated = duplicateWidget(initial, definition.id, definition);
  assert.ok(duplicated.widgets["knowledge.note#2"]);
  assert.equal(duplicated.widgets["knowledge.note#2"]?.definitionId, "knowledge.note");
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
  assert.equal(
    moveWidgetToSlot(parsed, definition.id, "workspace.main", 0, definition),
    parsed,
    "unsupported canvas placement is rejected",
  );
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
  }), ["core.composer"]);
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

  activateProject("layout-project-alpha");
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
