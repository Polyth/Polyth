// Touch terminal behavior on the real TermPane: long-press selection with
// handles and its selection bar, tap-to-type through the IME bridge, Termux
// extra keys with sticky modifiers, the text-input row, pinch zoom, and
// drag-scroll in full-screen programs.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import { createTerminalEmulator } from "../widgets/terminal/emulator.ts";
import { getTouchPrefs, resetTouchPrefsCache, TERMINAL_TOUCH_PREFS_KEY } from "../widgets/terminal/touchPrefs.ts";

const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  HTMLInputElement: dom.HTMLInputElement,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
Object.defineProperty(globalThis, "isSecureContext", { value: true, configurable: true });
const copied: string[] = [];
Object.defineProperty(dom.navigator, "clipboard", {
  value: { writeText: async (text: string) => { copied.push(text); } },
});

register("./tsxHooks.mjs", import.meta.url);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: TermPane } = await import("../widgets/TermPane.tsx");
const { HOLD_MS, REPEAT_MS } = await import("../widgets/ExtraKeysBar.tsx");
const { LONG_PRESS_MS } = await import("../widgets/terminal/touchSelection.ts");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function mountTerminal(extra: Record<string, unknown> = {}) {
  dom.localStorage.removeItem(TERMINAL_TOUCH_PREFS_KEY);
  resetTouchPrefsCache();
  const emu = createTerminalEmulator({ cols: 40, rows: 8 });
  emu.write("alpha selected omega");
  const sent: string[] = [];
  const container = document.createElement("div");
  container.className = "term-view";
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(TermPane, {
      emu, label: "shell", running: true, send: (text: string) => sent.push(text), onResize: () => {}, ...extra,
    }));
  });
  const body = container.querySelector<HTMLElement>(".term-body")!;
  const input = container.querySelector<HTMLInputElement>(".term-mobile-input")!;
  const dispatch = async (target: Element | Window, event: Event) => {
    await act(async () => { (target as unknown as EventTarget).dispatchEvent(event); });
    return event;
  };
  const pointer = async (pointerType: string) => dispatch(body,
    new dom.PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType }) as unknown as Event);
  const mouse = (type: string, extra = {}) => new dom.MouseEvent(type, {
    bubbles: true, cancelable: true, button: 0, clientX: 43.2, clientY: 8, ...extra,
  }) as unknown as Event;
  const keyButton = (label: string) => {
    const found = Array.from(container.querySelectorAll<HTMLButtonElement>(".term-extra-key"))
      .find((button) => button.querySelector(".term-extra-key-label")?.textContent === label);
    assert.ok(found, `extra key ${label}`);
    return found;
  };
  const press = async (button: Element, options: { dx?: number; dy?: number; holdMs?: number } = {}) => {
    const at = { clientX: 100, clientY: 400, pointerId: 7, pointerType: "touch", button: 0, bubbles: true, cancelable: true };
    const down = await dispatch(button, new dom.PointerEvent("pointerdown", at) as unknown as Event);
    if (options.dx || options.dy) {
      await dispatch(button, new dom.PointerEvent("pointermove", {
        ...at, clientX: at.clientX + (options.dx ?? 0), clientY: at.clientY + (options.dy ?? 0),
      }) as unknown as Event);
    }
    if (options.holdMs) await act(async () => { await sleep(options.holdMs!); });
    await dispatch(button, new dom.PointerEvent("pointerup", at) as unknown as Event);
    // A real press is followed by a click; the bar must not act twice.
    await dispatch(button, mouse("click", { detail: 1 }));
    return down;
  };
  const typeIme = async (value: string, composing = false) => {
    input.value = value;
    await dispatch(input, new dom.InputEvent("input", { bubbles: true, isComposing: composing }) as unknown as Event);
  };
  const menuItem = (label: string) => {
    const found = Array.from(document.body.querySelectorAll<HTMLButtonElement>(".ui-menu-item"))
      .find((item) => item.querySelector(".ui-menu-item-label")?.textContent === label);
    assert.ok(found, `menu item ${label}`);
    return found;
  };
  // A real long press on the output: finger down on (x, y), held past the
  // threshold. Returns the lift, which takes optional moves first.
  const longPress = async (clientX = 43.2, clientY = 8) => {
    await pointer("touch");
    await dispatch(body, touchEvent("touchstart", [{ identifier: 0, clientX, clientY }]));
    await act(async () => { await sleep(LONG_PRESS_MS + 30); });
    return {
      move: async (x: number, y: number) => dispatch(body, touchEvent("touchmove", [{ identifier: 0, clientX: x, clientY: y }])),
      lift: async () => {
        await dispatch(body, touchEvent("touchend", []));
        // The compatibility events a platform may still send for the lift.
        const down = await dispatch(body, mouse("mousedown"));
        await dispatch(body, mouse("click"));
        return down;
      },
    };
  };
  const highlighted = () => container.querySelectorAll(".term-row-sel").length;
  const handles = () => container.querySelectorAll(".term-select-handle").length;
  const bar = () => container.querySelector<HTMLElement>(".term-select-bar");
  const barButton = (label: string) => {
    const found = Array.from(container.querySelectorAll<HTMLButtonElement>(".term-select-bar .ui-btn"))
      .find((button) => button.textContent === label);
    assert.ok(found, `selection bar ${label}`);
    return found;
  };
  return {
    container, body, input, sent, emu, dispatch, pointer, mouse, keyButton, press, typeIme, menuItem,
    longPress, highlighted, handles, bar, barButton,
    unmount: async () => {
      window.getSelection()?.removeAllRanges();
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

test("a long press selects the word with handles and a selection bar, and keeps the keyboard", async () => {
  const pane = await mountTerminal();
  try {
    await act(async () => { pane.input.focus(); });
    assert.equal(document.activeElement, pane.input, "typing: the hidden input holds the keyboard");
    const held = await pane.longPress();
    assert.equal(pane.highlighted(), 1, "the pressed word is highlighted while the finger is down");
    assert.equal(pane.handles(), 2);
    assert.ok(pane.bar()?.hasAttribute("data-hidden"), "the bar waits for the finger to lift");
    const down = await held.lift();
    assert.equal(down.defaultPrevented, true, "a compatibility mousedown cannot move focus");
    assert.equal(pane.bar()?.hasAttribute("data-hidden"), false);
    assert.equal(pane.bar()?.getAttribute("role"), "toolbar");
    assert.equal(document.activeElement, pane.input, "selecting never takes the keyboard down");
    assert.deepEqual(pane.sent, [], "a long press types nothing");
    const context = await pane.dispatch(pane.body, pane.mouse("contextmenu"));
    assert.equal(context.defaultPrevented, true, "no platform callout competes with the selection");

    const copy = pane.barButton("Copy");
    const pressCopy = await pane.dispatch(copy,
      new dom.PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "touch" }) as unknown as Event);
    assert.equal(pressCopy.defaultPrevented, true, "the bar keeps the keyboard's focus");
    await pane.dispatch(copy, pane.mouse("click"));
    await act(async () => { await Promise.resolve(); });
    assert.equal(copied.at(-1), "selected", "Copy takes the selected cells, not the buffer");
    assert.ok(pane.barButton("Copied"), "the bar confirms the copy");
    assert.equal(document.activeElement, pane.input);
    await act(async () => { await sleep(800); });
    assert.equal(pane.handles(), 0, "the copied selection clears");
  } finally {
    await pane.unmount();
  }
});

