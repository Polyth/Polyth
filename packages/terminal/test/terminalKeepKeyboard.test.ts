// The terminal's bottom controls (extra keys, ⋯ menu, text-input row) never take
// the software keyboard down; only the keyboard button does, on purpose. The touch
// chrome and the hidden terminal input are a host keep-keyboard surface, the ⋯
// menu is an anchored popover rather than a modal phone sheet while a keyboard is
// up, and the text-input row hands the keyboard over before it unmounts.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import { createTerminalEmulator } from "../widgets/terminal/emulator.ts";
import { resetTouchPrefsCache, TERMINAL_TOUCH_PREFS_KEY } from "../widgets/terminal/touchPrefs.ts";

const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  HTMLInputElement: dom.HTMLInputElement,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
Object.defineProperty(globalThis, "isSecureContext", { value: true, configurable: true });
// A phone shell: every media query matches, so Menu offers its phone sheet.
Object.defineProperty(dom, "matchMedia", {
  configurable: true,
  value: (query: string) => ({ matches: true, media: query, addEventListener: () => {}, removeEventListener: () => {} }),
});

register("./tsxHooks.mjs", import.meta.url);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: TermPane } = await import("../widgets/TermPane.tsx");
const viewport = await import("../../../apps/web/src/mobileViewport.ts");
// What the app's bootstrap installs: the keep-keyboard seam the terminal opts into.
viewport.startMobileViewport();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const PointerEventCtor = (dom as unknown as { PointerEvent: typeof PointerEvent }).PointerEvent;
const MouseEventCtor = (dom as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
const KeyboardEventCtor = (dom as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;

async function mountTerminal() {
  dom.localStorage.removeItem(TERMINAL_TOUCH_PREFS_KEY);
  resetTouchPrefsCache();
  const emu = createTerminalEmulator({ cols: 40, rows: 8 });
  const sent: string[] = [];
  const container = document.createElement("div");
  container.className = "term-view";
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(TermPane, {
      emu,
      label: "shell",
      running: true,
      send: (text: string) => sent.push(text),
      onResize: () => {},
      sessions: [{ id: "a", title: "shell 1", running: true }],
      activeSessionId: "a",
      onSelectSession: () => {},
      onNewSession: () => {},
    }));
  });
  const q = <T extends Element>(selector: string) => container.querySelector<T>(selector);
  const input = q<HTMLInputElement>(".term-mobile-input")!;
  const body = q<HTMLElement>(".term-body")!;
  const keyButton = (label: string) => {
    const found = Array.from(container.querySelectorAll<HTMLButtonElement>(".term-extra-key"))
      .find((button) => button.querySelector(".term-extra-key-label")?.textContent === label);
    assert.ok(found, `extra key ${label}`);
    return found;
  };
  /** A finger going down as an engine delivers it: pointerdown, then the
   *  compatibility mousedown (what moves focus). Reports what was cancelled. */
  const touchDown = async (target: Element) => {
    let pointerPrevented = false;
    let mousePrevented = false;
    await act(async () => {
      const down = new PointerEventCtor("pointerdown", { bubbles: true, cancelable: true, pointerType: "touch", button: 0 });
      target.dispatchEvent(down);
      pointerPrevented = down.defaultPrevented;
      const mouse = new MouseEventCtor("mousedown", { bubbles: true, cancelable: true, button: 0 });
      target.dispatchEvent(mouse);
      mousePrevented = mouse.defaultPrevented;
    });
    return { pointerPrevented, mousePrevented };
  };
  /** Focus the way a finished tap does; TermPane's focus handlers update state. */
  const focus = (target: HTMLElement) => act(async () => { target.focus(); });
  const click = (target: Element) => act(async () => {
    target.dispatchEvent(new MouseEventCtor("click", { bubbles: true, cancelable: true, detail: 1 }));
  });
  /** A complete tap on a menu trigger or menu item. */
  const tap = async (target: Element) => {
    const result = await touchDown(target);
    await click(target);
    await act(async () => { await sleep(20); });
    return result;
  };
  /** Output scrolled up, then fresh output arriving: the "New output" pill appears. */
  const scrollBehind = async (emu: ReturnType<typeof createTerminalEmulator>) => {
    for (const [name, value] of [["scrollHeight", 1000], ["clientHeight", 100]] as const) {
      Object.defineProperty(body, name, { configurable: true, value });
    }
    body.scrollTop = 0;
    await act(async () => { body.dispatchEvent(new dom.Event("scroll") as unknown as Event); });
    await act(async () => { emu.write("fresh output\r\n"); await sleep(30); });
  };
  const menuItem = (label: string) => {
    const found = Array.from(document.body.querySelectorAll<HTMLButtonElement>(".ui-menu-item, .ui-menu-sheet-item"))
      .find((item) => item.textContent?.includes(label));
    assert.ok(found, `menu item ${label}`);
    return found;
  };
  return {
    container, emu, input, body, sent, q, keyButton, touchDown, focus, click, tap, menuItem, scrollBehind,
    unmount: async () => {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

test("the touch chrome and the terminal input are a keep-keyboard surface", async () => {
  const pane = await mountTerminal();
  try {
    assert.ok(pane.input.hasAttribute("data-keep-keyboard"), "the held input belongs to the surface");
    assert.ok(pane.q(".term-touch-chrome")!.hasAttribute("data-keep-keyboard"), "taps on the bottom controls count as keyboard taps");
    assert.ok(!pane.body.closest("[data-keep-keyboard]"), "the output's own tap and long-press handling decides focus");
  } finally {
    await pane.unmount();
  }
});

test("a touch on a bottom control leaves the focused terminal input alone", async () => {
  const pane = await mountTerminal();
  try {
    await pane.focus(pane.input);
    assert.equal(document.activeElement, pane.input);
    const controls: Array<[string, Element]> = [
      ["extra key", pane.keyButton("ESC")],
      ["extra modifier", pane.keyButton("CTRL")],
      ["⋯ menu", pane.q(".term-touch-menu")!],
      ["keyboard button", pane.q(".term-touch-keyboard")!],
    ];
    for (const [name, control] of controls) {
      const { pointerPrevented, mousePrevented } = await pane.touchDown(control);
      assert.equal(pointerPrevented, true, `${name}: pointerdown is cancelled`);
      assert.equal(mousePrevented, true, `${name}: the focus-moving compatibility mousedown is cancelled`);
      assert.equal(document.activeElement, pane.input, `${name}: the keyboard input keeps focus`);
    }
  } finally {
    await pane.unmount();
  }
});

test("the New output pill sits above the bottom keys and scrolls without taking the keyboard down", async () => {
  const pane = await mountTerminal();
  try {
    await pane.focus(pane.input);
    assert.equal(pane.q(".term-follow"), null, "no pill while following the output");
    await pane.scrollBehind(pane.emu);
    const pill = pane.q<HTMLButtonElement>(".term-follow");
    assert.ok(pill, "new output while scrolled up shows the pill");
    const anchor = pill.closest(".term-follow-anchor");
    assert.ok(anchor, "the pill hangs off an anchor on the output's bottom edge");
    assert.equal(anchor.nextElementSibling, pane.q(".term-touch-chrome"), "the anchor sits directly above the touch chrome, so the pill never covers the keys");
    assert.ok(anchor.hasAttribute("data-keep-keyboard"), "the pill is a keep-keyboard surface");

    const { pointerPrevented, mousePrevented } = await pane.touchDown(pill);
    assert.equal(pointerPrevented, true, "pointerdown is cancelled");
    assert.equal(mousePrevented, true, "the focus-moving compatibility mousedown is cancelled");
    assert.equal(document.activeElement, pane.input, "the keyboard input keeps focus");
    await pane.click(pill);
    assert.equal(pane.q(".term-follow"), null, "tapping the pill follows the output again");
    assert.equal(document.activeElement, pane.input, "and the keyboard is still up");
  } finally {
    await pane.unmount();
  }
});

test("the keyboard button still closes an open keyboard and opens a closed one", async () => {
  const pane = await mountTerminal();
  try {
    const toggle = pane.q(".term-touch-keyboard")!;
    await pane.focus(pane.input);
    await pane.tap(toggle);
    assert.notEqual(document.activeElement, pane.input, "open keyboard: the button is the one control that closes it");
    await pane.tap(toggle);
    assert.equal(document.activeElement, pane.input, "closed keyboard: the button raises it");
  } finally {
    await pane.unmount();
  }
});

test("over a live keyboard the ⋯ menu is an anchored popover and focus stays on the input", async () => {
  const pane = await mountTerminal();
  try {
    await pane.focus(pane.input);
    const trigger = pane.q<HTMLButtonElement>(".term-touch-menu")!;
    await pane.tap(trigger);
    assert.ok(document.querySelector('[role="menu"]'), "a popover opened");
    assert.equal(document.querySelector(".sheet"), null, "not the modal phone sheet");
    assert.equal(document.activeElement, pane.input, "opening neither claims focus nor focuses the first item");

    assert.equal((await pane.touchDown(pane.menuItem("Larger text"))).mousePrevented, true, "an item tap does not take focus");
    await pane.click(pane.menuItem("Larger text"));
    await act(async () => { await sleep(20); });
    assert.equal(document.querySelector('[role="menu"]'), null, "choosing an item closes the menu");
    assert.equal(document.activeElement, pane.input, "closing hands focus back to the keyboard input");
  } finally {
    await pane.unmount();
  }
});

test("an outside tap closes the popover without moving focus off the keyboard input", async () => {
  const pane = await mountTerminal();
  try {
    await pane.focus(pane.input);
    await pane.tap(pane.q(".term-touch-menu")!);
    assert.ok(document.querySelector('[role="menu"]'));
    await act(async () => {
      pane.body.dispatchEvent(new PointerEventCtor("pointerdown", { bubbles: true, cancelable: true, pointerType: "touch", button: 0 }));
      await sleep(20);
    });
    assert.equal(document.querySelector('[role="menu"]'), null);
    assert.equal(document.activeElement, pane.input, "the terminal output is not where focus goes in between");
  } finally {
    await pane.unmount();
  }
});

test("without a keyboard the ⋯ menu stays a phone sheet", async () => {
  const pane = await mountTerminal();
  try {
    await pane.focus(pane.body);
    await pane.tap(pane.q(".term-touch-menu")!);
    assert.ok(document.querySelector(".sheet"), "the long menu keeps its sheet");
    assert.equal(document.querySelector('[role="menu"]'), null);
    await pane.tap(pane.menuItem("Larger text"));
    assert.equal(document.querySelector(".sheet"), null);
    assert.notEqual(document.activeElement, pane.input, "a menu used with the keyboard down does not raise it");
  } finally {
    await pane.unmount();
  }
});

test("closing the text-input row hands the keyboard to the terminal input before the field unmounts", async () => {
  const pane = await mountTerminal();
  try {
    // A sideways swipe on the bar opens the row (see terminalTouchSelection).
    const at = { clientX: 100, clientY: 400, pointerId: 7, pointerType: "touch", button: 0, bubbles: true, cancelable: true };
    const home = pane.keyButton("HOME");
    await act(async () => {
      home.dispatchEvent(new PointerEventCtor("pointerdown", at));
      home.dispatchEvent(new PointerEventCtor("pointermove", { ...at, clientX: at.clientX - 90 }));
      home.dispatchEvent(new PointerEventCtor("pointerup", at));
    });
    const field = pane.q<HTMLInputElement>(".term-text-input input");
    assert.ok(field, "the row opened");
    assert.equal(document.activeElement, field);

    let fieldStillMounted: boolean | null = null;
    pane.input.addEventListener("focus", () => { fieldStillMounted = field.isConnected; });
    const close = pane.q<HTMLButtonElement>('.term-text-input button[aria-label="Close text input"]');
    assert.ok(close, "the row has a close button");
    assert.equal((await pane.touchDown(close)).mousePrevented, true, "the close button keeps the field focused until it hands over");
    await pane.click(close);
    assert.equal(fieldStillMounted, true, "the terminal input took focus while the row's field was still mounted");
    assert.equal(pane.q(".term-text-input"), null, "the row closed");
    assert.equal(document.activeElement, pane.input);
  } finally {
    await pane.unmount();
  }
});

test("Escape in the text-input row also hands over cleanly", async () => {
  const pane = await mountTerminal();
  try {
    const at = { clientX: 100, clientY: 400, pointerId: 7, pointerType: "touch", button: 0, bubbles: true, cancelable: true };
    const home = pane.keyButton("HOME");
    await act(async () => {
      home.dispatchEvent(new PointerEventCtor("pointerdown", at));
      home.dispatchEvent(new PointerEventCtor("pointermove", { ...at, clientX: at.clientX - 90 }));
      home.dispatchEvent(new PointerEventCtor("pointerup", at));
    });
    const field = pane.q<HTMLInputElement>(".term-text-input input")!;
    await act(async () => {
      field.dispatchEvent(new KeyboardEventCtor("keydown", { bubbles: true, cancelable: true, key: "Escape" }));
    });
    assert.equal(pane.q(".term-text-input"), null);
    assert.equal(document.activeElement, pane.input);
  } finally {
    await pane.unmount();
  }
});
