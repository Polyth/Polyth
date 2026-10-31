// Touch selection dock: a finger selection in the transcript summons the
// bottom dock (not the desktop toolbar), its preview follows the selection,
// actions quote/copy and then clear the selection, a tap that collapses the
// selection under the dock does not swallow the action, and a swipe down
// dismisses. Mounts the real SelectionMenu router in happy-dom.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { Project } from "@polyth/contracts";

const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  Event: dom.Event,
  CustomEvent: (dom as unknown as { CustomEvent: typeof CustomEvent }).CustomEvent,
  Node: (dom as unknown as { Node: typeof Node }).Node,
  isSecureContext: true,
});
const clipboardWrites: string[] = [];
Object.defineProperty(dom.navigator, "clipboard", {
  configurable: true,
  value: { writeText: async (text: string) => { clipboardWrites.push(text); } },
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
Object.defineProperty(globalThis, "location", { value: dom.location, configurable: true });
Object.defineProperty(globalThis, "HTMLElement", {
  value: (dom as unknown as { HTMLElement: typeof HTMLElement }).HTMLElement,
  configurable: true,
});
Object.defineProperty(globalThis, "requestAnimationFrame", {
  value: (callback: FrameRequestCallback) => { callback(0); return 0; },
  configurable: true,
});
Object.defineProperty(globalThis, "cancelAnimationFrame", { value: () => {}, configurable: true });
// Wide shell: only the pointer type can pick the dock in these tests.
Object.defineProperty(dom, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }),
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { fetch?: unknown }).fetch = async () => ({
  ok: true, status: 200, statusText: "OK", json: async () => [], text: async () => "[]",
});

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement, useRef } = await import("react");
const { createRoot } = await import("react-dom/client");
const store = await import("../src/store.ts");
const { COMPOSER_INSERT } = await import("../src/composerInsert.ts");
const { default: SelectionMenu } = await import("../src/components/SelectionMenu.tsx");

const EventCtor = (dom as unknown as { Event: typeof Event }).Event;
const MouseEventCtor = (dom as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
const sleep = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
/** Past the 140ms settle; past the 240ms exit plus its frame tail. */
const PAST_SETTLE_MS = 220;
const PAST_EXIT_MS = 400;

function pointer(type: string, target: EventTarget, init: { pointerType: string; clientX?: number; clientY?: number; pointerId?: number }) {
  const event = new MouseEventCtor(type, { bubbles: true, cancelable: true, clientX: init.clientX ?? 0, clientY: init.clientY ?? 0 });
  Object.defineProperty(event, "pointerType", { value: init.pointerType });
  Object.defineProperty(event, "pointerId", { value: init.pointerId ?? 1 });
  target.dispatchEvent(event);
}

function Harness() {
  const ref = useRef<HTMLDivElement>(null);
  return createElement("div", null,
    createElement("div", { ref, className: "timeline" },
      createElement("p", { id: "line" }, "Polyth keeps one canonical history for every session.")),
    createElement(SelectionMenu, { container: ref }));
}

function select(start: number, end: number) {
  const text = document.getElementById("line")!.firstChild!;
  const range = document.createRange();
  range.setStart(text, start);
  range.setEnd(text, end);
  const sel = document.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  document.dispatchEvent(new EventCtor("selectionchange"));
}

/** A handle drag moves one end of the live range; it never collapses it. */
function extend(end: number) {
  const sel = document.getSelection()!;
  sel.getRangeAt(0).setEnd(document.getElementById("line")!.firstChild!, end);
  document.dispatchEvent(new EventCtor("selectionchange"));
}

function collapse() {
  document.getSelection()!.removeAllRanges();
  document.dispatchEvent(new EventCtor("selectionchange"));
}

const dock = () => document.querySelector<HTMLElement>(".selection-dock");
const action = (label: string) => [...document.querySelectorAll<HTMLButtonElement>(".selection-dock-action")]
  .find((b) => b.textContent === label);

async function mount() {
  const ticket = store.beginProjectListRequest();
  store.publishProjectList(ticket, [{ id: "alpha", path: "/work/alpha", name: "alpha", createdAt: 1 } satisfies Project]);
  store.activateProject("alpha");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(createElement(Harness)); });
  return {
    async unmount() {
      await act(async () => { collapse(); });
      await act(async () => { root.unmount(); });
      host.remove();
    },
  };
}

test("a touch selection summons the bottom dock with a live preview, never the floating toolbar", async () => {
  const view = await mount();
  try {
    await act(async () => { pointer("pointerdown", document.getElementById("line")!, { pointerType: "touch" }); });
    await act(async () => { select(0, 6); });
    assert.equal(dock(), null, "the dock waits for the long-press selection to settle");
    await sleep(PAST_SETTLE_MS);
    const card = dock();
    assert.ok(card, "dock mounted");
    assert.equal(card.parentElement?.className, "selection-dock-frame");
    assert.equal(card.parentElement?.parentElement, document.body, "portaled out of the timeline");
    assert.equal(card.dataset.phase, "open");
    assert.equal(document.querySelector(".selection-menu"), null, "no floating toolbar on touch");
    assert.equal(card.querySelector(".selection-dock-preview-text")?.textContent, "Polyth");
    assert.deepEqual(
      [...card.querySelectorAll(".selection-dock-action-label")].map((n) => n.textContent),
      ["Quote", "New session", "Copy"],
      "Share appears only where the platform has a share sheet",
    );

    // Dragging a handle extends the selection: the preview follows in place.
    await act(async () => { extend(23); });
    assert.equal(card.querySelector(".selection-dock-preview-text")?.textContent, "Polyth keeps one canoni");
    assert.equal(dock(), card, "same card, no remount while the handles move");
  } finally {
    await view.unmount();
  }
});