test("the held finger extends the selection and the session menu copies it", async () => {
  const pane = await mountTerminal();
  try {
    const held = await pane.longPress();
    const move = await held.move(144, 8);
    assert.equal(move.defaultPrevented, true, "extending is not a scroll");
    await held.lift();
    const menu = pane.container.querySelector<HTMLButtonElement>(".term-touch-menu")!;
    await pane.dispatch(menu, pane.mouse("click"));
    await pane.dispatch(pane.menuItem("Copy"), pane.mouse("click"));
    assert.equal(copied.at(-1), "selected omega", "the word stays selected as the finger extends it");
    assert.deepEqual(pane.sent, []);
  } finally {
    await pane.unmount();
  }
});

test("a handle drags one end of the selection and a tap dismisses it", async () => {
  const pane = await mountTerminal();
  try {
    await (await pane.longPress()).lift();
    const end = pane.container.querySelector<HTMLElement>(".term-select-handle.end")!;
    const at = { pointerId: 4, pointerType: "touch", button: 0, bubbles: true, cancelable: true, clientY: 8.75 };
    const grab = await pane.dispatch(end, new dom.PointerEvent("pointerdown", { ...at, clientX: 100.8 }) as unknown as Event);
    assert.equal(grab.defaultPrevented, true, "a handle never takes focus or scrolls");
    assert.ok(pane.bar()?.hasAttribute("data-hidden"), "the bar steps aside while a handle moves");
    await pane.dispatch(end, new dom.PointerEvent("pointermove", { ...at, clientX: 144 }) as unknown as Event);
    await pane.dispatch(end, new dom.PointerEvent("pointerup", { ...at, clientX: 144 }) as unknown as Event);
    assert.equal(pane.bar()?.hasAttribute("data-hidden"), false);
    await pane.dispatch(pane.barButton("Copy"), pane.mouse("click"));
    await act(async () => { await Promise.resolve(); });
    assert.equal(copied.at(-1), "selected omega");

    // A grabbed start handle stops one cell short of the end.
    const start = pane.container.querySelector<HTMLElement>(".term-select-handle.start")!;
    await pane.dispatch(start, new dom.PointerEvent("pointerdown", { ...at, pointerId: 5, clientX: 43.2 }) as unknown as Event);
    await pane.dispatch(start, new dom.PointerEvent("pointermove", { ...at, pointerId: 5, clientX: 280 }) as unknown as Event);
    await pane.dispatch(start, new dom.PointerEvent("pointerup", { ...at, pointerId: 5, clientX: 280 }) as unknown as Event);
    assert.equal(pane.highlighted(), 1, "handles never cross into an empty selection");

    await pane.pointer("touch");
    await pane.dispatch(pane.body, pane.mouse("click"));
    assert.equal(pane.handles(), 0, "a tap dismisses the selection");
    assert.equal(pane.highlighted(), 0);
    assert.notEqual(document.activeElement, pane.input, "the dismissing tap does not also open the keyboard");
    assert.deepEqual(pane.sent, []);
  } finally {
    await pane.unmount();
  }
});

