import test from "node:test";
import assert from "node:assert/strict";
import { isUiSlot, type WidgetKind } from "@polyth/contracts";
import {
  areaRecommends,
  areasByGroup,
  areasRecommending,
  getArea,
  listAreas,
  registerArea,
  registerAreas,
  type WidgetArea,
} from "../src/widgets/areas.ts";
import { BUILTIN_AREAS, installBuiltinAreas } from "../src/widgets/builtinAreas.ts";
import { allPlacementAreas, canPlaceWidget } from "../src/widgets/widgetLayout.ts";

const area = (over: Partial<WidgetArea> & Pick<WidgetArea, "id">): WidgetArea => ({
  label: over.id,
  description: over.id,
  group: "workspace",
  orientation: "row",
  sizeHint: "compact",
  recommends: [],
  order: 0,
  ...over,
});

test("registerArea lists deterministically by order then id and replaces by id", () => {
  const off = registerAreas([
    area({ id: "workspace.main.tabs", order: 5 }),
    area({ id: "workspace.right.tabs", order: 5 }),
    area({ id: "workspace.canvas", order: 1 }),
  ]);
  try {
    const ids = listAreas().map((a) => a.id);
    assert.ok(ids.indexOf("workspace.canvas") < ids.indexOf("workspace.main.tabs"));
    assert.ok(ids.indexOf("workspace.main.tabs") < ids.indexOf("workspace.right.tabs"));

    // Replace by id — last registration wins, no duplicate entry.
    const off2 = registerArea(area({ id: "workspace.canvas", order: 99, label: "replaced" }));
    assert.equal(listAreas().filter((a) => a.id === "workspace.canvas").length, 1);
    assert.equal(getArea("workspace.canvas")?.label, "replaced");
    off2();
  } finally {
    off();
  }
});

test("a superseded unregister is a no-op; the live registration survives", () => {
  const offOld = registerArea(area({ id: "workspace.canvas", label: "old" }));
  const offNew = registerArea(area({ id: "workspace.canvas", label: "new" }));
  offOld(); // must NOT remove the newer registration
  assert.equal(getArea("workspace.canvas")?.label, "new");
  offNew();
  assert.equal(getArea("workspace.canvas"), undefined);
});

test("recommendation helpers read the registry", () => {
  const off = registerArea(area({
    id: "sidebar.toolbar",
    group: "sidebar",
    recommends: ["sidebar.filter", "sidebar.search"],
  }));
  try {
    assert.equal(areaRecommends("sidebar.toolbar", "sidebar.filter"), true);
    assert.equal(areaRecommends("sidebar.toolbar", "nope"), false);
    assert.equal(areaRecommends("composer.meta", "sidebar.filter"), false);
    assert.deepEqual(
      areasRecommending("sidebar.search").map((a) => a.id),
      ["sidebar.toolbar"],
    );
  } finally {
    off();
  }
});

test("installBuiltinAreas registers the catalogue once with valid slot ids", () => {
  installBuiltinAreas();
  installBuiltinAreas(); // idempotent

  const ids = listAreas().map((a) => a.id);
  for (const builtin of BUILTIN_AREAS) {
    assert.equal(ids.filter((id) => id === builtin.id).length, 1, `${builtin.id} registered once`);
    assert.equal(isUiSlot(builtin.id), true, `${builtin.id} is a canonical UiSlot`);
  }
  for (const expected of [
    "workspace.rail", "sidebar.toolbar", "composer.meta", "composer.pending",
    "app.header.center", "workspace.left", "workspace.main",
  ]) {
    assert.ok(getArea(expected as never), `${expected} is a built-in area`);
  }

  const groups = areasByGroup();
  for (const group of ["shell", "sidebar", "workspace", "session", "composer"] as const) {
    assert.ok((groups.get(group)?.length ?? 0) > 0, `${group} has at least one area`);
  }

  // Widget-areas (WA3): the rails recommend their capability launchers, so the
  // Widget Library surfaces "Git", "Terminal", … first for those areas.
  assert.equal(areaRecommends("workspace.rail", "capability:git"), true);
  assert.equal(areaRecommends("workspace.rail", "capability:terminal"), true);
  assert.equal(areaRecommends("app.header.center", "capability:files"), true);
  // Chat has no capability launcher widget (it is core.chat).
  assert.equal(areaRecommends("workspace.rail", "capability:session"), false);
});

test("allPlacementAreas unions the six canvas zones with every registered area", () => {
  installBuiltinAreas();
  const all = allPlacementAreas();
  for (const zone of [
    "workspace.header", "workspace.left", "workspace.main",
    "workspace.right", "workspace.bottom", "workspace.floating",
  ]) {
    assert.ok(all.includes(zone as never), `${zone} is always placeable`);
  }
  assert.ok(all.includes("workspace.rail" as never));
  assert.ok(all.includes("composer.meta" as never));
  assert.equal(new Set(all).size, all.length, "no duplicates");
});

test("canPlaceWidget never blocks and grades fit against areas + supportedSlots", () => {
  // Ad-hoc test area on a non-built-in slot so disposing cannot strip a
  // built-in area for later tests in this file.
  const off = registerArea(area({
    id: "workspace.main.tabs",
    orientation: "row",
    sizeHint: "icon",
    recommends: ["permissions.composer"],
  }));
  try {
    const permWidget = {
      id: "permissions.composer",
      supportedSlots: ["session.composer.before"] as const,
      defaultSize: { w: 4, h: 3 },
    };
    // area recommends it -> recommended, even though supportedSlots doesn't list it
    const rec = canPlaceWidget(permWidget, "workspace.main.tabs");
    assert.equal(rec.ok, true);
    assert.equal(rec.fit, "recommended");

    // widget's own supported slot -> supported
    assert.equal(canPlaceWidget(permWidget, "session.composer.before").fit, "supported");

    // neither -> unusual, still ok, with a note
    const odd = canPlaceWidget(permWidget, "workspace.bottom");
    assert.equal(odd.ok, true);
    assert.equal(odd.fit, "unusual");
    assert.ok((odd.note ?? "").length > 0);

    // recommended flag + supported slot -> recommended
    const flagged = {
      id: "x.flagged",
      supportedSlots: ["workspace.right"] as const,
      recommended: true,
    };
    assert.equal(canPlaceWidget(flagged, "workspace.right").fit, "recommended");

    // a tall widget in an icon row gets an extra sizing note
    const tall = { id: "x.tall", supportedSlots: ["workspace.main.tabs"] as const, minSize: { w: 2, h: 6 } };
    assert.match(canPlaceWidget(tall, "workspace.main.tabs").note ?? "", /height|header/i);

    // missing definition is tolerated
    const missing = canPlaceWidget(undefined, "workspace.main");
    assert.equal(missing.ok, true);
    assert.equal(missing.fit, "unusual");
  } finally {
    off();
  }
});

test("kind hint is carried but never consulted for blocking", () => {
  const off = registerArea(area({ id: "workspace.right.tabs", group: "shell", preferredKind: "mini-widget" }));
  try {
    assert.equal(getArea("workspace.right.tabs")?.preferredKind, "mini-widget" satisfies WidgetKind);
    const panel = { id: "big.panel", supportedSlots: ["workspace.main"] as const, defaultSize: { w: 12, h: 8 } };
    assert.equal(canPlaceWidget(panel, "workspace.right.tabs").ok, true);
  } finally {
    off();
  }
});
