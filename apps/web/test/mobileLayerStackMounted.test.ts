// Phone layer stack, mounted for real (happy-dom): the Workspace is a layer
// UNDER a package window, so Back is a pop back to something already rendered.
// Pins the lifecycle the DOM-free helpers only decide: presence, phases, the
// idle-underlay deferral, dismissal, and the keep-alive regression where a
// closed package frame reopened/closed the Workspace Back had just returned to.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { Project } from "@polyth/contracts";

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
Object.defineProperty(globalThis, "requestAnimationFrame", {
  value: (callback: FrameRequestCallback) => { callback(0); return 0; },
  configurable: true,
});
Object.defineProperty(globalThis, "cancelAnimationFrame", { value: () => {}, configurable: true });

// The phone shell is a media query; make it a live flag so one file can mount
// both a phone and a wider shell. No stylesheet is loaded, so presence runs on
// the helper's fallback durations (--motion-stack: 300ms + one frame of slack).
let phoneShell = true;
Object.defineProperty(dom, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    get matches() {
      if (query.includes("prefers-reduced-motion")) return false;
      if (query.includes("max-width: 480px")) return phoneShell;
      if (query.includes("max-width: 960px")) return phoneShell;
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

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const store = await import("../src/store.ts");
const nav = await import("../src/mobileWorkspaceNavigation.ts");
const { default: MobileWorkspaceLayer } = await import("../src/components/mobile/MobileWorkspaceLayer.tsx");
const { default: ModuleView } = await import("../src/components/ui/ModuleView.ts");
const { tr } = await import("../src/i18n/index.ts");

const sleep = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
/** Past --motion-stack (300ms) plus its one-frame tail: a surviving timer would have fired. */
const PAST_STACK_MS = 420;
/** Short of the stack duration: the exit is still being drawn. */
const MID_STACK_MS = 120;
async function waitFor(condition: () => boolean, message: string, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    assert.ok(Date.now() < deadline, message);
    await sleep(25);
  }
}

const backdrop = () => document.querySelector<HTMLElement>(".sheet-backdrop[data-stack]");
const panel = () => backdrop()?.querySelector<HTMLElement>(".workspace-panel-sheet") ?? null;
const stack = () => backdrop()?.dataset.stack ?? null;
const closing = () => backdrop()?.classList.contains("is-closing") ?? false;

function seed() {
  const ticket = store.beginProjectListRequest();
  store.publishProjectList(ticket, [{ id: "alpha", path: "/work/alpha", name: "alpha", createdAt: 1 } satisfies Project]);
  store.activateProject("alpha");
}

function reset() {
  nav.hideMobileWorkspaceHome();
  nav.setMobileWorkspaceLastPackage(null);
  store.setRailPlugin(null);
  phoneShell = true;
}

async function mountLayer() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(MobileWorkspaceLayer)); });
  return {
    unmount: async () => { await act(async () => { root.unmount(); }); container.remove(); },
  };
}

test("the Workspace stays mounted under a package, is revealed by Back, and Close dismisses it", async () => {
  seed();
  reset();
  const view = await mountLayer();
  try {
    assert.equal(backdrop(), null, "nothing renders while the Workspace is closed");

    await act(async () => { nav.showMobileWorkspaceHome(); });
    assert.equal(stack(), "enter", "it arrives from the edge over Chat");
    assert.ok(!panel()!.hasAttribute("inert"), "the foreground layer is interactive");

    // A package window opens above it; the resume bookkeeping then clears homeOpen.
    await act(async () => { store.setRailPlugin("demo"); });
    assert.equal(stack(), "covered", "the Workspace retreats beneath the package");
    assert.ok(panel()!.hasAttribute("inert"), "a covered layer is out of focus order and the a11y tree");
    await act(async () => { nav.rememberMobileWorkspacePackage("demo"); });
    await sleep(PAST_STACK_MS);
    assert.ok(backdrop(), "the push finishing does not unmount the layer Back returns to");
    assert.equal(stack(), "covered");
    assert.equal(closing(), false);

    // Back: the Workspace is named first, then the package leaves.
    await act(async () => { nav.showMobileWorkspaceHome(); store.setRailPlugin(null); });
    assert.equal(stack(), "revealed", "Back settles the layer from its retreat; it is not a fresh slide-in");
    assert.equal(closing(), false);
    assert.ok(!panel()!.hasAttribute("inert"), "the revealed layer is interactive again");
    await sleep(PAST_STACK_MS);
    assert.ok(backdrop(), "Back lands on the Workspace and stays there, never on Chat");
    assert.equal(nav.getMobileWorkspaceNavigationSnapshot().homeOpen, true);

    // Close (X) on the Workspace itself leaves through its exit frame.
    await act(async () => { nav.hideMobileWorkspaceHome(); });
    assert.equal(closing(), true, "the exit frame stays mounted while it animates");
    await sleep(MID_STACK_MS);
    assert.ok(backdrop(), "…and is still there mid-exit");
    await waitFor(() => backdrop() === null, "the layer unmounts once its exit finishes");
  } finally {
    await view.unmount();
    reset();
  }
});

