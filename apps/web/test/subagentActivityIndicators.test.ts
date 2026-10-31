// A parent chat shows its subagents' activity: the navigator's disclosure pill
// (desktop and phone) turns live while subagents work and amber while one
// waits for a person. The chat's own branch above the composer is pinned in
// subagentBranch.test.ts.
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
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
Object.defineProperty(globalThis, "location", { value: dom.location, configurable: true });
Object.defineProperty(globalThis, "HTMLElement", {
  value: (dom as unknown as { HTMLElement: typeof HTMLElement }).HTMLElement,
  configurable: true,
});
Object.defineProperty(globalThis, "requestAnimationFrame", {
  configurable: true,
  value: (callback: FrameRequestCallback) => { callback(0); return 1; },
});
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: () => {} });
Object.defineProperty(dom, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  }),
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// An empty server: the store fixtures are the whole truth.
(globalThis as { fetch?: unknown }).fetch = async (url: string) => {
  const path = new URL(String(url), "http://localhost:3000").pathname;
  const body: unknown = path === "/api/sessions/summaries" ? { sessions: [], revision: 0, complete: true } : [];
  return { ok: true, status: 200, statusText: "OK", json: async () => body, text: async () => JSON.stringify(body) };
};

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const store = await import("../src/store.ts");
const { default: SessionList } = await import("../src/components/sidebar/SessionList.tsx");
const { default: MobileNavigator } = await import("../src/components/mobile/MobileNavigator.tsx");

const now = Date.now();
const session = (over: Partial<SessionProjection> & { id: string }): SessionProjection => ({
  projectId: "p1", title: over.id, status: "idle", createdAt: now - 60_000, updatedAt: now - 30_000, lastTurnAt: now - 30_000,
  ...over,
});
const approval = { questions: 0, permissions: 1, unread: 0 };
// The server always sends attention counts; the store keeps old ones otherwise.
const settled = { status: "idle", attention: { questions: 0, permissions: 0, unread: 0 } } as const;
const fixtures = (): SessionProjection[] => [
  session({ id: "run", title: "Running parent" }),
  session({ id: "run-a", parentId: "run", title: "Style audit", status: "working" }),
  session({ id: "run-b", parentId: "run", title: "Idle helper" }),
  session({ id: "run-c", parentId: "run", title: "Delegating helper" }),
  session({ id: "run-c1", parentId: "run-c", title: "Grandchild run", status: "working" }),
  session({ id: "wait", title: "Waiting parent" }),
  session({ id: "wait-a", parentId: "wait", title: "Data migration", status: "working", attention: approval }),
  session({ id: "wait-b", parentId: "wait", title: "Schema check", status: "working" }),
  session({ id: "idle", title: "Idle parent" }),
  session({ id: "idle-a", parentId: "idle", title: "Done helper" }),
];

function seed(sessions = fixtures()) {
  const ticket = store.beginProjectListRequest();
  store.publishProjectList(ticket, [{ id: "p1", path: "/work/p1", name: "p1", createdAt: 1 } satisfies Project]);
  store.activateProject("p1");
  store.setSessions("p1", sessions);
}

async function mount(element: ReturnType<typeof createElement>) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(element); });
  return {
    container,
    unmount: async () => {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

function pillOf(container: HTMLElement, rowSelector: string, toggleSelector: string, title: string): HTMLButtonElement {
  const row = [...container.querySelectorAll<HTMLElement>(rowSelector)]
    .find((node) => node.textContent?.includes(title));
  const toggle = row?.querySelector<HTMLButtonElement>(toggleSelector);
  assert.ok(toggle, `${title} offers its subagents`);
  return toggle!;
}

test("the desktop disclosure is live while subagents work and amber while one waits", async () => {
  seed();
  const { container, unmount } = await mount(createElement(SessionList, { projectId: "p1" }));
  try {
    const pill = (title: string) => pillOf(container, ".session-subagent-parent", ".session-subagent-toggle", title);
    const running = pill("Running parent");
    assert.equal(running.dataset.activity, "working");
    assert.equal(running.textContent, "2/3", "a grandchild's run counts for the child it hangs under");
    assert.ok(running.querySelector(".subagent-activity-dot.working"), "a pulsing dot marks running work");
    assert.equal(running.getAttribute("aria-label"), "Expand: Subagents: 3, Working: 2");

    const waiting = pill("Waiting parent");
    assert.equal(waiting.dataset.activity, "waiting", "a person's turn outranks running work");
    assert.equal(waiting.textContent, "1/2");
    assert.equal(waiting.getAttribute("aria-label"), "Expand: Subagents: 2, Working: 1, Waiting for you: 1");

    const idle = pill("Idle parent");
    assert.equal(idle.dataset.activity, undefined);
    assert.equal(idle.textContent, "1", "an idle disclosure keeps its plain count");
    assert.ok(idle.querySelector(".subagent-activity-dot") === null);

    await act(async () => {
      store.setSessions("p1", fixtures().map((row) => row.parentId ? { ...row, ...settled } : row));
    });
    assert.equal(pill("Running parent").dataset.activity, undefined, "finished work leaves the pill quiet");
    assert.equal(pill("Running parent").textContent, "3");
  } finally {
    await unmount();
  }
});

test("the phone navigator's disclosure shows the same activity", async () => {
  seed();
  store.setSidebarOpen(true);
  const { container, unmount } = await mount(createElement(MobileNavigator));
  try {
    const pill = (title: string) => pillOf(container, ".mobile-nav-subagent-parent", ".mobile-nav-subagent-toggle", title);
    assert.equal(pill("Running parent").dataset.activity, "working");
    assert.equal(pill("Running parent").textContent, "2/3");
    assert.equal(pill("Waiting parent").dataset.activity, "waiting");
    assert.match(pill("Waiting parent").getAttribute("aria-label") ?? "", /Waiting for you: 1$/);
    assert.equal(pill("Idle parent").dataset.activity, undefined);
  } finally {
    await unmount();
    store.setSidebarOpen(false);
  }
});
