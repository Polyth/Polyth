// The mounted button, walk bar and panel against a stubbed transport: what a
// person sees and what reaches the server. Never pass a DOM node to an assert
// (a failure would serialise the whole window); assert on booleans and strings.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { WebPackageHost } from "@polyth/web-sdk";

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });

interface Call { method: string; path: string; body: Record<string, unknown> }
const calls: Call[] = [];
let stored: Array<Record<string, unknown>> = [];
let nextId = 0;
let conflictOnce = false;

const view = (patch: Record<string, unknown>) => ({
  id: `b${++nextId}`,
  kind: "answer",
  projectId: "p1",
  sessionId: "s1",
  eventSeq: 5,
  chatTitle: "Backups",
  ownChat: true,
  title: "Title",
  links: [],
  edited: false,
  createdAt: 1793970000000,
  updatedAt: 1793970000000,
  revision: 1,
  chat: "open",
  ...patch,
});

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), "http://localhost");
  const method = init?.method ?? "GET";
  const body = (init?.body ? JSON.parse(String(init.body)) : {}) as Record<string, unknown>;
  calls.push({ method, path: `${url.pathname}${url.search}`, body });
  const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  if (url.pathname === "/api/bookmarks" && method === "GET") return reply({ revision: 1, bookmarks: stored });
  if (url.pathname === "/api/bookmarks" && method === "POST") {
    const bookmark = view({ eventSeq: body.eventSeq, title: body.title ?? "Saved", kind: body.kind });
    stored = [...stored, bookmark];
    return reply({ bookmark });
  }
  if (url.pathname === "/api/bookmarks/delete") {
    const removed = stored.find((entry) => entry.id === body.id)!;
    stored = stored.filter((entry) => entry.id !== body.id);
    return reply({ removed, body: "Saved text" });
  }
  if (url.pathname === "/api/bookmarks/body") return reply({ id: url.searchParams.get("id"), revision: 1, body: "Saved **text** [a](https://a.example)" });
  if (url.pathname === "/api/bookmarks/update") {
    if (conflictOnce) {
      conflictOnce = false;
      stored = stored.map((entry) => (entry.id === body.id ? { ...entry, revision: 5, title: "From the other device" } : entry));
      return reply({ error: "conflict", message: "This bookmark changed on another device" }, 409);
    }
    if (stored.find((entry) => entry.id === body.id)?.revision !== body.revision) return reply({ error: "conflict", message: "stale" }, 409);
    const next = { ...stored.find((entry) => entry.id === body.id)!, ...(body.title ? { title: body.title } : {}), edited: true, revision: (body.revision as number) + 1 };
    stored = stored.map((entry) => (entry.id === body.id ? next : entry));
    return reply({ bookmark: next });
  }
  return reply({ error: "not-found" }, 404);
}) as typeof fetch;

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: BookmarkAction, answerActionMenuLabel } = await import("../widgets/BookmarkAction.tsx");
const { default: WalkBar } = await import("../widgets/WalkBar.tsx");
const { default: BookmarksPanel } = await import("../widgets/BookmarksPanel.tsx");
const { refreshBookmarks, resetBookmarksState, setBookmarkWalk } = await import("../widgets/client.ts");

interface Notice { title: string; undo?: () => void | Promise<void> }

function hostStub(reveal: (seq: number, focus: boolean) => boolean = () => true) {
  const revealed: Array<{ seq: number; focus: boolean }> = [];
  const notices: Notice[] = [];
  const panes: string[] = [];
  const host = {
    notifications: {
      show: (input: { title: string; actions?: Array<{ run(): void | Promise<void> }> }) => {
        notices.push({ title: input.title, ...(input.actions?.[0] ? { undo: input.actions[0].run } : {}) });
        return { id: "n", update() {}, dismiss() {} };
      },
    },
    conversation: {
      revealEvent: async (_: string, seq: number, options?: { focus?: boolean }) => {
        revealed.push({ seq, focus: options?.focus === true });
        return reveal(seq, options?.focus === true);
      },
    },
    navigation: {
      openWorkspacePane: (id: string) => { panes.push(`open:${id}`); return true; },
      closeWorkspacePane: () => { panes.push("close"); },
    },
    ui: { components: {} },
  } as unknown as WebPackageHost;
  return { host, revealed, notices, panes };
}

