// Carrying a launcher into a rail from OUTSIDE every rail (the Custom actions
// window): the HTML5 drag marks the rail it hovers with a landing slot and
// persists the drop through the same commit a rail-to-rail drag uses.
import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  Element: dom.Element,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  requestAnimationFrame: (callback: FrameRequestCallback) => dom.setTimeout(() => callback(Date.now()), 0) as unknown as number,
  cancelAnimationFrame: (handle: number) => { dom.clearTimeout(handle as unknown as Parameters<typeof dom.clearTimeout>[0]); },
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MIME = "application/x-polyth-capability";

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useRailDragZone, beginExternalRailDrag, endExternalRailDrag, EXTERNAL_RAIL_SOURCE } =
  await import("../src/railDrag.ts");

/** A stand-in for one rail: real children marked `data-rail-item`, at real
 *  rectangles, so the zone measures them the way a rail would. */
function Rail({ ids, accepts, onCommit }: { ids: string[]; accepts: (id: string) => boolean; onCommit: (order: string[]) => void }) {
  const drag = useRailDragZone({
    id: "right",
    axis: "y",
    ids,
    isDraggable: () => true,
    accepts,
    externalMime: MIME,
    commit: (next) => onCommit(next),
  });
  return createElement(
    "div",
    { className: "rail", ...drag.dropProps, ref: drag.ref, "data-target": drag.targeted ? "yes" : "no" },
    drag.order.map((entry, index) => entry === null
      ? createElement("span", { key: `slot-${index}`, "data-rail-slot": "true", className: "slot" })
      : createElement("button", { key: entry, "data-rail-item": entry, className: "item" }, entry)),
  );
}

/** Lay the items out along the rail axis so insertion indices are real. */
function stack(top: number, height: number) {
  for (const [index, item] of [...document.querySelectorAll<HTMLElement>("[data-rail-item]")].entries()) {
    const rect = { left: 0, top: top + index * height, width: 32, height, right: 32, bottom: top + (index + 1) * height, x: 0, y: top + index * height };
    item.getBoundingClientRect = () => rect as DOMRect;
  }
}

const transfer = (types: string[], data: Record<string, string> = {}) => ({
  types, getData: (type: string) => data[type] ?? "", setData: () => {}, dropEffect: "none", effectAllowed: "all",
});
const dragEvent = (type: string, clientY: number, types: string[], relatedTarget: EventTarget | null = null, data?: Record<string, string>) => {
  const event = new dom.Event(type, { bubbles: true, cancelable: true }) as unknown as Event & {
    clientX: number; clientY: number; dataTransfer: unknown; relatedTarget: EventTarget | null; defaultPrevented: boolean;
  };
  Object.assign(event, { clientX: 16, clientY, dataTransfer: transfer(types, data), relatedTarget });
  return event;
};
/** What a rail sees while a capability is carried in from another window. */
const carried = (id: string) => ({ [MIME]: id });

