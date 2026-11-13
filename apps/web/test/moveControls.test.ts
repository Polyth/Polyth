// The host tap-first reorder primitive: plain taps (clicks) move an item,
// bounds disable the ends, and every button is keyboard-reachable and named.
// This is the accessible alternative to drag reorder on every surface.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  getComputedStyle: dom.getComputedStyle.bind(dom),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: MoveControls } = await import("../src/components/MoveControls.tsx");

const mount = async (props: {
  label: string;
  index: number;
  count: number;
  onMove: (next: number) => void;
  axis?: "horizontal" | "vertical";
}) => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(MoveControls as never, props as never));
  });
  const buttons = (): HTMLButtonElement[] => [...container.querySelectorAll("button")];
  return {
    container,
    buttons,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
};

test("tap moves an item up and down and announces the target index", async () => {
  const moves: number[] = [];
  const { buttons, unmount } = await mount({ label: "Alpha", index: 1, count: 3, onMove: (next) => moves.push(next) });

  const [up, down] = buttons();
  assert.ok(up && down, "two controls render");
  // Tap up → index 0.
  await act(async () => { up.click(); });
  // Tap down → index 2.
  await act(async () => { down.click(); });
  assert.deepEqual(moves, [0, 2]);
  await unmount();
});

test("bounds disable the leading and trailing ends", async () => {
  const moves: number[] = [];
  const first = await mount({ label: "First", index: 0, count: 3, onMove: (next) => moves.push(next) });
  {
    const [up, down] = first.buttons() as [HTMLButtonElement, HTMLButtonElement];
    assert.equal(up.disabled, true, "the first item cannot move up");
    assert.equal(down.disabled, false);
    await act(async () => { down.click(); });
    assert.deepEqual(moves, [1]);
  }
  await first.unmount();

  const last = await mount({ label: "Last", index: 2, count: 3, onMove: (next) => moves.push(next) });
  {
    const [up, down] = last.buttons() as [HTMLButtonElement, HTMLButtonElement];
    assert.equal(up.disabled, false);
    assert.equal(down.disabled, true, "the last item cannot move down");
    await act(async () => { up.click(); });
    assert.deepEqual(moves, [1, 1]);
  }
  await last.unmount();
});

test("every control is keyboard-reachable and named", async () => {
  const { buttons, unmount } = await mount({ label: "Beta", index: 1, count: 3, onMove: () => {} });
  const [up, down] = buttons() as [HTMLButtonElement, HTMLButtonElement];
  for (const button of [up, down]) {
    assert.equal(button.type, "button");
    assert.ok(button.getAttribute("aria-label")?.length, "each control has an accessible name");
  }
  await unmount();
});
