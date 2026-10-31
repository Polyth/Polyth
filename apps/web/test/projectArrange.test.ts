// Moving projects in both navigators, mounted for real (happy-dom; geometry is
// mocked from the live DOM order because happy-dom has no layout). A still
// touch press or a mouse drag lifts a project's row; the order is saved once,
// when it lands; a move made under any sort becomes the custom order; a touch
// that moves first is a scroll; Escape puts the project back; and a project
// that folds its chats while it is up never pulls the list out from under the
// finger.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { Project, SessionProjection } from "@polyth/contracts";

const dom = new Window({ url: "http://localhost:3000/" });
// These cases cover the drag logic, not its motion (workspaceEditor.test.ts
// plays the glides). happy-dom implements Element.animate, so run them with
// the product's reduce-animations setting, as before it did.
dom.document.documentElement.dataset.reduceAnimations = "true";
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
// Frames are real turns of the event loop: the drag engine's auto-scroll asks
// for one frame after another.
Object.defineProperty(dom, "requestAnimationFrame", {
  configurable: true,
  value: (callback: FrameRequestCallback) => setTimeout(() => callback(dom.performance.now()), 4) as unknown as number,
});
Object.defineProperty(dom, "cancelAnimationFrame", { configurable: true, value: (id: number) => clearTimeout(id) });
Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: dom.requestAnimationFrame });
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: dom.cancelAnimationFrame });
let shellWidth = 390;
Object.defineProperty(dom, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    get matches() {
      if (query.includes("960px")) return shellWidth <= 960;
      if (query.includes("480px")) return shellWidth <= 480;
      return false;
    },
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

const now = Date.now();
// Only alpha has a chat, so "Recent activity" puts it first and keeps the rest
// in a stable order.
const alphaSession: SessionProjection = {
  id: "a1", projectId: "alpha", title: "Alpha chat", status: "idle", createdAt: now, updatedAt: now, lastTurnAt: now,
};
(globalThis as { fetch?: unknown }).fetch = async (url: string) => {
  const u = new URL(String(url), "http://localhost:3000");
  const projectId = u.searchParams.get("projectId");
  const body: unknown = u.pathname === "/api/sessions/summaries"
    ? { sessions: u.searchParams.get("archived") === "true" ? [] : [alphaSession], revision: 0, complete: true }
    : u.pathname === "/api/sessions"
      ? (!projectId || projectId === "alpha" ? [alphaSession] : [])
      : u.pathname === "/api/worktrees"
        ? [{ path: `/work/${projectId}`, branch: "master", head: "a", isMain: true }]
        : [];
  return { ok: true, status: 200, statusText: "OK", json: async () => body, text: async () => JSON.stringify(body) };
};

// Which listeners the lists register, and how (see the touch test below).
const listeners: { element: Element; type: string; options: unknown }[] = [];
const elementProto = dom.HTMLElement.prototype as unknown as {
  addEventListener(this: Element, type: string, listener: unknown, options?: unknown): void;
};
const realAddEventListener = elementProto.addEventListener;
elementProto.addEventListener = function (this: Element, type: string, listener: unknown, options?: unknown) {
  listeners.push({ element: this, type, options });
  return realAddEventListener.call(this, type, listener, options);
};

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const store = await import("../src/store.ts");
const {
  getProjectOrder, getProjectSortMode, PROJECT_ORDER_KEY, PROJECT_SORT_KEY, setProjectOrder, setProjectSortMode, setSidebarViewMode,
} = await import("../src/sidebarPrefs.ts");
const { default: MobileNavigator } = await import("../src/components/mobile/MobileNavigator.tsx");
const { default: Sidebar } = await import("../src/components/Sidebar.tsx");

const sleep = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
const rect = (x: number, y: number, width: number, height: number) => new dom.DOMRect(x, y, width, height) as unknown as DOMRect;

function pointer(type: string, target: EventTarget, x: number, y: number, pointerType = "touch") {
  const event = new dom.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType, button: 0, clientX: x, clientY: y });
  return act(async () => { target.dispatchEvent(event as unknown as Event); });
}

/** Release, then the click a browser sends after it, as one input. */
function release(target: Element, x: number, y: number, pointerType = "touch") {
  return act(async () => {
    window.dispatchEvent(new dom.PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerId: 7, pointerType, button: 0, clientX: x, clientY: y }) as unknown as Event);
    target.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as unknown as Event);
  });
}

const PROJECTS = ["alpha", "beta", "gamma", "delta"];

