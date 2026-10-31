// "Keep the pinned window", mounted for real (happy-dom): a launcher swaps the
// content of the pinned frame, and the frame keeps the width the person saw.
// The next package's own default or comfortable maximum must not resize it.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  location: dom.location,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  MouseEvent: dom.MouseEvent,
  PointerEvent: dom.PointerEvent,
  KeyboardEvent: dom.KeyboardEvent,
  requestAnimationFrame: (callback: FrameRequestCallback) =>
    setTimeout(() => callback(Date.now()), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { fetch?: unknown }).fetch = async (input: string | URL | Request) => {
  const body = String(input).startsWith("/api/git/status")
    ? { branch: null, ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [], conflicted: [], clean: true, isRepo: false }
    : [];
  return { ok: true, status: 200, statusText: "OK", json: async () => body, text: async () => JSON.stringify(body) };
};

// Chat's measured box: wide enough to dock beside it. The pane reports no
// width, so the admission width stays this number whatever the mode.
const CHAT_WIDTH = 1200;
const elementProto = dom.HTMLElement.prototype as unknown as { getBoundingClientRect: (this: HTMLElement) => DOMRect };
const realRect = elementProto.getBoundingClientRect;
elementProto.getBoundingClientRect = function (this: HTMLElement) {
  if (this.classList.contains("workspace")) {
    return { x: 0, y: 0, top: 0, left: 0, right: CHAT_WIDTH, bottom: 800, width: CHAT_WIDTH, height: 800, toJSON() {} } as DOMRect;
  }
  return realRect.call(this);
};

register("./tsxHooks.mjs", import.meta.url);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { registerSurface } = await import("../src/surfaces.ts");
const { activateProject, applyProjectUpsert, closeWorkspacePane, getState, openWorkspacePane, togglePanePin } = await import("../src/store.ts");
const { toggleCapability } = await import("../src/builtinCapabilities.ts");
const { getUiSettings, setUiSettings } = await import("../src/uiPrefs.ts");
const { getWorkspacePanePrefs, SHARED_PINNED_PANE_KEY } = await import("../src/workspace/panePrefs.ts");
const { default: ContextRail } = await import("../src/components/ContextRail.tsx");

const PROJECT = "shared-pinned-frame";

test("switching packages keeps the pinned frame at the width it showed", async () => {
  applyProjectUpsert({ id: PROJECT, path: "/work/shared-pinned-frame", name: "Frame", createdAt: 1 });
  activateProject(PROJECT);
  const unregister = [
    // Wide default: 0.5 × 1200 = 600, under its own 720 maximum.
    registerSurface({
      id: "frame-wide", title: "Wide", capabilityId: "frame-wide", order: 1, component: () => createElement("p", null, "wide"),
      presentation: { kind: "workspace", defaultRatio: 0.5, minWidth: 320, preferredMaxWidth: 720, keepAlive: false, escape: "close" },
    }),
    // On its own this window would open at 420 (its comfortable maximum).
    registerSurface({
      id: "frame-narrow", title: "Narrow", capabilityId: "frame-narrow", order: 2, component: () => createElement("p", null, "narrow"),
      presentation: { kind: "workspace", defaultRatio: 0.3, minWidth: 320, preferredMaxWidth: 420, keepAlive: false, escape: "close" },
    }),
  ];
  const before = getUiSettings().sharedPinnedWindow;
  const app = document.createElement("div");
  app.className = "app";
  app.innerHTML = `<div class="app-shell"><main class="workspace"></main><div class="rail-host"></div></div>`;
  document.body.appendChild(app);
  const root = createRoot(app.querySelector(".rail-host")!);
  const railWidth = () => app.querySelector<HTMLElement>(".railbar > .rail")?.style.getPropertyValue("--rail-w") ?? "";
  try {
    setUiSettings({ sharedPinnedWindow: true });
    await act(async () => { root.render(createElement(ContextRail)); });
    await act(async () => { openWorkspacePane("frame-wide"); });
    await act(async () => { togglePanePin(); });
    assert.equal(getState().paneMode, "pinned");
    assert.equal(railWidth(), "600px", "the first pinned window opens at its own default");
    assert.equal(getWorkspacePanePrefs(PROJECT).widths[SHARED_PINNED_PANE_KEY], undefined,
      "pinning alone stores no frame width (the geometry may still be settling)");

    await act(async () => { toggleCapability("frame-narrow", () => openWorkspacePane("frame-narrow")); });
    assert.equal(getState().railPlugin, "frame-narrow");
    assert.equal(getState().paneMode, "pinned", "only the content changes");
    assert.equal(railWidth(), "600px", "the frame keeps its width past the next package's own maximum");
    assert.equal(getWorkspacePanePrefs(PROJECT).widths[SHARED_PINNED_PANE_KEY], 600, "the carried width becomes the frame's");

    await act(async () => { toggleCapability("frame-wide", () => openWorkspacePane("frame-wide")); });
    assert.equal(railWidth(), "600px", "and switching back changes nothing");
  } finally {
    await act(async () => { closeWorkspacePane(); });
    await act(async () => root.unmount());
    app.remove();
    for (const off of unregister) off();
    setUiSettings({ sharedPinnedWindow: before });
  }
});
