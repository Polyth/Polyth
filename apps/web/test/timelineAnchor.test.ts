// UX-A390 + UX-PANE-MODEL: stable per-session timeline anchors survive reload
// without coupling position to a global raw scrollTop.
import { test } from "node:test";
import assert from "node:assert/strict";

const mem = new Map<string, string>();
(globalThis as { sessionStorage?: unknown }).sessionStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};

const {
  loadTimelineAnchor, parseTimelineAnchor, saveTimelineAnchor,
} = await import("../src/timelineAnchor.ts");

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