function seed() {
  const ticket = store.beginProjectListRequest();
  store.publishProjectList(ticket, PROJECTS.map((id, index) => ({
    id, path: `/work/${id}`, name: id, createdAt: 10 - index,
  }) satisfies Project));
  store.activateProject("alpha");
  for (const id of PROJECTS) store.setSessions(id, id === "alpha" ? [alphaSession] : []);
  store.setSidebarOpen(true);
}

function reset() {
  setProjectSortMode("recent");
  setProjectOrder([]);
  localStorage.clear();
}

async function mount(component: Parameters<typeof createElement>[0]) {
  const container = document.createElement("div");
  container.className = "app";
  document.body.appendChild(container);
  const root = createRoot(container);
  seed();
  await act(async () => { root.render(createElement(component)); });
  await sleep(20);
  return async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    store.setSidebarOpen(false);
  };
}

/** Swap in layout for the mounted lists; returns the undo. */
function mockGeometry(rectOf: (element: HTMLElement) => DOMRect | null): () => void {
  const proto = dom.HTMLElement.prototype as unknown as { getBoundingClientRect(this: HTMLElement): DOMRect };
  const real = proto.getBoundingClientRect;
  proto.getBoundingClientRect = function (this: HTMLElement) {
    return rectOf(this) ?? real.call(this);
  };
  return () => { proto.getBoundingClientRect = real; };
}

/** A scroll container `height` tall over `content()` px: scrollTop clamps
 *  like a browser's, and the engine's end padding (`calc(… + Npx)`) counts. */
function scrollable(scroller: HTMLElement, height: number, content: () => number): void {
  let offset = 0;
  const total = () => {
    const room = /\+\s*([\d.]+)px\)\s*$/.exec(scroller.style.paddingBlockEnd ?? "")?.[1];
    return content() + (room ? Number(room) : 0);
  };
  const max = () => Math.max(0, total() - height);
  Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => height });
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: total });
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    get: () => (offset = Math.min(offset, max())),
    set: (value: number) => { offset = Math.max(0, Math.min(value, max())); },
  });
}

// ---- phone Navigator --------------------------------------------------------
// The list scrolls in a 400px window from y=60. A project row is 48px (4px
// apart, from 8px in); an open project's chats add 200px unless it is up.

const PHONE_TOP = 60;
const PHONE_HEIGHT = 400;
const phoneScroller = () => document.querySelector<HTMLElement>(".mobile-nav-scroll")!;
const phoneOrder = () => [...phoneScroller().querySelectorAll<HTMLElement>(":scope > .mobile-nav-project")]
  .map((section) => section.dataset.projectId);
const section = (id: string) => phoneScroller().querySelector<HTMLElement>(`:scope > [data-project-id="${id}"]`)!;
const head = (id: string) => section(id).querySelector<HTMLElement>(":scope > .mobile-nav-project-head")!;
const opener = (id: string) => head(id).querySelector<HTMLButtonElement>(".mobile-nav-project-main")!;
const phoneHeight = (element: Element) =>
  48 + (element.querySelector(":scope > .mobile-nav-project-body") && !element.classList.contains("is-arrange-held") ? 200 : 0);
const phoneContent = () => 8 + 16 + [...phoneScroller().children]
  .filter((child) => child.classList.contains("mobile-nav-project"))
  .reduce((sum, child) => sum + phoneHeight(child) + 4, 0);

function phoneRect(element: HTMLElement): DOMRect | null {
  if (element.classList.contains("mobile-navigator")) return rect(0, 0, 390, 844);
  if (element.classList.contains("mobile-nav-scroll")) return rect(0, PHONE_TOP, 390, PHONE_HEIGHT);
  const project = element.classList.contains("mobile-nav-project")
    ? element
    : element.classList.contains("mobile-nav-project-head") ? element.parentElement : null;
  const scroller = project?.parentElement;
  if (!project || !scroller?.classList.contains("mobile-nav-scroll")) return null;
  let top = PHONE_TOP + 8 - scroller.scrollTop;
  for (const child of scroller.children) {
    if (!child.classList.contains("mobile-nav-project")) continue;
    if (child === project) return rect(6, top, 378, element === project ? phoneHeight(child) : 48);
    top += phoneHeight(child) + 4;
  }
  return null;
}

const ghost = () => document.querySelector(".workspace-arrange-ghost");

