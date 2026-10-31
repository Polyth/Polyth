import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import { api } from "@polyth/session/web-api";

const dom = new Window({ url: "http://localhost/" });
const realComputedStyle = dom.getComputedStyle.bind(dom);
let direction: "ltr" | "rtl" = "ltr";
Object.assign(globalThis, {
  window: dom, document: dom.document, location: dom.location, localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node,
  Event: dom.Event, CustomEvent: dom.CustomEvent, KeyboardEvent: dom.KeyboardEvent,
  // happy-dom does not resolve the cascade, so the bookmark's direction is the one thing faked here.
  getComputedStyle: (node: Element) => (node.classList?.contains("prompt-bookmark")
    ? ({ direction } as CSSStyleDeclaration)
    : realComputedStyle(node as unknown as Parameters<typeof realComputedStyle>[0]) as unknown as CSSStyleDeclaration),
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
  cancelAnimationFrame: clearTimeout,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
register("./tsxHooks.mjs", import.meta.url);

// The free area and the control as the stylesheet would lay them out: the toggle sits at
// start + range * fraction, where range is the free area minus the control.
const AREA = { left: 0, top: 100, width: 400, height: 500 };
const SIZE = 44;
const RANGE_X = AREA.width - SIZE;
const RANGE_Y = AREA.height - SIZE;
const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() { return this; } }) as DOMRect;
const captures = new WeakMap<object, number>();
let captureRequests = 0;
Object.assign(dom.HTMLElement.prototype, {
  getBoundingClientRect(this: HTMLElement) {
    if (this.classList.contains("prompt-bookmark")) return rect(AREA.left, AREA.top, AREA.width, AREA.height);
    if (this.classList.contains("prompt-bookmark-toggle")) {
      const area = this.closest(".prompt-bookmark") as HTMLElement;
      const x = Number(area.style.getPropertyValue("--prompt-bookmark-x") || 1);
      const y = Number(area.style.getPropertyValue("--prompt-bookmark-y") || 0);
      return rect(AREA.left + (direction === "rtl" ? 1 - x : x) * RANGE_X, AREA.top + y * RANGE_Y, SIZE, SIZE);
    }
    return rect(0, 0, 0, 0);
  },
  setPointerCapture(id: number) { captureRequests++; captures.set(this, id); },
  hasPointerCapture(id: number) { return captures.get(this) === id; },
  releasePointerCapture() { captures.delete(this); },
});

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const PromptBookmark = (await import("../src/components/PromptBookmark.tsx")).default;
const { accountStorageKey } = await import("../src/accountStorage.ts");
const stored = await import("../src/promptBookmarkPosition.ts");
const { tr } = await import("../src/i18n/index.ts");
after(() => dom.happyDOM.abort());

const RECORD = accountStorageKey(stored.PROMPT_BOOKMARK_POSITION_KEY);
const round = (value: number) => Math.round(value * 1e4) / 1e4;
const toggle = () => document.querySelector<HTMLButtonElement>(".prompt-bookmark-toggle")!;
const area = () => document.querySelector<HTMLElement>(".prompt-bookmark")!;
const vars = () => ({ x: area().style.getPropertyValue("--prompt-bookmark-x"), y: area().style.getPropertyValue("--prompt-bookmark-y") });
const record = () => dom.localStorage.getItem(RECORD);
const expanded = () => toggle().getAttribute("aria-expanded");

async function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(PromptBookmark, {
    sessionId: "s", spaceId: "sp", revision: "v1", prompt: { id: "p1", preview: "Prompt 1" },
    onJump: async () => {}, onCancelJump: () => {},
  })));
  return { cleanup: async () => { await act(async () => root.unmount()); host.remove(); } };
}
const pointer = async (type: string, x: number, y: number, init: Record<string, unknown> = {}) => {
  await act(async () => {
    toggle().dispatchEvent(new dom.PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 1, pointerType: "touch", isPrimary: true, button: 0, clientX: x, clientY: y, ...init,
    }) as unknown as Event);
  });
};
const click = async (detail = 1) => {
  await act(async () => { toggle().dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true, detail }) as unknown as Event); });
};
const key = async (name: string, init: Record<string, unknown> = { shiftKey: true }) => {
  let prevented = false;
  await act(async () => {
    const event = new dom.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init });
    toggle().dispatchEvent(event as unknown as Event);
    prevented = event.defaultPrevented;
  });
  return prevented;
};
/** Press on the control at its current spot, 14px/16px inside it, then drag to (x, y). */
const dragTo = async (x: number, y: number, release = "pointerup") => {
  const at = toggle().getBoundingClientRect();
  await pointer("pointerdown", at.left + 14, at.top + 16);
  await pointer("pointermove", x, y);
  if (release) await pointer(release, x, y);
};

beforeEach(() => {
  dom.localStorage.clear();
  stored.writePromptBookmarkPosition(null);
  direction = "ltr";
  captureRequests = 0;
  api.sessionPrompts = async () => ({ prompts: [], beforeSeq: null });
});

