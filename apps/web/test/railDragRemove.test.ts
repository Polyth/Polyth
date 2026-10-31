// Pulling a launcher away from every rail removes it. The pointer past
// REMOVE_DISTANCE_PX from each rail arms the verdict (the icon's home closes,
// the ghost wears a "Remove" pill) and releasing there hands the icon to its
// rail's `remove`. Anything nearer, off screen, or from a rail that cannot lose
// the icon puts it back instead.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://127.0.0.1:4400/", width: 1280, height: 800 });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  Element: dom.Element,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: (callback: FrameRequestCallback) => dom.setTimeout(() => callback(Date.now()), 0) as unknown as number,
  cancelAnimationFrame: (handle: number) => { dom.clearTimeout(handle as unknown as Parameters<typeof dom.clearTimeout>[0]); },
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
// Newer happy-dom ships its own Web Animations. These tests run the engine
// with none unless a test installs `fakeAnimate`, whatever version is
// installed: with happy-dom's, a removal leaves its ghost for the real poof.
delete (dom.Element.prototype as unknown as { animate?: unknown }).animate;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement, Fragment } = await import("react");
const { createRoot } = await import("react-dom/client");
const { getRailDrag, useRailDragZone } = await import("../src/railDrag.ts");

interface RailProps {
  zone: string;
  axis: "x" | "y";
  ids: string[];
  remove?: (id: string) => void;
  canRemove?: (id: string) => boolean;
  onCommit?: (order: string[]) => void;
}

/** A stand-in for one rail: real children marked `data-rail-item`. */
function Rail({ zone, axis, ids, remove, canRemove, onCommit }: RailProps) {
  const drag = useRailDragZone({
    id: zone,
    axis,
    ids,
    isDraggable: () => true,
    accepts: () => true,
    commit: (order) => onCommit?.(order),
    ...(remove ? { remove } : {}),
    ...(canRemove ? { canRemove } : {}),
  });
  return createElement(
    "div",
    { className: "rail", ref: drag.ref, "data-zone": zone },
    drag.order.map((entry, index) => entry === null
      ? createElement("span", { key: `slot-${index}`, "data-rail-slot": "true" })
      : createElement("button", { key: entry, ...drag.itemProps(entry) }, entry)),
  );
}

const box = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top }) as DOMRect;

/** Lay a mounted rail out at real rectangles so the zone measures it. */
function place(zone: string, left: number, top: number, axis: "x" | "y", size = 40) {
  const rail = document.querySelector<HTMLElement>(`[data-zone="${zone}"]`)!;
  const items = [...rail.querySelectorAll<HTMLElement>("[data-rail-item]")];
  items.forEach((item, index) => {
    item.getBoundingClientRect = () => axis === "y"
      ? box(left, top + index * size, size, size)
      : box(left + index * size, top, size, size);
  });
  const frame = axis === "y" ? box(left, top, size, size * items.length) : box(left, top, size * items.length, size);
  rail.getBoundingClientRect = () => frame;
}

const tick = (ms = 5) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const pointer = (type: string, x: number, y: number) =>
  window.dispatchEvent(new dom.PointerEvent(type, { pointerId: 1, clientX: x, clientY: y }) as unknown as Event);

/** Press `id` where it sits and drag to `to`; the drag lifts on the way. */
async function lift(id: string, from: [number, number], to: [number, number]) {
  const item = document.querySelector<HTMLElement>(`[data-rail-item="${id}"]`)!;
  await act(async () => {
    item.dispatchEvent(new dom.PointerEvent("pointerdown", {
      bubbles: true, button: 0, pointerId: 1, pointerType: "mouse", clientX: from[0], clientY: from[1],
    }) as unknown as Event);
    pointer("pointermove", to[0], to[1]);
    await tick();
  });
}
const moveTo = (x: number, y: number) => act(async () => { pointer("pointermove", x, y); await tick(); });
const release = (x: number, y: number) => act(async () => { pointer("pointerup", x, y); await tick(30); });
const escape = () => act(async () => {
  window.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as unknown as Event);
  await tick(30);
});

const ghost = () => document.querySelector<HTMLElement>(".rail-drag-ghost");
/** No such element. Never hand a DOM node to `assert` as a value: a failure
 *  serialises it for the reporter, and a happy-dom node drags its whole window
 *  along — tens of GB, enough to take the machine running the tests down. */
