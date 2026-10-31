// The phone Workspace editor, mounted for real (happy-dom): Edit shows the
// arrangement with per-item controls; the Add page is a full page of the same
// sheet that searches, filters, adds and takes off; minus removes with Undo;
// keys and pointer drags reorder (geometry is mocked: happy-dom has no layout),
// and an order is saved once, when the item lands.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { Project } from "@polyth/contracts";

const dom = new Window({ url: "http://localhost:3000/" });
// Web Animations: cancel() rejects `finished` with an AbortError the spec marks
// handled, so a page never sees it. happy-dom leaves it unhandled, which
// fails the run, so mark it handled here as a browser does.
const cancelAnimation = dom.Animation.prototype.cancel;
dom.Animation.prototype.cancel = function cancel(this: InstanceType<typeof dom.Animation>) {
  void this.finished.catch(() => undefined);
  cancelAnimation.call(this);
};
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  Event: dom.Event,
  getComputedStyle: (elt: Element, pseudo?: string | null) =>
    (dom as unknown as { getComputedStyle(el: Element, pseudo?: string | null): CSSStyleDeclaration })
      .getComputedStyle(elt, pseudo),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
Object.defineProperty(globalThis, "location", { value: dom.location, configurable: true });
Object.defineProperty(globalThis, "HTMLElement", {
  value: (dom as unknown as { HTMLElement: typeof HTMLElement }).HTMLElement,
  configurable: true,
});
Object.defineProperty(dom, "requestAnimationFrame", {
  configurable: true,
  value: (callback: FrameRequestCallback) => setTimeout(() => callback(dom.performance.now()), 4) as unknown as number,
});
Object.defineProperty(dom, "cancelAnimationFrame", { configurable: true, value: (id: number) => clearTimeout(id) });
Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: dom.requestAnimationFrame });
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: dom.cancelAnimationFrame });
Object.defineProperty(dom, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    matches: query.includes("max-width: 480px") || query.includes("max-width: 960px"),
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
(globalThis as { fetch?: unknown }).fetch = async () => ({ ok: true, status: 200, statusText: "OK", json: async () => [], text: async () => "[]" });

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const store = await import("../src/store.ts");
const { registerCapability } = await import("../src/capabilities.ts");
const { registerWidget } = await import("../src/widgets/catalog.ts");
const { default: WorkspacePanel } = await import("../src/components/mobile/WorkspacePanel.tsx");

const PROJECT = "alpha";
const KEY = `polyth.workspacePanel.v1.${PROJECT}`;
for (const [rank, id, label] of [[1, "files", "Files"], [2, "browser", "Browser"], [3, "terminal", "Terminal"], [4, "git", "Git"]] as const) {
  registerCapability({
    id,
    ownerPackageId: id,
    label,
    plainDescription: `Open ${label}`,
    keywords: [id],
    standardTier: "more",
    standardRank: rank,
    open: () => {},
    available: () => true,
  });
}
const render = () => createElement("p", null, "live widget");
registerWidget({ id: "usage.limits", pluginId: "usage", title: "Usage limits", description: "Provider limits", render });
registerWidget({ id: "markets.watchlist", pluginId: "markets", title: "Watchlist", description: "Prices you follow", duplicatable: true, render });
registerWidget({ id: "markets.news", pluginId: "markets", title: "Market news", description: "Headlines", render });

const sleep = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
const sheet = () => document.querySelector<HTMLElement>(".workspace-panel-sheet")!;
const order = () => [...document.querySelectorAll<HTMLElement>(".workspace-editor-grid [data-arrange-id]")].map((item) => item.dataset.arrangeId);
const stored = () => (JSON.parse(localStorage.getItem(KEY) ?? "{\"items\":[]}") as { items: { id: string }[] }).items.map((item) => item.id);
const item = (id: string) => [...document.querySelectorAll<HTMLElement>("[data-arrange-id]")].find((node) => node.dataset.arrangeId === id)!;

async function click(element: Element | null) {
  assert.ok(element, "the control is there");
  await act(async () => { element.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as unknown as Event); });
}

