// Drag-to-dismiss for phone sheets (sheetDrag.ts), driven with real touch
// sequences (happy-dom): which touches pull the sheet, that it follows the
// finger without a jump, how a release is decided and what it hands the exit.
import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(dom, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }),
});
Object.defineProperty(dom, "requestAnimationFrame", {
  configurable: true,
  value: (callback: FrameRequestCallback) => setTimeout(() => callback(dom.performance.now()), 4) as unknown as number,
});
Object.defineProperty(dom, "cancelAnimationFrame", { configurable: true, value: (id: number) => clearTimeout(id) });

const { attachSheetDrag, sheetDragDismisses, SHEET_DISMISS_DISTANCE } = await import("../src/sheetDrag.ts");

const doc = dom.document as unknown as Document;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const HEIGHT = 600;

function page(origin: "bottom" | "top" = "bottom") {
  doc.body.innerHTML = `
    <div class="sheet-backdrop">
      <div class="sheet" id="sheet">
        <div class="sheet-grabber" id="grabber"><i></i></div>
        <div class="sheet-head" id="head"><h2>Title</h2><button id="action">Edit</button></div>
        <div class="sheet-body" id="body" style="overflow-y: auto">
          <div id="row">Row</div>
          <input id="field" />
          <div id="handle" style="touch-action: none">grip</div>
        </div>
      </div>
    </div>`;
  const sheet = doc.getElementById("sheet")!;
  sheet.getBoundingClientRect = () => ({ height: HEIGHT, width: 390, top: 0, left: 0, right: 390, bottom: HEIGHT, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  const body = doc.getElementById("body")!;
  Object.defineProperty(body, "scrollHeight", { configurable: true, value: 2000 });
  Object.defineProperty(body, "clientHeight", { configurable: true, value: 400 });
  let scrollTop = 0;
  Object.defineProperty(body, "scrollTop", { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = value; } });
  const state = { dismissed: 0, enabled: true, progress: [] as number[] };
  const detach = attachSheetDrag({
    sheet: () => doc.getElementById("sheet"),
    origin: () => origin,
    enabled: () => state.enabled,
    onDismiss: () => { state.dismissed += 1; },
    onProgress: (value) => { state.progress.push(value); },
  }, doc);
  return { sheet, body, state, detach, scroll: (value: number) => { scrollTop = value; } };
}

let stamp = 1000;
function touch(type: "touchstart" | "touchmove" | "touchend", target: Element, point?: { x: number; y: number }, stepMs = 16) {
  const event = new dom.Event(type, { bubbles: true, cancelable: true }) as unknown as TouchEvent;
  const list = point ? [{ identifier: 4, clientX: point.x, clientY: point.y }] : [];
  Object.defineProperty(event, "touches", { value: type === "touchend" ? [] : list });
  Object.defineProperty(event, "changedTouches", { value: [{ identifier: 4, clientX: point?.x ?? 0, clientY: point?.y ?? 0 }] });
  Object.defineProperty(event, "timeStamp", { value: (stamp += stepMs) });
  target.dispatchEvent(event as unknown as Event);
  return event;
}

function drag(target: Element, fromY: number, toY: number, { x = 200, steps = 8, stepMs = 16 } = {}) {
  touch("touchstart", target, { x, y: fromY }, stepMs);
  const moves: TouchEvent[] = [];
  for (let i = 1; i <= steps; i++) moves.push(touch("touchmove", target, { x: x + 1, y: fromY + ((toY - fromY) * i) / steps }, stepMs));
  return moves;
}

const offset = (sheet: HTMLElement) => {
  const match = /translate3d\(0, (-?[\d.]+)px, 0\)/.exec(sheet.style.transform);
  return match ? Number(match[1]) : 0;
};

test("the grabber pulls the sheet down, following the finger without a jump", () => {
  const { sheet, state, detach } = page();
  try {
    const seen: number[] = [];
    touch("touchstart", doc.getElementById("grabber")!, { x: 200, y: 20 });
    for (let y = 26; y <= 140; y += 6) {
      touch("touchmove", doc.getElementById("grabber")!, { x: 200, y });
      seen.push(offset(sheet));
    }
    assert.equal(seen[0], 0, "below the slop nothing moves");
    for (let i = 1; i < seen.length; i++) assert.ok(seen[i]! - seen[i - 1]! <= 12.001, `no jump: ${seen.join(", ")}`);
    assert.equal(seen.at(-1), 120, "caught up: exactly the finger's travel");
    assert.equal(sheet.getAttribute("data-dragging"), "true");
    assert.ok(state.progress.at(-1)! > 0.19 && state.progress.at(-1)! < 0.21, "progress is the share of the sheet's height");
    touch("touchend", doc.getElementById("grabber")!, undefined, 16);
    assert.equal(state.dismissed, 1, "a release past the threshold dismisses");
    assert.equal(sheet.style.getPropertyValue("--sheet-from"), "120px", "the exit starts where the finger let go");
    assert.ok(Number.parseFloat(sheet.style.getPropertyValue("--sheet-settle")) > 0, "…and takes the rest of the travel time");
    assert.equal(sheet.hasAttribute("data-drag-dismissed"), true);
    assert.equal(sheet.hasAttribute("data-dragging"), false);
  } finally {
    detach();
  }
});

test("a slow, short pull springs back and dismisses nothing", async () => {
  const { sheet, state, detach } = page();
  try {
    drag(doc.getElementById("head")!, 40, 100, { steps: 6, stepMs: 60 });
    assert.ok(offset(sheet) > 0);
    touch("touchend", doc.getElementById("head")!, undefined, 300);
    await sleep(400);
    assert.equal(state.dismissed, 0);
    assert.equal(sheet.style.transform, "", "home again");
    assert.equal(state.progress.at(-1), 0);
    assert.equal(sheet.hasAttribute("data-dragging"), false);
  } finally {
    detach();
  }
});

test("the body pulls the sheet only from the top of its scroll, never from fields or handles", () => {
  const { sheet, state, detach, scroll } = page();
  try {
    scroll(120);
    const moves = drag(doc.getElementById("row")!, 200, 320);
    assert.equal(offset(sheet), 0, "scrolled content keeps the touch");
    assert.equal(moves.at(-1)!.defaultPrevented, false, "…and the browser scrolls it");
    touch("touchend", doc.getElementById("row")!);

    for (const id of ["field", "handle"]) {
      scroll(0);
      drag(doc.getElementById(id)!, 200, 320);
      assert.equal(offset(sheet), 0, `${id} keeps the touch`);
      touch("touchend", doc.getElementById(id)!);
    }

    scroll(0);
    const pulled = drag(doc.getElementById("row")!, 200, 320);
    assert.ok(offset(sheet) > 0, "at the top, pulling down moves the sheet");
    assert.equal(pulled.at(-1)!.defaultPrevented, true, "the browser does not also bounce the list");
    touch("touchend", doc.getElementById("row")!);
    assert.equal(state.dismissed, 1);
  } finally {
    detach();
  }
});

test("up, sideways and disabled touches are not drags", () => {
  const { sheet, state, detach } = page();
  try {
    drag(doc.getElementById("grabber")!, 200, 120);
    touch("touchend", doc.getElementById("grabber")!);
    drag(doc.getElementById("grabber")!, 200, 200);
    touch("touchmove", doc.getElementById("grabber")!, { x: 320, y: 204 });
    touch("touchend", doc.getElementById("grabber")!);
    state.enabled = false;
    drag(doc.getElementById("grabber")!, 20, 200);
    touch("touchend", doc.getElementById("grabber")!);
    assert.equal(offset(sheet), 0);
    assert.equal(state.dismissed, 0);
  } finally {
    detach();
  }
});

test("a top sheet is pushed up, and the threshold follows the sheet's size", () => {
  const { sheet, state, detach } = page("top");
  try {
    drag(doc.getElementById("grabber")!, 300, 180);
    assert.ok(offset(sheet) < 0, "it travels up");
    touch("touchend", doc.getElementById("grabber")!);
    assert.equal(state.dismissed, 1);
    assert.equal(sheet.style.getPropertyValue("--sheet-from"), "-120px");
  } finally {
    detach();
  }
  assert.equal(sheetDragDismisses({ travel: SHEET_DISMISS_DISTANCE, height: 800, velocity: 0 }), true);
  assert.equal(sheetDragDismisses({ travel: 60, height: 160, velocity: 0 }), true, "a short sheet needs a third of itself");
  assert.equal(sheetDragDismisses({ travel: 40, height: 800, velocity: 0.6 }), true, "a flick");
  assert.equal(sheetDragDismisses({ travel: 200, height: 800, velocity: -0.6 }), false, "flung back home");
  assert.equal(sheetDragDismisses({ travel: 20, height: 800, velocity: 2 }), false, "a twitch is not a flick");
});
