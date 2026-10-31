// Split sessions view: the pure placement rules and the tab-scoped store that
// follows the active chat. Presentation state only — no event, no runtime.
import { test } from "node:test";
import assert from "node:assert/strict";

const mem = new Map<string, string>();
const memStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};
(globalThis as { sessionStorage?: unknown }).sessionStorage = memStorage;
(globalThis as { localStorage?: unknown }).localStorage = memStorage;

const split = await import("../src/sessionSplit.ts");
const store = await import("../src/store.ts");
const {
  clampSplitRatio, companionSessionId, fitSplitRatio, followActiveSession, openSplit,
  parseSessionSplit, pruneSplit, splitFits, splitTransition, swapSplitSides,
  SPLIT_PANE_MIN_PX, SPLIT_RATIO_MAX, SPLIT_RATIO_MIN,
} = split;

test("opening puts the companion at the end and never pairs a chat with itself", () => {
  const opened = openSplit(null, "a", "b");
  assert.deepEqual(opened, { panes: ["a", "b"], focused: 0, ratio: 0.5 });
  assert.equal(companionSessionId(opened), "b");
  assert.equal(openSplit(null, "a", "a"), null);
  // An open split takes a new companion in the companion's place.
  assert.deepEqual(openSplit(opened, "a", "c")?.panes, ["a", "c"]);
});

test("following the active chat moves focus in place, or replaces the focused chat", () => {
  const opened = openSplit(null, "a", "b")!;
  // Choosing the companion: both chats keep their places, focus moves.
  const focusedB = followActiveSession(opened, "b")!;
  assert.deepEqual(focusedB.panes, ["a", "b"]);
  assert.equal(focusedB.focused, 1);
  assert.equal(companionSessionId(focusedB), "a");
  // Choosing another chat shows it in the focused place.
  const replaced = followActiveSession(focusedB, "c")!;
  assert.deepEqual(replaced.panes, ["a", "c"]);
  assert.equal(replaced.focused, 1);
  // A fresh chat in the focused place keeps the companion beside it.
  const fresh = followActiveSession(opened, null)!;
  assert.deepEqual(fresh.panes, [null, "b"]);
  // ...but focusing the companion then would leave an empty place: close.
  assert.equal(followActiveSession(fresh, "b"), null);
  assert.equal(followActiveSession(opened, "a"), opened);
});

test("swapping sides keeps focus with its chat and mirrors the divider", () => {
  const swapped = swapSplitSides({ panes: ["a", "b"], focused: 0, ratio: 0.4 });
  assert.deepEqual(swapped, { panes: ["b", "a"], focused: 1, ratio: 0.6 });
});

test("a removed chat ends the split", () => {
  const opened = openSplit(null, "a", "b")!;
  assert.equal(pruneSplit(opened, new Set(["b"])), null);
  assert.equal(pruneSplit(opened, new Set(["a"])), null);
  assert.equal(pruneSplit(opened, new Set(["z"])), opened);
});

test("ratios clamp, and the divider keeps both panes readable", () => {
  assert.equal(clampSplitRatio(0.01), SPLIT_RATIO_MIN);
  assert.equal(clampSplitRatio(0.99), SPLIT_RATIO_MAX);
  assert.equal(clampSplitRatio(Number.NaN), 0.5);
  assert.equal(splitFits(SPLIT_PANE_MIN_PX * 2 - 1), false);
  assert.equal(splitFits(SPLIT_PANE_MIN_PX * 2), true);
  const width = 900;
  const fitted = fitSplitRatio(SPLIT_RATIO_MIN, width);
  assert.ok(fitted * width >= SPLIT_PANE_MIN_PX - 0.001);
  assert.ok((1 - fitSplitRatio(SPLIT_RATIO_MAX, width)) * width >= SPLIT_PANE_MIN_PX - 0.001);
});

test("stored state is untrusted: malformed or self-paired records are dropped", () => {
  assert.equal(parseSessionSplit(null), null);
  assert.equal(parseSessionSplit("{"), null);
  assert.equal(parseSessionSplit(JSON.stringify({ panes: ["a"] })), null);
  assert.equal(parseSessionSplit(JSON.stringify({ panes: ["a", "a"], focused: 0 })), null);
  // The companion place must hold a chat.
  assert.equal(parseSessionSplit(JSON.stringify({ panes: ["a", null], focused: 0 })), null);
  assert.deepEqual(
    parseSessionSplit(JSON.stringify({ panes: [null, "b"], focused: 0, ratio: 3 })),
    { panes: [null, "b"], focused: 0, ratio: SPLIT_RATIO_MAX },
  );
});

test("motion reads what changed between renders", () => {
  const base = { shown: true, companion: "b", focusedSide: 0 as const, focusedId: "a" };
  assert.equal(splitTransition({ ...base, shown: false }, base), "open");
  assert.equal(splitTransition(base, { ...base, shown: false }), "close");
  assert.equal(splitTransition(base, base), null);
  // Focus moved to the other chat: places unchanged.
  assert.equal(splitTransition(base, { shown: true, companion: "a", focusedSide: 1, focusedId: "b" }), "focus");
  // The same focused chat crossed over: sides swapped.
  assert.equal(splitTransition(base, { shown: true, companion: "b", focusedSide: 1, focusedId: "a" }), "sides");
  assert.equal(splitTransition(base, { ...base, companion: "c" }), "replace");
});

test("the store follows the active chat and remembers the tab's pair", () => {
  store.activateSession("a");
  assert.equal(split.openSessionInSplit("b"), true);
  assert.equal(split.openSessionInSplit("a"), false);
  assert.deepEqual(split.getSessionSplit()?.panes, ["a", "b"]);
  assert.ok(mem.get("polyth.sessionSplit.v1")?.includes("\"b\""));

  store.activateSession("b");
  assert.equal(split.getSessionSplit()?.focused, 1);
  assert.equal(split.splitOtherSessionId(), "a");

  split.swapSessionSplit();
  assert.deepEqual(split.getSessionSplit()?.panes, ["b", "a"]);
  assert.equal(split.getSessionSplit()?.focused, 0);

  split.setSessionSplitRatio(0.6, { remember: true });
  assert.equal(mem.get("polyth.sessionSplit.ratio"), "0.6");

  // Mod+\ closes an open split, then pairs with the previous chat again.
  assert.equal(split.toggleSessionSplit(), true);
  assert.equal(split.getSessionSplit(), null);
  assert.equal(mem.has("polyth.sessionSplit.v1"), false);
  assert.equal(split.toggleSessionSplit(), true);
  assert.deepEqual(split.getSessionSplit()?.panes, ["b", "a"]);
  assert.equal(split.getSessionSplit()?.ratio, 0.6);

  split.dropSplitSession("a");
  assert.equal(split.getSessionSplit(), null);
});

test("a background chat stays cached while a split view shows it", () => {
  const event = (sessionId: string) => ({ sessionId, seq: 1, type: "user/message", ts: 1, data: { text: "hi" } });
  store.applyEvents([event("pinned")] as never, { notifySessionEvents: false });
  const release = store.pinSessionCache("pinned");
  for (let index = 0; index < 20; index += 1) {
    store.applyEvents([event(`other-${index}`)] as never, { notifySessionEvents: false });
    store.touchSessionCache(`other-${index}`);
  }
  assert.ok(store.getState().events.pinned, "the pinned chat survived the LRU");
  assert.equal(store.getState().events["other-0"], undefined, "unpinned chats still age out");
  release();
});
