import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const dom = new Window();
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "requestAnimationFrame", {
  configurable: true,
  value: (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  },
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement, useRef, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useDismissibleMenu } = await import("../src/components/a11y/Menu.ts");

function Harness() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const onKeyDown = useDismissibleMenu({
    open,
    triggerRef,
    menuRef,
    onClose: () => setOpen(false),
  });
  return createElement(
    "div",
    null,
    createElement("button", {
      ref: triggerRef,
      "aria-label": "Actions",
      "aria-expanded": open,
      onClick: () => setOpen((value) => !value),
    }, "Open"),
    open
      ? createElement("div", { ref: menuRef, role: "menu", onKeyDown },
          createElement("button", { role: "menuitem" }, "First"),
          createElement("button", { role: "menuitem" }, "Second"))
      : null,
  );
}

const KeyboardEventCtor = (dom as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;
const MouseEventCtor = (dom as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;

test("shared menus focus, navigate, dismiss, and restore their trigger", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(Harness)); });
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Actions"]')!;

    await act(async () => { trigger.click(); });
    assert.equal(document.activeElement?.textContent, "First");
    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEventCtor("keydown", {
        key: "ArrowDown", bubbles: true, cancelable: true,
      }));
    });
    assert.equal(document.activeElement?.textContent, "Second");

    await act(async () => {
      document.dispatchEvent(new KeyboardEventCtor("keydown", {
        key: "Escape", bubbles: true, cancelable: true,
      }));
    });
    assert.equal(container.querySelector('[role="menu"]'), null);
    assert.equal(document.activeElement, trigger);

    await act(async () => { trigger.click(); });
    await act(async () => {
      document.body.dispatchEvent(new MouseEventCtor("pointerdown", { bubbles: true, cancelable: true }));
    });
    assert.equal(container.querySelector('[role="menu"]'), null);
    assert.equal(document.activeElement, trigger);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