const assertNone = (node: Element | null, message: string) =>
  assert.equal(node === null, true, `${message}; found ${node?.outerHTML.slice(0, 160)}`);
/** The verdict of the drag in flight, after checking it is `id`'s: a press
 *  that never lifted must not pass for "not removing". */
const verdict = (id: string): boolean => {
  const state = getRailDrag();
  assert.equal(state?.id, id, `a drag of ${id} is under way`);
  return state?.removing === true;
};
const itemsOf = (zone: string) =>
  [...document.querySelectorAll<HTMLElement>(`[data-zone="${zone}"] [data-rail-item]`)].map((item) => item.dataset.railItem ?? "");

/** Mount the rails side by side. The tests lay the right rail out with
 *  `place("right", 1200, 100, "y")`: a column at x 1200–1240 holding a, b, c at
 *  y 100, 140 and 180, in a 1280×800 window. */
async function mount(rails: RailProps[]) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(Fragment, null, ...rails.map((props) => createElement(Rail, { key: props.zone, ...props })))); });
  return {
    root,
    unmount: async () => {
      if (getRailDrag()) await escape();
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("pulled far from every rail and released, the icon is removed, not moved", async () => {
  const removed: string[] = [];
  const commits: string[][] = [];
  const view = await mount([{ zone: "right", axis: "y", ids: ["a", "b", "c"], remove: (id) => removed.push(id), onCommit: (order) => commits.push(order) }]);
  try {
    place("right", 1200, 100, "y");
    await lift("b", [1220, 160], [1100, 200]);

    assert.equal(getRailDrag()?.removing, true, "100px from the rail: armed");
    assert.equal(ghost()?.dataset.removing, "true", "the ghost wears the verdict");
    assert.equal(ghost()?.querySelector(".rail-drag-ghost-label")?.textContent, "Remove", "with its pill");
    assert.equal(document.body.dataset.railDragOver, "remove");
    assert.deepEqual(itemsOf("right"), ["a", "c"], "the neighbours closed over b's place");

    await release(1100, 200);
    assert.deepEqual(removed, ["b"], "handed to the rail that held it");
    assert.deepEqual(commits, [], "nothing was reordered");
    assert.equal(getRailDrag(), null);
    assert.equal(document.body.dataset.railDragging, undefined);
    assertNone(ghost(), "the ghost is gone (no animation engine here: no poof)");
  } finally { await view.unmount(); }
});

test("the pill rides above the ghost, and drops below it where the window has no room", async () => {
  const view = await mount([{ zone: "right", axis: "y", ids: ["a", "b", "c"], remove: () => {} }]);
  try {
    place("right", 1200, 100, "y");
    await lift("b", [1220, 160], [700, 400]);
    assert.equal(verdict("b"), true);
    assert.equal(ghost()?.dataset.label, undefined, "above by default");
    await moveTo(700, 25);
    assert.equal(verdict("b"), true, "still far from every rail");
    assert.equal(ghost()?.dataset.label, "below", "the ghost is at the top edge: its pill would be cut off");
    await moveTo(700, 300);
    assert.equal(ghost()?.dataset.label, undefined, "and back above once there is room");
    await escape();
  } finally { await view.unmount(); }
});

test("between the hit area and the line, a release still puts the icon back", async () => {
  const removed: string[] = [];
  const commits: string[][] = [];
  const view = await mount([{ zone: "right", axis: "y", ids: ["a", "b", "c"], remove: (id) => removed.push(id), onCommit: (order) => commits.push(order) }]);
  try {
    place("right", 1200, 100, "y");
    // 28px of hit area, then the 50px line, measured to the rail's left edge.
    await lift("b", [1220, 160], [1160, 160]);
    assert.equal(getRailDrag()?.over, null, "outside the hit area");
    assert.equal(verdict("b"), false, "40px away: still near");
    assert.deepEqual(itemsOf("right"), ["a", "b", "c"], "the hole stays, so release reads as put back");
    assert.notEqual(ghost()?.dataset.removing, "true");

    await moveTo(1150, 160);
    assert.equal(verdict("b"), false, "exactly 50px is not past the line");
    await moveTo(1149, 160);
    assert.equal(verdict("b"), true, "past it");

    await moveTo(1160, 160);
    assert.equal(verdict("b"), false, "back within the give: put back again");
    await release(1160, 160);
    assert.deepEqual(removed, []);
    assert.deepEqual(commits, [], "dropped on nothing: no reorder either");
    assert.equal(getRailDrag(), null);
  } finally { await view.unmount(); }
});

test("a pointer on the line does not flicker the verdict", async () => {
  const view = await mount([{ zone: "right", axis: "y", ids: ["a", "b", "c"], remove: () => {} }]);
  try {
    place("right", 1200, 100, "y");
    await lift("b", [1220, 160], [1100, 160]);
    assert.equal(verdict("b"), true);
    // 48 and 45px from the rail: past the give-back line (44), still armed.
    await moveTo(1152, 160);
    assert.equal(verdict("b"), true);
    await moveTo(1155, 160);
    assert.equal(verdict("b"), true);
    await moveTo(1156, 160);
    assert.equal(verdict("b"), false, "44px: disarmed");
    await moveTo(1151, 160);
    assert.equal(verdict("b"), false, "and re-arming takes the full 50");
  } finally { await view.unmount(); }
});

test("Escape cancels an armed removal", async () => {
  const removed: string[] = [];
  const view = await mount([{ zone: "right", axis: "y", ids: ["a", "b", "c"], remove: (id) => removed.push(id) }]);
  try {
    place("right", 1200, 100, "y");
    await lift("b", [1220, 160], [1000, 400]);
    assert.equal(verdict("b"), true);
    await escape();
    assert.deepEqual(removed, []);
    assert.equal(getRailDrag(), null);
    assert.equal(ghost(), null);
    assert.deepEqual(itemsOf("right"), ["a", "b", "c"], "b is back in its place");
  } finally { await view.unmount(); }
});

test("a pointer that left the window is a lost drag, never a removal", async () => {
  const removed: string[] = [];
  const view = await mount([{ zone: "right", axis: "y", ids: ["a", "b", "c"], remove: (id) => removed.push(id) }]);
  try {
    place("right", 1200, 100, "y");
    for (const [x, y] of [[-30, 300], [600, -20], [600, 900], [1400, 300]] as const) {
      await lift("b", [1220, 160], [x, y]);
      assert.equal(verdict("b"), false, `${x},${y} is off screen`);
      await release(x, y);
      assert.deepEqual(removed, [], `${x},${y}`);
    }
  } finally { await view.unmount(); }
});

test("a rail that cannot lose the icon never offers to remove it", async () => {
  const removed: string[] = [];
  const view = await mount([
    { zone: "right", axis: "y", ids: ["a", "b", "c"], remove: (id) => removed.push(id), canRemove: (id) => id !== "b" },
    { zone: "top", axis: "x", ids: ["t1", "t2"], onCommit: () => {} },
  ]);
  try {
    place("right", 1200, 100, "y");
    place("top", 300, 0, "x");
    // A locked icon on a rail that removes.
    await lift("b", [1220, 160], [700, 500]);
    assert.equal(verdict("b"), false);
    assertNone(ghost()!.querySelector(".rail-drag-ghost-label"), "no pill promising what will not happen");
    await release(700, 500);
    // A rail with no `remove` at all.
    await lift("t1", [320, 20], [700, 500]);
    assert.equal(verdict("t1"), false);
    assertNone(ghost()!.querySelector(".rail-drag-ghost-label"), "no pill on a rail that never removes");
    await release(700, 500);
    // The removable neighbour still works.
    await lift("a", [1220, 120], [700, 500]);
    assert.equal(verdict("a"), true);
    assert.ok(ghost()?.querySelector(".rail-drag-ghost-label"));
    await release(700, 500);
    assert.deepEqual(removed, ["a"]);
  } finally { await view.unmount(); }
});

test("near any rail is not far: the project rail counts, and a drop on another rail wins", async () => {
  const removed: string[] = [];
  const commits: string[][] = [];
  const region = document.createElement("div");
  region.setAttribute("data-rail-region", "");
  region.getBoundingClientRect = () => box(0, 0, 49, 800);
  document.body.appendChild(region);
  const view = await mount([
    { zone: "right", axis: "y", ids: ["a", "b", "c"], remove: (id) => removed.push(id) },
    { zone: "top", axis: "x", ids: ["t1", "t2"], onCommit: (order) => commits.push(order) },
  ]);
  try {
    place("right", 1200, 100, "y");
    place("top", 400, 0, "x");
    // Beside the project rail (31px) nothing is removed; further out it is.
    await lift("b", [1220, 160], [80, 300]);
    assert.equal(verdict("b"), false, "31px from the project rail");
    await moveTo(110, 300);
    assert.equal(verdict("b"), true, "61px from it");
    // On another rail the verdict gives way to the drop.
    await moveTo(450, 20);
    assert.equal(getRailDrag()?.over, "top");
    assert.equal(verdict("b"), false);
    await release(450, 20);
    assert.deepEqual(removed, [], "moved, not removed");
    assert.equal(commits.length, 1);
    assert.ok(commits[0]!.includes("b"), JSON.stringify(commits));
  } finally {
    await view.unmount();
    region.remove();
  }
});

// ---------------------------------------------------------------- the poof

type Handler = () => void;
class FakeAnimation {
  private handlers = new Map<string, Handler[]>();
  addEventListener(type: string, handler: Handler) { this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]); }
  fire(type: "finish" | "cancel") { for (const handler of this.handlers.get(type) ?? []) handler(); }
}

