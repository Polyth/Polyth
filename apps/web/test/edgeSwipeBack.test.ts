// The interactive edge-swipe Back controller, driven with real touch/pointer
// event sequences (happy-dom). The decisions are pinned in mobileGestures.test.ts;
// this covers what the controller does with them: claiming the touch, painting
// the drag, handing a release to the exit animation, springing home, and
// staying out of the way of everything that is not a swipe.
import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
// Motion on, and a timer-driven frame loop so a spring-home really animates.
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

const { attachEdgeSwipeBack } = await import("../src/edgeSwipeBack.ts");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const doc = dom.document as unknown as Document;

interface Fixture {
  layer: HTMLElement;
  inner: HTMLElement;
  under: HTMLElement;
  backs: number;
  enabled: boolean;
  detach: () => void;
  cancelled: string[];
}

function fixture(overrides: { enabled?: boolean; withUnder?: boolean } = {}): Fixture {
  doc.body.innerHTML = `
    <div id="under"></div>
    <div id="layer"><button id="inner">Row</button></div>
    <div id="outside"></div>`;
  const layer = doc.getElementById("layer")!;
  const inner = doc.getElementById("inner")!;
  const under = doc.getElementById("under")!;
  const state: Fixture = { layer, inner, under, backs: 0, enabled: overrides.enabled ?? true, detach: () => {}, cancelled: [] };
  state.detach = attachEdgeSwipeBack({
    layer: () => layer,
    ...(overrides.withUnder === false ? {} : { under: () => under }),
    enabled: () => state.enabled,
    onBack: () => { state.backs += 1; },
  }, doc);
  doc.addEventListener("pointercancel", (event) => { state.cancelled.push((event.target as HTMLElement).id); });
  return state;
}

let nextStamp = 1000;
function touch(type: "touchstart" | "touchmove" | "touchend" | "touchcancel", target: Element, point?: { x: number; y: number }, stepMs = 16) {
  const event = new dom.Event(type, { bubbles: true, cancelable: true }) as unknown as TouchEvent;
  const t = point ? [{ identifier: 7, clientX: point.x, clientY: point.y }] : [];
  Object.defineProperty(event, "touches", { value: type === "touchend" || type === "touchcancel" ? [] : t });
  Object.defineProperty(event, "changedTouches", { value: [{ identifier: 7, clientX: point?.x ?? 0, clientY: point?.y ?? 0 }] });
  Object.defineProperty(event, "timeStamp", { value: (nextStamp += stepMs) });
  target.dispatchEvent(event as unknown as Event);
  return event;
}

function pointerDown(target: Element) {
  const PointerEvent = dom.PointerEvent as unknown as typeof globalThis.PointerEvent;
  target.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 5, pointerType: "touch", bubbles: true }));
}

/** An edge drag to `x` in `steps` moves, `stepMs` apart. */
function drag(target: Element, toX: number, { fromX = 8, y = 300, steps = 6, stepMs = 16 } = {}) {
  touch("touchstart", target, { x: fromX, y }, stepMs);
  for (let i = 1; i <= steps; i++) touch("touchmove", target, { x: fromX + ((toX - fromX) * i) / steps, y: y + 1 }, stepMs);
}

const WIDTH = 1024; // happy-dom's default viewport

test("a claimed drag follows the finger, peeks the layer beneath, and a long release completes the Back", async () => {
  const f = fixture();
  try {
    pointerDown(f.inner);
    drag(f.inner, 600, { steps: 8, stepMs: 40 });
    assert.equal(doc.documentElement.dataset.stackSwiping, "true");
    assert.equal(f.layer.style.transform, "translate3d(592px, 0, 0)", "the layer sits where the finger is");
    assert.equal(f.layer.style.willChange, "transform");
    assert.equal(f.under.getAttribute("data-peek"), "true", "the layer beneath is told to peek");
    const progress = 592 / WIDTH;
    assert.equal(f.under.style.getPropertyValue("--stack-peek-dim"), (1 - progress).toFixed(4));
    assert.match(f.under.style.getPropertyValue("--stack-peek-x"), /calc\(var\(--stack-dir, 1\) \* var\(--stack-parallax, 28%\) \* -0\.4\d+\)/);
    assert.deepEqual(f.cancelled, ["inner"], "the page's pending press on the row was cancelled the way the browser would");

    touch("touchend", f.inner);
    assert.equal(f.backs, 1, "release past the commit point completes the Back");
    // Hand-off: the exit animation reads where the finger left each layer.
    assert.equal(f.layer.style.transform, "", "the inline drag position is dropped…");
    assert.equal(f.layer.style.getPropertyValue("--stack-from"), "592px", "…and published for the exit to start from");
    assert.match(f.under.style.getPropertyValue("--stack-uncover-from"), /\* -0\.4\d+\)/);
    assert.equal(f.under.hasAttribute("data-peek"), false);
    assert.equal(f.under.style.getPropertyValue("--stack-peek-x"), "");
    assert.equal(doc.documentElement.dataset.stackSwiping, undefined);

    // The exit animation ending releases the hand-off values.
    const end = new dom.AnimationEvent("animationend", { animationName: "stack-out", bubbles: true });
    f.layer.dispatchEvent(end as unknown as Event);
    assert.equal(f.layer.style.getPropertyValue("--stack-from"), "");
    assert.equal(f.under.style.getPropertyValue("--stack-uncover-from"), "");
    assert.equal(f.under.style.getPropertyValue("--stack-dim-from"), "");
  } finally {
    f.detach();
  }
});

