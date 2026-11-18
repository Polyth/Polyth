// The phone navigator used to render again as a whole every second while any
// chat was working, only to move one row's elapsed-time label. The label now
// ticks by itself on the shared clock (nowTicker.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { Project, SessionProjection } from "@polyth/contracts";

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
(globalThis as { fetch?: unknown }).fetch = async (url: string) => {
  const u = new URL(String(url), "http://localhost:3000");
  const body: unknown = u.pathname === "/api/sessions/summaries"
    ? { sessions: [], revision: 0, complete: true }
    : [];
  return { ok: true, status: 200, statusText: "OK", json: async () => body, text: async () => JSON.stringify(body) };
};
// Every interval the navigator asks the page for, by its period.
const intervals: number[] = [];
const pageSetInterval = dom.setInterval.bind(dom);
(dom as unknown as { setInterval: (handler: () => void, ms?: number) => unknown }).setInterval = (handler, ms) => {
  intervals.push(ms ?? 0);
  return pageSetInterval(handler, ms);
};

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const store = await import("../src/store.ts");
const { nowTickSubscriberCount } = await import("../src/nowTicker.ts");
const { default: MobileNavigator } = await import("../src/components/mobile/MobileNavigator.tsx");


const frames = () => act(async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0)); });

test("a working row runs its own clock; the open navigator keeps no one-second timer", async () => {
  const ticket = store.beginProjectListRequest();
  store.publishProjectList(ticket, [{ id: "alpha", path: "/work/alpha", name: "alpha", createdAt: 2 } satisfies Project]);
  const startedAt = Date.now() - 42_000;
  const row = (id: string, extra: Partial<SessionProjection>): SessionProjection => ({
    id, projectId: "alpha", title: id, createdAt: startedAt, updatedAt: startedAt, lastTurnAt: startedAt, summary: true, ...extra,
  } as SessionProjection);
  store.upsertSessions([row("running", { status: "working" }), row("resting", { status: "idle" })]);
  store.activateProject("alpha");
  store.setSidebarOpen(true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(MobileNavigator)); });
    await frames();
    assert.equal(container.querySelectorAll(".mobile-nav-session-row").length, 2);
    const clocks = [...container.querySelectorAll(".mobile-nav-duration")];
    assert.equal(clocks.length, 1, "only the working chat shows a clock");
    assert.match(clocks[0]!.textContent ?? "", /^4[2-9]s$/, "it counts from the turn's start");
    assert.equal(nowTickSubscriberCount(), 1, "that label is the one thing on the shared clock");
    assert.ok(intervals.length > 0, "the navigator still refreshes its date headings");
    assert.deepEqual(intervals.filter((ms) => ms < 60_000), [], "but never by the second");

    // The label follows the clock by itself.
    const before = Number.parseInt(clocks[0]!.textContent!, 10);
    await act(async () => { await new Promise((r) => setTimeout(r, 2_300)); });
    const after = Number.parseInt(container.querySelector(".mobile-nav-duration")!.textContent!, 10);
    assert.ok(after >= before + 1, `the clock moved on (${before}s -> ${after}s)`);

    // Once the turn ends nothing is left ticking.
    await act(async () => { store.upsertSessions([row("running", { status: "idle", updatedAt: startedAt + 1 })]); });
    await frames();
    assert.equal(container.querySelector(".mobile-nav-duration"), null);
    assert.equal(nowTickSubscriberCount(), 0);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    store.setSidebarOpen(false);
  }
});

test.after(async () => { await dom.happyDOM.close(); });