/** Give happy-dom the one Web Animations method the engine reaches for. */
function fakeAnimate() {
  const made: Array<{ target: Element; keyframes: unknown; options: Record<string, unknown>; animation: FakeAnimation }> = [];
  const prototype = dom.HTMLElement.prototype as unknown as { animate?: unknown };
  prototype.animate = function (this: Element, keyframes: unknown, options: Record<string, unknown>) {
    const animation = new FakeAnimation();
    made.push({ target: this, keyframes, options, animation });
    return animation;
  };
  return { made, restore: () => { delete prototype.animate; } };
}

test("the icon goes in a puff of smoke that clears itself", async () => {
  const removed: string[] = [];
  const view = await mount([{ zone: "right", axis: "y", ids: ["a", "b", "c"], remove: (id) => removed.push(id) }]);
  const motion = fakeAnimate();
  try {
    place("right", 1200, 100, "y");
    await lift("b", [1220, 160], [1000, 400]);
    motion.made.length = 0;
    const leaving = ghost()!;
    await release(1000, 400);

    assert.deepEqual(removed, ["b"]);
    const cloud = document.querySelector(".rail-poof");
    assert.ok(cloud, "a cloud blooms where the icon was let go");
    assert.equal(cloud.querySelectorAll(".rail-poof-puff").length, 7, "a core and a fan of puffs");
    const puffs = motion.made.filter((entry) => entry.target.classList.contains("rail-poof-puff"));
    assert.equal(puffs.length, 14, "each puff moves and fades on its own curve");
    const fades = puffs.filter((entry) => "opacity" in (entry.keyframes as Array<object>)[0]!);
    const moves = puffs.filter((entry) => "transform" in (entry.keyframes as Array<object>)[0]!);
    assert.equal(fades.length, 7);
    assert.equal(moves.length, 7);
    for (const puff of fades) {
      const frames = puff.keyframes as Array<{ opacity: number }>;
      assert.deepEqual([frames[0]!.opacity, frames.at(-1)!.opacity], [0, 0], "each puff blooms from nothing and fades out");
    }
    for (const puff of puffs) {
      assert.ok((puff.options.duration as number) + (puff.options.delay as number) <= 480, "inside the cloud's lifetime");
    }
    const dissolve = motion.made.find((entry) => entry.target.classList.contains("rail-drag-ghost-body"));
    assert.ok(dissolve, "the icon itself dissolves");
    assert.ok(document.body.contains(leaving), "the ghost stays until it has dissolved");
    assert.equal(getRailDrag(), null, "yet the rails are already free");
    assert.equal(document.body.dataset.railDragging, undefined);

    dissolve.animation.fire("finish");
    assert.equal(document.body.contains(leaving), false, "dissolved: gone");
    assert.ok(document.querySelector(".rail-poof"), "the smoke is still drifting");
    for (const puff of puffs) puff.animation.fire("finish");
    assertNone(document.querySelector(".rail-poof"), "and then it clears");
  } finally {
    motion.restore();
    await view.unmount();
  }
});