test("dismissing a package takes the Workspace beneath it along", async () => {
  seed();
  reset();
  const view = await mountLayer();
  try {
    await act(async () => { nav.showMobileWorkspaceHome(); });
    await act(async () => { store.setRailPlugin("demo"); });
    await act(async () => { nav.rememberMobileWorkspacePackage("demo"); });
    await sleep(PAST_STACK_MS);
    assert.equal(stack(), "covered");

    // Close on the package: homeOpen is already false and the package goes.
    await act(async () => { store.setRailPlugin(null); });
    assert.equal(closing(), true, "the covered layer leaves with the package that was on top");
    await waitFor(() => backdrop() === null, "…and unmounts after the shared exit");
    assert.equal(nav.getMobileWorkspaceNavigationSnapshot().homeOpen, false, "dismissal lands on Chat");
  } finally {
    await view.unmount();
    reset();
  }
});

test("a package opened from Chat adds its idle Workspace underlay only after it has landed", async () => {
  seed();
  reset();
  const view = await mountLayer();
  try {
    await act(async () => { store.setRailPlugin("demo"); });
    await act(async () => { nav.rememberMobileWorkspacePackage("demo"); });
    assert.equal(backdrop(), null, "no Workspace render inside the package's first frames");
    await sleep(MID_STACK_MS);
    assert.equal(backdrop(), null);
    await waitFor(() => backdrop() !== null, "the underlay arrives once the package has settled");
    assert.equal(stack(), "covered");
    assert.ok(panel()!.hasAttribute("inert"));

    // Back from here reveals it.
    await act(async () => { nav.showMobileWorkspaceHome(); store.setRailPlugin(null); });
    assert.equal(stack(), "revealed");
    await sleep(PAST_STACK_MS);
    assert.ok(backdrop());
  } finally {
    await view.unmount();
    reset();
  }
});

test("Back before the idle underlay exists still reveals the Workspace", async () => {
  seed();
  reset();
  const view = await mountLayer();
  try {
    await act(async () => { store.setRailPlugin("demo"); });
    await act(async () => { nav.rememberMobileWorkspacePackage("demo"); });
    assert.equal(backdrop(), null);

    await act(async () => { nav.showMobileWorkspaceHome(); store.setRailPlugin(null); });
    assert.ok(backdrop(), "Back mounts the Workspace as the destination");
    assert.equal(stack(), "revealed", "it settles behind the leaving package instead of sliding in a second time");
    await sleep(PAST_STACK_MS);
    assert.ok(backdrop());
  } finally {
    await view.unmount();
    reset();
  }
});

test("a package dismissed before its underlay arrives never mounts one", async () => {
  seed();
  reset();
  const view = await mountLayer();
  try {
    await act(async () => { store.setRailPlugin("demo"); });
    await act(async () => { nav.rememberMobileWorkspacePackage("demo"); });
    await act(async () => { store.setRailPlugin(null); });
    await sleep(PAST_STACK_MS);
    assert.equal(backdrop(), null, "the settle timer was cancelled with the package");
  } finally {
    await view.unmount();
    reset();
  }
});

test("the layer is a phone-shell concept", async () => {
  seed();
  reset();
  phoneShell = false;
  const view = await mountLayer();
  try {
    await act(async () => { nav.showMobileWorkspaceHome(); });
    assert.equal(backdrop(), null, "wider shells keep their own navigation");
  } finally {
    await view.unmount();
    reset();
  }
});

test("a reduced-motion exit releases the layer immediately", async () => {
  seed();
  reset();
  const view = await mountLayer();
  document.documentElement.dataset.reduceAnimations = "true";
  try {
    await act(async () => { nav.showMobileWorkspaceHome(); });
    assert.ok(backdrop());
    await act(async () => { nav.hideMobileWorkspaceHome(); });
    assert.equal(backdrop(), null, "no exit frame is held when motion is off");
  } finally {
    delete document.documentElement.dataset.reduceAnimations;
    await view.unmount();
    reset();
  }
});