test("the bookmark starts at its original place and describes how to move it", async () => {
  const t = await mount();
  try {
    assert.deepEqual(vars(), { x: "1", y: "0" }, "inline-end edge, top of the free area");
    assert.equal(area().hasAttribute("data-dragging"), false);
    const hint = document.getElementById(toggle().getAttribute("aria-describedby")!);
    assert.equal(hint?.textContent, tr("timeline.promptBookmarkMoveHint"), "the way to move it is part of its accessible description");
    assert.match(hint!.textContent!, /Shift/);
    assert.equal(toggle().getAttribute("aria-label"), "Prompt navigation", "the name itself is unchanged");
  } finally { await t.cleanup(); }
});

test("dragging follows the pointer, stays within the free area and is remembered on release", async () => {
  const t = await mount();
  try {
    await pointer("pointerdown", 370, 116);
    await pointer("pointermove", 200, 300);
    const x = round((200 - 14 - AREA.left) / RANGE_X);
    const y = round((300 - 16 - AREA.top) / RANGE_Y);
    assert.deepEqual(vars(), { x: String(x), y: String(y) }, "the control keeps the grab point under the pointer");
    assert.equal(area().getAttribute("data-dragging"), "true");
    assert.equal(record(), null, "nothing is written until the drag ends");
    await pointer("pointerup", 200, 300);
    assert.equal(area().hasAttribute("data-dragging"), false);
    assert.deepEqual(JSON.parse(record()!), { v: 1, x, y });
    assert.deepEqual(vars(), { x: String(x), y: String(y) }, "the saved placement is what is rendered");
    assert.equal(expanded(), "false", "a drag never opens the history");

    await dragTo(-500, 5000);
    assert.deepEqual(JSON.parse(record()!), { v: 1, x: 0, y: 1 }, "the free area is a hard boundary");
    await dragTo(9000, -9000);
    assert.equal(record(), null, "dragging back to the original corner leaves no record behind");
    assert.deepEqual(vars(), { x: "1", y: "0" });
  } finally { await t.cleanup(); }
});

test("a short press is still a tap, and the click that ends a drag is swallowed exactly once", async () => {
  const t = await mount();
  try {
    await pointer("pointerdown", 370, 116);
    await pointer("pointermove", 372, 118);
    await pointer("pointerup", 372, 118);
    await click();
    assert.equal(expanded(), "true", "movement below the threshold opens the history");
    assert.equal(record(), null, "and moves nothing");
    await click();
    assert.equal(expanded(), "false");

    await dragTo(100, 200);
    await click(1);
    assert.equal(expanded(), "false", "the click after a mouse drag must not open the history");
    await click(1);
    assert.equal(expanded(), "true", "only that one click is swallowed");
    await click(0);

    await dragTo(120, 220);
    await click(0);
    assert.equal(expanded(), "true", "keyboard and assistive activation after a drag is never swallowed");
  } finally { await t.cleanup(); }
});

test("a new press forgets an unconsumed drag click", async () => {
  const t = await mount();
  try {
    await dragTo(100, 200);
    await pointer("pointerdown", 100, 200);
    await pointer("pointerup", 100, 200);
    await click(1);
    assert.equal(expanded(), "true", "touch drags produce no click, so the next real tap must work");
  } finally { await t.cleanup(); }
});

test("capture is only requested once a press becomes a drag, and a cancelled gesture keeps its last position", async () => {
  const t = await mount();
  try {
    await pointer("pointerdown", 370, 116);
    assert.equal(captureRequests, 0, "a plain tap never depends on pointer capture");
    await pointer("pointermove", 371, 117);
    assert.equal(captureRequests, 0);
    await pointer("pointermove", 300, 250);
    assert.equal(captureRequests, 1);
    await pointer("pointermove", 280, 260);
    assert.equal(captureRequests, 1, "captured once per drag");
    await pointer("pointercancel", 280, 260);
    assert.equal(area().hasAttribute("data-dragging"), false, "a browser-cancelled gesture never leaves the drag state stuck");
    assert.deepEqual(JSON.parse(record()!), { v: 1, x: round((280 - 14) / RANGE_X), y: round((260 - 16 - AREA.top) / RANGE_Y) });
    assert.equal(captures.has(toggle()), false, "capture is released");
  } finally { await t.cleanup(); }
});

test("only the primary button of the primary pointer starts a drag, and never while the history is open", async () => {
  const t = await mount();
  try {
    await pointer("pointerdown", 370, 116, { button: 2 });
    await pointer("pointermove", 100, 300, { button: 2 });
    await pointer("pointerup", 100, 300, { button: 2 });
    await pointer("pointerdown", 370, 116, { pointerId: 2, isPrimary: false });
    await pointer("pointermove", 100, 300, { pointerId: 2, isPrimary: false });
    await pointer("pointerup", 100, 300, { pointerId: 2, isPrimary: false });
    assert.equal(record(), null);
    assert.deepEqual(vars(), { x: "1", y: "0" });

    await click(0);
    assert.equal(expanded(), "true");
    await pointer("pointerdown", 370, 116);
    await pointer("pointermove", 100, 300);
    await pointer("pointerup", 100, 300);
    assert.equal(record(), null, "an open history owns the pointer");
  } finally { await t.cleanup(); }
});

