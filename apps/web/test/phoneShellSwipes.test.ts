// Phone shell swipes, mounted for real (happy-dom): a swipe from Chat pulls
// the Navigator in from the inline-start side or the Workspace in from the
// inline-end side, each as an inert peek that follows the finger; a release
// opens it from where the finger left it, a short one unmounts it unseen, and
// the open Navigator swipes closed the way it came. Also pins the gates: the
// Swipe navigation setting, edge-only mode, and "Chat must be the top layer".
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { Project, SessionProjection } from "@polyth/contracts";

const dom = new Window({ url: "http://localhost:3000/" });
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
// Timer-driven frames, so a spring-home really animates.
Object.defineProperty(dom, "requestAnimationFrame", {
  configurable: true,
  value: (callback: FrameRequestCallback) => setTimeout(() => callback(dom.performance.now()), 4) as unknown as number,
});
Object.defineProperty(dom, "cancelAnimationFrame", { configurable: true, value: (id: number) => clearTimeout(id) });
Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: dom.requestAnimationFrame });
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: dom.cancelAnimationFrame });
// A phone shell with motion on. No stylesheet: durations use the helpers' fallbacks.
let coarsePointerHost = false;
Object.defineProperty(dom, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    matches: query.includes("any-pointer: coarse")
      ? coarsePointerHost
      : query.includes("max-width: 480px") || query.includes("max-width: 960px"),
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
const sessions: SessionProjection[] = [
  { id: "a1", projectId: "alpha", title: "Alpha session", status: "idle", createdAt: now, updatedAt: now, lastTurnAt: now },
];
(globalThis as { fetch?: unknown }).fetch = async (url: string) => {
  const u = new URL(String(url), "http://localhost:3000");
  const body: unknown = u.pathname === "/api/sessions/summaries"
    ? { sessions, revision: 0, complete: true }
    : u.pathname === "/api/sessions" ? sessions : [];
  return { ok: true, status: 200, statusText: "OK", json: async () => body, text: async () => JSON.stringify(body) };
};

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const store = await import("../src/store.ts");
const nav = await import("../src/mobileWorkspaceNavigation.ts");
const { setUiSettings } = await import("../src/uiPrefs.ts");
const { getSwipePeek } = await import("../src/shellSwipe.ts");
const { default: PhoneShellSwipes } = await import("../src/components/mobile/PhoneShellSwipes.tsx");
const { default: MobileNavigator } = await import("../src/components/mobile/MobileNavigator.tsx");
const { default: MobileWorkspaceLayer } = await import("../src/components/mobile/MobileWorkspaceLayer.tsx");

const WIDTH = 1024; // happy-dom's default viewport
const sleep = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

let stamp = 1000;
function touch(type: "touchstart" | "touchmove" | "touchend", target: Element, point?: { x: number; y: number }, stepMs = 40) {
  const event = new dom.Event(type, { bubbles: true, cancelable: true }) as unknown as TouchEvent;
  const list = point ? [{ identifier: 1, clientX: point.x, clientY: point.y }] : [];
  Object.defineProperty(event, "touches", { value: type === "touchend" ? [] : list });
  Object.defineProperty(event, "changedTouches", { value: [{ identifier: 1, clientX: point?.x ?? 0, clientY: point?.y ?? 0 }] });
  Object.defineProperty(event, "timeStamp", { value: (stamp += stepMs) });
  act(() => { target.dispatchEvent(event as unknown as Event); });
  return event;
}

/** Touch down at `fromX`, move to `toX` in even steps; the caller decides how it ends. */
function pull(target: Element, fromX: number, toX: number, { steps = 8, stepMs = 40 } = {}) {
  touch("touchstart", target, { x: fromX, y: 400 });
  for (let i = 1; i <= steps; i++) touch("touchmove", target, { x: fromX + ((toX - fromX) * i) / steps, y: 401 }, stepMs);
}

const chat = () => document.getElementById("chat")!;
const navigatorEl = () => document.getElementById("polyth-session-drawer");
const workspaceBackdrop = () => document.querySelector<HTMLElement>(".sheet-backdrop[data-stack]");
const workspacePanel = () => workspaceBackdrop()?.querySelector<HTMLElement>(".workspace-panel-sheet") ?? null;

async function mount() {
  const ticket = store.beginProjectListRequest();
  store.publishProjectList(ticket, [{ id: "alpha", path: "/work/alpha", name: "alpha", createdAt: 1 } satisfies Project]);
  store.activateProject("alpha");
  const container = document.createElement("div");
  container.className = "app";
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement("div", null,
      createElement("main", { id: "chat" }, createElement("p", null, "Conversation")),
      createElement(PhoneShellSwipes),
      createElement(MobileWorkspaceLayer),
      createElement(MobileNavigator),
    ));
  });
  return async () => {
    await act(async () => { root.unmount(); });
    container.remove();
  };
}