// ---- the keep-alive regression -------------------------------------------------
// ContextRail keeps a visited package's frame mounted (hidden) after close and
// falls back to the placeholder id "panel". That frame used to register itself
// as the resume target ~450ms after Back, which closed the Workspace Back had
// just opened and dropped the user on Chat.

async function mountFrame(props: Record<string, unknown>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (next: Record<string, unknown>) =>
    act(async () => { root.render(createElement(ModuleView, { title: "Files", ...next } as never)); });
  await render(props);
  return {
    container,
    render,
    unmount: async () => { await act(async () => { root.unmount(); }); container.remove(); },
  };
}

test("a closed keep-alive frame never claims to be the resume target or reopens the Workspace", async () => {
  reset();
  const closes: boolean[] = [];
  const frame = await mountFrame({
    id: "files",
    presented: true,
    onClose: () => closes.push(nav.getMobileWorkspaceNavigationSnapshot().homeOpen),
  });
  try {
    assert.deepEqual(nav.getMobileWorkspaceNavigationSnapshot(), { homeOpen: false, lastPackageId: "files" },
      "a presented phone package becomes the resume target");

    // The phone Back button.
    const back = frame.container.querySelector<HTMLButtonElement>(".module-view-back");
    assert.ok(back, "phone frames expose Back");
    assert.equal(back.getAttribute("aria-label"), tr("common.back"));
    await act(async () => { back.click(); });
    assert.deepEqual(closes, [true], "the Workspace is already the foreground target when the package leaves");
    assert.deepEqual(nav.getMobileWorkspaceNavigationSnapshot(), { homeOpen: true, lastPackageId: null });

    // The host keeps the frame mounted, hidden, under the placeholder id.
    await frame.render({ id: "panel", presented: false, onClose: () => {} });
    await sleep(PAST_STACK_MS);
    assert.deepEqual(nav.getMobileWorkspaceNavigationSnapshot(), { homeOpen: true, lastPackageId: null },
      "the hidden frame did not close the Workspace or poison the resume target");

    // Reopening presents it again.
    await frame.render({ id: "files", presented: true, onClose: () => {} });
    assert.deepEqual(nav.getMobileWorkspaceNavigationSnapshot(), { homeOpen: false, lastPackageId: "files" });
  } finally {
    await frame.unmount();
    reset();
  }
});

test("Close forgets the package: the next Tools tap opens the Workspace home", async () => {
  reset();
  let closes = 0;
  const frame = await mountFrame({ id: "files", presented: true, onClose: () => { closes += 1; } });
  try {
    assert.deepEqual(nav.getMobileWorkspaceNavigationSnapshot(), { homeOpen: false, lastPackageId: "files" });
    assert.equal(localStorage.getItem("polyth.mobileWorkspace.lastPackage"), "files");
    const close = frame.container.querySelector<HTMLButtonElement>(".module-view-dismiss");
    assert.ok(close, "phone frames expose Close");
    await act(async () => { close.click(); });
    assert.equal(closes, 1, "Close dismisses the window");
    assert.deepEqual(nav.getMobileWorkspaceNavigationSnapshot(), { homeOpen: false, lastPackageId: null },
      "…and the package is no longer what Tools resumes");
    assert.equal(localStorage.getItem("polyth.mobileWorkspace.lastPackage"), null, "not after a reload either");

    // The host hides the frame; nothing re-registers it.
    await frame.render({ id: "files", presented: false, onClose: () => {} });
    await sleep(PAST_STACK_MS);
    assert.deepEqual(nav.getMobileWorkspaceNavigationSnapshot(), { homeOpen: false, lastPackageId: null });
  } finally {
    await frame.unmount();
    reset();
  }
});

test("a wider shell's frame has no Workspace to return to", async () => {
  reset();
  phoneShell = false;
  const frame = await mountFrame({ id: "files", presented: true, onClose: () => {} });
  try {
    assert.equal(frame.container.querySelector(".module-view-back"), null, "Back is a phone control");
    assert.deepEqual(nav.getMobileWorkspaceNavigationSnapshot(), { homeOpen: false, lastPackageId: null });
  } finally {
    await frame.unmount();
    reset();
  }
});