test("an icon dragged in from outside opens a landing slot and commits where it was dropped", async () => {
  const commits: string[][] = [];
  const mount = document.createElement("div");
  document.body.append(mount);
  const root = createRoot(mount);
  try {
    await act(async () => root.render(createElement(Rail, {
      ids: ["alpha", "beta", "gamma"],
      accepts: (id: string) => id === "custom-action.run.deploy",
      onCommit: (order: string[]) => commits.push(order),
    })));
    stack(100, 32);
    const rail = mount.querySelector<HTMLElement>(".rail")!;
    const items = () => [...mount.querySelectorAll("[data-rail-item]")].map((node) => (node as HTMLElement).dataset.railItem);

    assert.deepEqual(items(), ["alpha", "beta", "gamma"]);

    // Hovering the rail carries the capability and previews an empty landing slot.
    await act(async () => { beginExternalRailDrag("custom-action.run.deploy"); });
    const over = dragEvent("dragover", 148, [MIME], null, carried("custom-action.run.deploy"));
    await act(async () => { rail.dispatchEvent(over as unknown as Event); });
    assert.equal(over.defaultPrevented, true, "the rail accepts the drop");
    assert.equal(rail.dataset.target, "yes");
    // The landing slot sits where the icon would go, just after alpha
    // (148 is past alpha's centre at 116 and before beta's at 148): every
    // real item is still there, in order.
    assert.deepEqual(items(), ["alpha", "beta", "gamma"]);
    assert.deepEqual(
      [...rail.children].map((node) => node.hasAttribute("data-rail-slot") ? "<slot>" : (node as HTMLElement).dataset.railItem),
      ["alpha", "<slot>", "beta", "gamma"],
    );
    assert.deepEqual(commits, [], "hovering persists nothing");

    // Dropping below the last item lands it at the end.
    await act(async () => { rail.dispatchEvent(dragEvent("drop", 500, [MIME], null, carried("custom-action.run.deploy")) as unknown as Event); });
    assert.deepEqual(commits, [["alpha", "beta", "gamma", "custom-action.run.deploy"]]);
    await act(async () => { endExternalRailDrag(); });
    assert.equal(document.body.dataset.railDragging, undefined, "the drag state is released");
  } finally {
    await act(async () => root.unmount());
    mount.remove();
  }
});

test("dropping above the first item lands it first, and the index is frozen at the first hover", async () => {
  const commits: string[][] = [];
  const mount = document.createElement("div");
  document.body.append(mount);
  const root = createRoot(mount);
  try {
    await act(async () => root.render(createElement(Rail, {
      ids: ["alpha", "beta"],
      accepts: () => true,
      onCommit: (order: string[]) => commits.push(order),
    })));
    stack(100, 32);
    const rail = mount.querySelector<HTMLElement>(".rail")!;

    await act(async () => { beginExternalRailDrag("custom-action.run.deploy"); });
    // Two hovers at the same point: the slot the first one opened must not
    // shift the centres the second one counts against.
    await act(async () => { rail.dispatchEvent(dragEvent("dragover", 90, [MIME], null, carried("custom-action.run.deploy")) as unknown as Event); });
    await act(async () => { rail.dispatchEvent(dragEvent("dragover", 90, [MIME], null, carried("custom-action.run.deploy")) as unknown as Event); });
    await act(async () => { rail.dispatchEvent(dragEvent("drop", 90, [MIME], null, carried("custom-action.run.deploy")) as unknown as Event); });
    assert.deepEqual(commits, [["custom-action.run.deploy", "alpha", "beta"]]);
  } finally {
    await act(async () => { endExternalRailDrag(); });
    await act(async () => root.unmount());
    mount.remove();
  }
});

test("a rail that cannot hold the icon refuses the drop and shows no slot", async () => {
  const commits: string[][] = [];
  const mount = document.createElement("div");
  document.body.append(mount);
  const root = createRoot(mount);
  try {
    await act(async () => root.render(createElement(Rail, {
      ids: ["alpha"],
      accepts: () => false,
      onCommit: (order: string[]) => commits.push(order),
    })));
    stack(100, 32);
    const rail = mount.querySelector<HTMLElement>(".rail")!;

    await act(async () => { beginExternalRailDrag("custom-action.run.other-project"); });
    const over = dragEvent("dragover", 110, [MIME], null, carried("custom-action.run.other-project"));
    await act(async () => { rail.dispatchEvent(over as unknown as Event); });
    assert.equal(over.defaultPrevented, false, "the rail says no");
    assert.equal(rail.dataset.target, "no");
    assert.equal(mount.querySelectorAll("[data-rail-slot]").length, 0);
    assert.deepEqual([...mount.querySelectorAll("[data-rail-item]")].map((node) => (node as HTMLElement).dataset.railItem), ["alpha"]);

    await act(async () => { rail.dispatchEvent(dragEvent("drop", 110, [MIME], null, carried("custom-action.run.other-project")) as unknown as Event); });
    assert.deepEqual(commits, [], "an unwelcome icon is never placed");
  } finally {
    await act(async () => { endExternalRailDrag(); });
    await act(async () => root.unmount());
    mount.remove();
  }
});

