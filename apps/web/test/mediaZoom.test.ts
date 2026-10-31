// Media viewer zoom (mediaZoom.ts): the pure pan/zoom geometry, and the
// pointer controller driven with real pointer sequences (happy-dom) — a pinch
// zooms around the fingers, a double tap zooms in and back out, a zoomed image
// drags within its bounds, and a drag over the dim is not a tap that closes it.
import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { MEDIA_ZOOM_DOUBLE_TAP, MEDIA_ZOOM_MAX, REST_VIEW, attachMediaZoom, clampView, zoomAround, type ZoomBox } from "../src/mediaZoom.ts";

// A 400×300 image centred in an 800×600 slide.
const box: ZoomBox = { left: 200, top: 150, width: 400, height: 300, viewWidth: 800, viewHeight: 600 };

test("zooming around a point keeps that image point under it", () => {
  const view = zoomAround(REST_VIEW, { x: 500, y: 300 }, 2, box);
  // Image centre is (400, 300); the point 100px right of it must stay at x=500.
  assert.deepEqual(view, { scale: 2, x: -100, y: 0 });
  const back = zoomAround(view, { x: 500, y: 300 }, 1, box);
  assert.deepEqual(back, { scale: 1, x: 0, y: 0 });
});

test("a zoomed image stays inside the view while smaller, and covers it once larger", () => {
  // 2× → 800×600: exactly the view, no room to move.
  assert.deepEqual(clampView({ scale: 2, x: 300, y: -200 }, box), { scale: 2, x: 0, y: 0 });
  // 3× → 1200×900: edges stay outside the view (±200 / ±150).
  assert.deepEqual(clampView({ scale: 3, x: 999, y: -999 }, box), { scale: 3, x: 200, y: -150 });
  // 1.5× → 600×450: smaller than the view, may move only until an edge touches it.
  assert.deepEqual(clampView({ scale: 1.5, x: 999, y: 0 }, box), { scale: 1.5, x: 100, y: 0 });
  assert.equal(clampView({ scale: 99, x: 0, y: 0 }, box).scale, MEDIA_ZOOM_MAX);
  assert.deepEqual(clampView({ scale: 0.5, x: 40, y: 40 }, box), REST_VIEW, "never below rest");
});

function fixture() {
  const dom = new Window({ url: "http://localhost:3000/" });
  const doc = dom.document as unknown as Document;
  const stage = doc.createElement("div");
  const slide = doc.createElement("div");
  const img = doc.createElement("img");
  slide.appendChild(img);
  stage.appendChild(slide);
  doc.body.appendChild(stage);
  const define = (el: Element, values: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(values)) Object.defineProperty(el, key, { configurable: true, value });
  };
  define(img, { offsetParent: slide, offsetLeft: box.left, offsetTop: box.top, offsetWidth: box.width, offsetHeight: box.height });
  define(slide, {
    clientWidth: box.viewWidth,
    clientHeight: box.viewHeight,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0 }),
  });
  const zoom = attachMediaZoom({ surface: () => stage as HTMLElement, media: () => img as HTMLElement });
  const pointer = (type: string, target: Element, id: number, x: number, y: number, pointerType = "touch") => {
    const event = new dom.PointerEvent(type, { pointerId: id, pointerType, clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0 });
    target.dispatchEvent(event as unknown as Event);
  };
  const transform = () => (img as HTMLElement).style.transform;
  return { dom, stage, img, zoom, pointer, transform };
}

test("two fingers pinch the image around their midpoint and engage the zoom", () => {
  const { stage, img, zoom, pointer, transform } = fixture();
  pointer("pointerdown", img, 1, 350, 300);
  pointer("pointerdown", img, 2, 450, 300);
  assert.equal(zoom.engaged(), true, "two fingers down already keep the swipe away");
  pointer("pointermove", img, 1, 300, 300);
  pointer("pointermove", img, 2, 500, 300);
  assert.equal(transform(), "translate3d(0px, 0px, 0) scale(2)", "twice the distance, the midpoint stays put");
  assert.equal(stage.hasAttribute("data-zoomed"), true);
  pointer("pointerup", img, 1, 300, 300);
  pointer("pointerup", img, 2, 500, 300);
  assert.equal(zoom.engaged(), true, "a zoomed image stays engaged after the fingers lift");
  zoom.reset();
  assert.equal(transform(), "");
  assert.equal(stage.hasAttribute("data-zoomed"), false);
  assert.equal(zoom.engaged(), false);
  zoom.detach();
});

test("a double tap zooms into the tapped point, a drag pans it within bounds, another double tap zooms out", () => {
  const { img, zoom, pointer, transform } = fixture();
  const tap = (x: number, y: number) => {
    pointer("pointerdown", img, 7, x, y);
    pointer("pointerup", img, 7, x, y);
  };
  tap(400, 300);
  assert.equal(transform(), "", "one tap is just a tap");
  tap(402, 300);
  assert.equal(transform(), `translate3d(-3px, 0px, 0) scale(${MEDIA_ZOOM_DOUBLE_TAP})`);
  assert.equal(img.hasAttribute("data-zoom-settling"), true, "a double tap settles, not jumps");

  pointer("pointerdown", img, 8, 400, 300);
  pointer("pointermove", img, 8, 900, 300);
  // 2.5× → 1000px wide in an 800px view: at most 100px either way.
  assert.equal(transform(), `translate3d(100px, 0px, 0) scale(${MEDIA_ZOOM_DOUBLE_TAP})`);
  pointer("pointerup", img, 8, 900, 300);

  tap(400, 300);
  tap(400, 300);
  assert.equal(transform(), "", "a double tap on a zoomed image goes back to rest");
  assert.equal(zoom.engaged(), false);
  zoom.detach();
});

test("a drag over the dim does not reach its close click", () => {
  const { dom, stage, img, zoom, pointer } = fixture();
  let clicks = 0;
  stage.parentElement!.addEventListener("click", () => { clicks += 1; });
  pointer("pointerdown", img, 1, 350, 300);
  pointer("pointerdown", img, 2, 450, 300);
  pointer("pointermove", img, 1, 300, 300);
  pointer("pointermove", img, 2, 500, 300);
  pointer("pointerup", img, 1, 300, 300);
  pointer("pointerup", img, 2, 500, 300);
  stage.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
  assert.equal(clicks, 0, "the pinch's trailing click is swallowed");
  pointer("pointerdown", stage, 3, 50, 50);
  pointer("pointerup", stage, 3, 50, 50);
  stage.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
  assert.equal(clicks, 1, "a plain tap still clicks");
  zoom.detach();
});