test("phone: a still press lifts a project, it moves under the finger and lands once, in the custom order", async () => {
  reset();
  const restore = mockGeometry(phoneRect);
  const unmount = await mount(MobileNavigator);
  try {
    scrollable(phoneScroller(), PHONE_HEIGHT, phoneContent);
    assert.deepEqual(phoneOrder(), ["alpha", "beta", "gamma", "delta"], "recent activity puts alpha first");
    assert.equal(opener("alpha").getAttribute("aria-expanded"), "true", "the active project starts open");
    // alpha is open (248px), so beta's row spans 320–368.
    await pointer("pointerdown", head("beta"), 200, 344);
    await sleep(400);
    assert.ok(document.querySelector(".mobile-navigator .workspace-arrange-ghost"), "the lifted copy is drawn in the drawer");
    assert.ok(section("beta").classList.contains("is-arrange-held"), "its own place stays behind");
    assert.equal(document.querySelector<HTMLElement>(".mobile-navigator")!.dataset.arrangeDragging, "true");

    await pointer("pointermove", window, 200, 430);
    await sleep(20);
    assert.deepEqual(phoneOrder(), ["alpha", "gamma", "beta", "delta"], "past gamma's middle the hole moves");
    await pointer("pointermove", window, 200, 490);
    await sleep(20);
    assert.deepEqual(phoneOrder(), ["alpha", "gamma", "delta", "beta"]);
    assert.equal(getProjectSortMode(), "recent", "nothing is saved mid-drag");
    assert.equal(localStorage.getItem(PROJECT_ORDER_KEY), null);

    await release(opener("beta"), 200, 490);
    await sleep(40);
    assert.equal(getProjectSortMode(), "manual", "a move is the custom order");
    assert.equal(localStorage.getItem(PROJECT_SORT_KEY), "manual");
    assert.deepEqual(getProjectOrder(), ["alpha", "gamma", "delta", "beta"]);
    assert.equal(localStorage.getItem(PROJECT_ORDER_KEY), '["alpha","gamma","delta","beta"]', "saved once, where it landed");
    assert.deepEqual(phoneOrder(), ["alpha", "gamma", "delta", "beta"]);
    assert.equal(opener("beta").getAttribute("aria-expanded"), "false", "the press that moved beta did not also open it");
    assert.equal(ghost(), null);
    assert.equal(document.querySelector(".is-arrange-held"), null);
    assert.equal(document.querySelector<HTMLElement>(".mobile-navigator")!.dataset.arrangeDragging, undefined);

    // A touch that moves before the lift is a scroll, and a tap still opens.
    await pointer("pointerdown", head("gamma"), 200, 344);
    await sleep(60);
    await pointer("pointermove", window, 200, 364);
    await sleep(400);
    assert.equal(ghost(), null, "a moving finger scrolls instead");
    await pointer("pointerup", window, 200, 364);
    await pointer("pointerdown", head("gamma"), 200, 344);
    await release(opener("gamma"), 200, 344);
    assert.equal(opener("gamma").getAttribute("aria-expanded"), "true", "a tap opens the project");
    await act(async () => { opener("gamma").click(); });
    assert.equal(opener("gamma").getAttribute("aria-expanded"), "false");

    // Escape puts a lifted project back and saves nothing.
    await pointer("pointerdown", head("delta"), 200, 396);
    await sleep(400);
    await pointer("pointermove", window, 200, 330);
    await sleep(20);
    assert.deepEqual(phoneOrder(), ["alpha", "delta", "gamma", "beta"], "the hole moved while held");
    await act(async () => {
      window.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as unknown as Event);
    });
    await sleep(40);
    assert.deepEqual(phoneOrder(), ["alpha", "gamma", "delta", "beta"]);
    assert.deepEqual(getProjectOrder(), ["alpha", "gamma", "delta", "beta"]);
    assert.equal(ghost(), null);
    await pointer("pointerup", window, 200, 330);
  } finally {
    await unmount();
    restore();
  }
});