async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
  });
}

async function key(element: Element, name: string) {
  await act(async () => {
    element.dispatchEvent(new dom.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }) as unknown as Event);
  });
}

async function mount(items: string[], onClose: () => void = () => {}) {
  localStorage.setItem(KEY, JSON.stringify({
    version: 1,
    items: items.map((id) => ({
      id,
      definitionId: id,
      type: id.startsWith("launcher:") ? "launcher" : id.startsWith("widget:") ? "widget" : id.slice("layout:".length),
      size: id.startsWith("layout:") ? "wide" : "compact",
      config: {},
    })),
  }));
  const ticket = store.beginProjectListRequest();
  store.publishProjectList(ticket, [{ id: PROJECT, path: "/work/alpha", name: "alpha", createdAt: 1 } satisfies Project]);
  store.activateProject(PROJECT);
  const container = document.createElement("div");
  container.className = "app";
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(WorkspacePanel, { onClose })); });
  // Editing is a mode: the header's Edit switch turns it on.
  await click(document.querySelector(".sheet-head-switch"));
  return async () => {
    await act(async () => { root.unmount(); });
    container.remove();
  };
}

test("Edit shows the arrangement; the Add page searches, filters, adds and takes off", async () => {
  const unmount = await mount(["launcher:files", "launcher:browser", "widget:usage.limits"]);
  try {
    assert.equal(document.querySelector(".sheet-title")?.textContent, "Edit Workspace");
    assert.deepEqual(order(), ["launcher:files", "launcher:browser", "widget:usage.limits"]);
    assert.equal(document.querySelectorAll(".workspace-editor-remove").length, 3, "every item has its minus");
    assert.equal(document.querySelectorAll("[data-arrange-grip]").length, 1, "rows have a grip; tiles are their own handle");
    assert.equal(document.querySelector(".workspace-editor .workspace-panel-widget-body") === null, true, "no live widget in edit mode");

    await click(document.querySelector(".workspace-editor-add"));
    const page = sheet().querySelector<HTMLElement>(":scope > .workspace-gallery");
    assert.ok(page, "the Add page is the sheet's own layer, not a nested box");
    assert.ok(sheet().classList.contains("is-gallery-open"));
    assert.equal(document.querySelector(".workspace-editor")?.hasAttribute("inert"), true, "the covered editor is inert");
    const sections = [...page.querySelectorAll(".workspace-gallery-section-head > span")].map((node) => node.textContent);
    assert.equal(sections[0], "Apps");
    assert.equal(sections.at(-1), "Layout");
    assert.ok(sections.indexOf("Markets") < sections.indexOf("Usage"), sections.join(", "));

    const search = page.querySelector<HTMLInputElement>(".workspace-gallery-search input")!;
    await type(search, "WATCH prices");
    const cards = [...page.querySelectorAll<HTMLButtonElement>(".workspace-gallery-card")];
    assert.equal(cards.length, 1);
    assert.equal(cards[0]!.querySelector("mark")?.textContent, "Watch");
    assert.equal(cards[0]!.getAttribute("aria-label"), "Add Watchlist");
    await click(cards[0]!);
    assert.equal(stored().at(-1), "widget:markets.watchlist", "a widget goes to the end");
    assert.equal(page.querySelector(".workspace-gallery-card")?.getAttribute("aria-label"), "Add another Watchlist");
    assert.equal(page.querySelector(".workspace-gallery-card-badge")?.textContent, "×1");

    await type(search, "nothing like this");
    assert.match(page.querySelector(".workspace-gallery-empty strong")?.textContent ?? "", /Nothing matches “nothing like this”/);
    await click(page.querySelector(".workspace-gallery-empty-action"));
    assert.equal(search.value, "");

    const filters = [...page.querySelectorAll<HTMLButtonElement>(".workspace-gallery-filter")];
    const counts = filters.map((node) => Number(node.querySelector("small")?.textContent));
    assert.deepEqual(filters.map((node) => node.querySelector("span")?.textContent), ["All", "Widgets", "Apps", "Layout"]);
    assert.equal(counts[0], counts[1]! + counts[2]! + counts[3]!, "All is the sum of its kinds");
    assert.equal(counts[3], 3, "heading, divider, labelled divider");
    await click(filters[2]!);
    assert.equal(filters[2]!.getAttribute("aria-pressed"), "true");
    assert.equal(page.querySelectorAll(".workspace-gallery-card").length, 0, "Apps shows tiles only");
    assert.equal(page.querySelectorAll(".workspace-gallery-tile").length, counts[2], "and every app, unfolded");
    // Apps already on the Workspace when the page opened sort last.
    const labels = [...page.querySelectorAll(".workspace-gallery-tile")].map((node) => node.getAttribute("aria-label"));
    assert.deepEqual(labels.slice(-2), ["Files", "Browser"], labels.join(", "));
    const tile = (label: string) => [...page.querySelectorAll<HTMLButtonElement>(".workspace-gallery-tile")].find((node) => node.getAttribute("aria-label") === label)!;
    await click(tile("Git"));
    assert.deepEqual(stored(), ["launcher:files", "launcher:browser", "launcher:git", "widget:usage.limits", "widget:markets.watchlist"], "an app joins the apps");
    assert.equal(tile("Git").getAttribute("aria-pressed"), "true");
    await click(tile("Files"));
    assert.equal(stored().includes("launcher:files"), false, "tapping an added app takes it off");
    assert.equal(page.querySelector(".workspace-gallery-subtitle")?.textContent, "Added: 2");

    await click(page.querySelector(".workspace-gallery-done"));
    assert.ok(sheet().classList.contains("is-gallery-closing"));
    await sleep(450);
    assert.equal(sheet().querySelector(".workspace-gallery") === null, true, "the page leaves after its exit");
    assert.equal(document.querySelector(".workspace-editor")?.hasAttribute("inert"), false);
    assert.deepEqual(order(), ["launcher:browser", "launcher:git", "widget:usage.limits", "widget:markets.watchlist"]);
    assert.deepEqual([...document.querySelectorAll(".workspace-editor-item.is-fresh")].map((node) => (node as HTMLElement).dataset.arrangeId),
      ["launcher:git", "widget:markets.watchlist"], "what just arrived is marked");
    assert.equal(document.activeElement?.classList.contains("workspace-editor-add"), true, "focus returns to Add");
  } finally {
    await unmount();
  }
});

