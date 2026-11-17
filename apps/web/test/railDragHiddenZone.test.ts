// A rail the window layout collapses while it is empty (shellLayout.css hides
// an empty docked group) has no box to measure. It must not become a drop
// target at the window origin, and it must be measured again where it really
// is once a drag brings it back.
import test from "node:test";
import assert from "node:assert/strict";
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
// Run the engine with no Web Animations, so a drop settles at once.
delete (dom.Element.prototype as unknown as { animate?: unknown }).animate;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { getRailDrag, useRailDragZone } = await import("../src/railDrag.ts");

function Rail({ zone, axis, ids, onCommit }: {
  zone: string;
  axis: "x" | "y";
  ids: string[];
  onCommit: (order: string[]) => void;
}) {
  const drag = useRailDragZone({
    id: zone,
    axis,
    ids,
    isDraggable: () => true,
    accepts: () => true,
    commit: (order) => onCommit(order),
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
/** Lay a rail and its items out along the rail's axis; without a frame they
 *  stay unlaid-out (0×0), as a `display: none` group measures. */
function place(zone: string, axis: "x" | "y", frame?: DOMRect, itemSize = 40) {
  const rail = document.querySelector<HTMLElement>(`[data-zone="${zone}"]`)!;
  const items = [...rail.querySelectorAll<HTMLElement>("[data-rail-item]")];
  items.forEach((item, index) => {
    item.getBoundingClientRect = () => frame
      ? box(
        axis === "x" ? frame.left + index * itemSize : frame.left,
        axis === "y" ? frame.top + index * itemSize : frame.top,
        itemSize,
        itemSize,
      )
      : box(0, 0, 0, 0);
  });
  rail.getBoundingClientRect = () => frame ?? box(0, 0, 0, 0);
}

const tick = (ms = 5) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const pointer = (type: string, x: number, y: number) =>
  window.dispatchEvent(new dom.PointerEvent(type, { pointerId: 1, clientX: x, clientY: y }) as unknown as Event);
const moveTo = (x: number, y: number) => act(async () => { pointer("pointermove", x, y); await tick(); });
const release = (x: number, y: number) => act(async () => { pointer("pointerup", x, y); await tick(30); });

/** Press `id` where it sits and move past the drag threshold to lift it. */
async function lift(id: string, from: [number, number]) {
  const item = document.querySelector<HTMLElement>(`[data-rail-item="${id}"]`)!;
  await act(async () => {
    item.dispatchEvent(new dom.PointerEvent("pointerdown", {
      bubbles: true, button: 0, pointerId: 1, pointerType: "mouse", clientX: from[0], clientY: from[1],
    }) as unknown as Event);
    pointer("pointermove", from[0] + 8, from[1]);
    await tick();
  });
}

test("an empty rail measured at 0×0 is no target at the origin, and is measured where it reappears", async () => {
  const commits: string[][] = [];
  const mount = document.createElement("div");
  document.body.append(mount);
  const root = createRoot(mount);
  try {
    await act(async () => root.render(createElement("div", null,
      createElement(Rail, { key: "top", zone: "top", axis: "x", ids: ["alpha", "beta"], onCommit: (order) => commits.push(order) }),
      createElement(Rail, { key: "end", zone: "end", axis: "y", ids: [], onCommit: (order) => commits.push(order) }),
    )));
    place("top", "x", box(100, 100, 80, 40));
    // The empty group is collapsed by the layout: connected, but unmeasurable.
    place("end", "y");

    await lift("alpha", [110, 120]);
    assert.equal(getRailDrag()?.id, "alpha", "the drag is in the air");
    assert.equal(document.body.dataset.railDragging, "true", "the window shows the landing space while a launcher is lifted");
    assert.equal(getRailDrag()?.over, "top", "it starts in its own rail");

    // The window origin is inside the zone tolerance, but a rail with no
    // layout is not there: nothing may land at (0,0).
    await moveTo(5, 5);
    assert.notEqual(getRailDrag()?.over, "end", "a collapsed rail is not a target at the window origin");

    // A drag brings the group back at its place; the first hover measures it
    // there, not at the origin.
    place("end", "y", box(600, 100, 40, 200));
    await moveTo(610, 130);
    assert.equal(getRailDrag()?.over, "end", "the reappeared rail takes the launcher");

    await release(610, 130);
    assert.deepEqual(commits, [["alpha"]], "the launcher lands in the empty rail");
    assert.equal(document.body.dataset.railDragging, undefined, "the drag state is released");
    assert.equal(getRailDrag(), null);
  } finally {
    await act(async () => root.unmount());
    mount.remove();
  }
});
