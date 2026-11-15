// The shared shell-swipe controller (swipeSurface.ts), driven with real touch
// sequences (happy-dom): which touches it claims anywhere on a surface, what it
// leaves to content that owns horizontal movement, how a release is measured
// and handed over, and how long each kind of hand-off value lives.
import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
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

const { attachSwipeSurface, holdHandoff } = await import("../src/swipeSurface.ts");
type SwipeRelease = import("../src/swipeSurface.ts").SwipeRelease;
type SwipeZone = import("../src/mobileGestures.ts").SwipeZone;
type InlineDirection = import("../src/mobileGestures.ts").InlineDirection;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const doc = dom.document as unknown as Document;
const WIDTH = 1024; // happy-dom's default viewport

interface Probe {
  begins: number;
  paints: number[];
  commits: SwipeRelease[];
  cancels: number;
  enabled: boolean;
  zone: SwipeZone;
  decline: boolean;
  detach: () => void;
}

function controller(direction: InlineDirection, overrides: Partial<Pick<Probe, "zone" | "enabled">> = {}): Probe {
  const probe: Probe = {
    begins: 0, paints: [], commits: [], cancels: 0,
    enabled: overrides.enabled ?? true, zone: overrides.zone ?? "surface", decline: false, detach: () => {},
  };
  probe.detach = attachSwipeSurface({
    surface: () => doc.getElementById("surface"),
    direction,
    zone: () => probe.zone,
    enabled: () => probe.enabled,
    begin: () => {
      if (probe.decline) return null;
      probe.begins += 1;
      return {
        paint: (travel) => { probe.paints.push(travel); },
        commit: (release) => { probe.commits.push(release); },
        cancel: () => { probe.cancels += 1; },
      };
    },
  }, doc);
  return probe;
}

function page(inner = '<button id="row">Row</button>') {
  doc.body.innerHTML = `<div id="surface">${inner}</div><div id="outside"></div>`;
}

let stamp = 1000;
function touch(type: "touchstart" | "touchmove" | "touchend" | "touchcancel", target: Element, point?: { x: number; y: number }, stepMs = 16) {
  const event = new dom.Event(type, { bubbles: true, cancelable: true }) as unknown as TouchEvent;
  const list = point ? [{ identifier: 3, clientX: point.x, clientY: point.y }] : [];
  Object.defineProperty(event, "touches", { value: type === "touchend" || type === "touchcancel" ? [] : list });
  Object.defineProperty(event, "changedTouches", { value: [{ identifier: 3, clientX: point?.x ?? 0, clientY: point?.y ?? 0 }] });
  Object.defineProperty(event, "timeStamp", { value: (stamp += stepMs) });
  target.dispatchEvent(event as unknown as Event);
  return event;
}

function drag(target: Element, fromX: number, toX: number, { y = 300, steps = 6, stepMs = 16 } = {}) {
  touch("touchstart", target, { x: fromX, y }, stepMs);
  const moves: TouchEvent[] = [];
  for (let i = 1; i <= steps; i++) moves.push(touch("touchmove", target, { x: fromX + ((toX - fromX) * i) / steps, y: y + 1 }, stepMs));
  return moves;
}

const el = (id: string) => doc.getElementById(id)!;

test("a surface swipe starts anywhere and is followed in its own direction", () => {
  page();
  const end = controller("toward-end");
  const start = controller("toward-start");
  try {
    drag(el("row"), 500, 260, { steps: 6, stepMs: 120 });
    assert.equal(end.begins, 0, "the other direction never claims");
    assert.equal(start.begins, 1, "a swipe toward the inline start claims from the middle of the surface");
    assert.equal(start.paints.at(-1), 240, "travel is measured along the swipe");
    assert.equal(doc.documentElement.dataset.stackSwiping, "true");
    touch("touchend", el("row"));
    assert.equal(start.commits.length, 0, "240 of 1024 is short of the commit point at a slow release");
  } finally {
    end.detach();
    start.detach();
  }
});

