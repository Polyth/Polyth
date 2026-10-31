// The media viewer's touch gestures (AttachmentPreview.tsx), mounted with real
// touch sequences (happy-dom): sideways drags page through the items, a pull
// down dismisses the viewer, and a short pull is put back.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
Object.defineProperty(dom, "matchMedia", {
  configurable: true,
  value: (media: string) => ({ matches: false, media, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
});
Object.defineProperty(dom, "requestAnimationFrame", {
  configurable: true,
  value: (callback: FrameRequestCallback) => setTimeout(() => callback(dom.performance.now()), 4) as unknown as number,
});
Object.defineProperty(dom, "cancelAnimationFrame", { configurable: true, value: (id: number) => clearTimeout(id) });
Object.assign(globalThis, {
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: AttachmentPreview } = await import("../src/components/AttachmentPreview.tsx");

const doc = dom.document as unknown as Document;
const sleep = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
const attachments = ["a", "b", "c"].map((id) => ({
  id, kind: "image", name: `${id}.png`, mime: "image/png", url: `https://x.dev/${id}.png`,
})) as never[];

let stamp = 1000;
function touch(type: "touchstart" | "touchmove" | "touchend", target: Element, point?: { x: number; y: number }, stepMs = 16) {
  const event = new dom.Event(type, { bubbles: true, cancelable: true }) as unknown as TouchEvent;
  const list = point ? [{ identifier: 5, clientX: point.x, clientY: point.y }] : [];
  Object.defineProperty(event, "touches", { value: type === "touchend" ? [] : list });
  Object.defineProperty(event, "changedTouches", { value: [{ identifier: 5, clientX: point?.x ?? 0, clientY: point?.y ?? 0 }] });
  Object.defineProperty(event, "timeStamp", { value: (stamp += stepMs) });
  target.dispatchEvent(event as unknown as Event);
}

async function gesture(from: { x: number; y: number }, to: { x: number; y: number }, { steps = 8, stepMs = 16, releaseMs = 16 } = {}) {
  const slide = () => doc.querySelector(".attachment-preview-slide")!;
  await act(async () => {
    touch("touchstart", slide(), from, stepMs);
    for (let i = 1; i <= steps; i++) {
      touch("touchmove", slide(), { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }, stepMs);
    }
  });
  await act(async () => { touch("touchend", slide(), undefined, releaseMs); });
}

async function mount() {
  let closed = 0;
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(AttachmentPreview, { attachments, start: 0, onClose: () => { closed += 1; } })); });
  return {
    closed: () => closed,
    count: () => doc.querySelector(".attachment-preview-count")?.textContent,
    unmount: async () => {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

test("sideways drags page through the items, the next one riding in from the far edge", async () => {
  const view = await mount();
  try {
    assert.equal(view.count(), "1 / 3");
    await gesture({ x: 700, y: 400 }, { x: 300, y: 402 });
    assert.equal(view.count(), "2 / 3", "toward the inline start brings the next item");
    const slide = doc.querySelector(".attachment-preview-slide")!;
    assert.equal(slide.getAttribute("data-direction"), "next");
    assert.equal(slide.hasAttribute("data-swiped"), true, "it arrives from the edge, not with the button's nudge");
    assert.match(doc.querySelector<HTMLElement>(".attachment-preview-stage")!.style.getPropertyValue("--page-settle"), /^\d+ms$/);
    await gesture({ x: 300, y: 400 }, { x: 700, y: 402 });
    assert.equal(view.count(), "1 / 3", "toward the inline end goes back");
    await act(async () => { doc.querySelector<HTMLButtonElement>(".attachment-preview-nav--next")!.click(); });
    assert.equal(doc.querySelector(".attachment-preview-slide")!.hasAttribute("data-swiped"), false,
      "the arrows keep their own short slide");
    assert.equal(view.closed(), 0);
  } finally {
    await view.unmount();
  }
});

test("a pull down follows the finger and dismisses; a short slow one is put back", async () => {
  const view = await mount();
  try {
    await gesture({ x: 400, y: 300 }, { x: 402, y: 340 }, { steps: 8, stepMs: 60, releaseMs: 300 });
    await sleep(400);
    assert.equal(view.closed(), 0, "a short, slow pull springs back");
    const dialog = doc.querySelector<HTMLElement>(".attachment-preview-dialog")!;
    assert.equal(dialog.style.getPropertyValue("--preview-drag"), "0.0000", "the dim is back");
    assert.equal(dialog.hasAttribute("data-media-dragging"), false);
    assert.equal(view.count(), "1 / 3", "a vertical pull never pages");

    await gesture({ x: 400, y: 300 }, { x: 402, y: 500 });
    assert.equal(view.closed(), 1, "a pull past the threshold dismisses the viewer");
    const slide = doc.querySelector<HTMLElement>(".attachment-preview-slide")!;
    assert.equal(slide.style.getPropertyValue("--sheet-from"), "200px", "its exit starts where the finger let go");
  } finally {
    await view.unmount();
  }
});

test("a zoomed image pans instead of paging; back at rest the swipe pages again", async () => {
  const view = await mount();
  try {
    const img = doc.querySelector<HTMLElement>("img.attachment-preview-media")!;
    const slide = doc.querySelector<HTMLElement>(".attachment-preview-slide")!;
    for (const [key, value] of Object.entries({ offsetParent: slide, offsetLeft: 200, offsetTop: 150, offsetWidth: 400, offsetHeight: 300 })) {
      Object.defineProperty(img, key, { configurable: true, value });
    }
    Object.defineProperty(slide, "clientWidth", { configurable: true, value: 800 });
    Object.defineProperty(slide, "clientHeight", { configurable: true, value: 600 });
    const doubleTap = async () => {
      await act(async () => {
        for (let i = 0; i < 2; i++) {
          for (const type of ["pointerdown", "pointerup"]) {
            img.dispatchEvent(new dom.PointerEvent(type, { pointerId: 3, pointerType: "touch", clientX: 400, clientY: 300, bubbles: true }) as unknown as Event);
          }
        }
      });
    };
    await doubleTap();
    assert.match(img.style.transform, /scale\(2\.5\)/);
    assert.equal(doc.querySelector(".attachment-preview-stage")!.hasAttribute("data-zoomed"), true);
    await gesture({ x: 700, y: 400 }, { x: 300, y: 402 });
    assert.equal(view.count(), "1 / 3", "a drag on a zoomed image never turns the page");
    await gesture({ x: 400, y: 300 }, { x: 402, y: 500 });
    assert.equal(view.closed(), 0, "…nor pulls the viewer closed");

    await doubleTap();
    assert.equal(img.style.transform, "");
    await gesture({ x: 700, y: 400 }, { x: 300, y: 402 });
    assert.equal(view.count(), "2 / 3");
  } finally {
    await view.unmount();
  }
});