test("a right-to-left layout mirrors the horizontal axis and stores the same logical placement", async () => {
  direction = "rtl";
  const t = await mount();
  try {
    assert.equal(toggle().getBoundingClientRect().left, AREA.left, "home (inline-end) is the physical left edge");
    await pointer("pointerdown", 10, 116);
    await pointer("pointermove", 210, 300);
    await pointer("pointerup", 210, 300);
    assert.deepEqual(JSON.parse(record()!), {
      v: 1,
      x: round(1 - (210 - 10 - AREA.left) / RANGE_X),
      y: round((300 - 16 - AREA.top) / RANGE_Y),
    });
  } finally { await t.cleanup(); }
});

test("Shift with an arrow key nudges the bookmark, Shift+Home resets it, and nothing else is hijacked", async () => {
  stored.writePromptBookmarkPosition({ x: 0.5, y: 0.5 });
  const t = await mount();
  try {
    const left = 0.5 * RANGE_X;
    const top = 0.5 * RANGE_Y;
    assert.equal(await key("ArrowLeft"), true);
    assert.deepEqual(JSON.parse(record()!), { v: 1, x: round((left - 16) / RANGE_X), y: 0.5 });
    assert.equal(await key("ArrowDown"), true);
    assert.deepEqual(JSON.parse(record()!), { v: 1, x: round((left - 16) / RANGE_X), y: round((top + 16) / RANGE_Y) });
    await key("ArrowRight");
    await key("ArrowUp");
    assert.deepEqual(JSON.parse(record()!), { v: 1, x: 0.5, y: 0.5 }, "opposite nudges cancel");

    const before = record();
    for (const init of [{}, { shiftKey: true, ctrlKey: true }, { shiftKey: true, metaKey: true }, { shiftKey: true, altKey: true }]) {
      assert.equal(await key("ArrowLeft", init), false, `ArrowLeft ${JSON.stringify(init)} keeps its normal meaning`);
    }
    assert.equal(await key("Enter"), false);
    assert.equal(record(), before);

    assert.equal(await key("Home"), true);
    assert.equal(record(), null, "Shift+Home returns to the original place");
    assert.deepEqual(vars(), { x: "1", y: "0" });
  } finally { await t.cleanup(); }
});

test("keyboard nudges clamp at the edges and mirror in right-to-left layouts", async () => {
  direction = "rtl";
  stored.writePromptBookmarkPosition({ x: 0.5, y: 0.5 });
  const t = await mount();
  try {
    await key("ArrowLeft");
    assert.equal(JSON.parse(record()!).x, round(0.5 + 16 / RANGE_X), "physical left is toward the inline end in RTL");
    for (let i = 0; i < 40; i++) await key("ArrowRight");
    assert.equal(JSON.parse(record()!).x, 0, "pressing past the edge stays on it");
    for (let i = 0; i < 60; i++) await key("ArrowDown");
    assert.equal(JSON.parse(record()!).y, 1);
  } finally { await t.cleanup(); }
});

test("the placement is shared through the store: Settings can reset it and another tab can move it", async () => {
  const first = await mount();
  const second = await mount();
  try {
    const marks = [...document.querySelectorAll<HTMLElement>(".prompt-bookmark")];
    assert.equal(marks.length, 2);
    await act(async () => stored.writePromptBookmarkPosition({ x: 0.2, y: 0.3 }));
    assert.deepEqual(marks.map((m) => m.style.getPropertyValue("--prompt-bookmark-x")), ["0.2", "0.2"]);
    assert.deepEqual(marks.map((m) => m.style.getPropertyValue("--prompt-bookmark-y")), ["0.3", "0.3"]);
    await act(async () => stored.writePromptBookmarkPosition(null));
    assert.deepEqual(marks.map((m) => m.style.getPropertyValue("--prompt-bookmark-x")), ["1", "1"]);

    dom.localStorage.setItem(RECORD, JSON.stringify({ v: 1, x: 0.7, y: 0.8 }));
    await act(async () => { dom.dispatchEvent(Object.assign(new dom.Event("storage"), { key: RECORD })); });
    assert.deepEqual(marks.map((m) => m.style.getPropertyValue("--prompt-bookmark-y")), ["0.8", "0.8"]);
  } finally {
    await second.cleanup();
    await first.cleanup();
  }
});

test("a saved placement is restored on the next mount, and a corrupt record falls back home", async () => {
  const first = await mount();
  await dragTo(100, 250);
  const saved = JSON.parse(record()!);
  await first.cleanup();

  const again = await mount();
  try {
    assert.deepEqual(vars(), { x: String(saved.x), y: String(saved.y) });
  } finally { await again.cleanup(); }

  dom.localStorage.setItem(RECORD, "{broken");
  const corrupt = await mount();
  try {
    assert.deepEqual(vars(), { x: "1", y: "0" });
  } finally { await corrupt.cleanup(); }
});