test("edge zone: only the edge the finger leaves starts a swipe", () => {
  page();
  const back = controller("toward-end", { zone: "edge" });
  const open = controller("toward-start", { zone: "edge" });
  try {
    drag(el("row"), 400, 700);
    touch("touchend", el("row"));
    assert.equal(back.begins, 0, "not from the middle");
    drag(el("row"), 10, 400);
    touch("touchend", el("row"));
    assert.equal(back.begins, 1, "from the inline-start edge");
    drag(el("row"), WIDTH - 10, 600);
    touch("touchend", el("row"));
    assert.equal(open.begins, 1, "toward the start from the inline-end edge");
  } finally {
    back.detach();
    open.detach();
  }
});

test("a release past the commit point hands over its travel, speed and settle time", () => {
  page();
  const probe = controller("toward-end");
  try {
    drag(el("row"), 100, 700, { steps: 8, stepMs: 40 });
    const end = touch("touchend", el("row"));
    assert.equal(probe.commits.length, 1);
    const [release] = probe.commits;
    assert.equal(release!.travel, 600);
    assert.equal(release!.width, WIDTH);
    assert.ok(release!.velocity > 0);
    assert.ok(release!.settleMs > 0 && release!.settleMs <= 300, "paced by --motion-stack's 300ms fallback at most");
    assert.equal(end.defaultPrevented, true, "the synthesized click is kept from the page");
    assert.equal(doc.documentElement.dataset.stackSwiping, undefined);
    assert.equal(probe.cancels, 0);
  } finally {
    probe.detach();
  }
});

test("a short release springs home through paint and then undoes the begin", async () => {
  page();
  const probe = controller("toward-end");
  try {
    drag(el("row"), 300, 400, { steps: 5, stepMs: 60 });
    touch("touchend", el("row"), undefined, 300);
    assert.equal(probe.commits.length, 0);
    await sleep(400);
    assert.equal(probe.paints.at(-1), 0, "the last frame is home");
    assert.equal(probe.cancels, 1);
  } finally {
    probe.detach();
  }
});

test("content that owns horizontal movement keeps its touches away from the edge", () => {
  page(`
    <div id="owner" data-owns-swipe=""><span id="owned">swipe actions</span></div>
    <input id="field" />
    <div id="scroller" style="overflow-x: auto"><span id="scrolled">wide</span></div>
    <div id="handle" style="touch-action: none"><span id="grip">grip</span></div>
    <div id="opted" data-no-edge-swipe=""><span id="optedChild">opted out</span></div>`);
  const scroller = el("scroller");
  Object.defineProperty(scroller, "scrollWidth", { configurable: true, value: 900 });
  Object.defineProperty(scroller, "clientWidth", { configurable: true, value: 300 });
  let scrollLeft = 200;
  Object.defineProperty(scroller, "scrollLeft", { configurable: true, get: () => scrollLeft });
  const probe = controller("toward-end");
  try {
    for (const id of ["owned", "field", "scrolled", "grip", "optedChild"]) {
      const moves = drag(el(id), 300, 600);
      touch("touchend", el(id));
      assert.equal(probe.begins, 0, `${id} keeps the touch`);
      assert.equal(moves.at(-1)!.defaultPrevented, false, `${id}: the browser keeps its own handling`);
    }
    // A scroller that is back at its start hands the swipe on.
    scrollLeft = 0;
    drag(el("scrolled"), 300, 600);
    touch("touchend", el("scrolled"));
    assert.equal(probe.begins, 1, "nothing left to scroll that way: the swipe takes over");
    // From the edge, a row's own swipe actions give way; an opt-out never does.
    drag(el("owned"), 10, 400);
    touch("touchend", el("owned"));
    assert.equal(probe.begins, 2, "an edge swipe still navigates over swipe actions");
    drag(el("optedChild"), 10, 400);
    touch("touchend", el("optedChild"));
    assert.equal(probe.begins, 2, "data-no-edge-swipe owns even the edge");
  } finally {
    probe.detach();
  }
});

