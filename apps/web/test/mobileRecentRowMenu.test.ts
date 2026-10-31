// The phone overview's Recent rows promise the same hold-to-open session menu
// as the Navigator's rows. Mounts the real sheet: a hold or context menu opens
// the menu (with package actions in its footer), and the tap that ends a hold
// does not also open the session.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { SessionProjection } from "@polyth/contracts";

const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  Event: dom.Event,
  getComputedStyle: (elt: Element, pseudo?: string | null) =>
    (dom as unknown as { getComputedStyle(el: Element, pseudo?: string | null): CSSStyleDeclaration })
      .getComputedStyle(elt, pseudo),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
Object.defineProperty(globalThis, "location", { value: dom.location, configurable: true });
Object.defineProperty(globalThis, "HTMLElement", {
  value: (dom as unknown as { HTMLElement: typeof HTMLElement }).HTMLElement,
  configurable: true,
});
Object.defineProperty(globalThis, "requestAnimationFrame", {
  value: (callback: FrameRequestCallback) => { callback(0); return 0; },
  configurable: true,
});
Object.defineProperty(globalThis, "cancelAnimationFrame", { value: () => {}, configurable: true });
Object.defineProperty(dom, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }),
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { fetch?: unknown }).fetch = async () =>
  ({ ok: true, status: 200, statusText: "OK", json: async () => [], text: async () => "[]" });

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { SessionQuickAccessSheet } = await import("../src/components/mobile/MobileSessionHeader.tsx");
const { emptyModel } = await import("../src/reduce.ts");
const { registerSlot } = await import("../src/slots.ts");
const { tr } = await import("../src/i18n/index.ts");

const now = Date.now();
const recent: SessionProjection = {
  id: "recent-1", projectId: "p", title: "Recent chat", status: "idle",
  createdAt: now, updatedAt: now, lastTurnAt: now,
};

const MouseEventCtor = (dom as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
const PointerEventCtor = (dom as unknown as { PointerEvent: typeof PointerEvent }).PointerEvent;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const menuItems = () => [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((item) => item.textContent ?? "");

async function mount() {
  let closed = 0;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(SessionQuickAccessSheet, {
      model: emptyModel(), sessionTitle: "", prompt: undefined, tasks: [], requests: [],
      recent: [recent], events: {}, onClose: () => { closed++; },
    }));
    await sleep(0);
  });
  const row = document.querySelector(".mobile-island-session-entry");
  assert.ok(row, "the Recent row renders");
  return {
    row: row!,
    closed: () => closed,
    async close() { await act(async () => root.unmount()); container.remove(); },
  };
}

test("a Recent row's context menu lists session actions and package contributions", async () => {
  const off = registerSlot(
    "sidebar.session.actions",
    "test.recent-action",
    ({ sessionId }) => createElement("button", { role: "menuitem", type: "button" }, `pkg:${String(sessionId)}`),
    1,
  );
  const view = await mount();
  try {
    assert.deepEqual(menuItems(), []);
    await act(async () => {
      view.row.dispatchEvent(new MouseEventCtor("contextmenu", { bubbles: true, cancelable: true }));
      await sleep(0);
    });
    const items = menuItems();
    assert.ok(items.includes(tr("common.rename")));
    assert.ok(items.includes(tr("common.archive")));
    assert.ok(items.includes("pkg:recent-1"));
    assert.equal(view.closed(), 0, "opening the menu leaves the overview open");
  } finally {
    await view.close();
    off();
  }
});

test("the tap that ends a hold opens the menu, not the session", async () => {
  const view = await mount();
  try {
    const main = view.row.querySelector(".sheet-row-main") as HTMLButtonElement;
    await act(async () => {
      main.dispatchEvent(new PointerEventCtor("pointerdown", { bubbles: true, pointerType: "touch", clientX: 10, clientY: 10 }));
      await sleep(650);
    });
    assert.ok(menuItems().includes(tr("common.rename")), "the hold opened the menu");
    await act(async () => {
      main.dispatchEvent(new PointerEventCtor("pointerup", { bubbles: true, pointerType: "touch" }));
      main.click();
      await sleep(0);
    });
    assert.equal(view.closed(), 0, "the release did not open the session");
    // A later ordinary tap still opens it.
    await act(async () => { main.click(); await sleep(0); });
    assert.equal(view.closed(), 1);
  } finally {
    await view.close();
  }
});