test("minus removes with Undo; arrow keys move; turning Edit off ends the editing session", async () => {
  const unmount = await mount(["launcher:files", "launcher:browser", "widget:usage.limits", "layout:header"]);
  try {
    assert.equal(sheet().querySelector(".workspace-editor-undo") === null, true, "nothing to undo yet");
    await click(item("widget:usage.limits").querySelector(".workspace-editor-remove"));
    await sleep(300);
    assert.deepEqual(stored(), ["launcher:files", "launcher:browser", "layout:header"]);
    await click(sheet().querySelector(".workspace-editor-undo"));
    assert.deepEqual(stored(), ["launcher:files", "launcher:browser", "widget:usage.limits", "layout:header"]);
    assert.equal(sheet().querySelector(".workspace-editor-undo") === null, true, "the session is back to where it started");

    await key(item("launcher:browser"), "ArrowLeft");
    assert.deepEqual(stored(), ["launcher:browser", "launcher:files", "widget:usage.limits", "layout:header"]);
    await key(item("layout:header").querySelector("[data-arrange-grip]")!, "Home");
    assert.deepEqual(stored(), ["layout:header", "launcher:browser", "launcher:files", "widget:usage.limits"]);
    await key(item("launcher:files"), "Delete");
    await sleep(300);
    assert.equal(stored().includes("launcher:files"), false, "Delete on a focused tile removes it");

    // A heading is edited in place; a burst of typing undoes as one step.
    const heading = item("layout:header").querySelector<HTMLInputElement>("input")!;
    assert.equal(heading.placeholder, "Heading");
    await type(heading, "T");
    await type(heading, "To");
    await type(heading, "Today");
    const saved = JSON.parse(localStorage.getItem(KEY)!) as { items: { id: string; config: { label?: string } }[] };
    assert.equal(saved.items.find((entry) => entry.id === "layout:header")?.config.label, "Today");
    await click(sheet().querySelector(".workspace-editor-undo"));
    const undone = JSON.parse(localStorage.getItem(KEY)!) as { items: { id: string; config: { label?: string } }[] };
    assert.equal(undone.items.find((entry) => entry.id === "layout:header")?.config.label, undefined);

    const editSwitch = () => document.querySelector<HTMLElement>(".sheet-head-switch");
    assert.equal(editSwitch()?.getAttribute("role"), "switch");
    assert.equal(editSwitch()?.getAttribute("aria-checked"), "true");
    await click(editSwitch());
    assert.equal(document.querySelector(".workspace-editor") === null, true);
    assert.equal(editSwitch()?.textContent, "Edit", "the switch keeps one label; its state says whether it is on");
    assert.equal(editSwitch()?.getAttribute("aria-checked"), "false");
    await click(editSwitch());
    assert.equal(sheet().querySelector(".workspace-editor-undo") === null, true, "a new session starts without history");
  } finally {
    await unmount();
  }
});