test("a one-way swipe owner keeps only its own direction", () => {
  page('<div data-owns-swipe="toward-end"><span id="pinRow">row</span></div>');
  const toEnd = controller("toward-end");
  const toStart = controller("toward-start");
  try {
    drag(el("pinRow"), 300, 600);
    touch("touchend", el("pinRow"));
    assert.equal(toEnd.begins, 0, "the row's own direction stays with the row");
    drag(el("pinRow"), 600, 300);
    touch("touchend", el("pinRow"));
    assert.equal(toStart.begins, 1, "the other direction goes to the shell");
  } finally {
    toEnd.detach();
    toStart.detach();
  }
});

test("one swipe at a time, declined claims and disabled states leave the touch alone", () => {
  page();
  const first = controller("toward-end");
  const second = controller("toward-end");
  try {
    drag(el("row"), 300, 700);
    assert.equal(first.begins + second.begins, 1, "exactly one controller claims a touch");
    touch("touchend", el("row"));

    first.decline = true;
    second.decline = true;
    const moves = drag(el("row"), 300, 700);
    touch("touchend", el("row"));
    assert.equal(moves.at(-1)!.defaultPrevented, false, "a declined claim is not a swipe");

    first.enabled = false;
    second.enabled = false;
    first.decline = false;
    second.decline = false;
    drag(el("row"), 300, 700);
    touch("touchend", el("row"));
    assert.equal(first.begins + second.begins, 1, "disabled");

    first.enabled = true;
    drag(el("outside"), 300, 700);
    touch("touchend", el("outside"));
    assert.equal(first.begins + second.begins, 1, "outside the surface");
  } finally {
    first.detach();
    second.detach();
  }
});

test("a vertical scroll and a wandering diagonal are never promoted to a swipe", () => {
  page();
  const probe = controller("toward-end");
  try {
    touch("touchstart", el("row"), { x: 300, y: 300 });
    const scroll = touch("touchmove", el("row"), { x: 304, y: 340 });
    touch("touchmove", el("row"), { x: 500, y: 342 });
    touch("touchend", el("row"));
    assert.equal(scroll.defaultPrevented, false);
    assert.equal(probe.begins, 0, "once a scroll, always a scroll");
    touch("touchstart", el("row"), { x: 300, y: 300 });
    touch("touchmove", el("row"), { x: 318, y: 312 });
    touch("touchmove", el("row"), { x: 326, y: 318 });
    touch("touchmove", el("row"), { x: 500, y: 320 });
    touch("touchend", el("row"));
    assert.equal(probe.begins, 0, "undecided movement gives up");
  } finally {
    probe.detach();
  }
});

test("detaching mid-drag abandons the session", () => {
  page();
  const probe = controller("toward-end");
  drag(el("row"), 300, 600);
  assert.equal(probe.begins, 1);
  probe.detach();
  assert.equal(probe.cancels, 1);
  assert.equal(doc.documentElement.dataset.stackSwiping, undefined);
});

function animation(type: "animationstart" | "animationend" | "animationcancel", target: Element, animationName: string) {
  target.dispatchEvent(new dom.AnimationEvent(type, { animationName, bubbles: true }) as unknown as Event);
}

test("hand-off positions leave with their animation; pacing stays until another animation takes over", () => {
  page('<div id="layer"><div id="child"></div></div>');
  const layer = el("layer") as HTMLElement;
  holdHandoff(layer, {
    from: { "--from": "40px" },
    pacing: { "--settle": "150ms" },
    attrs: { "data-swipe-handoff": "open" },
    animations: ["swipe-in"],
    fallbackMs: 5_000,
  });
  assert.equal(layer.style.getPropertyValue("--from"), "40px");
  animation("animationend", el("child"), "swipe-in");
  assert.equal(layer.style.getPropertyValue("--from"), "40px", "a descendant's animation is not ours");
  animation("animationend", layer, "swipe-in");
  assert.equal(layer.style.getPropertyValue("--from"), "", "the start position is spent");
  assert.equal(layer.style.getPropertyValue("--settle"), "150ms",
    "the duration stays: taking it back would wake the finished animation");
  assert.equal(layer.getAttribute("data-swipe-handoff"), "open");
  animation("animationstart", el("child"), "row-in");
  assert.equal(layer.style.getPropertyValue("--settle"), "150ms", "a descendant starting is not a takeover");
  animation("animationstart", layer, "drawer-out");
  assert.equal(layer.style.getPropertyValue("--settle"), "");
  assert.equal(layer.hasAttribute("data-swipe-handoff"), false);
});