async function mount(element: ReturnType<typeof createElement>) {
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => { root.render(element); });
  return {
    container,
    rerender: async (next: ReturnType<typeof createElement>) => { await act(async () => { root.render(next); }); },
    unmount: async () => { await act(async () => { root.unmount(); }); container.remove(); },
  };
}

const reset = () => { resetBookmarksState(); stored = []; calls.length = 0; nextId = 0; };
const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); }); };
const answerContext = { sessionId: "s1", projectId: "p1", eventSeq: 5, messageText: "# Head\nText", messageActionPlacement: "bar", messageActionRequest: 0 };

test("the bar button saves, shows it is saved, and removes with undo", async () => {
  reset();
  const { host, notices } = hostStub();
  const view1 = await mount(createElement(BookmarkAction, { host, context: answerContext }));
  const button = () => view1.container.querySelector<HTMLButtonElement>('[data-action-id="bookmarks.toggle"]')!;
  assert.equal(button().getAttribute("aria-pressed"), "false");

  await act(async () => { button().click(); });
  await settle();
  const saved = calls.find((call) => call.method === "POST" && call.path === "/api/bookmarks");
  assert.deepEqual(saved?.body, { kind: "answer", sessionId: "s1", eventSeq: 5, body: "# Head\nText" });
  assert.equal(button().getAttribute("aria-pressed"), "true");
  assert.equal(notices.at(-1)?.title, "Saved to bookmarks");

  await act(async () => { button().click(); });
  await settle();
  assert.equal(button().getAttribute("aria-pressed"), "false");
  assert.equal(notices.at(-1)?.title, "Bookmark removed");

  // Undo brings it back under the old date.
  await act(async () => { await notices.at(-1)!.undo!(); });
  await settle();
  assert.equal(button().getAttribute("aria-pressed"), "true");
  await view1.unmount();
});

test("in the menu it renders no trigger and acts only when the request grows", async () => {
  reset();
  const { host } = hostStub();
  const menu = { ...answerContext, messageActionPlacement: "menu", messageActionRequest: 3 };
  const mounted = await mount(createElement(BookmarkAction, { host, context: menu }));
  assert.equal(mounted.container.querySelector("button") === null, true);
  await settle();
  assert.equal(calls.filter((call) => call.method === "POST").length, 0, "mounting does nothing");
  assert.equal(answerActionMenuLabel(menu), "Bookmark");

  await mounted.rerender(createElement(BookmarkAction, { host, context: { ...menu, messageActionRequest: 4 } }));
  await settle();
  assert.equal(calls.filter((call) => call.method === "POST").length, 1);
  assert.equal(answerActionMenuLabel(menu), "Remove bookmark");
  await mounted.unmount();
});

test("the walk bar names the place and steps through the chat in order", async () => {
  reset();
  stored = [view({ eventSeq: 3, title: "First" }), view({ eventSeq: 9, title: "Second" })];
  await refreshBookmarks("p1");
  const { host, revealed } = hostStub();
  const first = stored[0]!.id as string;
  const bar = await mount(createElement(WalkBar, { host, sessionId: "s1" }));
  assert.equal(bar.container.querySelector(".bm-walk") === null, true, "no line without a walk");

  await act(async () => { setBookmarkWalk({ sessionId: "s1", activeId: first }); });
  assert.equal(bar.container.querySelector(".bm-walk-at")?.textContent, "1 of 2");
  assert.equal(bar.container.querySelector(".bm-walk-title")?.textContent, "First");
  const arrow = (name: string) => bar.container.querySelector<HTMLButtonElement>(`[aria-label="${name}"]`)!;
  assert.equal(arrow("Previous bookmark").disabled, true);

  await act(async () => { arrow("Next bookmark").click(); });
  await settle();
  assert.deepEqual(revealed, [{ seq: 9, focus: false }], "the arrow keeps focus on the arrow");
  assert.equal(bar.container.querySelector(".bm-walk-at")?.textContent, "2 of 2");
  assert.equal(arrow("Next bookmark").disabled, true);

  await act(async () => { arrow("End the walk").click(); });
  assert.equal(bar.container.querySelector(".bm-walk") === null, true);
  await bar.unmount();
});

test("a walk in another chat stays out of this one", async () => {
  reset();
  stored = [view({ eventSeq: 3 })];
  await refreshBookmarks("p1");
  const { host } = hostStub();
  const bar = await mount(createElement(WalkBar, { host, sessionId: "other" }));
  await act(async () => { setBookmarkWalk({ sessionId: "s1", activeId: stored[0]!.id as string }); });
  assert.equal(bar.container.querySelector(".bm-walk") === null, true);
  await bar.unmount();
});