test("an unrelated HTML5 drag is ignored entirely", async () => {
  const mount = document.createElement("div");
  document.body.append(mount);
  const root = createRoot(mount);
  try {
    await act(async () => root.render(createElement(Rail, { ids: ["alpha"], accepts: () => true, onCommit: () => {} })));
    stack(100, 32);
    const rail = mount.querySelector<HTMLElement>(".rail")!;
    const over = dragEvent("dragover", 110, ["text/plain"]);
    await act(async () => { rail.dispatchEvent(over as unknown as Event); });
    assert.equal(over.defaultPrevented, false);
    assert.equal(mount.querySelectorAll("[data-rail-slot]").length, 0);
  } finally {
    await act(async () => root.unmount());
    mount.remove();
  }
});

test("the external source is not a rail: no rail draws its hole", async () => {
  const { previewOrder, finalOrder } = await import("../src/railDrag.ts");
  const ids = ["alpha", "beta"];
  const dragging = { id: "custom-action.run.deploy", from: EXTERNAL_RAIL_SOURCE, over: "right" as const, index: 1, phase: "dragging" as const };
  assert.deepEqual(previewOrder(ids, "right", dragging), ["alpha", null, "beta"]);
  assert.deepEqual(finalOrder(ids, dragging), ["alpha", "custom-action.run.deploy", "beta"]);
  assert.deepEqual(previewOrder(ids, "top", dragging), ids, "an uninvolved rail is untouched");
  // Hovering nowhere: an external drag leaves every rail exactly as it was.
  assert.deepEqual(previewOrder(ids, "right", { ...dragging, over: null }), ids);
});

test("the host arms the rails from a document dragstart, and disarms on dragend", async () => {
  const dnd = await import("../src/dnd.ts");
  const railDrag = await import("../src/railDrag.ts");
  const stop = dnd.installExternalCapabilityDrag();
  const transfer = (types: string[], data: Record<string, string> = {}) => ({
    types, getData: (type: string) => data[type] ?? "", setData: () => {}, dropEffect: "none", effectAllowed: "all",
  });
  const start = (types: string[], data?: Record<string, string>) => {
    const event = new dom.Event("dragstart", { bubbles: true, cancelable: true });
    Object.assign(event, { dataTransfer: transfer(types, data) });
    // Bubble phase: the source's own handler has already filled the payload.
    document.body.dispatchEvent(event as unknown as Event);
  };
  try {
    // A file or text drag is none of the rails' business.
    start(["Files"]);
    assert.equal(railDrag.getRailDrag(), null);
    assert.equal(document.body.dataset.railDragging, undefined);

    // A capability drag carrying its id arms them right away (Chromium).
    start([MIME, "text/plain"], carried("custom-action.run.deploy"));
    assert.equal(railDrag.getRailDrag()?.id, "custom-action.run.deploy");
    assert.equal(document.body.dataset.railDragging, "true");

    document.body.dispatchEvent(new dom.Event("dragend", { bubbles: true }) as unknown as Event);
    assert.equal(railDrag.getRailDrag(), null);
    assert.equal(document.body.dataset.railDragging, undefined);

    // Firefox hides the payload during dragstart: the rails arm with no id,
    // and the first rail that sees the drag resolves it.
    start([MIME]);
    assert.equal(railDrag.getRailDrag()?.id, "", "armed, id not readable yet");
    assert.equal(railDrag.resolveExternalRailDrag("custom-action.run.deploy"), "custom-action.run.deploy");
    assert.equal(railDrag.getRailDrag()?.id, "custom-action.run.deploy");
    railDrag.endExternalRailDrag();
    assert.equal(railDrag.getRailDrag(), null);
  } finally {
    stop();
  }
});