test("a cancelled, replaced or never-animated hand-off is released", async () => {
  page('<div id="layer"><div id="sheet"></div></div>');
  const layer = el("layer") as HTMLElement;
  holdHandoff(layer, { pacing: { "--settle": "1ms" }, animations: ["a"], fallbackMs: 0 });
  animation("animationcancel", layer, "a");
  assert.equal(layer.style.getPropertyValue("--settle"), "", "cancelled");

  holdHandoff(layer, { pacing: { "--settle": "2ms" }, attrs: { "data-swipe-handoff": "open" }, animations: ["a"], fallbackMs: 0 });
  holdHandoff(layer, { pacing: { "--other": "3ms" }, attrs: { "data-swipe-handoff": "close" }, animations: ["b"], fallbackMs: 0 });
  assert.equal(layer.style.getPropertyValue("--settle"), "", "replaced by the newer hand-off");
  assert.equal(layer.getAttribute("data-swipe-handoff"), "close", "…which keeps its own values");
  animation("animationstart", layer, "c");

  holdHandoff(layer, { from: { "--from": "9px" }, animations: ["a"], fallbackMs: 30 });
  await sleep(60);
  assert.equal(layer.style.getPropertyValue("--from"), "", "nothing animated it: the fallback takes it back");

  // Values on a host that passes them down, watched on the element that animates.
  holdHandoff(layer, { pacing: { "--uncover": "120ms" }, animations: ["uncover"], fallbackMs: 0, watch: el("sheet") as HTMLElement });
  animation("animationstart", layer, "unrelated-on-host");
  assert.equal(layer.style.getPropertyValue("--uncover"), "120ms");
  animation("animationend", el("sheet"), "uncover");
  assert.equal(layer.style.getPropertyValue("--uncover"), "120ms");
  animation("animationstart", el("sheet"), "cover");
  assert.equal(layer.style.getPropertyValue("--uncover"), "");
});

test("a claimed drag leaves rest at the finger's speed and closes its gap in a moment", () => {
  page();
  const probe = controller("toward-end");
  try {
    // 6px every 16ms: the claim comes 18px in, at rest.
    drag(el("row"), 300, 480, { steps: 30, stepMs: 16 });
    assert.equal(probe.begins, 1);
    assert.equal(probe.paints[0], 0, "the frame that claims paints the layer at rest");
    assert.ok(probe.paints[1]! <= 7, `it leaves at the finger's speed, with no kick: ${probe.paints[1]}`);
    for (let i = 1; i < probe.paints.length; i++) {
      const step = probe.paints[i]! - probe.paints[i - 1]!;
      assert.ok(step >= 0 && step <= 10, `no jump between frames (${step.toFixed(1)}): ${probe.paints.join(", ")}`);
    }
    assert.equal(probe.paints.at(-1), 180, "…and it is exactly under the finger once caught up");
    touch("touchend", el("row"));
  } finally {
    probe.detach();
  }
});