test("phone: a project that folds while it is up keeps the list where the finger left it", async () => {
  reset();
  setProjectSortMode("manual");
  setProjectOrder(["alpha", "gamma", "delta", "beta"]);
  localStorage.setItem("polyth.sidebar.expandedProjects", '["alpha","beta"]');
  const restore = mockGeometry(phoneRect);
  const unmount = await mount(MobileNavigator);
  try {
    const scroller = phoneScroller();
    scrollable(scroller, PHONE_HEIGHT, phoneContent);
    assert.equal(opener("beta").getAttribute("aria-expanded"), "true");
    // Scrolled to the end: 632px of list in a 400px window.
    scroller.scrollTop = 1_000;
    assert.equal(scroller.scrollTop, 232);
    const before = head("beta").getBoundingClientRect().top;
    assert.equal(before, 192);

    await pointer("pointerdown", head("beta"), 200, before + 24);
    await sleep(400);
    assert.ok(section("beta").classList.contains("is-arrange-held"), "beta is up and its chats folded");
    assert.equal(scroller.scrollTop, 232, "the shorter list did not slide down");
    assert.match(scroller.style.paddingBlockEnd, /\+ 200px\)$/, "the folded chats' room is kept at the end");
    assert.equal(section("beta").getBoundingClientRect().top, before, "the held place stays under the finger");

    await pointer("pointerup", window, 200, before + 24);
    await sleep(40);
    assert.equal(scroller.style.paddingBlockEnd, "", "the room goes back once the chats are back");
    assert.equal(scroller.scrollTop, 232);
    assert.deepEqual(getProjectOrder(), ["alpha", "gamma", "delta", "beta"], "set down where it was: nothing moved");
    assert.deepEqual(phoneOrder(), ["alpha", "gamma", "delta", "beta"]);
  } finally {
    await unmount();
    restore();
  }
});

test("phone: the keyboard moves a project too, and a move under any sort keeps that order", async () => {
  reset();
  setProjectSortMode("name");
  const unmount = await mount(MobileNavigator);
  try {
    assert.deepEqual(phoneOrder(), ["alpha", "beta", "delta", "gamma"], "project name order");
    const alpha = opener("alpha");
    assert.equal(alpha.getAttribute("aria-keyshortcuts"), "Alt+Shift+ArrowUp Alt+Shift+ArrowDown");
    await act(async () => {
      alpha.dispatchEvent(new dom.KeyboardEvent("keydown", {
        key: "ArrowDown", altKey: true, shiftKey: true, bubbles: true, cancelable: true,
      }) as unknown as Event);
    });
    assert.equal(getProjectSortMode(), "manual");
    assert.deepEqual(getProjectOrder(), ["beta", "alpha", "delta", "gamma"]);
    assert.deepEqual(phoneOrder(), ["beta", "alpha", "delta", "gamma"]);
  } finally {
    await unmount();
  }
});

test("phone: touches on the list stay cancellable, so a lifted row can stop the scroll", () => {
  // WebKit and Chromium decide at touchstart whether a touch's moves can still
  // be cancelled; a listener added once the row is up comes too late alone.
  const scrollers = listeners.filter((entry) =>
    entry.type === "touchmove" && entry.element.classList.contains("mobile-nav-scroll"));
  assert.ok(scrollers.length > 0, "the list listens to touchmove");
  assert.ok(scrollers.every((entry) => (entry.options as AddEventListenerOptions | undefined)?.passive === false));
});

// ---- wide navigator ---------------------------------------------------------
// Tree: the list scrolls in a 600px window from y=100; a project row is 56px
// (2px apart, from 8px in) and an open project's sessions add 120px.
// Rail: 36px tiles, 4px apart, from 6px into a column that starts at y=60.

const TREE_TOP = 100;
const sideScroll = () => document.querySelector<HTMLElement>(".side-scroll")!;
const treeOrder = () => [...sideScroll().querySelectorAll<HTMLElement>(":scope > .project-tree-node")]
  .map((node) => node.dataset.projectId);
const treeNode = (id: string) => sideScroll().querySelector<HTMLElement>(`:scope > [data-project-id="${id}"]`)!;
const treeHeight = (element: Element) =>
  56 + (element.querySelector(":scope > .project-tree-sessions") && !element.classList.contains("is-arrange-held") ? 120 : 0);
const railList = () => document.querySelector<HTMLElement>(".sidebar-project-rail-list")!;
const railOrder = () => [...railList().querySelectorAll<HTMLElement>(".sidebar-project-rail-item")]
  .map((item) => item.getAttribute("aria-label"));
const railItem = (id: string) => railList().querySelector<HTMLElement>(`.sidebar-project-rail-item[aria-label="${id}"]`)!;