test("the panel: a name goes to its place, an arrow opens the text with its links", async () => {
  reset();
  stored = [
    view({ eventSeq: 3, title: "First", links: [{ url: "https://a.example/", label: "a" }] }),
    view({ eventSeq: 9, title: "Second" }),
  ];
  const { host, revealed } = hostStub();
  const panel = await mount(createElement(BookmarksPanel, { host, projectId: "p1", sessionId: "s1" }));
  await settle();
  assert.equal(panel.container.querySelectorAll(".bm-item").length, 2);

  await act(async () => { panel.container.querySelector<HTMLButtonElement>(".bm-row-expand")!.click(); });
  await settle();
  assert.equal(calls.some((call) => call.path.startsWith("/api/bookmarks/body")), true, "text loads when opened");
  const link = panel.container.querySelector<HTMLAnchorElement>('.bm-text a[href="https://a.example"]');
  assert.equal(link?.getAttribute("target"), "_blank");
  assert.equal(revealed.length, 0, "the arrow does not leave the panel");

  await act(async () => { panel.container.querySelectorAll<HTMLButtonElement>(".bm-row-main")[1]!.click(); });
  await settle();
  assert.deepEqual(revealed, [{ seq: 9, focus: true }]);
  assert.equal(panel.container.querySelector('[data-active="true"] .bm-row-title')?.textContent, "Second");
  await panel.unmount();
});

test("the panel: a place the chat cannot show says so and keeps the bookmark", async () => {
  reset();
  stored = [view({ eventSeq: 3, title: "Gone" })];
  const { host, notices } = hostStub(() => false);
  const panel = await mount(createElement(BookmarksPanel, { host, projectId: "p1", sessionId: "s1" }));
  await settle();
  await act(async () => { panel.container.querySelector<HTMLButtonElement>(".bm-row-main")!.click(); });
  await settle();
  assert.match(notices.at(-1)?.title ?? "", /no longer in the chat/);
  assert.equal(panel.container.querySelectorAll(".bm-item").length, 1);
  assert.equal(panel.container.querySelector("[data-active]") === null, true, "no walk starts");
  await panel.unmount();
});

test("the panel: a deleted chat and a note open their text instead of going anywhere", async () => {
  reset();
  stored = [
    view({ eventSeq: 3, title: "Old", chat: "deleted" }),
    view({ kind: "note", title: "Idea", sessionId: undefined, eventSeq: undefined, chat: "none" }),
  ];
  const { host, revealed } = hostStub();
  const panel = await mount(createElement(BookmarksPanel, { host, projectId: "p1", sessionId: null }));
  await settle();
  const heads = [...panel.container.querySelectorAll(".bm-group-head")].map((head) => head.textContent ?? "");
  assert.ok(heads.some((head) => head.includes("Chat deleted")), heads.join("|"));
  await act(async () => { panel.container.querySelector<HTMLButtonElement>(".bm-row-main")!.click(); });
  await settle();
  assert.equal(revealed.length, 0);
  assert.equal(panel.container.querySelector('[data-open="true"]') !== null, true);
  await panel.unmount();
});

test("the panel: chat scope hides other chats and the links tab collects links", async () => {
  reset();
  stored = [
    view({ eventSeq: 3, title: "Here", links: [{ url: "https://a.example/", label: "A link" }] }),
    view({ eventSeq: 4, title: "Elsewhere", sessionId: "s2", links: [{ url: "https://b.example/", label: "B link" }] }),
  ];
  const { host } = hostStub();
  const panel = await mount(createElement(BookmarksPanel, { host, projectId: "p1", sessionId: "s1" }));
  await settle();
  assert.equal(panel.container.querySelectorAll(".bm-item").length, 1);
  const linksTab = [...panel.container.querySelectorAll<HTMLElement>("[role=tab]")].find((tab) => tab.textContent?.includes("Links"))!;
  await act(async () => { linksTab.click(); });
  const labels = [...panel.container.querySelectorAll(".bm-link-label")].map((label) => label.textContent);
  assert.deepEqual(labels, ["A link"]);
  await panel.unmount();
});

const typeInto = async (field: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")!.set!;
  await act(async () => {
    setter.call(field, value);
    field.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
  });
};
const buttonNamed = (root: Element, name: string) => [...root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === name)!;