test("a claim that stalls the page does not become a jump: the layer carries on from rest", () => {
  page();
  const probe = controller("toward-end");
  try {
    touch("touchstart", el("row"), { x: 300, y: 300 });
    touch("touchmove", el("row"), { x: 306, y: 301 });
    touch("touchmove", el("row"), { x: 318, y: 301 });
    assert.deepEqual(probe.paints, [0], "claimed 18px in, at rest");
    // Mounting the surface took 150ms; the finger is 60px further by the next move.
    touch("touchmove", el("row"), { x: 378, y: 301 }, 150);
    assert.equal(probe.paints.at(-1), 0, "the late frame leaves the layer where it was last seen");
    const after: number[] = [];
    for (let x = 384; x <= 480; x += 6) {
      touch("touchmove", el("row"), { x, y: 301 });
      after.push(probe.paints.at(-1)!);
    }
    for (let i = 1; i < after.length; i++) {
      const step = after[i]! - after[i - 1]!;
      assert.ok(step >= 0 && step <= 16, `it catches up without a lurch (${step.toFixed(1)}): ${after.join(", ")}`);
    }
    touch("touchmove", el("row"), { x: 500, y: 301 }, 250);
    assert.equal(probe.paints.at(-1), 200, "and then it is under the finger");
    // A page that is simply slow is not absorbed for ever: late frames track the finger.
    touch("touchmove", el("row"), { x: 560, y: 301 }, 250);
    assert.equal(probe.paints.at(-1), 260);
    touch("touchend", el("row"));
  } finally {
    probe.detach();
  }
});

test("a quick flick is judged by the finger, not by a layer still closing its gap", () => {
  page();
  const probe = controller("toward-end");
  try {
    // 40px in 48ms and gone: the layer has barely left rest, the finger is past the flick distance.
    drag(el("row"), 300, 340, { steps: 4, stepMs: 12 });
    assert.ok(probe.paints.at(-1)! < 24, `still catching up: ${probe.paints.at(-1)}`);
    touch("touchend", el("row"), undefined, 4);
    assert.equal(probe.commits.length, 1, "the flick completes");
    assert.equal(probe.commits[0]!.travel, probe.paints.at(-1), "from where the layer actually is");
    assert.match(probe.commits[0]!.easing, /^cubic-bezier\(0\.32, [\d.]+, [\d.]+, 1\)$/);
  } finally {
    probe.detach();
  }
});

// ---- a session that settles on the compositor -------------------------------

class FakeAnimation extends dom.EventTarget {
  currentTime: number | null = 0;
  cancelled = false;
  cancel() { this.cancelled = true; }
  finish() { this.dispatchEvent(new dom.Event("finish") as never); }
}

interface SettlingProbe extends Probe {
  settles: Array<{ outcome: string; durationMs: number; frames: Keyframe[]; travelAt(ms: number): number; animation: FakeAnimation }>;
  log: string[];
}

function settlingController(direction: InlineDirection): SettlingProbe {
  const probe: SettlingProbe = {
    begins: 0, paints: [], commits: [], cancels: 0, enabled: true, zone: "surface", decline: false, detach: () => {},
    settles: [], log: [],
  };
  probe.detach = attachSwipeSurface({
    surface: () => doc.getElementById("surface"),
    direction,
    zone: () => probe.zone,
    enabled: () => probe.enabled,
    begin: () => {
      probe.begins += 1;
      return {
        paint: (travel) => { probe.paints.push(travel); },
        settle: (settle) => {
          const animation = new FakeAnimation();
          probe.settles.push({
            outcome: settle.outcome,
            durationMs: settle.durationMs,
            travelAt: settle.travelAt,
            frames: settle.keyframes((travel) => ({ transform: `translateX(${travel.toFixed(2)}px)` })),
            animation,
          });
          probe.log.push(`settle:${settle.outcome}`);
          return animation as unknown as Animation;
        },
        commit: (release) => { probe.commits.push(release); probe.log.push("commit"); },
        cancel: () => { probe.cancels += 1; probe.log.push("cancel"); },
      };
    },
  }, doc);
  return probe;
}

const translate = (frame: Keyframe): number => Number(/translateX\(([-\d.]+)px\)/.exec(String(frame.transform))![1]);

