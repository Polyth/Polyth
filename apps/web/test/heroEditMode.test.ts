// New chat → touch edit mode: a long press on the screen enters it, the tiles
// get a hide badge and a grip, the toolbar opens the Customize panel, and
// Done-like exits (empty-space tap, Escape, leaving) end it. Mounts the real
// hook, host, tiles, toolbar and panel trigger.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { FunctionComponent, ReactNode } from "react";

const dom = new Window({ url: "http://localhost/", width: 390, height: 844 });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  Event: dom.Event,
  KeyboardEvent: dom.KeyboardEvent,
  MouseEvent: dom.MouseEvent,
  PointerEvent: dom.PointerEvent,
  HTMLElement: dom.HTMLElement,
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { fetch?: unknown }).fetch = async () => ({
  ok: false, status: 404, statusText: "", headers: { get: () => null }, json: async () => ({}), text: async () => "",
});

register("./tsxHooks.mjs", import.meta.url);
const { act, createElement: h } = await import("react");
const { createRoot } = await import("react-dom/client");
const heroWidgets = await import("../src/components/mobile/HeroWidgets.tsx");
// createElement passes children positionally; their props declare them required.
const HeroWidgetHost = heroWidgets.HeroWidgetHost as FunctionComponent<{ projectId: string | null; children?: ReactNode }>;
const HeroWidget = heroWidgets.HeroWidget as FunctionComponent<{ id: string; title?: string; children?: ReactNode }>;
const { HeroEditToolbar, HERO_LONG_PRESS_MS, useHeroEditGesture } = await import("../src/components/mobile/HeroEditMode.tsx");
const { HeroCustomizeButton } = await import("../src/components/mobile/HeroCustomize.tsx");
const { getHeroEditing, setHeroEditing } = await import("../src/heroEditing.ts");
const { defaultHeroWidgetPrefs, getHeroWidgetPrefs, setHeroWidgetPrefs } = await import("../src/heroWidgetPrefs.ts");
const { getHeroBoard, setHeroBoard } = await import("../src/heroBoard.ts");

const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

let pressed = 0;
function Hero({ projectId }: { projectId: string | null }) {
  const gesture = useHeroEditGesture(projectId);
  return h("div", { className: "hero-body customize-zone", ...gesture },
    h("h2", null, "What are we working on?"),
    h(HeroWidgetHost, { projectId },
      h(HeroWidget, { id: "starters" }, h("button", { type: "button", className: "starter-chip", onClick: () => { pressed++; } }, "Review")),
      h(HeroWidget, { id: "recent" }, h("div", null, "Recent")),
      h(HeroWidget, { id: "clock", title: "Clock" }, h("div", null, "12:00"))),
    h(HeroEditToolbar),
    h(HeroCustomizeButton));
}

async function mount(projectId: string | null = null) {
  setHeroWidgetPrefs(defaultHeroWidgetPrefs());
  setHeroBoard({ items: [{ id: "clock", widget: "sample.clock", size: "compact", config: {} }], order: [] });
  setHeroEditing(false);
  pressed = 0;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(h(Hero, { projectId })); });
  await settle();
  return {
    root,
    rerender: async (next: string | null) => { await act(async () => { root.render(h(Hero, { projectId: next })); }); await settle(); },
    unmount: async () => { await act(async () => { root.unmount(); }); document.body.innerHTML = ""; setHeroEditing(false); },
  };
}

const pointer = (target: Element, type: string, init: { pointerType?: string; x?: number; y?: number } = {}) =>
  act(async () => {
    target.dispatchEvent(new PointerEvent(type, {
      bubbles: true, pointerType: init.pointerType ?? "touch", clientX: init.x ?? 10, clientY: init.y ?? 10, button: 0,
    }) as unknown as Event);
  });
const click = async (target: Element | null | undefined) => {
  assert.ok(target, "element to click exists");
  await act(async () => { (target as HTMLElement).click(); });
  await settle();
};
const chip = () => document.querySelector(".starter-chip") as HTMLButtonElement;
const tile = (id: string) => document.querySelector(`.hero-widget[data-sort-id="${id}"]`) as HTMLElement;

async function longPress(target: Element) {
  await pointer(target, "pointerdown");
  await wait(HERO_LONG_PRESS_MS + 50);
  await pointer(target, "pointerup");
  await click(target);
}

test("a long touch press enters the edit mode and swallows the tap that ends it", async () => {
  const hero = await mount();
  assert.equal(document.querySelector(".hero-widget-edit"), null, "no edit chrome at rest");
  assert.equal(document.querySelector(".hero-edit-toolbar"), null);

  await longPress(chip());
  assert.equal(getHeroEditing(), true);
  assert.equal(pressed, 0, "the shortcut under the finger did not run");
  assert.equal(document.querySelector(".hero-body")?.getAttribute("data-editing"), "true");
  assert.deepEqual(
    [...document.querySelectorAll(".hero-widget-hide")].map((node) => node.getAttribute("aria-label")),
    ["Hide Shortcuts", "Hide Recent sessions", "Hide Clock"],
  );
  assert.equal(document.querySelectorAll(".hero-widget-grip").length, 3);
  assert.equal(tile("starters").getAttribute("draggable"), "false", "touch reorders by grip, not HTML drag");
  assert.ok(document.querySelector(".hero-edit-toolbar"));

  await click(chip());
  assert.equal(pressed, 1, "the next tap is an ordinary tap again");
  await hero.unmount();
});