test("a cloud whose animations never report back is still cleared", async () => {
  const view = await mount([{ zone: "right", axis: "y", ids: ["a", "b", "c"], remove: () => {} }]);
  const motion = fakeAnimate();
  try {
    place("right", 1200, 100, "y");
    await lift("b", [1220, 160], [1000, 400]);
    const leaving = ghost()!;
    await release(1000, 400);
    assert.ok(document.querySelector(".rail-poof"));
    await tick(760);
    assertNone(document.querySelector(".rail-poof"), "a hidden page stops animations, not the cleanup");
    assert.equal(document.body.contains(leaving), false);
  } finally {
    motion.restore();
    await view.unmount();
  }
});

test("reduced motion removes the icon with no smoke at all", async () => {
  const removed: string[] = [];
  const view = await mount([{ zone: "right", axis: "y", ids: ["a", "b", "c"], remove: (id) => removed.push(id) }]);
  const motion = fakeAnimate();
  document.documentElement.dataset.reduceAnimations = "true";
  try {
    place("right", 1200, 100, "y");
    await lift("b", [1220, 160], [1000, 400]);
    await release(1000, 400);
    assert.deepEqual(removed, ["b"], "still removed");
    assertNone(document.querySelector(".rail-poof"), "no smoke");
    assertNone(ghost(), "and no ghost left behind");
    assert.equal(motion.made.some((entry) => entry.target.classList.contains("rail-poof-puff")), false);
  } finally {
    delete document.documentElement.dataset.reduceAnimations;
    motion.restore();
    await view.unmount();
  }
});

