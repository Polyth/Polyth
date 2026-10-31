// Navigator multi-select: an always-visible toggle beside the list filter
// enters and leaves selection, and the selection bar runs pin, archive and
// sharing per session through the same routes as the row menu, plus package
// actions from `sidebar.sessions.bulk.actions`.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { SessionProjection } from "@polyth/contracts";

const dom = new Window();
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
Object.defineProperty(globalThis, "requestAnimationFrame", {
  configurable: true,
  value: (callback: FrameRequestCallback) => { callback(0); return 1; },
});
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: () => {} });
Object.defineProperty(dom, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    matches: query.includes("hover: hover"),
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => true,
  }),
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fetchCalls: Array<{ url: string; method: string; body?: string }> = [];
(globalThis as { fetch?: unknown }).fetch = async (url: string, init?: { method?: string; body?: string }) => {
  const request = { url: String(url), method: init?.method ?? "GET", ...(init?.body ? { body: init.body } : {}) };
  fetchCalls.push(request);
  const payload = request.url.startsWith("/api/sessions/summaries?")
    ? { sessions: [], revision: 0, complete: true }
    : request.url === "/api/sessions/bulk"
      ? { succeeded: JSON.parse(request.body ?? "{}").ids ?? [], failed: [] }
      : request.method === "PUT" && request.url.endsWith("/sharing")
        ? { visibility: "space" }
        : request.method === "PATCH" ? { ok: true } : [];
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
};

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { activateProject, applyProjectUpsert, setSessions, setSidebarOpen } = await import("../src/store.ts");
const { registerSlot } = await import("../src/slots.ts");
const { default: Sidebar } = await import("../src/components/Sidebar.tsx");
const { setSidebarViewMode } = await import("../src/sidebarPrefs.ts");
const { default: SessionSelectionBar } = await import("../src/components/sidebar/SessionSelectionBar.tsx");
const { default: MobileNavigator } = await import("../src/components/mobile/MobileNavigator.tsx");