test("Select all and Paste act from the selection bar", async () => {
  const pane = await mountTerminal();
  try {
    await (await pane.longPress()).lift();
    await pane.dispatch(pane.barButton("Select all"), pane.mouse("click"));
    assert.ok(pane.highlighted() >= 1);
    assert.equal(pane.handles(), 2);
    await pane.dispatch(pane.barButton("Copy"), pane.mouse("click"));
    await act(async () => { await Promise.resolve(); });
    assert.equal(copied.at(-1)?.trimEnd(), "alpha selected omega");

    await (await pane.longPress()).lift();
    Object.defineProperty(dom.navigator.clipboard, "readText", { value: async () => "pasted", configurable: true });
    await pane.dispatch(pane.barButton("Paste"), pane.mouse("click"));
    await act(async () => { await sleep(0); });
    assert.deepEqual(pane.sent, ["pasted"]);
    assert.equal(pane.handles(), 0, "pasting ends the selection");
  } finally {
    await pane.unmount();
  }
});

test("a long press on blank cells selects nothing and moving first is a scroll", async () => {
  const pane = await mountTerminal();
  try {
    const blank = await pane.longPress(200, 60);
    assert.equal(pane.handles(), 0);
    await blank.lift();
    await pane.pointer("touch");
    await pane.dispatch(pane.body, touchEvent("touchstart", [{ identifier: 0, clientX: 43.2, clientY: 8 }]));
    const scroll = await pane.dispatch(pane.body, touchEvent("touchmove", [{ identifier: 0, clientX: 43.2, clientY: 40 }]));
    assert.equal(scroll.defaultPrevented, false, "a moving finger scrolls natively");
    await act(async () => { await sleep(LONG_PRESS_MS + 30); });
    assert.equal(pane.handles(), 0, "a scroll never turns into a selection");
    await pane.dispatch(pane.body, touchEvent("touchend", []));
  } finally {
    await pane.unmount();
  }
});