test("a release starts its settle at once and commits a frame later, under it", async () => {
  page();
  const probe = settlingController("toward-end");
  try {
    drag(el("row"), 100, 700, { steps: 30, stepMs: 16 });
    assert.equal(probe.paints.at(-1), 600);
    touch("touchend", el("row"));
    assert.deepEqual(probe.log, ["settle:commit"], "the animation is started in the release's own task; nothing else yet");
    const [settle] = probe.settles;
    assert.ok(settle!.durationMs > 0 && settle!.durationMs <= 360, `about the token: ${settle!.durationMs}`);
    const xs = settle!.frames.map(translate);
    assert.equal(xs[0], 600, "from where the finger left the layer");
    assert.equal(xs.at(-1), WIDTH, "to the destination");
    for (let i = 1; i < xs.length; i++) assert.ok(xs[i]! >= xs[i - 1]! - 1e-6, "never backwards, never past the end");
    assert.deepEqual(settle!.frames.map((frame) => frame.offset).slice(0, 2), [0, 1 / (xs.length - 1)], "evenly spaced samples");
    // It leaves at the finger's speed (20px per 16ms) instead of leaping or stalling.
    const perMs = settle!.travelAt(1) - settle!.travelAt(0);
    assert.ok(perMs > 1.15 && perMs < 1.6, `leaves at about the finger's 1.25 px/ms: ${perMs.toFixed(2)}`);
    assert.equal(doc.documentElement.dataset.stackSwiping, "true", "the claim is held until the commit lands");

    await sleep(30);
    assert.deepEqual(probe.log, ["settle:commit", "commit"]);
    assert.equal(probe.commits[0]!.travel, 600);
    assert.equal(probe.commits[0]!.settleMs, settle!.durationMs);
    assert.equal(doc.documentElement.dataset.stackSwiping, undefined);
    assert.equal(settle!.animation.cancelled, false, "the animation holds the layer until it has arrived");
    settle!.animation.finish();
    assert.equal(settle!.animation.cancelled, true, "then the committed state takes over");
    assert.equal(probe.cancels, 0);
  } finally {
    probe.detach();
  }
});

test("an animation that ends before the commit keeps holding the layer until the commit has landed", async () => {
  page();
  const probe = settlingController("toward-end");
  try {
    drag(el("row"), 100, 700, { steps: 30, stepMs: 16 });
    touch("touchend", el("row"));
    const animation = probe.settles[0]!.animation;
    animation.finish();
    assert.equal(animation.cancelled, false, "nothing to rest on yet");
    await sleep(30);
    assert.deepEqual(probe.log, ["settle:commit", "commit"]);
    assert.equal(animation.cancelled, true);
  } finally {
    probe.detach();
  }
});

test("detaching between the release and its commit completes the commit", () => {
  page();
  const probe = settlingController("toward-end");
  drag(el("row"), 100, 700, { steps: 30, stepMs: 16 });
  touch("touchend", el("row"));
  assert.deepEqual(probe.log, ["settle:commit"]);
  probe.detach();
  assert.deepEqual(probe.log, ["settle:commit", "commit"], "the layer is already moving: the release is not undone");
  assert.equal(probe.cancels, 0);
});

test("a short release springs home on the compositor and is undone when it arrives", async () => {
  page();
  const probe = settlingController("toward-end");
  try {
    drag(el("row"), 300, 400, { steps: 25, stepMs: 16 });
    touch("touchend", el("row"), undefined, 300);
    assert.deepEqual(probe.log, ["settle:home"]);
    const [settle] = probe.settles;
    const xs = settle!.frames.map(translate);
    assert.equal(xs[0], 100);
    assert.equal(xs.at(-1), 0);
    const paints = probe.paints.length;
    await sleep(30);
    assert.equal(probe.paints.length, paints, "no frame-by-frame painting while the compositor has it");
    settle!.animation.finish();
    assert.equal(probe.paints.at(-1), 0, "the last paint is home");
    assert.deepEqual(probe.log, ["settle:home", "cancel"]);
    assert.equal(settle!.animation.cancelled, true, "taken back once the session has put the layer at rest");
    assert.equal(probe.commits.length, 0);
  } finally {
    probe.detach();
  }
});

