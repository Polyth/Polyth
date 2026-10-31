// Reported from an iPhone: opening the approval level switch over an open
// keyboard (and then moving focus into it) stranded the switch near the top of
// the screen instead of above its button. A phone now dismisses the keyboard
// first and opens once the viewport has settled — the composer Picker's
// contract. happy-dom cannot evaluate the phone shell's media query list, so
// this file stubs matchMedia as a phone before any shell module loads.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

register("./tsxHooks.mjs", import.meta.url);

const dom = new Window({ url: "http://127.0.0.1:4400/", width: 390, height: 844 });
Object.assign(globalThis, {
  window: dom as unknown as Window & typeof globalThis,
  document: dom.document as unknown as Document,
  localStorage: dom.localStorage as unknown as Storage,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  KeyboardEvent: dom.KeyboardEvent,
  MouseEvent: dom.MouseEvent,
  PointerEvent: dom.PointerEvent,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
  cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const phoneMedia = (media: string) => ({
  matches: media.includes("max-width: 480px"),
  media,
  onchange: null,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() { return false; },
});
(dom as unknown as { matchMedia: typeof phoneMedia }).matchMedia = phoneMedia;
(globalThis as unknown as { matchMedia: typeof phoneMedia }).matchMedia = phoneMedia;
globalThis.fetch = async () => new Response("{}", { status: 404 });

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AutoApproveAction } = await import("../../../packages/permissions/widgets/index.tsx");
const { getViewportMetrics, setNativeKeyboardInset } = await import("../src/mobileViewport.ts");

const frames = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
const options = () => document.querySelectorAll(".approval-level-option");

test("a phone opens the approval level switch only after the keyboard is dismissed", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const editor = document.createElement("textarea");
  document.body.appendChild(editor);
  const context = {
    projectId: "phone-approvals", sessionId: null, editing: false, instanceId: "phone-auto-approve",
    config: {}, updateConfig: () => {}, autoApproveOn: false, autoApproveAll: false, setDraftAutoApprove: () => {},
  };
  try {
    await act(async () => root.render(createElement(AutoApproveAction, { context })));
    const button = () => container.querySelector<HTMLButtonElement>(".composer-auto-approve")!;
    await act(async () => { setNativeKeyboardInset(300); });
    assert.equal(getViewportMetrics().covering, true, "the fixture has an open keyboard");
    editor.focus();
    assert.equal(document.activeElement, editor);

    act(() => button().click());
    assert.notEqual(document.activeElement, editor, "the composer gives up the keyboard first");
    assert.equal(options().length, 0, "the switch is not anchored under the open keyboard");
    await act(async () => { setNativeKeyboardInset(0); });
    await frames();
    assert.equal(options().length, 3, "the switch opens once the viewport has settled");
    assert.equal(button().getAttribute("aria-expanded"), "true");

    // With the keyboard already closed the switch opens immediately.
    await act(async () => button().click());
    assert.equal(options().length, 0);
    await act(async () => button().click());
    assert.equal(options().length, 3);
    await act(async () => button().click());

    // A control that goes away while the keyboard is dismissed never opens late.
    await act(async () => { setNativeKeyboardInset(300); });
    act(() => button().click());
    await act(async () => root.unmount());
    await frames();
    assert.equal(options().length, 0, "an unmounted control never opens late");
  } finally {
    await act(async () => { setNativeKeyboardInset(0); });
    editor.remove();
    container.remove();
  }
});