test("Quote inserts a markdown quote, clears the selection, and the dock exits before unmounting", async () => {
  const view = await mount();
  const inserts: string[] = [];
  const onInsert = (e: Event) => { inserts.push(String((e as CustomEvent).detail)); };
  window.addEventListener(COMPOSER_INSERT, onInsert);
  try {
    await act(async () => { pointer("pointerdown", document.getElementById("line")!, { pointerType: "touch" }); });
    await act(async () => { select(0, 6); });
    await sleep(PAST_SETTLE_MS);
    await act(async () => { action("Quote")!.click(); });
    assert.deepEqual(inserts, ["> Polyth\n\n"]);
    assert.equal(document.getSelection()!.isCollapsed, true, "selection cleared");
    assert.equal(dock()?.dataset.phase, "closing", "presentation-only exit frame");
    await sleep(PAST_EXIT_MS);
    assert.equal(dock(), null);
  } finally {
    window.removeEventListener(COMPOSER_INSERT, onInsert);
    await view.unmount();
  }
});

test("a tap that collapses the selection under the dock still runs Copy, then the dock leaves", async () => {
  const view = await mount();
  clipboardWrites.length = 0;
  try {
    await act(async () => { pointer("pointerdown", document.getElementById("line")!, { pointerType: "touch" }); });
    await act(async () => { select(7, 12); });
    await sleep(PAST_SETTLE_MS);
    const copy = action("Copy")!;
    await act(async () => { pointer("pointerdown", copy, { pointerType: "touch" }); });
    // Some engines collapse the selection on the tap, before its click.
    await act(async () => { collapse(); });
    assert.equal(dock()?.dataset.phase, "open", "a finger on the dock holds it open");
    await act(async () => { pointer("pointerup", copy, { pointerType: "touch" }); });
    await act(async () => { copy.click(); });
    await sleep(20);
    assert.deepEqual(clipboardWrites, ["keeps"]);
    assert.equal(copy.dataset.state, "done");
    assert.equal(copy.textContent, "Copied");
    await sleep(500);
    assert.equal(dock()?.dataset.phase, "open", "the outcome stays readable through the hold release");
    await sleep(900);
    assert.equal(dock(), null);
  } finally {
    await view.unmount();
  }
});

test("swiping the dock down dismisses it and clears the selection; a short drag springs back", async () => {
  const view = await mount();
  try {
    await act(async () => { pointer("pointerdown", document.getElementById("line")!, { pointerType: "touch" }); });
    await act(async () => { select(0, 6); });
    await sleep(PAST_SETTLE_MS);
    const card = dock()!;
    await act(async () => { pointer("pointerdown", card, { pointerType: "touch", clientY: 600 }); });
    await act(async () => { pointer("pointermove", card, { pointerType: "touch", clientY: 610 }); });
    assert.equal(card.dataset.dragging, "true");
    assert.equal(card.style.getPropertyValue("--selection-dock-drag"), "10px");
    // Upward drags resist instead of lifting the dock off the bottom edge.
    await act(async () => { pointer("pointermove", card, { pointerType: "touch", clientY: 500 }); });
    assert.ok(Number.parseFloat(card.style.getPropertyValue("--selection-dock-drag")) >= -18);
    await act(async () => { pointer("pointerup", card, { pointerType: "touch", clientY: 500 }); });
    assert.equal(card.style.getPropertyValue("--selection-dock-drag"), "0px", "springs back");
    assert.equal(card.dataset.phase, "open");
    await sleep(400);

    await act(async () => { pointer("pointerdown", card, { pointerType: "touch", clientY: 600 }); });
    await act(async () => { pointer("pointermove", card, { pointerType: "touch", clientY: 640 }); });
    await act(async () => { pointer("pointermove", card, { pointerType: "touch", clientY: 760 }); });
    await act(async () => { pointer("pointerup", card, { pointerType: "touch", clientY: 760 }); });
    assert.equal(card.dataset.phase, "closing");
    assert.equal(card.dataset.exit, "drag");
    assert.equal(document.getSelection()!.isCollapsed, true);
    await sleep(PAST_EXIT_MS);
    assert.equal(dock(), null);
  } finally {
    await view.unmount();
  }
});

test("a mouse selection keeps the desktop floating toolbar", async () => {
  const view = await mount();
  try {
    await act(async () => { pointer("pointerdown", document.getElementById("line")!, { pointerType: "mouse" }); });
    await act(async () => { select(0, 6); });
    await act(async () => {
      document.dispatchEvent(new MouseEventCtor("mouseup", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await sleep(PAST_SETTLE_MS);
    assert.equal(dock(), null);
    assert.ok(document.querySelector(".selection-menu"));
  } finally {
    await view.unmount();
  }
});
