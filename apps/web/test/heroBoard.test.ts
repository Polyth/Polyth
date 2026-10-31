import test from "node:test";
import assert from "node:assert/strict";
import {
  addHeroBoardItem,
  adoptLegacyHeroPlacements,
  duplicateHeroBoardItem,
  heroItemDefaultSize,
  heroItemsFor,
  heroOrder,
  normalizeHeroBoard,
  removeHeroBoardItem,
  updateHeroBoardItem,
  type HeroBoard,
} from "../src/heroBoard.ts";

const empty: HeroBoard = { items: [], order: [] };
const clock = { id: "glance.clock", duplicatable: true, panelSizes: ["compact", "standard"] as const, panelDefaultSize: "compact" as const };
const limits = { id: "usage.limits" };

test("one order: stored entries first, then missing built-ins in their own order, then items", () => {
  let board = addHeroBoardItem(empty, clock).board;
  assert.deepEqual(heroOrder(board, ["recent", "starters", "apps"]), ["recent", "starters", "apps", "glance.clock"]);
  board = { ...board, order: ["glance.clock", "apps", "gone"] };
  assert.deepEqual(heroOrder(board, ["starters", "recent", "apps"]), ["glance.clock", "apps", "starters", "recent"], "unknown ids drop");
});

test("adding: sizes come from the widget, singletons are shown again instead of added twice", () => {
  assert.equal(heroItemDefaultSize(clock), "compact");
  assert.equal(heroItemDefaultSize(limits), "wide", "a widget without panel sizes keeps its full-width row");
  const first = addHeroBoardItem(empty, limits);
  const hidden = updateHeroBoardItem(first.board, first.id, { hidden: true });
  const again = addHeroBoardItem(hidden, limits);
  assert.equal(again.board.items.length, 1);
  assert.equal(again.id, first.id);
  assert.equal(again.board.items[0]!.hidden, undefined);
  const two = addHeroBoardItem(addHeroBoardItem(empty, clock).board, clock);
  assert.deepEqual(two.board.items.map((item) => item.id), ["glance.clock", "glance.clock#2"]);
});

test("project scope, duplicate below the source with its own config, remove drops it from the order", () => {
  let board = addHeroBoardItem(empty, clock, { config: { zone: "Europe/Kyiv" } }).board;
  board = updateHeroBoardItem(board, "glance.clock", { projectId: "p1" });
  assert.equal(heroItemsFor(board, "p1").length, 1);
  assert.equal(heroItemsFor(board, "p2").length, 0, "an item of one project stays out of others");
  board = updateHeroBoardItem(board, "glance.clock", { projectId: undefined });
  assert.equal("projectId" in board.items[0]!, false, "clearing the scope removes the field");

  board = duplicateHeroBoardItem(board, "glance.clock", ["starters", "recent"]);
  assert.deepEqual(board.order, ["starters", "recent", "glance.clock", "glance.clock#2"]);
  (board.items[1]!.config as { zone: string }).zone = "UTC";
  assert.equal(board.items[0]!.config.zone, "Europe/Kyiv", "the copy's settings are its own");

  board = removeHeroBoardItem(board, "glance.clock");
  assert.deepEqual(board.items.map((item) => item.id), ["glance.clock#2"]);
  assert.equal(board.order.includes("glance.clock"), false);
});

test("legacy layout placements are adopted once, scoped to their project", () => {
  const placements = [{ instanceId: "custom-action.panel", widget: { id: "custom-action.panel" }, config: { a: 1 } }];
  const once = adoptLegacyHeroPlacements(empty, placements, "p1");
  assert.deepEqual(once.items, [{ id: "legacy:p1:custom-action.panel", widget: "custom-action.panel", size: "wide", config: { a: 1 }, projectId: "p1" }]);
  assert.equal(adoptLegacyHeroPlacements(once, placements, "p1"), once, "a layout synced back is not adopted twice");
  assert.equal(adoptLegacyHeroPlacements(empty, placements, undefined).items[0]!.projectId, undefined, "a shared interface adopts for every project");
});

test("synced values are read tolerantly", () => {
  const board = normalizeHeroBoard({
    items: [
      { id: "a", widget: "w", size: "huge", config: [1], hidden: "yes" },
      { id: "a", widget: "dup" },
      { widget: "no-id" },
      null,
    ],
    order: ["a", 3, "a"],
  });
  assert.deepEqual(board, { items: [{ id: "a", widget: "w", size: "wide", config: {} }], order: ["a"] });
  assert.deepEqual(normalizeHeroBoard("junk"), { items: [], order: [] });
});
