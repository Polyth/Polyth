// Ctrl/Cmd+click on a rendered terminal link opens it. macOS reports
// Ctrl+click as a secondary click and raises `contextmenu`, so both the
// mousedown and the contextmenu path must open the same URL exactly once.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import { createTerminalEmulator } from "../widgets/terminal/emulator.ts";

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

const opened: string[] = [];
(dom as unknown as { open: (url: string) => null }).open = (url: string) => {
  opened.push(url);
  return null;
};

register("./tsxHooks.mjs", import.meta.url);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: TermPane } = await import("../widgets/TermPane.tsx");

const URL_TEXT = "open https://example.com/docs now";

async function mountTerminal(send: (data: string) => void = () => {}) {
  opened.length = 0;
  const emu = createTerminalEmulator({ cols: 60, rows: 8 });
  emu.write(URL_TEXT);
  const container = document.createElement("div");
  container.className = "term-view";
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(TermPane, {
      emu, label: "shell", running: true, send, onResize: () => {},
    }));
  });
  const link = container.querySelector<HTMLElement>(".tlink");
  assert.ok(link, "the printed URL renders as a link");
  const dispatch = async (target: Element, event: Event) => {
    await act(async () => { target.dispatchEvent(event); });
  };
  const mouse = (type: string, extra: Record<string, unknown> = {}) => new dom.MouseEvent(type, {
    bubbles: true, cancelable: true, button: 0, clientX: 43, clientY: 8, ...extra,
  }) as unknown as Event;
  const menuOpen = () => document.body.querySelector(".ui-menu-item") !== null;
  const cleanup = async () => { await act(async () => { root.unmount(); }); container.remove(); };
  return { container, link, dispatch, mouse, menuOpen, cleanup };
}

test("Ctrl+click opens a terminal link", async () => {
  const t = await mountTerminal();
  await t.dispatch(t.link, t.mouse("mousedown", { ctrlKey: true }));
  assert.deepEqual(opened, ["https://example.com/docs"]);
  await t.cleanup();
});

test("Cmd+click opens a terminal link", async () => {
  const t = await mountTerminal();
  await t.dispatch(t.link, t.mouse("mousedown", { metaKey: true }));
  assert.deepEqual(opened, ["https://example.com/docs"]);
  await t.cleanup();
});

test("a plain click does not open a terminal link", async () => {
  const t = await mountTerminal();
  await t.dispatch(t.link, t.mouse("mousedown"));
  await t.dispatch(t.link, t.mouse("contextmenu", { button: 2 }));
  assert.deepEqual(opened, []);
  assert.equal(t.menuOpen(), true, "an unmodified right click still opens the menu");
  await t.cleanup();
});

test("macOS Ctrl+click through contextmenu opens once and skips the menu", async () => {
  const t = await mountTerminal();
  // The platform may report the secondary button, or a left button with
  // ctrlKey, before raising contextmenu; only the first opens.
  await t.dispatch(t.link, t.mouse("mousedown", { button: 2, ctrlKey: true }));
  await t.dispatch(t.link, t.mouse("contextmenu", { button: 2, ctrlKey: true }));
  assert.deepEqual(opened, ["https://example.com/docs"]);
  assert.equal(t.menuOpen(), false);
  await t.cleanup();
});

test("Ctrl+click on a non-link shows the terminal menu", async () => {
  const t = await mountTerminal();
  const row = t.link.parentElement!;
  await t.dispatch(row, t.mouse("contextmenu", { button: 2, ctrlKey: true }));
  assert.deepEqual(opened, []);
  assert.equal(t.menuOpen(), true);
  await t.cleanup();
});

test("the right-click menu anchors at the pointer, outside the package window", async () => {
  const t = await mountTerminal();
  try {
    // A package window is translated, so a fixed anchor inside it would resolve
    // against the window instead of the viewport and the menu opened elsewhere.
    t.container.style.transform = "translate(400px, 120px)";
    await t.dispatch(t.link.parentElement!, t.mouse("contextmenu", { button: 2, clientX: 200, clientY: 90 }));
    const anchor = document.body.querySelector<HTMLElement>(".term-ctx-anchor");
    assert.ok(anchor);
    assert.equal(anchor.parentElement, document.body, "the anchor is not inside the transformed window");
    assert.equal(t.container.contains(anchor), false);
    assert.equal(anchor.style.position, "fixed");
    assert.equal(anchor.style.left, "200px");
    assert.equal(anchor.style.top, "90px");
  } finally {
    await t.cleanup();
  }
  assert.equal(document.body.querySelector(".term-ctx-anchor"), null, "unmounting removes the anchor");
});

test("the menu's Paste sends the clipboard text to the shell", async () => {
  const sent: string[] = [];
  const clipboard = { readText: async () => "echo pasted" };
  Object.defineProperty(dom.navigator, "clipboard", { value: clipboard, configurable: true });
  const t = await mountTerminal((data) => { sent.push(data); });
  try {
    await t.dispatch(t.link.parentElement!, t.mouse("contextmenu", { button: 2 }));
    const paste = [...document.body.querySelectorAll<HTMLElement>(".ui-menu-item")]
      .find((item) => item.textContent?.includes("Paste"));
    assert.ok(paste, "the menu offers Paste");
    await t.dispatch(paste, t.mouse("click"));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    assert.deepEqual(sent, ["echo pasted"]);
  } finally {
    await t.cleanup();
  }
});