test("a completed touch tap opens the keyboard and Copy all takes the buffer", async () => {
  const pane = await mountTerminal();
  try {
    await pane.pointer("touch");
    await pane.dispatch(pane.body, pane.mouse("click"));
    assert.equal(document.activeElement, pane.input);
    await pane.typeIme("hello");
    assert.deepEqual(pane.sent, ["hello"], "software keyboard input still reaches the terminal");

    const outside = document.createElement("div");
    outside.textContent = "outside";
    document.body.appendChild(outside);
    try {
      const range = document.createRange();
      range.selectNodeContents(outside);
      window.getSelection()!.addRange(range);
      await pane.dispatch(pane.container.querySelector(".term-touch-menu")!, pane.mouse("click"));
      await pane.dispatch(pane.menuItem("Copy all"), pane.mouse("click"));
      assert.equal(copied.at(-1)?.trimEnd(), "alpha selected omega", "another pane's selection must not be copied");
    } finally {
      outside.remove();
    }
  } finally {
    await pane.unmount();
  }
});

test("switching from touch to mouse preserves terminal cell selection and copy shortcuts", async () => {
  const pane = await mountTerminal();
  try {
    await pane.pointer("touch");
    await pane.pointer("mouse");
    const down = await pane.dispatch(pane.body, pane.mouse("mousedown"));
    assert.equal(down.defaultPrevented, true, "mouse selection stays under the terminal's control");
    await pane.dispatch(dom, pane.mouse("mousemove", { clientX: 100.8 }));
    await pane.dispatch(dom, pane.mouse("mouseup", { clientX: 100.8 }));
    await pane.dispatch(pane.body, new dom.KeyboardEvent("keydown", {
      bubbles: true, cancelable: true, key: "c", ctrlKey: true,
    }) as unknown as Event);
    assert.equal(copied.at(-1), "selected");
    assert.deepEqual(pane.sent, [], "Ctrl+C copies a selection rather than interrupting the shell");
  } finally {
    await pane.unmount();
  }
});

test("touch taps still reach mouse-tracking applications but long presses select locally", async () => {
  const pane = await mountTerminal();
  try {
    await act(async () => { pane.emu.write("\x1b[?1000h\x1b[?1006h"); });
    await pane.pointer("touch");
    await pane.dispatch(pane.body, pane.mouse("mousedown"));
    await pane.dispatch(pane.body, pane.mouse("click"));
    assert.deepEqual(pane.sent, ["\x1b[<0;7;1M", "\x1b[<0;7;1m"]);

    await (await pane.longPress()).lift();
    assert.equal(pane.handles(), 2, "a long press selects locally");
    assert.equal(pane.sent.length, 2, "selecting text must not click the application");
    await pane.pointer("touch");
    await pane.dispatch(pane.body, pane.mouse("click"));
    assert.equal(pane.handles(), 0);
    assert.equal(pane.sent.length, 2, "the tap that dismisses a selection is not an application click");
  } finally {
    await pane.unmount();
  }
});

test("software keyboard text echoes while composing and Backspace works on an empty field", async () => {
  const pane = await mountTerminal();
  try {
    assert.equal(pane.input.value, " ", "the hidden input starts with its Backspace sentinel");
    await pane.typeIme(" g", true);
    await pane.typeIme(" gi", true);
    await pane.typeIme(" git", true);
    assert.deepEqual(pane.sent, ["g", "i", "t"], "each composed letter reaches the shell immediately");
    pane.input.value = " git ";
    await pane.dispatch(pane.input, new dom.CompositionEvent("compositionend", { bubbles: true }) as unknown as Event);
    assert.equal(pane.sent.at(-1), " ");
    assert.equal(pane.input.value, " ", "a finished composition resets the field");
    await pane.typeIme("");
    assert.equal(pane.sent.at(-1), "\x7f", "deleting the sentinel is a Backspace");
    assert.equal(pane.input.value, " ");
  } finally {
    await pane.unmount();
  }
});

