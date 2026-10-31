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

// Mirrors the phone Navigator: the menu's trigger lives inside an ancestor
// role="dialog", so a press elsewhere in that dialog is an ordinary outside
// press, not a nested-dialog interaction.
function DialogHostHarness() {
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
    { role: "dialog", "aria-label": "Navigator" },
    createElement("button", { "aria-label": "Another row" }, "Another row"),
    createElement("button", {
      ref: triggerRef,
      "aria-label": "Actions",
      "aria-expanded": open,
      onClick: () => setOpen((value) => !value),
    }, "Open"),
    open
      ? createElement("div", { ref: menuRef, role: "menu", onKeyDown },
          createElement("button", { role: "menuitem" }, "First"))
      : null,
  );
}

const KeyboardEventCtor = (dom as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;
const MouseEventCtor = (dom as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
// happy-dom's Event/dispatchEvent pair, loosely typed so the DOM lib's Event
// (a different class) never has to line up with it.
const dispatchWindowBlur = () => {
  const win = dom as unknown as {
    Event: new (type: string) => object;
    dispatchEvent: (event: object) => boolean;
  };
  win.dispatchEvent(new win.Event("blur"));
};

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
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const dialogButton = document.createElement("button");
    dialogButton.textContent = "Dialog control";
    dialog.append(dialogButton);
    document.body.append(dialog);
    await act(async () => {
      dialogButton.dispatchEvent(new MouseEventCtor("pointerdown", { bubbles: true, cancelable: true }));
    });
    assert.ok(container.querySelector('[role="menu"]'), "a portaled dialog stays open over its parent menu");
    await act(async () => {
      dialogButton.dispatchEvent(new KeyboardEventCtor("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    assert.ok(container.querySelector('[role="menu"]'), "a dialog owns Escape before the parent menu");
    dialog.remove();

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

test("a menu hosted by a dialog closes on an outside press inside that dialog", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(DialogHostHarness)); });
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Actions"]')!;
    const other = container.querySelector<HTMLButtonElement>('[aria-label="Another row"]')!;

    await act(async () => { trigger.click(); });
    assert.ok(container.querySelector('[role="menu"]'), "the menu opens inside the dialog");
    await act(async () => {
      other.dispatchEvent(new MouseEventCtor("pointerdown", { bubbles: true, cancelable: true }));
    });
    // Booleans, not nodes: a failing assert would serialize the DOM.
    assert.equal(!!container.querySelector('[role="menu"]'), false, "a press on another control in the host dialog closes the menu");

    await act(async () => { trigger.click(); });
    await act(async () => {
      other.dispatchEvent(new KeyboardEventCtor("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    assert.equal(!!container.querySelector('[role="menu"]'), false, "Escape in the host dialog closes the menu");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

// Switching to another application fires no pointer or key event, so a menu
// used to stay open behind whatever the user did next.
test("a menu closes when the window loses focus", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(Harness)); });
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Actions"]')!;

    await act(async () => { trigger.click(); });
    assert.ok(container.querySelector('[role="menu"]'), "the menu is open before the window blurs");
    await act(async () => { dispatchWindowBlur(); });
    assert.equal(!!container.querySelector('[role="menu"]'), false, "a window blur dismisses the menu");
    assert.equal(document.activeElement, trigger, "focus returns to the opener");

    // A closed menu must not keep a listener that reacts to later blurs.
    await act(async () => { trigger.click(); });
    await act(async () => { dispatchWindowBlur(); });
    assert.equal(!!container.querySelector('[role="menu"]'), false);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