test("a finger catches a compositor spring-home where the animation is, and carries on", async () => {
  page();
  const probe = settlingController("toward-end");
  try {
    drag(el("row"), 300, 420, { steps: 6, stepMs: 60 });
    touch("touchend", el("row"), undefined, 300);
    const [settle] = probe.settles;
    settle!.animation.currentTime = settle!.durationMs * 0.25;
    touch("touchstart", el("row"), { x: 200, y: 300 });
    const caughtAt = probe.paints.at(-1)!;
    assert.ok(caughtAt > 0 && caughtAt < 120, `pinned mid-way: ${caughtAt}`);
    assert.equal(settle!.animation.cancelled, true, "the animation lets go of the layer");
    for (const x of [210, 220, 230]) touch("touchmove", el("row"), { x, y: 301 }, 80);
    assert.ok(Math.abs(probe.paints.at(-1)! - (caughtAt + 30)) < 1e-9, "it moves on from there, 1:1");
    assert.equal(probe.begins, 1, "the same session continues");
    assert.equal(probe.cancels, 0);
    touch("touchend", el("row"), undefined, 300);
    assert.equal(probe.settles.length, 2, "and springs home again when let go");
    probe.settles[1]!.animation.finish();
    assert.equal(probe.cancels, 1);
  } finally {
    probe.detach();
  }
});

test("a finger can catch a layer while it springs home and carry on from there", async () => {
  page();
  const probe = controller("toward-end");
  try {
    drag(el("row"), 300, 420, { steps: 6, stepMs: 60 });
    touch("touchend", el("row"), undefined, 300);
    await sleep(30);
    const caughtAt = probe.paints.at(-1)!;
    assert.ok(caughtAt > 0 && caughtAt < 120, `mid spring-home: ${caughtAt}`);
    touch("touchstart", el("row"), { x: 200, y: 300 });
    const paintsBefore = probe.paints.length;
    await sleep(30);
    assert.equal(probe.paints.length, paintsBefore, "the spring stops the moment it is caught");
    for (const x of [210, 220, 230]) touch("touchmove", el("row"), { x, y: 301 }, 80);
    assert.equal(probe.begins, 1, "the same session continues");
    assert.equal(probe.cancels, 0);
    assert.ok(Math.abs(probe.paints.at(-1)! - (caughtAt + 30)) < 1e-9, "it moves on from where it was caught, 1:1");
    touch("touchend", el("row"), undefined, 300);
    await sleep(400);
    assert.equal(probe.commits.length, 0);
    assert.equal(probe.paints.at(-1), 0);
    assert.equal(probe.cancels, 1);
  } finally {
    probe.detach();
  }
});

