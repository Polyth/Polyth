// UX-A390 + UX-PANE-MODEL: stable per-session timeline anchors survive reload
// without coupling position to a global raw scrollTop.
// UX-TIMELINE-LAYOUT-01: capture and restore are relative to the USABLE
// content edge — the helper measures any in-scrollport top chrome so an
// occluded row is never captured or restored behind it.
import { test } from "node:test";
import assert from "node:assert/strict";

const mem = new Map<string, string>();
const memStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};
(globalThis as { sessionStorage?: unknown }).sessionStorage = memStorage;

// usableTopInset reads computed positions; the stub echoes a per-node marker.
(globalThis as { getComputedStyle?: unknown }).getComputedStyle =
  (el: { __position?: string }) => ({ position: el.__position ?? "static" });

const {
  captureTimelineAnchor, loadTimelineAnchor, parseTimelineAnchor,
  restoreScrollDelta, saveTimelineAnchor, usableTopEdge, usableTopInset,
} = await import("../src/timelineAnchor.ts");

// ---- DOM stubs ---------------------------------------------------------------

interface FakeRect { top: number; bottom: number; left: number; right: number; width: number; height: number }
const rect = (top: number, bottom: number, width = 100): FakeRect =>
  ({ top, bottom, left: 0, right: width, width, height: bottom - top });

interface FakeNode {
  __position?: string;
  dataset: { msgId?: string };
  getBoundingClientRect(): FakeRect;
}
const row = (id: string, top: number, bottom: number): FakeNode =>
  ({ dataset: { msgId: id }, getBoundingClientRect: () => rect(top, bottom) });
const chrome = (position: string, top: number, bottom: number, width = 100): FakeNode =>
  ({ __position: position, dataset: {}, getBoundingClientRect: () => rect(top, bottom, width) });

function scroller(opts: { top?: number; children?: FakeNode[]; rows?: FakeNode[] }): HTMLElement {
  const top = opts.top ?? 0;
  return {
    getBoundingClientRect: () => rect(top, top + 400),
    children: opts.children ?? [],
    querySelectorAll: (sel: string) => (sel === "[data-msg-id]" ? (opts.rows ?? []) : []),
  } as unknown as HTMLElement;
}

// ---- parse / save / load (legacy shape unchanged) ------------------------------

test("parseTimelineAnchor survives garbage and rejects unrestorable records", () => {
  assert.equal(parseTimelineAnchor(null), null);
  assert.equal(parseTimelineAnchor("not json"), null);
  assert.equal(parseTimelineAnchor("[]"), null);
  assert.equal(parseTimelineAnchor(JSON.stringify({ id: null, offset: 0, atBottom: false })), null);
  assert.deepEqual(
    parseTimelineAnchor(JSON.stringify({ id: "message-7", offset: -12.5, atBottom: false })),
    { id: "message-7", offset: -12.5, atBottom: false },
  );
  assert.deepEqual(
    parseTimelineAnchor(JSON.stringify({ id: null, offset: 0, atBottom: true })),
    { id: null, offset: 0, atBottom: true },
  );
  // Legacy records with extra fields keep parsing (shape is unchanged).
  assert.deepEqual(
    parseTimelineAnchor(JSON.stringify({ id: "m1", offset: 3, atBottom: false, legacy: true })),
    { id: "m1", offset: 3, atBottom: false },
  );
  assert.equal(parseTimelineAnchor(JSON.stringify({ id: "m1", offset: Infinity, atBottom: false }))?.offset, 0);
});

test("save/load round-trips a stable row anchor and at-bottom state", () => {
  mem.clear();
  saveTimelineAnchor("s1", { id: "message-3", offset: 17.25, atBottom: false });
  assert.deepEqual(loadTimelineAnchor("s1"), { id: "message-3", offset: 17.25, atBottom: false });
  saveTimelineAnchor("s1", { id: null, offset: 0, atBottom: true });
  assert.deepEqual(loadTimelineAnchor("s1"), { id: null, offset: 0, atBottom: true });
  assert.equal(loadTimelineAnchor("unknown"), null);
});

test("anchors remain scoped to their canonical session", () => {
  mem.clear();
  saveTimelineAnchor("s1", { id: "one", offset: 1, atBottom: false });
  saveTimelineAnchor("s2", { id: "two", offset: 2, atBottom: false });
  assert.deepEqual(loadTimelineAnchor("s1"), { id: "one", offset: 1, atBottom: false });
  assert.deepEqual(loadTimelineAnchor("s2"), { id: "two", offset: 2, atBottom: false });
});