function wideRect(element: HTMLElement): DOMRect | null {
  if (element.classList.contains("sidebar")) return rect(0, 0, 272, 900);
  if (element.classList.contains("side-scroll")) return rect(0, TREE_TOP, 272, 600);
  if (element.classList.contains("sidebar-project-rail-list")) return rect(0, 60, 49, 500);
  if (element.classList.contains("sidebar-project-rail-item") && element.closest(".sidebar-project-rail-list")) {
    const list = element.closest<HTMLElement>(".sidebar-project-rail-list")!;
    const index = [...list.querySelectorAll(".sidebar-project-rail-item")].indexOf(element);
    return rect(6, 60 + 6 + index * 40 - list.scrollTop, 36, 36);
  }
  const node = element.classList.contains("project-tree-node")
    ? element
    : element.classList.contains("project-card-shell") ? element.parentElement : null;
  const scroller = node?.parentElement;
  if (!node?.classList.contains("project-tree-node") || !scroller?.classList.contains("side-scroll")) return null;
  let top = TREE_TOP + 8 - scroller.scrollTop;
  for (const child of scroller.children) {
    if (!child.classList.contains("project-tree-node")) continue;
    if (child === node) return rect(8, top, 256, element === node ? treeHeight(child) : 56);
    top += treeHeight(child) + 2;
  }
  return null;
}

test("wide: the tree and the rail move projects with the mouse; a session row never lifts its project", async () => {
  reset();
  shellWidth = 1400;
  localStorage.setItem("polyth.sidebar.expandedProjects", '["alpha"]');
  setSidebarViewMode("tree");
  const restore = mockGeometry(wideRect);
  const unmount = await mount(Sidebar);
  try {
    assert.deepEqual(treeOrder(), ["alpha", "beta", "delta", "gamma"], "recent activity, then names");
    assert.ok(treeNode("alpha").querySelector(".project-tree-sessions"), "the active project is open");
    assert.equal(treeNode("beta").getAttribute("draggable"), null, "no browser drag and drop");

    // A press on a session row inside a project is the session's.
    const row = treeNode("alpha").querySelector<HTMLElement>(".project-tree-sessions .session-btn, .project-tree-sessions .session-row");
    assert.ok(row, "alpha lists its session");
    await pointer("pointerdown", row, 100, 200, "mouse");
    await pointer("pointermove", window, 100, 260, "mouse");
    await sleep(20);
    assert.equal(ghost(), null, "dragging a session row does not pick up its project");
    await pointer("pointerup", window, 100, 260, "mouse");

    // beta's row spans 286–342 below alpha's open tree.
    const card = treeNode("beta").querySelector<HTMLElement>(".project-card")!;
    await pointer("pointerdown", card, 100, 314, "mouse");
    await pointer("pointermove", window, 100, 320, "mouse");
    await sleep(20);
    assert.ok(document.querySelector(".sidebar .workspace-arrange-ghost"), "a small mouse move lifts the project");
    assert.ok(treeNode("beta").classList.contains("is-arrange-held"));
    await pointer("pointermove", window, 100, 420, "mouse");
    await sleep(20);
    assert.deepEqual(treeOrder(), ["alpha", "delta", "beta", "gamma"]);
    await release(card, 100, 420, "mouse");
    await sleep(40);
    assert.equal(getProjectSortMode(), "manual");
    assert.deepEqual(getProjectOrder(), ["alpha", "delta", "beta", "gamma"]);
    assert.equal(card.getAttribute("aria-expanded"), "false", "the drag did not also open beta");
    assert.equal(ghost(), null);

    // The rail moves every project. Its press starts near the top edge, where
    // auto-scroll asks to scroll up: the list is already at its top.
    await act(async () => { setSidebarViewMode("rail"); });
    await sleep(20);
    scrollable(railList(), 500, () => 6 + railList().querySelectorAll(".sidebar-project-rail-item").length * 40);
    assert.deepEqual(railOrder(), ["alpha", "delta", "beta", "gamma"]);
    await pointer("pointerdown", railItem("alpha"), 24, 84, "mouse");
    await pointer("pointermove", window, 24, 90, "mouse");
    await sleep(20);
    assert.ok(railItem("alpha").classList.contains("is-arrange-held"), "the tile is up");
    await pointer("pointermove", window, 24, 150, "mouse");
    await sleep(20);
    assert.deepEqual(railOrder(), ["delta", "alpha", "beta", "gamma"]);
    await pointer("pointermove", window, 24, 190, "mouse");
    await sleep(20);
    assert.deepEqual(railOrder(), ["delta", "beta", "alpha", "gamma"]);
    await release(railItem("alpha"), 24, 190, "mouse");
    await sleep(40);
    assert.deepEqual(getProjectOrder(), ["delta", "beta", "alpha", "gamma"]);
    assert.equal(ghost(), null);
  } finally {
    await unmount();
    restore();
    setSidebarViewMode("tree");
    shellWidth = 390;
  }
});
