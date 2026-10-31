// Pane tab-host logic: open/activate/close with dirty guard, reorder,
// keyboard cycling, and persistence round-trips including unavailable tabs.
import test from "node:test";
import assert from "node:assert";
import {
  activateTab, closeTab, cycleTab, deserializePane, emptyPane, markDirty,
  moveTab, openTab, pinTab, serializePane, tabId, type PaneState,
} from "../src/workspace/paneStore.ts";

const file = (p: string) => ({ id: tabId("file", p), kind: "file" as const, resource: p, title: p.split("/").pop()! });

test("pane: a background open adds the tab without taking focus, unless nothing is active", () => {
  let state = openTab(emptyPane, file("first.ts"), { background: true });
  assert.equal(state.activeId, "file:first.ts", "an empty pane still activates it");
  state = openTab(state, file("second.ts"), { background: true });
  assert.deepEqual(state.tabs.map((tab) => tab.resource), ["first.ts", "second.ts"]);
  assert.equal(state.activeId, "file:first.ts");
  state = openTab(state, file("second.ts"), { background: true });
  assert.equal(state.activeId, "file:first.ts", "re-opening in the background keeps the active tab");
  state = openTab(state, file("second.ts"));
  assert.equal(state.activeId, "file:second.ts");
});

test("pane: preview replacement preserves pinned tabs and their order", () => {
  let state = openTab(emptyPane, file("pinned.ts"));
  state = openTab(state, { ...file("a.ts"), preview: true });
  state = openTab(state, { ...file("b.ts"), preview: true });
  assert.deepEqual(state.tabs.map((tab) => tab.resource), ["pinned.ts", "b.ts"]);
  assert.equal(state.activeId, "file:b.ts");
  state = pinTab(state, "file:b.ts");
  state = openTab(state, { ...file("c.ts"), preview: true });
  assert.equal(state.tabs.length, 3);
  assert.equal(state.tabs.filter((tab) => tab.preview).length, 1);
});

test("pane: editing a preview pins it permanently, including after saving", () => {
  let state = openTab(emptyPane, { ...file("a.ts"), preview: true });
  state = markDirty(state, "file:a.ts", true);
  state = markDirty(state, "file:a.ts", false);
  state = openTab(state, { ...file("b.ts"), preview: true });
  assert.deepEqual(state.tabs.map((tab) => tab.resource), ["a.ts", "b.ts"]);
  assert.equal(state.tabs[0]!.preview, undefined);
});

test("pane: permanent reopen promotes preview but preview reopen never demotes", () => {
  let state = openTab(emptyPane, { ...file("a.ts"), preview: true });
  state = openTab(state, file("a.ts"));
  assert.equal(state.tabs[0]!.preview, undefined);
  assert.equal(openTab(state, { ...file("a.ts"), preview: true }), state);
});

test("pane: preview persists per pane and malformed duplicate previews normalize", () => {
  const state = openTab(emptyPane, { ...file("a.ts"), preview: true });
  assert.equal(deserializePane(serializePane(state), () => true).tabs[0]!.preview, true);
  const malformed = JSON.stringify({ tabs: [null, { ...file("a.ts"), preview: true }, { ...file("b.ts"), preview: true }] });
  assert.equal(deserializePane(malformed, () => true).tabs.filter((tab) => tab.preview).length, 1);
});

test("pane: open activates, reopen is idempotent", () => {
  let s = openTab(emptyPane, file("a.ts"));
  s = openTab(s, file("b.ts"));
  assert.equal(s.tabs.length, 2);
  assert.equal(s.activeId, "file:b.ts");
  const again = openTab(s, file("a.ts"));
  assert.equal(again.tabs.length, 2);
  assert.equal(again.activeId, "file:a.ts");
  // Reopening the already-active tab returns the same state object.
  assert.equal(openTab(again, file("a.ts")), again);
});

test("pane: dirty tabs survive activation changes and block close", () => {
  let s = openTab(openTab(emptyPane, file("a.ts")), file("b.ts"));
  s = markDirty(s, "file:a.ts", true);
  s = activateTab(s, "file:b.ts");
  assert.equal(s.tabs.find((t) => t.id === "file:a.ts")!.dirty, true);

  const blocked = closeTab(s, "file:a.ts");
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.state.tabs.length, 2);

  const forced = closeTab(s, "file:a.ts", { force: true });
  assert.equal(forced.blocked, false);
  assert.equal(forced.state.tabs.length, 1);
});

test("pane: closing the active tab picks the right neighbor then left", () => {
  let s = emptyPane as PaneState;
  for (const p of ["a", "b", "c"]) s = openTab(s, file(p));
  s = activateTab(s, "file:b");
  let r = closeTab(s, "file:b");
  assert.equal(r.state.activeId, "file:c");
  r = closeTab(r.state, "file:c");
  assert.equal(r.state.activeId, "file:a");
  r = closeTab(r.state, "file:a");
  assert.equal(r.state.activeId, null);
});

test("pane: move reorders and clamps; dirty rides along", () => {
  let s = emptyPane as PaneState;
  for (const p of ["a", "b", "c"]) s = openTab(s, file(p));
  s = markDirty(s, "file:c", true);
  s = moveTab(s, "file:c", 0);
  assert.deepEqual(s.tabs.map((t) => t.id), ["file:c", "file:a", "file:b"]);
  assert.equal(s.tabs[0]!.dirty, true);
  s = moveTab(s, "file:c", 99); // clamped to end
  assert.deepEqual(s.tabs.map((t) => t.id), ["file:a", "file:b", "file:c"]);
});

test("pane: cycle wraps in both directions", () => {
  let s = emptyPane as PaneState;
  for (const p of ["a", "b", "c"]) s = openTab(s, file(p));
  s = activateTab(s, "file:c");
  assert.equal(cycleTab(s, 1).activeId, "file:a");
  assert.equal(cycleTab(s, -1).activeId, "file:b");
});

test("pane: persistence round-trip drops dirty flags but keeps order/active", () => {
  let s = emptyPane as PaneState;
  for (const p of ["x.ts", "y.md"]) s = openTab(s, file(p));
  s = markDirty(s, "file:x.ts", true);
  s = activateTab(s, "file:x.ts");
  const restored = deserializePane(serializePane(s), () => true);
  assert.deepEqual(restored.tabs.map((t) => t.id), ["file:x.ts", "file:y.md"]);
  assert.equal(restored.activeId, "file:x.ts");
  assert.equal(restored.tabs.every((t) => !t.dirty), true);
});

test("pane: unavailable providers restore flagged, not dropped", () => {
  const raw = JSON.stringify({
    tabs: [
      { id: "file:a.ts", kind: "file", resource: "a.ts", title: "a.ts" },
      { id: "plugin:gone", kind: "plugin", resource: "gone", title: "Plugin tab" },
      { id: "weird:z", kind: "weird", resource: "z", title: "z" },
    ],
    activeId: "plugin:gone",
  });
  const s = deserializePane(raw, (kind) => kind === "file");
  assert.equal(s.tabs.length, 3);
  assert.equal(s.tabs[0]!.unavailable, undefined);
  assert.equal(s.tabs[1]!.unavailable, true);
  assert.equal(s.tabs[2]!.unavailable, true);
  assert.equal(s.activeId, "plugin:gone");
});

test("pane: corrupt persistence falls back to empty", () => {
  assert.deepEqual(deserializePane("not json{", () => true), emptyPane);
  assert.deepEqual(deserializePane(null, () => true), emptyPane);
  assert.deepEqual(deserializePane(JSON.stringify({ tabs: "nope" }), () => true), emptyPane);
});