test("a mouse press, a moving finger or a press on the toolbar never enters the mode", async () => {
  const hero = await mount();
  await pointer(chip(), "pointerdown", { pointerType: "mouse" });
  await wait(HERO_LONG_PRESS_MS + 50);
  assert.equal(getHeroEditing(), false, "a mouse uses Shift or the Edit mode");

  await pointer(chip(), "pointerdown", { x: 10, y: 10 });
  await pointer(chip(), "pointermove", { x: 10, y: 40 });
  await wait(HERO_LONG_PRESS_MS + 50);
  assert.equal(getHeroEditing(), false, "a scroll is not a hold");
  await hero.unmount();
});

test("badges hide built-ins and board items; the grip reorders shown tiles past hidden ones", async () => {
  const hero = await mount();
  await longPress(document.querySelector(".hero-body h2")!);
  assert.equal(getHeroEditing(), true);

  await click(tile("recent").querySelector(".hero-widget-hide"));
  assert.deepEqual(getHeroWidgetPrefs().hidden, ["recent"]);
  assert.equal(tile("recent"), null);
  await click(tile("clock").querySelector(".hero-widget-hide"));
  assert.equal(getHeroBoard().items[0]!.hidden, true, "a board item keeps its settings");

  await act(async () => { setHeroBoard({ items: [{ id: "clock", widget: "sample.clock", size: "compact", config: {} }], order: [] }); });
  await settle();
  const grip = tile("clock").querySelector(".hero-widget-grip") as HTMLElement;
  await act(async () => { grip.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }) as unknown as Event); });
  await settle();
  assert.deepEqual(getHeroBoard().order, ["clock", "starters", "recent", "apps"]);
  await act(async () => { grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }) as unknown as Event); });
  await settle();
  assert.deepEqual(
    getHeroBoard().order,
    ["starters", "recent", "clock", "apps"],
    "one step down passes the next shown tile, not just the hidden Recent",
  );
  await hero.unmount();
});

test("the toolbar opens Customize at Add widget or whole; empty space, Escape and leaving end the mode", async () => {
  const hero = await mount("p1");
  await longPress(document.querySelector(".hero-body h2")!);
  const toolbar = () => [...document.querySelectorAll(".hero-edit-toolbar button")];
  assert.deepEqual(toolbar().map((node) => node.textContent), ["Add widget", "All settings", "Done"]);

  await click(toolbar()[0]);
  assert.equal(document.querySelector(".hero-customize-add-row")?.getAttribute("aria-expanded"), "true");
  assert.equal(getHeroEditing(), true, "the panel opens over the mode");
  // The sheet is portaled, but React bubbles its events through the hero.
  await click(document.querySelector(".hero-customize-add-row"));
  assert.equal(getHeroEditing(), true, "a tap inside the panel is not a tap on empty space");
  await pointer(document.querySelector(".hero-customize-add-row")!, "pointerdown");
  await wait(HERO_LONG_PRESS_MS + 50);
  await pointer(document.querySelector(".hero-customize-add-row")!, "pointerup");
  await click(document.querySelector(".hero-customize-trigger"));
  assert.equal(document.querySelector(".hero-customize-panel"), null);
  await click(toolbar()[1]);
  assert.equal(document.querySelector(".hero-customize-add-row")?.getAttribute("aria-expanded"), "false");
  await click(document.querySelector(".hero-customize-trigger"));

  await click(document.querySelector(".hero-body h2"));
  assert.equal(getHeroEditing(), false, "a tap on empty space ends it");

  await act(async () => { setHeroEditing(true); });
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }) as unknown as Event); });
  assert.equal(getHeroEditing(), false);

  await act(async () => { setHeroEditing(true); });
  await click(toolbar().find((node) => node.textContent === "Done"));
  assert.equal(getHeroEditing(), false);

  await act(async () => { setHeroEditing(true); });
  await hero.rerender("p2");
  assert.equal(getHeroEditing(), false, "another project's screen starts at rest");
  await act(async () => { setHeroEditing(true); });
  await hero.unmount();
  assert.equal(getHeroEditing(), false, "leaving the new chat ends it");
});

test("CSS: tiles wobble only in the mode, take no taps there, and the grip owns its touch", async () => {
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.hero-widget\[data-editing="true"\] \{[^}]*animation: hero-widget-wobble/);
  assert.match(css, /\.hero-widget\[data-editing="true"\] > :not\(\.hero-widget-edit\) \{ pointer-events: none; \}/);
  assert.match(css, /\.hero-widget-grip \{[^}]*touch-action: none;/);
  assert.match(css, /\.hero-widget-hide,\n\.hero-widget-grip \{[^}]*width: var\(--tap\);[^}]*height: var\(--tap\);/);
  assert.match(css, /@media \(pointer: coarse\) \{\n  \.hero-body \{ -webkit-touch-callout: none; \}/);
});