test("a touch whose end never arrives is let go: hidden page or a new touch", async () => {
  page();
  const probe = controller("toward-end");
  const visibility = Object.getOwnPropertyDescriptor(doc, "visibilityState");
  try {
    drag(el("row"), 300, 500);
    assert.equal(probe.begins, 1);
    Object.defineProperty(doc, "visibilityState", { configurable: true, value: "hidden" });
    doc.dispatchEvent(new dom.Event("visibilitychange") as unknown as Event);
    await sleep(400);
    assert.equal(probe.cancels, 1, "sent to the background mid-drag: it springs home");
    assert.equal(doc.documentElement.dataset.stackSwiping, undefined);
    Object.defineProperty(doc, "visibilityState", { configurable: true, value: "visible" });

    drag(el("row"), 300, 500);
    assert.equal(probe.begins, 2);
    // The old finger's end was lost; a new finger (another identifier) lands.
    const fresh = new dom.Event("touchstart", { bubbles: true, cancelable: true }) as unknown as TouchEvent;
    Object.defineProperty(fresh, "touches", { value: [{ identifier: 9, clientX: 100, clientY: 300 }] });
    Object.defineProperty(fresh, "changedTouches", { value: [{ identifier: 9, clientX: 100, clientY: 300 }] });
    Object.defineProperty(fresh, "timeStamp", { value: (stamp += 16) });
    el("row").dispatchEvent(fresh as unknown as Event);
    // The stranded drag springs home; the new finger may catch it and let go.
    const lifted = new dom.Event("touchend", { bubbles: true, cancelable: true }) as unknown as TouchEvent;
    Object.defineProperty(lifted, "touches", { value: [] });
    Object.defineProperty(lifted, "changedTouches", { value: [{ identifier: 9, clientX: 100, clientY: 300 }] });
    Object.defineProperty(lifted, "timeStamp", { value: (stamp += 200) });
    el("row").dispatchEvent(lifted as unknown as Event);
    await sleep(400);
    assert.equal(probe.commits.length, 0);
    assert.equal(probe.paints.at(-1), 0, "the stranded drag is put back");
    assert.equal(doc.documentElement.dataset.stackSwiping, undefined, "nothing is left claimed");
  } finally {
    if (visibility) Object.defineProperty(doc, "visibilityState", visibility);
    else delete (doc as unknown as Record<string, unknown>).visibilityState;
    probe.detach();
  }
});

test("a swipe owner keeps swipes from the surfaces around it, never from its own", () => {
  doc.body.innerHTML = '<div id="surface"><div id="toast" data-owns-swipe=""><span id="copy">toast</span></div></div>';
  const outer = controller("toward-end");
  let own = 0;
  const detachOwn = attachSwipeSurface({
    surface: () => doc.getElementById("toast"),
    direction: "toward-end",
    zone: () => "surface",
    enabled: () => true,
    begin: () => {
      own += 1;
      return { paint: () => {}, commit: () => {}, cancel: () => {} };
    },
  }, doc);
  try {
    drag(el("copy"), 300, 600);
    touch("touchend", el("copy"));
    assert.equal(own, 1, "the owner's own swipe claims");
    assert.equal(outer.begins, 0, "the shell around it yields");
  } finally {
    detachOwn();
    outer.detach();
  }
});

test("a narrower layer travels, commits and settles against its own extent", () => {
  page();
  const commits: SwipeRelease[] = [];
  const paints: number[] = [];
  const detach = attachSwipeSurface({
    surface: () => doc.getElementById("surface"),
    direction: "toward-end",
    zone: () => "surface",
    enabled: () => true,
    extent: () => 320,
    begin: () => ({ paint: (travel) => { paints.push(travel); }, commit: (release) => { commits.push(release); }, cancel: () => {} }),
  }, doc);
  try {
    drag(el("row"), 100, 700, { steps: 10, stepMs: 120 });
    assert.equal(Math.max(...paints), 320, "never past the layer's own width");
    touch("touchend", el("row"), undefined, 400);
    assert.equal(commits.length, 1, "a slow release past 35% of the drawer completes");
    assert.equal(commits[0]!.width, 320);
  } finally {
    detach();
  }
});

test("a layer that is only caught, not moved on, carries on home", async () => {
  page();
  const probe = controller("toward-end");
  try {
    // Flung back home from far past the commit point: it springs home from there.
    drag(el("row"), 100, 1000, { steps: 6, stepMs: 60 });
    for (const x of [960, 920, 880]) touch("touchmove", el("row"), { x, y: 301 }, 30);
    touch("touchend", el("row"), undefined, 8);
    assert.equal(probe.commits.length, 0, "flung back");
    await sleep(8);
    assert.ok(probe.paints.at(-1)! > 1024 * 0.35, `still past the commit point: ${probe.paints.at(-1)}`);
    touch("touchstart", el("row"), { x: 300, y: 300 });
    touch("touchend", el("row"), undefined, 40);
    await sleep(400);
    assert.equal(probe.commits.length, 0, "a tap on the moving layer never completes the other way");
    assert.equal(probe.paints.at(-1), 0);
  } finally {
    probe.detach();
  }
});
