// Rename in a phone Navigator project's ⋮ menu opens an inline name field.
// The menu returns focus a frame after it closes; sent to the ⋮ it blurred the
// new field, whose blur saves, so the menu closed and no field ever showed.
// Mounts the real navigator with frames that really are deferred.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { Project } from "@polyth/contracts";

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
// A frame runs after the click that scheduled it has been committed.
Object.defineProperty(globalThis, "requestAnimationFrame", {
  value: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) as unknown as number,
  configurable: true,
});
Object.defineProperty(globalThis, "cancelAnimationFrame", {
  value: (id: number) => clearTimeout(id),
  configurable: true,
});
Object.defineProperty(dom, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }),
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const renames: unknown[] = [];
(globalThis as { fetch?: unknown }).fetch = async (url: string, init?: { method?: string; body?: string }) => {
  const u = new URL(String(url), "http://localhost:3000");
  if (init?.method && init.method !== "GET" && u.pathname.startsWith("/api/projects/")) {
    renames.push(JSON.parse(init.body ?? "null"));
    const body = { id: "alpha", path: "/work/alpha", name: "Renamed", createdAt: 2 };
    return { ok: true, status: 200, statusText: "OK", json: async () => body, text: async () => JSON.stringify(body) };
  }
  const body: unknown = u.pathname === "/api/sessions/summaries"
    ? { sessions: [], revision: 0, complete: true }
    : [];
  return { ok: true, status: 200, statusText: "OK", json: async () => body, text: async () => JSON.stringify(body) };
};

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const store = await import("../src/store.ts");
const { tr } = await import("../src/i18n/index.ts");
const { default: MobileNavigator } = await import("../src/components/mobile/MobileNavigator.tsx");

const MouseEventCtor = (dom as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
const click = (el: Element) => el.dispatchEvent(new MouseEventCtor("click", { bubbles: true }));
const frames = () => act(async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0)); });

test("Rename in a phone project's menu opens a focused name field that stays open", async () => {
  const ticket = store.beginProjectListRequest();
  store.publishProjectList(ticket, [
    { id: "alpha", path: "/work/alpha", name: "alpha", createdAt: 2 } satisfies Project,
    { id: "beta", path: "/work/beta", name: "beta", createdAt: 1 } satisfies Project,
  ]);
  store.activateProject("alpha");
  store.setSidebarOpen(true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(MobileNavigator)); });
    await frames();
    const more = container.querySelector<HTMLButtonElement>(
      '[data-project-id="alpha"] .mobile-nav-project-action[aria-haspopup="menu"]',
    );
    assert.ok(more, "the project's ⋮ renders");
    await act(async () => { more.focus(); click(more); });
    await frames();
    const rename = [...document.querySelectorAll<HTMLButtonElement>('[role="menu"] [role="menuitem"]')]
      .find((item) => item.textContent?.trim() === tr("common.rename"));
    assert.ok(rename, "the menu offers Rename");
    await act(async () => { click(rename); });
    await frames();

    const field = container.querySelector<HTMLInputElement>('[data-project-id="alpha"] .mobile-nav-project-rename');
    assert.ok(field, "the name field is still open after the menu has returned focus");
    assert.equal(document.activeElement, field, "the field keeps focus, not the ⋮");
    assert.equal(field.value, "alpha");

    // Typing a name and pressing Return saves it.
    await act(async () => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")!.set!.call(field, "Renamed");
      field.dispatchEvent(new (dom as unknown as { Event: typeof Event }).Event("input", { bubbles: true }));
    });
    await act(async () => {
      field.dispatchEvent(new (dom as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent(
        "keydown", { key: "Enter", bubbles: true },
      ));
    });
    await frames();
    assert.equal(renames.length, 1, "the new name was sent");
    assert.match(JSON.stringify(renames[0]), /Renamed/);
    assert.equal(container.querySelector(".mobile-nav-project-rename"), null, "the field closed");

    // Without an open field, a dismissed menu still returns focus to its ⋮.
    const again = container.querySelector<HTMLButtonElement>(
      '[data-project-id="alpha"] .mobile-nav-project-action[aria-haspopup="menu"]',
    )!;
    await act(async () => { again.focus(); click(again); });
    await frames();
    const escapeTarget = document.querySelector('[role="menu"]')!;
    await act(async () => {
      escapeTarget.dispatchEvent(new (dom as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent(
        "keydown", { key: "Escape", bubbles: true },
      ));
    });
    await frames();
    assert.equal(document.querySelector('[role="menu"]'), null, "Escape closed the menu");
    assert.equal(document.activeElement, again, "a dismissed menu returns focus to its ⋮");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    store.setSidebarOpen(false);
  }
});
