// A composer-held software keyboard must survive the Full access
// confirmation. The composer is a keep-keyboard surface; the approval
// switch's confirmation is the one modal that flow opens, and a modal
// normally claims focus and inerts the page behind it — both blur the editor
// and dismiss the keyboard. `confirmAlert(..., { keepKeyboard: true })` makes
// that specific dialog yield to the held editor. Other dialogs (including a
// prompt that collects input) still take focus.
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
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
// The modal's opening-focus guard polls over rAF; this fixture asserts the
// focus decision directly, so the callback is never run.
Object.defineProperty(globalThis, "requestAnimationFrame", {
  configurable: true,
  value: (_callback: FrameRequestCallback) => 1,
});
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: () => {} });
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
const { confirmAlert, resolveAlert, promptAlert } = await import("../src/alerts.ts");
const AlertDialog = (await import("../src/components/AlertDialog.tsx")).default;
const viewport = await import("../src/mobileViewport.ts");
viewport.startMobileViewport();

const PointerEventCtor = (dom as unknown as { PointerEvent: typeof PointerEvent }).PointerEvent;
const MouseEventCtor = (dom as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;

/** The tap a phone delivers inside the keep-keyboard zone: pointerdown marks
 *  the gesture, the compatibility mousedown is what a tap's focus move uses. */
async function tap(target: Element): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new PointerEventCtor("pointerdown", { bubbles: true, cancelable: true, pointerType: "touch" }));
    target.dispatchEvent(new MouseEventCtor("mousedown", { bubbles: true, cancelable: true }));
    target.dispatchEvent(new MouseEventCtor("click", { bubbles: true, cancelable: true, detail: 1 }));
  });
}

/** A composer holding the keyboard, plus the app-level alert host. */
async function mountHeldComposer() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(AlertDialog)); });
  const composer = document.createElement("div");
  composer.className = "composer";
  composer.setAttribute(viewport.KEEP_KEYBOARD_ATTRIBUTE, "");
  const editor = document.createElement("textarea");
  composer.appendChild(editor);
  document.body.appendChild(composer);
  editor.focus();
  await tap(editor);
  return {
    editor,
    composer,
    dialog: () => document.querySelector<HTMLElement>(".alert-dialog"),
    confirmButton: () => document.querySelector<HTMLButtonElement>(".alert-confirm"),
    unmount: async () => {
      // An unanswered confirmation must not leave its promise (or the alert
      // queue) behind when a check fails mid-test.
      resolveAlert(null);
      await act(async () => { root.unmount(); });
      composer.remove();
      container.remove();
    },
  };
}

test("the Full access confirmation keeps a composer-held keyboard open", async () => {
  const view = await mountHeldComposer();
  assert.equal(viewport.heldKeyboardEntry(), view.editor, "the composer holds the keyboard");
  let decision: Promise<boolean> | undefined;
  await act(async () => { decision = confirmAlert("Full access?", { keepKeyboard: true }); });
  const shown = view.dialog() !== null;
  const keepsFocus = document.activeElement === view.editor;
  const notInert = !view.composer.hasAttribute("inert");
  const notHidden = !view.composer.hasAttribute("aria-hidden");
  await act(async () => { view.confirmButton()!.click(); });
  const resolved = await decision;
  await view.unmount();

  assert.ok(shown, "the confirmation is shown");
  assert.ok(keepsFocus, "the dialog does not claim focus from the held editor");
  assert.ok(notInert, "the held editor's surface is not inert");
  assert.ok(notHidden, "and stays exposed to assistive tech");
  assert.equal(resolved, true, "the confirmation still resolves on its button");
});

test("a confirmation without the opt-in keeps its own focus", async () => {
  const view = await mountHeldComposer();
  let decision: Promise<boolean> | undefined;
  await act(async () => { decision = confirmAlert("Delete?", { destructive: true }); });
  const focusedConfirm = document.activeElement === view.confirmButton();
  const isolated = view.composer.hasAttribute("inert");
  await act(async () => { view.confirmButton()!.click(); });
  const resolved = await decision;
  await view.unmount();

  assert.ok(focusedConfirm, "the dialog focuses its confirm button");
  assert.ok(isolated, "the page behind it is isolated as before");
  assert.equal(resolved, true);
});

test("prompt alert does not submit on composing Enter", async () => {
  const view = await mountHeldComposer();
  let settled = false;
  let resolvedValue: string | null = null;
  let decision: Promise<string | null> | undefined;
  await act(async () => {
    decision = promptAlert("Enter value", { initialValue: "initial" }).then((val) => {
      settled = true;
      resolvedValue = val;
      return val;
    });
  });
  const input = document.querySelector<HTMLInputElement>(".alert-dialog input");
  assert.equal(input !== null, true, "prompt input is mounted");

  // 1. Enter with isComposing: true does not submit
  await act(async () => {
    input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, isComposing: true }));
  });
  assert.equal(settled, false, "isComposing Enter must not resolve alert");

  // 2. Enter with keyCode: 229 does not submit
  await act(async () => {
    input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, keyCode: 229 } as KeyboardEventInit));
  });
  assert.equal(settled, false, "keyCode 229 Enter must not resolve alert");

  // 3. Normal Enter submits
  await act(async () => {
    input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
  await decision;
  assert.equal(settled, true, "normal Enter resolves alert");
  assert.equal(resolvedValue, "initial");
  await view.unmount();
});