test("the panel: an edit saves what changed, and only that", async () => {
  reset();
  stored = [view({ eventSeq: 3, title: "First" })];
  const { host } = hostStub();
  const panel = await mount(createElement(BookmarksPanel, { host, projectId: "p1", sessionId: "s1" }));
  await settle();
  await act(async () => { panel.container.querySelector<HTMLButtonElement>(".bm-row-expand")!.click(); });
  await settle();
  await act(async () => { buttonNamed(panel.container, "Edit").click(); });
  await settle();
  await typeInto(panel.container.querySelector<HTMLInputElement>(".bm-form input")!, "Renamed");
  await act(async () => { buttonNamed(panel.container, "Save").click(); });
  await settle();
  const update = calls.find((call) => call.path === "/api/bookmarks/update");
  assert.deepEqual(update?.body, { title: "Renamed", id: stored[0]!.id, revision: 1 });
  assert.equal(panel.container.querySelector(".bm-form") === null, true);
  assert.equal(panel.container.querySelector(".bm-row-title")?.textContent, "Renamed");
  await panel.unmount();
});

test("the panel: a stale edit asks which version stays, and keeps the person's words", async (t) => {
  reset();
  stored = [view({ eventSeq: 3, title: "First" })];
  conflictOnce = true;
  const scrolled: unknown[] = [];
  const scroll = Object.getOwnPropertyDescriptor(dom.Element.prototype, "scrollIntoView");
  Object.defineProperty(dom.Element.prototype, "scrollIntoView", { configurable: true, writable: true, value(options: unknown) { scrolled.push(options); } });
  t.after(() => {
    if (scroll) Object.defineProperty(dom.Element.prototype, "scrollIntoView", scroll);
    else delete (dom.Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });
  const { host } = hostStub();
  const panel = await mount(createElement(BookmarksPanel, { host, projectId: "p1", sessionId: "s1" }));
  await settle();
  await act(async () => { panel.container.querySelector<HTMLButtonElement>(".bm-row-expand")!.click(); });
  await settle();
  await act(async () => { buttonNamed(panel.container, "Edit").click(); });
  await settle();
  await typeInto(panel.container.querySelector<HTMLInputElement>(".bm-form input")!, "Mine");
  await act(async () => { buttonNamed(panel.container, "Save").click(); });
  await settle();
  assert.match(panel.container.querySelector('[role="alert"]')?.textContent ?? "", /another device/);
  assert.equal(panel.container.querySelector<HTMLInputElement>(".bm-form input")?.value, "Mine", "the words are still there");
  assert.deepEqual(scrolled, [{ block: "nearest" }], "the choice is brought on screen once");

  await act(async () => { buttonNamed(panel.container, "Keep my version").click(); });
  await settle();
  const last = calls.filter((call) => call.path === "/api/bookmarks/update").at(-1);
  assert.equal(last?.body.revision, 5, "saved over the version it was told about");
  assert.equal(panel.container.querySelector(".bm-row-title")?.textContent, "Mine");
  assert.equal(panel.container.querySelector(".bm-form") === null, true);
  await panel.unmount();
});

test("the panel: a note made in a chat view stays with that chat, in a project view with the project", async () => {
  reset();
  const { host } = hostStub();
  const panel = await mount(createElement(BookmarksPanel, { host, projectId: "p1", sessionId: "s1" }));
  await settle();
  await act(async () => { buttonNamed(panel.container, "Note").click(); });
  assert.equal(buttonNamed(panel.container, "Save").disabled, true, "an empty note cannot be saved");
  await typeInto(panel.container.querySelector<HTMLTextAreaElement>(".bm-form textarea")!, "Remember this");
  await act(async () => { buttonNamed(panel.container, "Save").click(); });
  await settle();
  assert.deepEqual(calls.find((call) => call.method === "POST")?.body, { kind: "note", sessionId: "s1", body: "Remember this" });
  await panel.unmount();

  reset();
  const noChat = await mount(createElement(BookmarksPanel, { host, projectId: "p1", sessionId: null }));
  await settle();
  await act(async () => { buttonNamed(noChat.container, "Note").click(); });
  await typeInto(noChat.container.querySelector<HTMLTextAreaElement>(".bm-form textarea")!, "For the project");
  await act(async () => { buttonNamed(noChat.container, "Save").click(); });
  await settle();
  assert.deepEqual(calls.find((call) => call.method === "POST")?.body, { kind: "note", projectId: "p1", body: "For the project" });
  await noChat.unmount();
});