test("unavailable storage degrades gracefully: save swallows, load returns null", () => {
  const broken = {
    getItem: () => { throw new Error("denied"); },
    setItem: () => { throw new Error("quota"); },
    removeItem: () => { throw new Error("denied"); },
  };
  (globalThis as { sessionStorage?: unknown }).sessionStorage = broken;
  try {
    assert.doesNotThrow(() => saveTimelineAnchor("s1", { id: "m", offset: 0, atBottom: false }));
    assert.equal(loadTimelineAnchor("s1"), null);
  } finally {
    (globalThis as { sessionStorage?: unknown }).sessionStorage = memStorage;
  }
});

// ---- usable content edge -------------------------------------------------------

test("usableTopInset is zero without in-scrollport top chrome", () => {
  assert.equal(usableTopInset(scroller({ top: 50 })), 0);
  // Normal-flow rows never count, whatever their geometry.
  assert.equal(usableTopInset(scroller({ top: 50, children: [row("m1", 50, 90)] })), 0);
  // Positioned chrome away from the top band (e.g. a bottom live chip) never counts.
  assert.equal(
    usableTopInset(scroller({ top: 50, children: [chrome("sticky", 420, 444)] })),
    0,
  );
  // Zero-size positioned nodes never count.
  assert.equal(
    usableTopInset(scroller({ top: 50, children: [chrome("sticky", 50, 86, 0)] })),
    0,
  );
});

test("usableTopInset measures sticky/fixed/absolute chrome over the top band", () => {
  const el = scroller({
    top: 100,
    children: [chrome("sticky", 100, 136), chrome("absolute", 100, 128)],
  });
  assert.equal(usableTopInset(el), 36);
  assert.equal(usableTopEdge(el), 136);
  assert.equal(usableTopEdge(el, 0), 100);
});

// ---- capture -------------------------------------------------------------------

test("capture: atBottom wins; otherwise the topmost usable-visible row anchors", () => {
  const rows = [row("m1", -80, -10), row("m2", -10, 60), row("m3", 60, 140)];
  const el = scroller({ top: 0, rows });
  assert.deepEqual(captureTimelineAnchor(el, true), { id: null, offset: 0, atBottom: true });
  // m1 ended above the edge; m2 straddles it (negative offset preserved).
  assert.deepEqual(captureTimelineAnchor(el, false), { id: "m2", offset: -10, atBottom: false });
  // A fully visible first row keeps its positive offset.
  const below = scroller({ top: 0, rows: [row("m4", 24, 90)] });
  assert.deepEqual(captureTimelineAnchor(below, false), { id: "m4", offset: 24, atBottom: false });
});

test("capture skips a row that top chrome would occlude", () => {
  // A 36px sticky bar hides m2 (bottom 30 < edge 36); the raw-top capture of
  // the audited defect would have preserved that occluded row.
  const rows = [row("m2", -40, 30), row("m3", 30, 120)];
  const el = scroller({ top: 0, rows, children: [chrome("sticky", 0, 36)] });
  assert.deepEqual(captureTimelineAnchor(el, false), { id: "m3", offset: -6, atBottom: false });
  // With an explicit zero inset the raw behavior is still available to callers.
  assert.deepEqual(captureTimelineAnchor(el, false, 0), { id: "m2", offset: -40, atBottom: false });
});

test("capture returns an unrestorable record when no row qualifies", () => {
  assert.deepEqual(
    captureTimelineAnchor(scroller({ top: 0, rows: [] }), false),
    { id: null, offset: 0, atBottom: false },
  );
});

// ---- restore -------------------------------------------------------------------

test("restoreScrollDelta realigns the row to its remembered usable-edge offset", () => {
  const el = scroller({ top: 100 });
  const at = (top: number) => row("m", top, top + 50) as unknown as Element;
  // Row renders 40px below the edge, anchor wants 12px below: scroll down 28.
  assert.equal(restoreScrollDelta(el, at(140), { id: "m", offset: 12, atBottom: false }), 28);
  // Anchor with a negative (straddling) offset restores exactly too.
  assert.equal(restoreScrollDelta(el, at(90), { id: "m", offset: -10, atBottom: false }), 0);
  // Already aligned → no movement.
  assert.equal(restoreScrollDelta(el, at(112), { id: "m", offset: 12, atBottom: false }), 0);
});

test("restoreScrollDelta honours a top-chrome inset so rows never restore behind it", () => {
  const el = scroller({ top: 100, children: [chrome("sticky", 100, 130)] });
  // Usable edge is 130. A row at 130 with remembered offset 0 is aligned.
  assert.equal(restoreScrollDelta(el, row("m", 130, 180) as unknown as Element, { id: "m", offset: 0, atBottom: false }), 0);
  // Raw-top restoration (inset 0) would have parked it 30px behind the bar.
  assert.equal(restoreScrollDelta(el, row("m", 130, 180) as unknown as Element, { id: "m", offset: 0, atBottom: false }, 0), 30);
});