/** The editor grid as a browser would lay it out: tiles four to a line (80×90,
 *  10px gaps), rows 350×60, from y=100 — recomputed from the live DOM order. */
function mockGridGeometry(): () => void {
  const proto = dom.HTMLElement.prototype as unknown as { getBoundingClientRect(this: HTMLElement): DOMRect };
  const real = proto.getBoundingClientRect;
  const rectOf = (element: HTMLElement): DOMRect | null => {
    if (!element.dataset.arrangeId || !element.parentElement?.classList.contains("workspace-editor-grid")) return null;
    let top = 100;
    let column = 0;
    let lineHeight = 0;
    for (const child of [...element.parentElement.children] as HTMLElement[]) {
      const tile = child.classList.contains("workspace-editor-item--launcher");
      if (!tile || column === 4) {
        if (column > 0) top += lineHeight + 10;
        column = 0;
        lineHeight = 0;
      }
      const rect = tile
        ? new dom.DOMRect(20 + column * 90, top, 80, 90)
        : new dom.DOMRect(20, top, 350, 60);
      if (tile) {
        lineHeight = 90;
        column += 1;
      } else {
        top += 70;
      }
      if (child === element) return rect as unknown as DOMRect;
    }
    return null;
  };
  proto.getBoundingClientRect = function (this: HTMLElement) {
    const grid = rectOf(this);
    if (grid) return grid;
    if (this.classList.contains("sheet-body") || this.classList.contains("workspace-panel-sheet")) {
      return new dom.DOMRect(0, 0, 390, 844) as unknown as DOMRect;
    }
    return real.call(this);
  };
  return () => { proto.getBoundingClientRect = real; };
}

function pointer(type: string, target: EventTarget, x: number, y: number, pointerType = "mouse") {
  const event = new dom.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType, button: 0, clientX: x, clientY: y });
  return act(async () => { target.dispatchEvent(event as unknown as Event); });
}