test("smoke that cannot be drawn never strands the icon or the rails", async () => {
  const removed: string[] = [];
  const view = await mount([{ zone: "right", axis: "y", ids: ["a", "b", "c"], remove: (id) => removed.push(id) }]);
  const prototype = dom.HTMLElement.prototype as unknown as { animate?: unknown };
  prototype.animate = () => { throw new Error("no animations here"); };
  try {
    place("right", 1200, 100, "y");
    await lift("b", [1220, 160], [1000, 400]);
    await release(1000, 400);
    assert.deepEqual(removed, ["b"], "the removal does not wait for the show");
    assert.equal(getRailDrag(), null);
    assertNone(ghost(), "the ghost is not left floating");
    await lift("a", [1220, 120], [1000, 400]);
    assert.equal(getRailDrag()?.id, "a", "and the next drag starts normally");
    await escape();
  } finally {
    delete prototype.animate;
    await view.unmount();
  }
});

test("a throwing remove still frees the rails", async () => {
  const view = await mount([{ zone: "right", axis: "y", ids: ["a", "b", "c"], remove: () => { throw new Error("boom"); } }]);
  try {
    place("right", 1200, 100, "y");
    await lift("b", [1220, 160], [1000, 400]);
    // A listener's exception is reported on the window, not thrown at the sender.
    const reported: string[] = [];
    const onError = (event: Event) => {
      event.preventDefault();
      reported.push(String((event as unknown as { message?: string }).message));
    };
    window.addEventListener("error", onError);
    try {
      await release(1000, 400);
    } finally { window.removeEventListener("error", onError); }
    assert.ok(reported.some((message) => message.includes("boom")), JSON.stringify(reported));
    assert.equal(getRailDrag(), null, "the drag is over whatever the store did");
    assert.equal(document.body.dataset.railDragging, undefined);
    // The next drag starts normally.
    await lift("a", [1220, 120], [1000, 400]);
    assert.equal(getRailDrag()?.id, "a");
    await escape();
  } finally { await view.unmount(); }
});

// ---------------------------------------------------------------- wiring

const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

test("the launcher rails opt in, the editor's list and the view tabs do not", () => {
  const header = source("components/Header.tsx");
  assert.match(header, /id: "top",[\s\S]*?remove: \(id\) => removeRailItem\("top", id\),\s*canRemove: railItemRemovable/);
  assert.match(header, /id: "header",[\s\S]*?remove: \(id\) => removeRailItem\("header", id\),\s*canRemove: railItemRemovable/);
  assert.match(source("components/ContextRail.tsx"), /id: "right",[\s\S]*?remove: \(id\) => removeRailItem\("right", id\),\s*canRemove: railItemRemovable/);
  // A row dragged out of the editor, or a tab out of the header, is put back.
  for (const path of ["components/RailEditor.tsx", "components/HeaderViewTabs.tsx"]) {
    const zone = /useRailDragZone\(\{[\s\S]*?\n  \}\);/.exec(source(path))?.[0];
    assert.ok(zone, `${path} registers a drag zone`);
    assert.doesNotMatch(zone, /\bremove:|\bcanRemove:/, path);
  }
});

test("the project rail declares itself a rail an icon must stay clear of", () => {
  assert.match(source("components/Sidebar.tsx"), /className="sidebar-project-rail" data-rail-region/);
});
