// Finding 2 (UX-SHELL-CONSOLIDATION-02): desktop sidebar width + collapse
// persist across reloads. DOM-free (localStorage shimmed) — covers parsing,
// clamping, and the write-through round trip the Sidebar drag/collapse uses.
import test from "node:test";
import assert from "node:assert/strict";

const stored = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => stored.get(k) ?? null,
  setItem: (k: string, v: string) => { stored.set(k, v); },
  removeItem: (k: string) => { stored.delete(k); },
};

const {
  SIDEBAR_DEFAULT_WIDTH, SIDEBAR_LAYOUT_KEY, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH,
  clampSidebarWidth, getSidebarLayout, parseSidebarLayout, setSidebarLayout,
} = await import("../src/sidebarLayout.ts");

test("parseSidebarLayout: defaults, clamping, and garbage tolerance", () => {
  assert.deepEqual(parseSidebarLayout(null), { width: SIDEBAR_DEFAULT_WIDTH, collapsed: false });
  assert.deepEqual(parseSidebarLayout("not json"), { width: SIDEBAR_DEFAULT_WIDTH, collapsed: false });
  assert.deepEqual(parseSidebarLayout('{"width":320,"collapsed":true}'), { width: 320, collapsed: true });
  // Out-of-range and non-numeric widths clamp instead of breaking layout.
  assert.equal(parseSidebarLayout('{"width":10}').width, SIDEBAR_MIN_WIDTH);
  assert.equal(parseSidebarLayout('{"width":99999}').width, SIDEBAR_MAX_WIDTH);
  assert.equal(parseSidebarLayout('{"width":"wide"}').width, SIDEBAR_DEFAULT_WIDTH);
  // collapsed must be exactly true — truthy junk stays expanded.
  assert.equal(parseSidebarLayout('{"collapsed":"yes"}').collapsed, false);
});

test("clampSidebarWidth: bounds and rounding", () => {
  assert.equal(clampSidebarWidth(SIDEBAR_MIN_WIDTH - 1), SIDEBAR_MIN_WIDTH);
  assert.equal(clampSidebarWidth(SIDEBAR_MAX_WIDTH + 1), SIDEBAR_MAX_WIDTH);
  assert.equal(clampSidebarWidth(300.6), 301);
  assert.equal(clampSidebarWidth(Number.NaN), SIDEBAR_DEFAULT_WIDTH);
});

test("setSidebarLayout: partial patches persist and clamp through the store", () => {
  setSidebarLayout({ width: 333 });
  assert.deepEqual(getSidebarLayout(), { width: 333, collapsed: false });
  setSidebarLayout({ collapsed: true });
  // The untouched field survives a partial patch.
  assert.deepEqual(getSidebarLayout(), { width: 333, collapsed: true });
  setSidebarLayout({ width: 5 });
  assert.equal(getSidebarLayout().width, SIDEBAR_MIN_WIDTH);
  // The persisted record round-trips through the parser (reload path).
  assert.deepEqual(parseSidebarLayout(stored.get(SIDEBAR_LAYOUT_KEY) ?? null), getSidebarLayout());
});
