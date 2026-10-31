// The immersive voice layer covers the chat column, not the whole shell: the
// sidebar and the rail/navigator stay visible. These tests mount the real host
// inside a shell DOM and assert the portal target and the published column
// frame (including the RTL mirror) rather than a re-implemented layout.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { act, createElement } from "react";
import { Window } from "happy-dom";
import type { VoiceModeController, VoiceModeSnapshot } from "../widgets/controller.ts";

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

const rect = (left: number, top: number, right: number, bottom: number): DOMRect => ({
  x: left, y: top, left, top, right, bottom,
  width: right - left, height: bottom - top,
  toJSON: () => ({}),
}) as DOMRect;

const stubRect = (element: Element, value: DOMRect): void => {
  Object.defineProperty(element, "getBoundingClientRect", { value: () => value, configurable: true });
};

const fakeController = (snapshot: VoiceModeSnapshot): VoiceModeController => ({
  subscribe: () => () => {},
  getSnapshot: () => snapshot,
  getLevels: () => ({ input: 0, output: 0 }),
  setImmersive: () => {},
  stop: () => {},
  primary: () => {},
  toggleMute: () => {},
  stopAgent: () => {},
}) as unknown as VoiceModeController;

test("the immersive layer is anchored to the chat column, not the shell", async () => {
  const dom = new Window({ width: 1280, height: 800 });
  Object.assign(globalThis, {
    window: dom,
    document: dom.document,
    localStorage: dom.localStorage,
    CustomEvent: dom.CustomEvent,
    Event: dom.Event,
    HTMLElement: dom.HTMLElement,
    MutationObserver: dom.MutationObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 16) as unknown as number,
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });

  dom.document.body.innerHTML = `
    <div class="app">
      <div class="header"></div>
      <div class="app-shell">
        <aside class="sidebar"></aside>
        <div class="workspace"><div id="mount"></div></div>
        <aside class="railbar"></aside>
      </div>
    </div>`;
  const shell = dom.document.querySelector(".app-shell") as unknown as HTMLElement;
  const workspace = dom.document.querySelector(".workspace") as unknown as HTMLElement;
  const mount = dom.document.querySelector("#mount") as unknown as HTMLElement;
  // happy-dom has no layout: the frames are the real geometry the layer sees.
  stubRect(shell, rect(0, 0, 1000, 600));
  stubRect(workspace, rect(240, 52, 700, 600));

  const { VoiceModeHost } = await import("../widgets/VoiceModeLayer.tsx");
  const { voiceModeStrings } = await import("../src/strings.ts");
  const snapshot: VoiceModeSnapshot = {
    phase: "listening", agent: "idle", userText: "", assistantText: "", tool: null, action: null,
    error: null, notice: null, muted: false, immersive: true, route: null, sessionId: "s1",
  };
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(mount);
  try {
    await act(async () => {
      root.render(createElement(VoiceModeHost, {
        controller: fakeController(snapshot),
        strings: voiceModeStrings("en"),
        sessionTitle: () => "",
        activeSessionId: () => "s1",
        bargeIn: () => false,
        commands: () => null,
      }));
    });

    const layer = shell.querySelector<HTMLElement>(".voice-mode-immersive");
    assert.ok(layer, "the immersive layer renders");
    assert.equal(layer.parentElement, shell, "the layer is portaled into the shell, not the viewport");
    assert.equal(layer.getAttribute("data-anchored"), "shell");
    // The published frame is the workspace box relative to the shell.
    assert.equal(layer.style.getPropertyValue("--voice-layer-block-start"), "52px");
    assert.equal(layer.style.getPropertyValue("--voice-layer-block-end"), "0px");
    assert.equal(layer.style.getPropertyValue("--voice-layer-inline-start"), "240px");
    assert.equal(layer.style.getPropertyValue("--voice-layer-inline-end"), "300px");
    // The column's distance from the physical top, so the layer clears the
    // status bar and notch only where the column does not.
    assert.equal(layer.style.getPropertyValue("--voice-layer-viewport-top"), "52px");
    // RTL mirrors the inline edges, not the block edges.
    shell.style.direction = "rtl";
    dom.document.documentElement.setAttribute("dir", "rtl");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(layer.style.getPropertyValue("--voice-layer-inline-start"), "300px", "rtl keeps the layer inside the chat column");
    assert.equal(layer.style.getPropertyValue("--voice-layer-inline-end"), "240px");
    // The regions the layer must not cover are still present beside it.
    assert.ok(shell.querySelector(".sidebar"), "the sidebar stays visible");
    assert.ok(shell.querySelector(".railbar"), "the navigator rail stays visible");
  } finally {
    await act(async () => { root.unmount(); });
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    await dom.happyDOM.close();
  }
});

test("a host outside the shell falls back to the viewport layer", async () => {
  const dom = new Window({ width: 1280, height: 800 });
  Object.assign(globalThis, {
    window: dom,
    document: dom.document,
    localStorage: dom.localStorage,
    CustomEvent: dom.CustomEvent,
    Event: dom.Event,
    HTMLElement: dom.HTMLElement,
    MutationObserver: dom.MutationObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 16) as unknown as number,
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });

  const mount = dom.document.createElement("div");
  dom.document.body.appendChild(mount);
  const { VoiceModeHost } = await import("../widgets/VoiceModeLayer.tsx");
  const { voiceModeStrings } = await import("../src/strings.ts");
  const snapshot: VoiceModeSnapshot = {
    phase: "listening", agent: "idle", userText: "", assistantText: "", tool: null, action: null,
    error: null, notice: null, muted: false, immersive: true, route: null, sessionId: "s1",
  };
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(mount as unknown as HTMLElement);
  try {
    await act(async () => {
      root.render(createElement(VoiceModeHost, {
        controller: fakeController(snapshot),
        strings: voiceModeStrings("en"),
        sessionTitle: () => "",
        activeSessionId: () => "s1",
        bargeIn: () => false,
        commands: () => null,
      }));
    });
    const layer = dom.document.querySelector(".voice-mode-immersive") as unknown as HTMLElement | null;
    assert.ok(layer, "the fallback layer still renders");
    assert.equal(layer.parentElement, dom.document.body, "without a shell the layer uses the viewport");
    assert.equal(layer.getAttribute("data-anchored"), null);
  } finally {
    await act(async () => { root.unmount(); });
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    await dom.happyDOM.close();
  }
});