test("a pointer drag glides the hole through the grid and saves once, where the item lands", async () => {
  const restore = mockGridGeometry();
  const unmount = await mount(["launcher:files", "launcher:browser", "launcher:terminal", "launcher:git", "widget:usage.limits", "layout:header"]);
  // Count the panel's saves through a stand-in for the global storage (happy-dom
  // binds Storage methods on first use, so patching its prototype misses calls).
  const writes: string[] = [];
  const real = dom.localStorage;
  const counting = {
    get length() { return real.length; },
    key: (index: number) => real.key(index),
    getItem: (name: string) => real.getItem(name),
    setItem: (name: string, value: string) => {
      if (name === KEY) writes.push(value);
      real.setItem(name, value);
    },
    removeItem: (name: string) => real.removeItem(name),
    clear: () => real.clear(),
  };
  Object.defineProperty(globalThis, "localStorage", { value: counting, configurable: true });
  try {
    // Files (centre 60,145) picked up with the mouse and carried past Terminal (centre 240).
    await pointer("pointerdown", item("launcher:files"), 60, 145);
    await pointer("pointermove", window, 70, 145);
    assert.ok(sheet().querySelector(".workspace-arrange-ghost"), "the lifted copy is drawn in the sheet");
    assert.equal(sheet().dataset.arrangeDragging, "true");
    assert.ok(item("launcher:files").classList.contains("is-hole"), "its own slot stays as a hole");
    await sleep(20);
    await pointer("pointermove", window, 160, 145);
    await sleep(20);
    await pointer("pointermove", window, 262, 145);
    await sleep(20);
    assert.deepEqual(order(), ["launcher:browser", "launcher:terminal", "launcher:files", "launcher:git", "widget:usage.limits", "layout:header"]);
    assert.equal(writes.length, 0, "nothing is saved mid-drag");
    await pointer("pointerup", window, 262, 145);
    await sleep(500);
    assert.deepEqual(stored(), ["launcher:browser", "launcher:terminal", "launcher:files", "launcher:git", "widget:usage.limits", "layout:header"]);
    assert.equal(writes.length, 1, "saved once, on landing");
    assert.equal(sheet().querySelector(".workspace-arrange-ghost") === null, true);
    assert.equal(sheet().dataset.arrangeDragging, undefined);
    assert.equal(document.querySelector(".is-hole") === null, true);

    // A touch long-press on a row lifts it; dragged above the tiles it goes first.
    const header = item("layout:header");
    await pointer("pointerdown", header, 200, 345, "touch");
    await sleep(300);
    assert.ok(header.classList.contains("is-hole"), "the long press lifted it");
    await pointer("pointermove", window, 200, 120, "touch");
    await sleep(20);
    await pointer("pointermove", window, 200, 60, "touch");
    await sleep(20);
    await pointer("pointerup", window, 200, 60, "touch");
    await sleep(500);
    assert.equal(stored()[0], "layout:header");

    // Escape puts a lifted item back and saves nothing.
    const before = stored();
    const count = writes.length;
    await pointer("pointerdown", item("launcher:git"), 330, 175);
    await pointer("pointermove", window, 320, 175);
    await sleep(20);
    await pointer("pointermove", window, 40, 175);
    await sleep(20);
    assert.notDeepEqual(order(), before.filter((id) => order().includes(id)), "the hole moved while held");
    await act(async () => {
      window.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as unknown as Event);
    });
    await sleep(500);
    assert.deepEqual(stored(), before);
    assert.deepEqual(order(), before);
    assert.equal(writes.length, count);
  } finally {
    Object.defineProperty(globalThis, "localStorage", { value: real, configurable: true });
    await unmount();
    restore();
  }
});

test("the Workspace leads with Back and turns editing on and off with a switch", async () => {
  let closed = 0;
  const unmount = await mount(["launcher:files", "widget:usage.limits"], () => { closed += 1; });
  try {
    const head = sheet().querySelector<HTMLElement>(".sheet-head")!;
    const back = head.firstElementChild as HTMLElement;
    assert.equal(back.className, "sheet-back", "Back leads the header, where the swipe takes the layer");
    assert.equal(back.getAttribute("aria-label"), "Back");
    assert.equal(sheet().querySelector(".sheet-close"), null, "no separate Close: Back is the way out");
    assert.equal(sheet().querySelector(".sheet-grabber"), null, "nor bottom-sheet drag chrome");
    const editSwitch = head.querySelector<HTMLElement>(".sheet-head-switch")!;
    assert.equal(editSwitch.getAttribute("role"), "switch");
    assert.equal(editSwitch.getAttribute("aria-checked"), "true", "the mount helper turned Edit on");
    assert.ok(sheet().classList.contains("is-mode-switched"), "content that replaces the other mode settles in");
    // Back leaves the Workspace from Edit too: editing is a mode, not a place.
    await click(back);
    assert.equal(closed, 1);
  } finally {
    await unmount();
  }
});
