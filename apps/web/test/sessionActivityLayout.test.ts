// The activity details' layout record: the tab that was open last and the
// order of the blocks. Presentation only, per browser, and a damaged or older
// record degrades to the defaults.
import test from "node:test";
import assert from "node:assert/strict";
import {
  ACTIVITY_BLOCKS,
  ACTIVITY_LAYOUT_KEY,
  DEFAULT_ACTIVITY_ORDER,
  activityBlocksOf,
  isDefaultActivityOrder,
  normalizeActivityOrder,
  parseActivityLayout,
  permuteActivityOrder,
} from "../src/sessionActivityLayout.ts";

test("every block is known once, with a tab and a shape", () => {
  assert.equal(new Set(DEFAULT_ACTIVITY_ORDER).size, DEFAULT_ACTIVITY_ORDER.length);
  assert.deepEqual(ACTIVITY_BLOCKS.filter((block) => block.shape === "row").map((block) => block.id), ["context", "request", "plan"]);
  assert.deepEqual(activityBlocksOf(DEFAULT_ACTIVITY_ORDER, "content"), ["request", "plan"]);
  // Figures every agent reports come first, so a quiet provider still fills a line.
  assert.deepEqual(activityBlocksOf(DEFAULT_ACTIVITY_ORDER, "stats").slice(0, 3), ["context", "duration", "messages"]);
  assert.deepEqual(activityBlocksOf(DEFAULT_ACTIVITY_ORDER, null), [...DEFAULT_ACTIVITY_ORDER]);
});

test("a stored order keeps every block exactly once and places a missing one by default", () => {
  assert.deepEqual(normalizeActivityOrder(undefined), [...DEFAULT_ACTIVITY_ORDER]);
  assert.deepEqual(normalizeActivityOrder("nope"), [...DEFAULT_ACTIVITY_ORDER]);
  const stored = ["cost", "context", "cost", "bogus", 7, "plan", "request"];
  const order = normalizeActivityOrder(stored);
  assert.equal(order.length, DEFAULT_ACTIVITY_ORDER.length);
  assert.equal(new Set(order).size, order.length);
  // The person's order wins among the stored blocks…
  assert.deepEqual(order.filter((id) => ["cost", "context", "plan", "request"].includes(id)), ["cost", "context", "plan", "request"]);
  // …and a block the record lacks joins right after its nearest default
  // predecessor: `input` follows `cost`, `duration` follows `context`.
  assert.equal(order[order.indexOf("cost") + 1], "input");
  assert.equal(order[order.indexOf("context") + 1], "duration");
  assert.deepEqual(order.slice(-2), ["plan", "request"]);
});

test("a damaged record degrades to the defaults", () => {
  assert.deepEqual(parseActivityLayout(null), { tab: "stats", order: [...DEFAULT_ACTIVITY_ORDER] });
  assert.deepEqual(parseActivityLayout("{not json"), { tab: "stats", order: [...DEFAULT_ACTIVITY_ORDER] });
  assert.deepEqual(parseActivityLayout('{"tab":"plan"}').tab, "stats", "an unknown tab is not trusted");
  assert.equal(parseActivityLayout('{"tab":"content"}').tab, "content");
});

test("reordering one tab's blocks leaves the other tab's blocks in their places", () => {
  const order = [...DEFAULT_ACTIVITY_ORDER];
  const plan = permuteActivityOrder(order, ["plan", "request"]);
  assert.deepEqual(activityBlocksOf(plan, "content"), ["plan", "request"]);
  assert.deepEqual(activityBlocksOf(plan, "stats"), activityBlocksOf(order, "stats"));
  // A subset that is not part of the order changes nothing.
  assert.deepEqual(permuteActivityOrder(order, ["plan", "plan"]), order);
  assert.equal(isDefaultActivityOrder(order), true);
  assert.equal(isDefaultActivityOrder(plan), false);
});

test("the record persists the tab and the order and notifies subscribers", async () => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    },
  });
  const layout = await import(`../src/sessionActivityLayout.ts?persist=${Date.now()}`) as typeof import("../src/sessionActivityLayout.ts");
  let calls = 0;
  const off = layout.subscribeActivityLayout(() => { calls += 1; });
  layout.setActivityTab("content");
  layout.setActivityTab("content");
  assert.equal(calls, 1, "an unchanged tab notifies nobody");
  layout.setActivityOrder(["cost", ...DEFAULT_ACTIVITY_ORDER.filter((id) => id !== "cost")]);
  assert.deepEqual(JSON.parse(values.get(ACTIVITY_LAYOUT_KEY)!), {
    tab: "content",
    order: ["cost", ...DEFAULT_ACTIVITY_ORDER.filter((id) => id !== "cost")],
  });
  layout.resetActivityOrder();
  assert.deepEqual(layout.getActivityLayout(), { tab: "content", order: [...DEFAULT_ACTIVITY_ORDER] });
  off();
  assert.equal(calls, 3);
});