const KeyboardEventCtor = (dom as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;

const session = (over: Partial<SessionProjection>): SessionProjection => ({
  id: "s", projectId: "p1", title: "session", status: "idle",
  createdAt: Date.now() - 60_000, updatedAt: Date.now() - 30_000,
  ...over,
});

async function mount(element: ReturnType<typeof createElement>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
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

const buttonNamed = (scope: ParentNode, name: string) =>
  [...scope.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === name);

test("the select toggle sits left of the search field and ends selection on Escape", async () => {
  // The tree's toolbar row; the desktop rail selects from the project's ⋮ menu.
  setSidebarViewMode("tree");
  applyProjectUpsert({ id: "p1", name: "Project one", path: "/workspace", createdAt: Date.now() });
  activateProject("p1");
  setSessions("p1", [
    session({ id: "s-a", title: "Alpha" }),
    session({ id: "s-b", title: "Beta" }),
  ]);
  const { container, unmount } = await mount(createElement(Sidebar));
  try {
    const toggle = container.querySelector<HTMLButtonElement>(".sidebar-service-bar .sidebar-select-toggle");
    assert.ok(toggle, "the toggle is rendered without opening a menu");
    assert.equal(toggle!.nextElementSibling?.className, "sidebar-search", "it sits left of the search field");
    assert.equal(toggle!.getAttribute("aria-pressed"), "false");
    assert.equal(container.querySelector(".session-bulk-actions"), null);

    await act(async () => toggle!.click());
    assert.equal(toggle!.getAttribute("aria-pressed"), "true");
    assert.ok(container.querySelector(".session-bulk-actions"));
    const checks = container.querySelectorAll<HTMLInputElement>(".session-check");
    assert.equal(checks.length, 2);
    await act(async () => { checks[0]!.click(); checks[1]!.click(); });
    assert.match(container.querySelector(".session-bulk-count")!.textContent!, /2 selected/);

    // A click on a row's title toggles it instead of opening the chat.
    const rowButtons = container.querySelectorAll<HTMLButtonElement>(".session-btn");
    await act(async () => rowButtons[0]!.click());
    assert.equal(rowButtons[0]!.getAttribute("aria-pressed"), "false");
    assert.equal(checks[0]!.checked, false);
    assert.match(container.querySelector(".session-bulk-count")!.textContent!, /1 selected/);
    await act(async () => rowButtons[0]!.click());
    assert.equal(checks[0]!.checked, true);
    assert.match(container.querySelector(".session-bulk-count")!.textContent!, /2 selected/);

    await act(async () => {
      window.dispatchEvent(new KeyboardEventCtor("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    assert.equal(container.querySelector(".session-bulk-actions"), null);
    assert.equal(container.querySelectorAll(".session-check").length, 0);
    assert.equal(toggle!.getAttribute("aria-pressed"), "false");
  } finally {
    await unmount();
    setSidebarViewMode("rail");
  }
});

test("pin pins every selected session that is not pinned yet", async () => {
  activateProject("p1");
  setSessions("p1", [
    session({ id: "s-a", title: "Alpha" }),
    session({ id: "s-b", title: "Beta", pinned: { position: 3 } }),
    session({ id: "s-c", title: "Gamma" }),
  ]);
  let done = 0;
  const { container, unmount } = await mount(createElement(SessionSelectionBar, {
    selectedIds: new Set(["s-a", "s-b", "s-c"]),
    onDone: () => { done += 1; },
  }));
  try {
    fetchCalls.length = 0;
    const pin = buttonNamed(container, "Pin");
    assert.ok(pin, "a mixed selection offers Pin");
    await act(async () => { pin!.click(); });
    const organized = fetchCalls.filter((call) => call.method === "PATCH").map((call) => call.url);
    assert.deepEqual(organized.sort(), ["/api/sessions/s-a/organize", "/api/sessions/s-c/organize"]);
    assert.equal(done, 1);
  } finally {
    await unmount();
  }
});

test("an all-archived selection offers Restore and sends one bulk restore", async () => {
  activateProject("p1");
  setSessions("p1", [
    session({ id: "s-a", title: "Alpha", status: "archived" }),
    session({ id: "s-b", title: "Beta", status: "archived" }),
  ]);
  const { container, unmount } = await mount(createElement(SessionSelectionBar, {
    selectedIds: new Set(["s-a", "s-b"]),
    onDone: () => {},
  }));
  try {
    fetchCalls.length = 0;
    const restore = buttonNamed(container, "Restore");
    assert.ok(restore);
    await act(async () => { restore!.click(); });
    const bulk = fetchCalls.find((call) => call.url === "/api/sessions/bulk");
    assert.deepEqual(JSON.parse(bulk!.body!), { op: "restore", ids: ["s-a", "s-b"] });
  } finally {
    await unmount();
  }
});

test("share with the Space changes only manageable, non-inherited chats", async () => {
  activateProject("p1");
  setSessions("p1", [
    session({ id: "s-own", sharing: { visibility: "private", access: "manage", shared: false } }),
    session({ id: "s-view", sharing: { visibility: "space", access: "view", shared: true } }),
    session({ id: "s-child", parentId: "s-own", sharing: { visibility: "private", access: "manage", inherited: true, shared: false } }),
  ]);
  const { container, unmount } = await mount(createElement(SessionSelectionBar, {
    selectedIds: new Set(["s-own", "s-view", "s-child"]),
    onDone: () => {},
  }));
  try {
    await act(async () => container.querySelector<HTMLButtonElement>(".session-bulk-more")!.click());
    const share = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((item) => item.textContent?.includes("Share with the Space"));
    assert.ok(share, "the menu offers sharing");
    fetchCalls.length = 0;
    await act(async () => { share!.click(); });
    const puts = fetchCalls.filter((call) => call.method === "PUT");
    assert.deepEqual(puts.map((call) => call.url), ["/api/sessions/s-own/sharing"]);
    assert.deepEqual(JSON.parse(puts[0]!.body!), { visibility: "space" });
  } finally {
    await unmount();
  }
});

test("package bulk actions receive the selection, done and report", async () => {
  activateProject("p1");
  setSessions("p1", [session({ id: "s-a" }), session({ id: "s-b" })]);
  let seen: Record<string, unknown> | null = null;
  let off = () => {};
  await act(async () => {
    off = registerSlot("sidebar.sessions.bulk.actions", "test.bulk", (context) => {
      seen = context;
      return createElement("button", { type: "button", role: "menuitem" }, "Package action");
    });
  });
  let done = 0;
  const { container, unmount } = await mount(createElement(SessionSelectionBar, {
    selectedIds: new Set(["s-a", "s-b"]),
    onDone: () => { done += 1; },
  }));
  try {
    const more = container.querySelector<HTMLButtonElement>(".session-bulk-more")!;
    assert.equal(more.disabled, false, "a package action alone enables the menu");
    await act(async () => more.click());
    assert.ok([...document.querySelectorAll('[role="menuitem"]')].some((item) => item.textContent === "Package action"));
    assert.deepEqual(seen!.sessionIds, ["s-a", "s-b"]);
    assert.equal(typeof seen!.report, "function");
    await act(async () => (seen!.done as () => void)());
    assert.equal(done, 1);
  } finally {
    await act(async () => off());
    await unmount();
  }
});

test("the phone navigator selects by tapping rows once its select toggle is on", async () => {
  applyProjectUpsert({ id: "p1", name: "Project one", path: "/workspace", createdAt: Date.now() });
  activateProject("p1");
  setSessions("p1", [session({ id: "s-a", title: "Alpha" }), session({ id: "s-b", title: "Beta" })]);
  setSidebarOpen(true);
  const { container, unmount } = await mount(createElement(MobileNavigator));
  try {
    const toggle = container.querySelector<HTMLButtonElement>(".mobile-nav-select-toggle");
    assert.ok(toggle, "the toggle is in the navigator header");
    assert.ok(toggle!.previousElementSibling?.classList.contains("mobile-nav-search-toggle"), "right after the search tool");
    await act(async () => toggle!.click());
    assert.equal(toggle!.getAttribute("aria-pressed"), "true");
    const rows = [...container.querySelectorAll<HTMLButtonElement>(".mobile-nav-session-main")];
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.getAttribute("aria-pressed"), "false");
    await act(async () => rows[0]!.click());
    assert.equal(rows[0]!.getAttribute("aria-pressed"), "true", "a tap selects instead of opening");
    assert.match(container.querySelector(".session-bulk-count")!.textContent!, /1 selected/);
    await act(async () => container.querySelector<HTMLButtonElement>(".session-bulk-close")!.click());
    assert.equal(container.querySelector(".session-bulk-actions"), null);
    assert.equal(rows[0]!.getAttribute("aria-pressed"), null);
  } finally {
    await unmount();
    setSidebarOpen(false);
  }
});
