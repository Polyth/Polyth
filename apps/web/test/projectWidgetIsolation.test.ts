import test from "node:test";
import assert from "node:assert/strict";
import {
  persistedProjectWidgetIds,
  pruneUnpersistedIrrelevantWidgets,
} from "../src/packages/projectWidgetIsolation.ts";

const layout = () => ({
  version: 1 as const,
  audience: "standard" as const,
  zones: {
    header: [],
    left: [],
    main: [],
    right: ["engineering.default", "finance.default", "finance.saved"],
    bottom: [],
    floating: [],
  },
  slotPlacements: { "composer.trailing": ["finance.action"] },
  widgets: {
    "engineering.default": {
      visible: true,
      size: { w: 4, h: 3 },
      position: { x: 0, y: 0 },
      definitionId: "engineering.default",
      pluginId: "engineering",
      title: "Engineering",
    },
    "finance.default": {
      visible: true,
      requiredVisible: true,
      size: { w: 4, h: 3 },
      position: { x: 4, y: 0 },
      definitionId: "finance.default",
      pluginId: "finance",
      title: "Finance default",
    },
    "finance.saved": {
      visible: true,
      size: { w: 4, h: 3 },
      position: { x: 8, y: 0 },
      definitionId: "finance.saved",
      pluginId: "finance",
      title: "Finance saved",
    },
    "finance.action": {
      visible: true,
      size: { w: 1, h: 1 },
      position: { x: 0, y: 0 },
      definitionId: "finance.action",
      pluginId: "finance",
      title: "Finance action",
    },
  },
});

test("project switch prunes never-persisted irrelevant defaults including requiredVisible", () => {
  const current = layout();
  const persisted = persistedProjectWidgetIds(JSON.stringify({
    widgets: {
      "finance.saved": { definitionId: "finance.saved" },
    },
  }));
  const next = pruneUnpersistedIrrelevantWidgets(current as never, [{ id: "engineering.default" }], persisted);

  assert.ok(next.widgets["engineering.default"]);
  assert.ok(next.widgets["finance.saved"], "persisted irrelevant state stays latent");
  assert.equal(next.widgets["finance.default"], undefined, "requiredVisible cannot bypass project relevance");
  assert.equal(next.widgets["finance.action"], undefined);
  assert.deepEqual(next.zones.right, ["engineering.default", "finance.saved"]);
  assert.deepEqual(next.slotPlacements["composer.trailing"], []);
});

test("persisted duplicate instances retain both instance and definition identity", () => {
  const ids = persistedProjectWidgetIds(JSON.stringify({
    widgets: {
      "notes.card#2": { definitionId: "notes.card" },
    },
  }));
  assert.deepEqual([...ids].sort(), ["notes.card", "notes.card#2"]);
});

test("malformed persistence cannot protect globally injected irrelevant state", () => {
  assert.deepEqual([...persistedProjectWidgetIds("not json")], []);
  const current = layout();
  const next = pruneUnpersistedIrrelevantWidgets(current as never, [{ id: "engineering.default" }], new Set());
  assert.deepEqual(Object.keys(next.widgets), ["engineering.default"]);
});