test("detaching because the Back completed keeps the hand-off alive for the exit", async () => {
  // Completing the Back is what disables the layer, so the controller detaches
  // right after publishing the release position. That position must survive
  // until the exit animation has read it (this regressed once: the cleanup
  // released it before the animation's first frame and the exit restarted
  // from the screen edge instead of from the finger).
  const f = fixture();
  drag(f.inner, 600, { steps: 8, stepMs: 40 });
  touch("touchend", f.inner);
  assert.equal(f.backs, 1);
  f.detach();
  assert.equal(f.layer.style.getPropertyValue("--stack-from"), "592px", "still there after detach");
  assert.ok(f.under.style.getPropertyValue("--stack-uncover-from"));
  f.layer.dispatchEvent(new dom.AnimationEvent("animationend", { animationName: "stack-out", bubbles: true }) as unknown as Event);
  assert.equal(f.layer.style.getPropertyValue("--stack-from"), "", "released once the exit has finished");
  assert.equal(f.under.style.getPropertyValue("--stack-uncover-from"), "");
});

test("a hand-off nobody animates (motion off) is still released", async () => {
  const f = fixture();
  drag(f.inner, 600, { steps: 8, stepMs: 40 });
  touch("touchend", f.inner);
  f.detach();
  assert.equal(f.layer.style.getPropertyValue("--stack-from"), "592px");
  await sleep(1000);
  assert.equal(f.layer.style.getPropertyValue("--stack-from"), "", "the fallback timer clears it");
  assert.equal(f.under.style.getPropertyValue("--stack-dim-from"), "");
});

test("a short, slow release springs home without navigating", async () => {
  const f = fixture();
  try {
    drag(f.inner, 90, { steps: 6, stepMs: 60 });
    assert.equal(f.layer.style.transform, "translate3d(82px, 0, 0)");
    touch("touchend", f.inner, undefined, 300);
    assert.equal(f.backs, 0);
    await sleep(60);
    const midway = f.layer.style.transform;
    assert.notEqual(midway, "translate3d(82px, 0, 0)", "it is on its way home");
    await sleep(400);
    assert.equal(f.layer.style.transform, "", "home: no inline position left");
    assert.equal(f.under.hasAttribute("data-peek"), false);
    assert.equal(f.under.style.getPropertyValue("--stack-peek-x"), "");
    assert.equal(f.backs, 0);
  } finally {
    f.detach();
  }
});

test("a quick flick completes the Back from a short drag", () => {
  const f = fixture();
  try {
    drag(f.inner, 70, { steps: 4, stepMs: 8 });
    touch("touchend", f.inner, undefined, 8);
    assert.equal(f.backs, 1);
  } finally {
    f.detach();
  }
});

test("touches that are not an edge swipe are left alone", () => {
  const f = fixture();
  try {
    // Not at the edge.
    drag(f.inner, 400, { fromX: 120 });
    assert.equal(f.layer.style.transform, "");
    touch("touchend", f.inner);
    // Starts at the edge but is a vertical scroll.
    touch("touchstart", f.inner, { x: 8, y: 300 });
    const scrollMove = touch("touchmove", f.inner, { x: 12, y: 380 });
    assert.equal(scrollMove.defaultPrevented, false, "the browser keeps the scroll");
    touch("touchmove", f.inner, { x: 120, y: 384 });
    assert.equal(f.layer.style.transform, "", "a scroll is never promoted to a swipe mid-way");
    touch("touchend", f.inner);
    // Outside the layer.
    drag(doc.getElementById("outside")!, 400);
    assert.equal(f.layer.style.transform, "");
    touch("touchend", doc.getElementById("outside")!);
    // A tap.
    touch("touchstart", f.inner, { x: 8, y: 300 });
    touch("touchend", f.inner);
    assert.equal(f.backs, 0);
    assert.equal(doc.documentElement.dataset.stackSwiping, undefined);
  } finally {
    f.detach();
  }
});

