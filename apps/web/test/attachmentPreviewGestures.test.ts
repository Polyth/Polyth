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

test("a mouse click zooms into the point, a second click returns, and the wheel zooms", async () => {
  const view = await mount();
  try {
    const img = doc.querySelector<HTMLElement>("img.attachment-preview-media")!;
    const slide = doc.querySelector<HTMLElement>(".attachment-preview-slide")!;
    for (const [key, value] of Object.entries({ offsetParent: slide, offsetLeft: 200, offsetTop: 150, offsetWidth: 400, offsetHeight: 300 })) {
      Object.defineProperty(img, key, { configurable: true, value });
    }
    Object.defineProperty(slide, "clientWidth", { configurable: true, value: 800 });
    Object.defineProperty(slide, "clientHeight", { configurable: true, value: 600 });

    let at = 5000;
    const mouse = async (type: "pointerdown" | "pointerup" | "click", ms = 0) => {
      at += ms;
      await act(async () => {
        const event = new dom.PointerEvent(type === "click" ? "click" : type, { pointerId: 7, pointerType: "mouse", button: 0, clientX: 400, clientY: 300, bubbles: true }) as unknown as Event;
        Object.defineProperty(event, "timeStamp", { value: at });
        img.dispatchEvent(event);
      });
    };
    const tap = async (gapMs = 0) => {
      await mouse("pointerdown", gapMs);
      await mouse("pointerup");
    };

    await tap();
    assert.match(img.style.transform, /scale\(2\.5\)/, "one click enlarges the picture");

    await tap(500);
    assert.equal(img.style.transform, "", "a later click returns to rest");

    // A double click is two clicks: the second one must not undo the first.
    await tap(500);
    await tap(60);
    await act(async () => { img.dispatchEvent(new dom.MouseEvent("dblclick", { bubbles: true, clientX: 400, clientY: 300 }) as unknown as Event); });
    assert.match(img.style.transform, /scale\(2\.5\)/, "a double click stays zoomed");

    const wheel = async (deltaY: number) => {
      await act(async () => {
        const event = new dom.WheelEvent("wheel", { deltaY, bubbles: true, cancelable: true }) as unknown as Event;
        Object.defineProperties(event, { clientX: { value: 400 }, clientY: { value: 300 } });
        img.dispatchEvent(event);
      });
    };
    await wheel(400);
    await wheel(400);
    assert.equal(img.style.transform, "", "a wheel zoom-out returns to rest");
    await wheel(-400);
    assert.match(img.style.transform, /scale\(2\./, "a wheel zoom-in enlarges the picture");

    await act(async () => { doc.querySelector<HTMLButtonElement>('[aria-label="Reset zoom"]')!.click(); });
    assert.equal(img.style.transform, "", "the reset control returns to rest");
  } finally {
    await view.unmount();
  }
});

// The package seams (host.ui.components.MediaViewer): a controlled position,
// a package overlay over exactly the image, an aside, a controls row, and
// gestures a package can suspend while the person draws on its overlay.
test("a package viewer keeps its own position, overlay, aside and controls", async () => {
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  const root = createRoot(container);
  const picked: number[] = [];
  const render = (props: Record<string, unknown>) => act(async () => {
    root.render(createElement(AttachmentPreview, {
      attachments,
      start: 0,
      onClose: () => {},
      onIndexChange: (index: number) => { picked.push(index); },
      renderOverlay: (attachment: { id: string }) => createElement("span", { className: "probe-overlay" }, attachment.id),
      aside: createElement("textarea", { className: "probe-note" }),
      asideLabel: "Notes",
      actions: createElement("div", { className: "probe-tools" }, "tools"),
      ...props,
    }));
  });
  const box = Object.getOwnPropertyDescriptors(dom.HTMLElement.prototype);
  Object.defineProperty(dom.HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
  Object.defineProperty(dom.HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 500 });
  const count = () => doc.querySelector(".attachment-preview-count")?.textContent;
  try {
    await render({ index: 1 });
    assert.equal(count(), "2 / 3", "the controlled index picks the first item");
    assert.equal(doc.querySelector(".attachment-preview-aside")?.getAttribute("aria-label"), "Notes");
    assert.ok(doc.querySelector(".attachment-preview-actions .probe-tools"), "package controls sit in the controls row");

    const image = doc.querySelector<HTMLImageElement>(".attachment-preview-frame .attachment-preview-frame-image")!;
    assert.ok(image, "an overlay viewer draws the image inside a zoomable frame");
    Object.defineProperty(image, "naturalWidth", { configurable: true, value: 2000 });
    Object.defineProperty(image, "naturalHeight", { configurable: true, value: 500 });
    await act(async () => { image.dispatchEvent(new dom.Event("load") as unknown as Event); });
    const frame = doc.querySelector<HTMLElement>(".attachment-preview-frame")!;
    assert.equal(frame.hasAttribute("data-measured"), true);
    assert.equal(frame.style.width, "1000px", "the frame is the fitted image box");
    assert.equal(frame.style.height, "250px");
    assert.equal(doc.querySelector(".attachment-preview-overlay .probe-overlay")?.textContent, "b");

    await act(async () => { doc.querySelector<HTMLButtonElement>(".attachment-preview-nav--next")!.click(); });
    assert.deepEqual(picked, [2], "paging reports the new position");
    await render({ index: 0 });
    assert.equal(count(), "1 / 3", "a position moved from outside follows");

    const note = doc.querySelector<HTMLTextAreaElement>(".probe-note")!;
    await act(async () => {
      note.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }) as unknown as Event);
    });
    assert.equal(count(), "1 / 3", "arrow keys typed in the aside stay in the field");

    await render({ index: 0, gesturesDisabled: true });
    await gesture({ x: 700, y: 400 }, { x: 300, y: 402 });
    assert.equal(count(), "1 / 3", "suspended gestures do not page");
    assert.deepEqual(picked, [2]);
  } finally {
    for (const key of ["clientWidth", "clientHeight"] as const) {
      if (box[key]) Object.defineProperty(dom.HTMLElement.prototype, key, box[key]);
      else delete (dom.HTMLElement.prototype as unknown as Record<string, unknown>)[key];
    }
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