test("extra keys send terminal bytes and sticky CTRL applies to the next typed letter", async () => {
  const pane = await mountTerminal();
  try {
    assert.ok(pane.container.querySelector(".term-extra-keys[role=toolbar]"));
    const esc = await pane.press(pane.keyButton("ESC"));
    assert.equal(esc.defaultPrevented, true, "keys never take focus from the keyboard input");
    assert.deepEqual(pane.sent, ["\x1b"], "press then click sends once");

    const ctrl = pane.keyButton("CTRL");
    await pane.press(ctrl);
    assert.equal(ctrl.getAttribute("aria-pressed"), "true");
    await pane.typeIme(" c");
    assert.equal(pane.sent.at(-1), "\x03", "CTRL then c from the software keyboard is Ctrl+C");
    assert.equal(ctrl.getAttribute("aria-pressed"), "false", "a one-shot modifier releases");
    assert.equal(pane.input.value, " ", "the keyboard restarts after a modified letter");

    await pane.press(pane.keyButton("ALT"));
    await pane.dispatch(pane.input, new dom.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "b" }) as unknown as Event);
    assert.equal(pane.sent.at(-1), "\x1bb", "sticky ALT applies to a hardware or iOS key event too");

    await pane.press(ctrl);
    await pane.press(ctrl);
    assert.equal(ctrl.dataset.level, "2", "a double tap locks CTRL");
    await pane.press(pane.keyButton("←"));
    await pane.press(pane.keyButton("←"));
    assert.deepEqual(pane.sent.slice(-2), ["\x1b[1;5D", "\x1b[1;5D"], "a locked modifier stays on");
    await pane.press(ctrl);
    assert.equal(ctrl.dataset.level, undefined);

    await act(async () => { pane.emu.write("\x1b[?1h"); });
    await pane.press(pane.keyButton("↑"));
    assert.equal(pane.sent.at(-1), "\x1bOA", "application cursor mode is honored");
  } finally {
    await pane.unmount();
  }
});

test("swipe up sends a key's popup and holding a navigation key repeats it", async () => {
  const pane = await mountTerminal();
  try {
    await pane.press(pane.keyButton("-"), { dy: -40 });
    assert.deepEqual(pane.sent, ["|"], "the Termux default dash key carries a pipe popup");
    await pane.press(pane.keyButton("-"));
    assert.equal(pane.sent.at(-1), "-");

    pane.sent.length = 0;
    await pane.press(pane.keyButton("↓"), { holdMs: HOLD_MS + REPEAT_MS * 3 + 20 });
    assert.ok(pane.sent.length >= 3, `held arrow repeats (sent ${pane.sent.length})`);
    assert.ok(pane.sent.every((bytes) => bytes === "\x1b[B"));
    const repeated = pane.sent.length;
    await act(async () => { await sleep(REPEAT_MS * 2); });
    assert.equal(pane.sent.length, repeated, "release stops the repeat");
  } finally {
    await pane.unmount();
  }
});

test("swiping the bar opens a text-input row that sends whole lines", async () => {
  const pane = await mountTerminal();
  try {
    await pane.press(pane.keyButton("HOME"), { dx: -90 });
    assert.deepEqual(pane.sent, [], "a sideways swipe is not a key press");
    const field = pane.container.querySelector<HTMLInputElement>(".term-text-input input");
    assert.ok(field, "the text-input row opened");
    assert.equal(document.activeElement, field, "it takes focus inside the gesture");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!;
      setter.call(field, "echo hi");
      field.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
    });
    await pane.dispatch(pane.container.querySelector("form.term-text-input")!,
      new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
    assert.deepEqual(pane.sent, ["echo hi\r"]);
    await pane.dispatch(field, new dom.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }) as unknown as Event);
    assert.equal(pane.container.querySelector(".term-text-input"), null);
    assert.equal(document.activeElement, pane.input, "closing returns to terminal typing");
  } finally {
    await pane.unmount();
  }
});