test("a disabled layer, an opted-out subtree and a second finger never start or keep a swipe", () => {
  const f = fixture({ enabled: false });
  try {
    drag(f.inner, 400);
    assert.equal(f.layer.style.transform, "", "disabled");
    touch("touchend", f.inner);
    f.enabled = true;

    f.inner.setAttribute("data-no-edge-swipe", "");
    drag(f.inner, 400);
    assert.equal(f.layer.style.transform, "", "a subtree that owns horizontal gestures opts out");
    touch("touchend", f.inner);
    f.inner.removeAttribute("data-no-edge-swipe");

    drag(f.inner, 300);
    assert.notEqual(f.layer.style.transform, "");
    const second = new dom.Event("touchstart", { bubbles: true, cancelable: true });
    Object.defineProperty(second, "touches", { value: [{ identifier: 7, clientX: 300, clientY: 301 }, { identifier: 8, clientX: 50, clientY: 50 }] });
    f.inner.dispatchEvent(second as unknown as Event);
    touch("touchend", f.inner);
    assert.equal(f.backs, 0, "a second finger turns the drag into a cancel");
  } finally {
    f.detach();
  }
});

test("a cancelled touch springs home", async () => {
  const f = fixture();
  try {
    drag(f.inner, 300, { stepMs: 40 });
    touch("touchcancel", f.inner);
    await sleep(450);
    assert.equal(f.layer.style.transform, "");
    assert.equal(f.backs, 0);
  } finally {
    f.detach();
  }
});

test("right-to-left layouts swipe from the right edge toward the left", () => {
  const f = fixture();
  doc.documentElement.dir = "rtl";
  try {
    touch("touchstart", f.inner, { x: WIDTH - 6, y: 300 });
    for (let i = 1; i <= 6; i++) touch("touchmove", f.inner, { x: WIDTH - 6 - 100 * i, y: 301 }, 40);
    assert.equal(f.layer.style.transform, "translate3d(-600px, 0, 0)", "the layer travels toward the inline end, mirrored");
    touch("touchend", f.inner);
    assert.equal(f.backs, 1);
    assert.equal(f.layer.style.getPropertyValue("--stack-from"), "600px", "hand-off values stay unsigned: --stack-dir mirrors them");
  } finally {
    doc.documentElement.dir = "";
    f.detach();
  }
});

test("a swipe with nothing beneath still pulls and completes", () => {
  const f = fixture({ withUnder: false });
  try {
    drag(f.inner, 600, { steps: 8, stepMs: 40 });
    touch("touchend", f.inner);
    assert.equal(f.backs, 1);
  } finally {
    f.detach();
  }
});

test("detaching mid-drag restores every inline style", () => {
  const f = fixture();
  drag(f.inner, 300, { stepMs: 40 });
  assert.notEqual(f.layer.style.transform, "");
  f.detach();
  assert.equal(f.layer.style.transform, "");
  assert.equal(f.under.hasAttribute("data-peek"), false);
  assert.equal(doc.documentElement.dataset.stackSwiping, undefined);
  // Nothing listens any more.
  drag(f.inner, 300);
  assert.equal(f.layer.style.transform, "");
});

test("the pointerup that ends a claimed drag never reaches the page as a tap", () => {
  const f = fixture();
  const seen: string[] = [];
  f.inner.addEventListener("pointerup", () => seen.push("inner"));
  try {
    pointerDown(f.inner);
    drag(f.inner, 600, { steps: 8, stepMs: 40 });
    const PointerEvent = dom.PointerEvent as unknown as typeof globalThis.PointerEvent;
    f.inner.dispatchEvent(new PointerEvent("pointerup", { pointerId: 5, pointerType: "touch", bubbles: true }));
    touch("touchend", f.inner);
    assert.deepEqual(seen, [], "swallowed before any page handler");
    // …and only that one: the next, ordinary tap works.
    f.inner.dispatchEvent(new PointerEvent("pointerup", { pointerId: 6, pointerType: "touch", bubbles: true }));
    assert.deepEqual(seen, ["inner"]);
  } finally {
    f.detach();
  }
});