async function waitForRow() {
  const deadline = Date.now() + 2000;
  while (!document.querySelector(".mobile-nav-session-swipe")) {
    assert.ok(Date.now() < deadline, "a session row renders");
    await sleep(25);
  }
}

async function reset() {
  await act(async () => {
    store.setSidebarOpen(false);
    store.setRailPlugin(null);
    nav.hideMobileWorkspaceHome();
    nav.setMobileWorkspaceLastPackage(null);
    setUiSettings({ swipeNavigation: "surface" });
  });
  await sleep(400);
}

test("a swipe from Chat pulls the Navigator in as a peek and a long release opens it from the finger", async () => {
  const unmount = await mount();
  try {
    await reset();
    assert.equal(navigatorEl(), null);
    pull(chat(), 300, 700);
    const drawer = navigatorEl();
    assert.ok(drawer, "the Navigator mounts the moment the swipe claims the touch");
    assert.equal(drawer!.dataset.drawerState, "peek");
    assert.ok(drawer!.classList.contains("is-peeking"));
    assert.ok(drawer!.hasAttribute("inert"), "a peek is not interactive and not the active modal");
    assert.equal(store.getState().sidebarOpen, false, "nothing is open yet");
    assert.equal(drawer!.style.transform, `translate3d(${400 - WIDTH}px, 0, 0)`, "its trailing edge follows the finger");

    touch("touchend", chat());
    assert.equal(store.getState().sidebarOpen, true, "the release opens it");
    assert.equal(getSwipePeek(), null);
    assert.equal(drawer, navigatorEl(), "the peek becomes the open drawer, not a remount");
    assert.equal(drawer!.dataset.drawerState, "open");
    assert.equal(drawer!.classList.contains("is-peeking"), false);
    assert.equal(drawer!.style.transform, "", "the inline position is handed over…");
    assert.equal(drawer!.style.getPropertyValue("--nav-swipe-from"), `${400 - WIDTH}px`, "…to the entrance");
    assert.match(drawer!.style.getPropertyValue("--nav-swipe-settle"), /^\d+ms$/);
    assert.equal(drawer!.getAttribute("data-swipe-handoff"), "open");
  } finally {
    await reset();
    await unmount();
  }
});

test("a short pull springs back and unmounts the peek without ever opening", async () => {
  const unmount = await mount();
  try {
    await reset();
    pull(chat(), 300, 420, { steps: 6, stepMs: 120 });
    assert.ok(navigatorEl());
    touch("touchend", chat(), undefined, 300);
    assert.equal(store.getState().sidebarOpen, false);
    await sleep(400);
    assert.equal(navigatorEl(), null, "gone once it is home");
    assert.equal(getSwipePeek(), null);
  } finally {
    await reset();
    await unmount();
  }
});

test("the open Navigator swipes closed toward the inline start and hands its position to the exit", async () => {
  const unmount = await mount();
  try {
    await reset();
    await act(async () => { store.setSidebarOpen(true); });
    await sleep(50);
    const drawer = navigatorEl()!;
    const toolbar = drawer.querySelector(".mobile-nav-toolbar")!;
    pull(toolbar, 800, 300);
    assert.equal(drawer.getAttribute("data-swiping"), "true");
    assert.equal(drawer.style.transform, "translate3d(-500px, 0, 0)");
    touch("touchend", toolbar);
    assert.equal(store.getState().sidebarOpen, false);
    assert.ok(drawer.classList.contains("is-closing"));
    assert.equal(drawer.getAttribute("data-swipe-handoff"), "close");
    assert.equal(drawer.style.getPropertyValue("--nav-swipe-from"), "-500px");
    assert.equal(drawer.hasAttribute("data-swiping"), false);
    assert.equal(drawer.style.transform, "");
  } finally {
    await reset();
    await unmount();
  }
});

test("a short close drag springs home and keeps the entrance animation from replaying", async () => {
  const unmount = await mount();
  try {
    await reset();
    await act(async () => { store.setSidebarOpen(true); });
    await sleep(50);
    const drawer = navigatorEl()!;
    const toolbar = drawer.querySelector(".mobile-nav-toolbar")!;
    pull(toolbar, 300, 260);
    assert.equal(drawer.getAttribute("data-swiping"), "true");
    touch("touchend", toolbar);
    await sleep(600);
    assert.equal(store.getState().sidebarOpen, true);
    assert.equal(drawer.hasAttribute("data-swiping"), false);
    assert.equal(drawer.style.transform, "");
    assert.equal(drawer.getAttribute("data-swipe-handoff"), "rest");
  } finally {
    await reset();
    await unmount();
  }
});