const touchList = (...points: Array<[number, number]>) => points.map(([clientX, clientY], identifier) =>
  ({ identifier, clientX, clientY }));

function touchEvent(type: string, touches: ReturnType<typeof touchList>) {
  const event = new dom.Event(type, { bubbles: true, cancelable: true }) as unknown as Event;
  Object.defineProperty(event, "touches", { value: touches });
  return event;
}

test("pinching zooms the terminal font and remembers it on this device", async () => {
  const pane = await mountTerminal();
  try {
    pane.body.style.fontSize = "14px";
    await pane.dispatch(pane.body, touchEvent("touchstart", touchList([100, 100], [200, 100])));
    const move = await pane.dispatch(pane.body, touchEvent("touchmove", touchList([50, 100], [250, 100])));
    assert.equal(move.defaultPrevented, true, "the pinch never pans the page");
    assert.equal(pane.container.style.getPropertyValue("--terminal-font-size"), "28px", "live preview on the terminal view");
    await pane.dispatch(pane.body, touchEvent("touchend", touchList()));
    assert.equal(getTouchPrefs().fontSize, 28);
    await pane.dispatch(pane.body, pane.mouse("click"));
    assert.deepEqual(pane.sent, [], "ending a pinch is not a tap");
  } finally {
    await pane.unmount();
  }
});

test("dragging in a full-screen program scrolls it instead of the scrollback", async () => {
  const pane = await mountTerminal();
  try {
    await act(async () => { pane.emu.write("\x1b[?1049h"); });
    await pane.pointer("touch");
    assert.ok(pane.body.classList.contains("app-scroll"));
    await pane.dispatch(pane.body, touchEvent("touchstart", touchList([100, 100])));
    const move = await pane.dispatch(pane.body, touchEvent("touchmove", touchList([100, 160])));
    assert.equal(move.defaultPrevented, true);
    assert.deepEqual(pane.sent, ["\x1b[A\x1b[A\x1b[A"], "dragging down by three rows reveals earlier lines");
    await pane.dispatch(pane.body, touchEvent("touchend", touchList()));

    await act(async () => { pane.emu.write("\x1b[?1000h\x1b[?1006h"); });
    await pane.dispatch(pane.body, touchEvent("touchstart", touchList([100, 100])));
    await pane.dispatch(pane.body, touchEvent("touchmove", touchList([100, 80])));
    assert.match(pane.sent.at(-1)!, /^\x1b\[<65;\d+;\d+M$/, "mouse-tracking programs get wheel reports");
    await pane.dispatch(pane.body, touchEvent("touchend", touchList()));
    const count = pane.sent.length;
    await pane.dispatch(pane.body, pane.mouse("click"));
    assert.equal(pane.sent.length, count, "a drag is not a tap");
  } finally {
    await pane.unmount();
  }
});

test("the touch menu lists sibling sessions like Termux's drawer", async () => {
  const selected: string[] = [];
  let created = 0;
  const pane = await mountTerminal({
    sessions: [{ id: "a", title: "shell 1", running: true }, { id: "b", title: "build", running: false }],
    activeSessionId: "a",
    onSelectSession: (id: string) => selected.push(id),
    onNewSession: () => { created++; },
  });
  try {
    await pane.dispatch(pane.container.querySelector(".term-touch-menu")!, pane.mouse("click"));
    assert.equal(pane.menuItem("shell 1").getAttribute("aria-checked"), "true");
    await pane.dispatch(pane.menuItem("build"), pane.mouse("click"));
    assert.deepEqual(selected, ["b"]);
    await pane.dispatch(pane.container.querySelector(".term-touch-menu")!, pane.mouse("click"));
    await pane.dispatch(pane.menuItem("New terminal"), pane.mouse("click"));
    assert.equal(created, 1);
  } finally {
    await pane.unmount();
  }
});
