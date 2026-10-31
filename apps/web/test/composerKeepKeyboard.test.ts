// Keep-keyboard surfaces (the composer): a touch on their controls, or on a
// picker they open, never moves focus off the editor, so the software keyboard
// stays open. Mouse/keyboard focus management is unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as Window & typeof globalThis,
  document: dom.document as unknown as Document,
  localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "requestAnimationFrame", {
  configurable: true,
  value: (callback: FrameRequestCallback) => { callback(0); return 1; },
});
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: () => {} });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// A phone shell: compact popover presentation for menus.
Object.defineProperty(dom, "matchMedia", {
  configurable: true,
  value: (query: string) => ({ matches: true, media: query, addEventListener: () => {}, removeEventListener: () => {} }),
});

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const ui = await import("../src/components/ui/index.ts");
const viewport = await import("../src/mobileViewport.ts");
viewport.startMobileViewport();

const PointerEventCtor = (dom as unknown as { PointerEvent: typeof PointerEvent }).PointerEvent;
const MouseEventCtor = (dom as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
const KeyboardEventCtor = (dom as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;

/** One tap as an engine delivers it: pointerdown, compatibility mousedown, click.
 *  Resolves to whether the focus-moving mousedown was cancelled. */
async function tap(target: Element, pointerType = "touch"): Promise<boolean> {
  let prevented = false;
  await act(async () => {
    target.dispatchEvent(new PointerEventCtor("pointerdown", { bubbles: true, cancelable: true, pointerType }));
    const down = new MouseEventCtor("mousedown", { bubbles: true, cancelable: true });
    target.dispatchEvent(down);
    prevented = down.defaultPrevented;
    target.dispatchEvent(new MouseEventCtor("click", { bubbles: true, cancelable: true, detail: 1 }));
  });
  return prevented;
}

async function mountComposer() {
  const picked: string[] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement("div", null,
      createElement("div", { className: "composer", "data-keep-keyboard": "" },
        createElement("textarea", { className: "editor" }),
        createElement("input", { className: "inline-field" }),
        createElement(ui.Menu, {
          label: "Thinking",
          entries: [
            { id: "low", label: "Low", onSelect: () => picked.push("low") },
            { id: "high", label: "High", onSelect: () => picked.push("high") },
          ],
          children: (trigger: object) => createElement("button", { ...trigger, type: "button", className: "effort" }, "Effort"),
        }),
      ),
      createElement("button", { type: "button", className: "outside" }, "Outside"),
    ));
  });
  const q = <T extends Element>(selector: string) => document.querySelector<T>(selector);
  return {
    picked,
    editor: q<HTMLTextAreaElement>(".editor")!,
    field: q<HTMLInputElement>(".inline-field")!,
    trigger: q<HTMLButtonElement>(".effort")!,
    outside: q<HTMLButtonElement>(".outside")!,
    menu: () => q<HTMLElement>('[role="menu"]'),
    items: () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')],
    unmount: async () => {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

test("a touch keeps the composer editor focused through a menu open, pick and close", async () => {
  const view = await mountComposer();
  try {
    view.editor.focus();
    assert.equal(await tap(view.trigger), true, "the trigger's focus-moving mousedown is cancelled");
    assert.ok(view.menu(), "the click still opens the menu on the first tap");
    assert.equal(document.activeElement, view.editor, "opening does not focus the first item");

    assert.equal(await tap(view.items()[1]!), true, "a menu item tap does not take focus either");
    assert.deepEqual(view.picked, ["high"], "the item click still dispatches");
    assert.equal(view.menu(), null);
    assert.equal(document.activeElement, view.editor, "closing does not return focus to the trigger");
    assert.equal(viewport.heldKeyboardEntry(), view.editor);
  } finally { await view.unmount(); }
});

test("an outside press and Escape dismiss without stealing the held editor", async () => {
  const view = await mountComposer();
  try {
    view.editor.focus();
    await tap(view.trigger);
    assert.ok(view.menu());
    await tap(view.editor);
    assert.equal(view.menu(), null, "tapping the editor dismisses the menu");
    assert.equal(document.activeElement, view.editor);

    await tap(view.trigger);
    await act(async () => {
      document.dispatchEvent(new KeyboardEventCtor("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    assert.equal(view.menu(), null);
    assert.equal(document.activeElement, view.editor);
  } finally { await view.unmount(); }
});

test("pickers do not dismiss a keyboard the composer holds; elsewhere they still do", async () => {
  const view = await mountComposer();
  try {
    view.editor.focus();
    await tap(view.trigger);
    await viewport.dismissKeyboard();
    assert.equal(document.activeElement, view.editor, "a composer-opened picker keeps the keyboard");
    await tap(view.editor);

    await tap(view.outside);
    assert.equal(viewport.heldKeyboardEntry(), null, "a tap outside the composer releases the hold");
    await viewport.dismissKeyboard();
    assert.notEqual(document.activeElement, view.editor, "non-composer pickers keep the §22 dismissal");
  } finally { await view.unmount(); }
});

test("text fields still take focus and mouse menus keep their focus management", async () => {
  const view = await mountComposer();
  try {
    view.editor.focus();
    assert.equal(await tap(view.field), false, "a text field in the composer still takes focus");

    view.editor.focus();
    assert.equal(await tap(view.trigger, "mouse"), false, "mouse focus is unchanged");
    assert.equal(document.activeElement, view.items()[0], "a mouse-opened menu focuses its first item");
    await act(async () => {
      document.dispatchEvent(new KeyboardEventCtor("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    assert.equal(document.activeElement, view.trigger, "and returns focus to its trigger");
  } finally { await view.unmount(); }
});
