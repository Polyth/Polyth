// The header view tabs (Chat, Canvas, workbench profiles) are one customizable
// list: the person's order, per-tab visibility, and the tab this device is on
// always drawn so it can be left.
import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
Object.defineProperty(globalThis, "location", { value: dom.location, configurable: true });

const { resolveViewTabs, viewTabLayoutWithHidden } = await import("../src/viewTabs.ts");
const { parseCapabilityLayout, MAX_VIEW_TABS } = await import("../src/capabilityLayout.ts");

type Candidate = Parameters<typeof resolveViewTabs>[0][number];
const tab = (id: string, visibility: Candidate["visibility"] = "layout", offered = true): Candidate =>
  ({ id, label: id, visibility, offered, focused: false });
const CANDIDATES = [tab("chat"), tab("canvas", "canvas", true), tab("tasks", "offer", true), tab("creative-studio")];
const ids = (tabs: ReturnType<typeof resolveViewTabs>, key: "drawn" | "shown" = "drawn") =>
  tabs.filter((entry) => entry[key]).map((entry) => entry.id);

test("tabs keep their natural order until the person reorders them", () => {
  assert.deepEqual(ids(resolveViewTabs(CANDIDATES, {}, "chat")), ["chat", "canvas", "tasks", "creative-studio"]);
  assert.deepEqual(
    ids(resolveViewTabs(CANDIDATES, { order: ["creative-studio", "chat"] }, "chat")),
    ["creative-studio", "chat", "canvas", "tasks"],
    "unmentioned tabs follow the tab they come after naturally",
  );
  assert.deepEqual(
    ids(resolveViewTabs(CANDIDATES, { order: ["gone", "creative-studio", "chat"] }, "chat")),
    ["creative-studio", "chat", "canvas", "tasks"],
    "stale ids drop",
  );
});

test("every tab can be hidden, including Chat; the active one stays drawn", () => {
  const layout = viewTabLayoutWithHidden(viewTabLayoutWithHidden({}, "chat", true), "creative-studio", true);
  assert.deepEqual(layout.hidden, ["chat", "creative-studio"]);
  const onCanvas = resolveViewTabs(CANDIDATES, layout, "canvas");
  assert.deepEqual(ids(onCanvas), ["canvas", "tasks"]);
  assert.deepEqual(ids(resolveViewTabs(CANDIDATES, layout, "chat")), ["chat", "canvas", "tasks"]);
  assert.deepEqual(ids(resolveViewTabs(CANDIDATES, layout, "chat"), "shown"), ["canvas", "tasks"]);
  assert.deepEqual(viewTabLayoutWithHidden(layout, "chat", false).hidden, ["creative-studio"]);
});

test("Canvas and optional profiles keep their own per-project offers", () => {
  const candidates = [tab("chat"), tab("canvas", "canvas", false), tab("tasks", "offer", false)];
  // `hidden` only covers always-offered tabs: it cannot re-show an unoffered one.
  assert.deepEqual(ids(resolveViewTabs(candidates, { hidden: [] }, "chat")), ["chat"]);
  assert.deepEqual(ids(resolveViewTabs(candidates, { hidden: ["canvas"] }, "tasks")), ["chat", "tasks"]);
});

test("the capability layout record keeps the tab layout bounded and typed", () => {
  const raw = JSON.stringify({
    version: 1,
    placements: {},
    viewTabs: { order: ["tasks", "chat", "tasks", 4, ""], hidden: ["chat"] },
  });
  assert.deepEqual(parseCapabilityLayout(raw).viewTabs, { order: ["tasks", "chat"], hidden: ["chat"] });
  const many = Array.from({ length: MAX_VIEW_TABS + 10 }, (_, index) => `p${index}`);
  const bounded = parseCapabilityLayout(JSON.stringify({ version: 1, placements: {}, viewTabs: { order: many } }));
  assert.equal(bounded.viewTabs?.order?.length, MAX_VIEW_TABS);
  assert.equal(parseCapabilityLayout(JSON.stringify({ version: 1, placements: {}, viewTabs: [] })).viewTabs, undefined);
});