test("a leftward swipe over a session row closes the Navigator; the row keeps only its Pin swipe", async () => {
  const unmount = await mount();
  try {
    await reset();
    await act(async () => { store.setSidebarOpen(true); });
    await waitForRow();
    const row = document.querySelector<HTMLElement>(".mobile-nav-session-swipe")!;
    assert.equal(row.dataset.ownsSwipe, "toward-end", "at rest the row owns only the Pin direction");
    assert.equal(row.querySelector(".mobile-nav-swipe-action.is-trailing"), null, "Archive is a menu action, not a swipe");
    const title = row.querySelector(".mobile-nav-session-title") ?? row;
    pull(title, 700, 300);
    touch("touchend", title);
    assert.equal(store.getState().sidebarOpen, false, "the swipe closed the Navigator from the middle of a row");
  } finally {
    await reset();
    await unmount();
  }
});

test("a swipe from Chat toward the inline start pulls the Workspace in and opens it from the finger", async () => {
  const unmount = await mount();
  try {
    await reset();
    pull(chat(), 800, 300);
    const backdrop = workspaceBackdrop();
    assert.ok(backdrop, "the Workspace mounts as a peek");
    assert.equal(backdrop!.hasAttribute("data-swipe-peek"), true);
    assert.equal(workspacePanel()!.hasAttribute("inert"), true);
    assert.equal(nav.getMobileWorkspaceNavigationSnapshot().homeOpen, false);
    assert.equal(workspacePanel()!.style.transform, `translate3d(${WIDTH - 500}px, 0, 0)`);

    touch("touchend", chat());
    assert.equal(nav.getMobileWorkspaceNavigationSnapshot().homeOpen, true);
    assert.equal(backdrop!.hasAttribute("data-swipe-peek"), false);
    assert.equal(backdrop!.dataset.stack, "enter");
    const panel = workspacePanel()!;
    assert.equal(panel.hasAttribute("inert"), false, "now it is the active layer");
    assert.equal(panel.getAttribute("data-swipe-handoff"), "enter");
    assert.equal(panel.style.getPropertyValue("--stack-enter-from"), `${WIDTH - 500}px`);
    assert.equal(panel.style.transform, "");
  } finally {
    await reset();
    await unmount();
  }
});

test("an abandoned Workspace pull unmounts at once and leaves focus where it was", async () => {
  const unmount = await mount();
  try {
    await reset();
    const field = document.createElement("textarea");
    chat().appendChild(field);
    field.focus();
    pull(chat(), 800, 700, { steps: 4, stepMs: 150 });
    assert.ok(workspaceBackdrop());
    touch("touchend", chat(), undefined, 300);
    await sleep(400);
    assert.equal(workspaceBackdrop(), null, "no closing frame for a layer that never opened");
    assert.equal(document.activeElement, field, "the peek never took focus, so nothing was handed back");
    field.remove();
  } finally {
    await reset();
    await unmount();
  }
});

test("chat swipes follow the setting and only start while Chat is the top layer", async () => {
  const unmount = await mount();
  try {
    await reset();
    await act(async () => { setUiSettings({ swipeNavigation: "off" }); });
    pull(chat(), 300, 800);
    touch("touchend", chat());
    assert.equal(navigatorEl(), null, "off: no swipe navigation");

    await act(async () => { setUiSettings({ swipeNavigation: "edge" }); });
    pull(chat(), 300, 800);
    touch("touchend", chat());
    assert.equal(navigatorEl(), null, "edges only: not from the middle");
    pull(chat(), 10, 800);
    touch("touchend", chat());
    assert.equal(store.getState().sidebarOpen, true, "…but from the inline-start edge");
    await reset();

    await act(async () => { store.setRailPlugin("files"); });
    pull(chat(), 300, 800);
    touch("touchend", chat());
    assert.equal(navigatorEl(), null, "a package window owns its own swipes");
    assert.equal(store.getState().sidebarOpen, false);
  } finally {
    await reset();
    await unmount();
  }
});

test("a coarse-pointer web host mounts nothing: the browser owns the edge gesture", async () => {
  // The host gate is read at mount: in a coarse-pointer web host the shell
  // attaches no listeners at all, so no drag from Chat can open a surface.
  coarsePointerHost = true;
  const unmount = await mount();
  try {
    await reset();
    pull(chat(), 300, 800);
    touch("touchend", chat());
    assert.equal(navigatorEl(), null, "no Navigator from the middle of the screen");
    assert.equal(store.getState().sidebarOpen, false);

    pull(chat(), 10, 800);
    touch("touchend", chat());
    assert.equal(navigatorEl(), null, "not even from the inline-start edge");
    assert.equal(store.getState().sidebarOpen, false, "the browser keeps its own edge gesture");

    pull(chat(), 800, 300);
    touch("touchend", chat());
    assert.equal(workspaceBackdrop(), null, "no Workspace pull either");
  } finally {
    await unmount();
    coarsePointerHost = false;
    await reset();
  }
});
