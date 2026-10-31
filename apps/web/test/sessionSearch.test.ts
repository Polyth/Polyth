// Session search surface: instant local rows, merged ranked server hits with
// highlighted excerpts, message rows as reveal targets, keyboard roving and
// facet chips that rewrite the query string.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { ComponentType } from "react";

register("./tsxHooks.mjs", import.meta.url);

const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
Object.defineProperty(globalThis, "location", { value: dom.location, configurable: true });
Object.defineProperty(globalThis, "HTMLElement", {
  value: (dom as unknown as { HTMLElement: typeof HTMLElement }).HTMLElement,
  configurable: true,
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { api } = await import("@polyth/session/web-api");
const store = await import("../src/store.ts");
const { default: SessionSearch } = await import("../src/components/SessionSearch.tsx");

type SearchResults = Awaited<ReturnType<typeof api.searchSessions>>;
let searchCalls: Array<{ q: string; opts: Record<string, unknown> }> = [];
let searchResults: SearchResults = [];
const originalSearch = api.searchSessions;

before(() => {
  api.searchSessions = (async (q, opts = {}) => {
    searchCalls.push({ q, opts: opts as Record<string, unknown> });
    await new Promise((r) => setTimeout(r, 5));
    return searchResults;
  }) as typeof api.searchSessions;
  const ticket = store.beginProjectListRequest();
  store.publishProjectList(ticket, [
    { id: "p1", name: "Polyth", path: "/repos/polyth", createdAt: 1 },
    { id: "p2", name: "Website", path: "/repos/site", createdAt: 1 },
  ]);
  const now = Date.now();
  store.setSessions("p1", [
    { id: "s-login", projectId: "p1", title: "Fix Café login", status: "idle", createdAt: 1, updatedAt: now - 1000, lastTurnAt: now - 1000 },
    { id: "s-deploy", projectId: "p1", title: "Deploy pipeline", status: "working", branch: "feat/login-redirect", createdAt: 1, updatedAt: now - 5000, lastTurnAt: now - 5000 },
    { id: "s-old", projectId: "p1", title: "Archived notes", status: "archived", createdAt: 1, updatedAt: now - 9000 },
  ]);
  store.setSessions("p2", [
    { id: "s-site", projectId: "p2", title: "Login page copy", status: "idle", createdAt: 1, updatedAt: now - 2000, lastTurnAt: now - 2000 },
  ]);
  store.activateProject("p1");
});

after(() => { api.searchSessions = originalSearch; });

async function mount(node: ComponentType<any>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(node)); });
  return {
    unmount: async () => { await act(async () => { root.unmount(); }); container.remove(); },
  };
}

const input = () => document.querySelector<HTMLInputElement>(".session-search-input")!;
const rows = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
const titles = () => rows().filter((r) => r.classList.contains("session-search-row--session"))
  .map((r) => r.querySelector(".session-search-title")!.textContent);

async function type(value: string) {
  await act(async () => {
    const el = input();
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set
      ?? Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}
const settle = async (ms: number) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };
const key = async (k: string) => {
  await act(async () => {
    input().dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true }));
  });
};

test("empty query lists recent chats of the active project, archived hidden", async () => {
  const view = await mount(SessionSearch);
  assert.deepEqual(titles(), ["Fix Café login", "Deploy pipeline"]);
  assert.ok(document.querySelector(".session-search-summary")!.textContent!.includes("Recent"));
  assert.equal(searchCalls.length, 0, "no server round trip for an empty query");
  await view.unmount();
});

test("typing shows instant local matches, then merges ranked message hits with highlights", async () => {
  searchCalls = [];
  searchResults = [
    {
      sessionId: "s-deploy", projectId: "p1", title: "Deploy pipeline", status: "working", updatedAt: 1, messageHits: 5,
      matches: [
        { field: "branch", snippet: "feat/login-redirect" },
        { field: "message", snippet: "…the login redirect loops after…", ranges: [[5, 10]], seq: 42, role: "assistant", time: Date.now() - 60_000 },
        { field: "message", snippet: "please fix login", ranges: [[11, 16]], seq: 7, role: "user", time: Date.now() - 120_000 },
      ],
    },
    {
      sessionId: "s-old", projectId: "p1", title: "Archived notes", status: "archived", updatedAt: 1, messageHits: 1,
      matches: [{ field: "message", snippet: "login notes", ranges: [[0, 5]], seq: 3, role: "user", time: Date.now() - 999_000 }],
    },
  ];
  const view = await mount(SessionSearch);
  await type("login");
  // Instant: title + branch matches from the local store, before any response.
  assert.deepEqual(titles(), ["Fix Café login", "Deploy pipeline"]);
  assert.ok(document.querySelector(".session-search-title .session-search-mark")?.textContent === "login");
  await settle(200);
  assert.deepEqual(searchCalls.map((c) => [c.q, c.opts.projectId]), [["login", "p1"]]);
  // Merged: local rows keep their place; the archived chat with a message hit joins.
  assert.deepEqual(titles(), ["Fix Café login", "Deploy pipeline", "Archived notes"]);
  const messageRows = rows().filter((r) => r.classList.contains("session-search-row--message"));
  assert.equal(messageRows.length, 3);
  assert.equal(messageRows[0]!.querySelector(".session-search-mark")!.textContent, "login");
  assert.equal(messageRows[0]!.querySelector(".session-search-role")!.textContent, "Agent");
  assert.equal(messageRows[1]!.querySelector(".session-search-role")!.textContent, "You");
  assert.ok(document.querySelector(".session-search-more")!.textContent!.includes("3"), "hidden hit count = 5 - 2 shown");
  const summary = document.querySelector(".session-search-summary")!.textContent!;
  assert.ok(summary.includes("3 chats") && summary.includes("6 messages"), summary);
  assert.ok(document.querySelector(".session-search-took"), "elapsed time shown");

  // Keyboard roving walks session and message rows alike.
  assert.equal(rows()[0]!.getAttribute("aria-selected"), "true");
  await key("ArrowDown");
  await key("ArrowDown");
  assert.equal(rows()[2]!.getAttribute("aria-selected"), "true");
  assert.ok(rows()[2]!.classList.contains("session-search-row--message"));
  assert.equal(input().getAttribute("aria-activedescendant"), rows()[2]!.id);
  await key("End");
  assert.equal(rows().at(-1)!.getAttribute("aria-selected"), "true");
  await view.unmount();
});

test("scope and facet chips rewrite the query and the request", async () => {
  searchCalls = [];
  searchResults = [];
  const view = await mount(SessionSearch);
  await type("redirect");
  await act(async () => {
    [...document.querySelectorAll<HTMLButtonElement>(".session-search-facet")]
      .find((b) => b.textContent === "From agent")!.click();
  });
  assert.equal(input().value, "redirect from:agent");
  await act(async () => {
    [...document.querySelectorAll<HTMLButtonElement>(".session-search-scope-btn")]
      .find((b) => b.textContent === "All projects")!.click();
  });
  await settle(200);
  const last = searchCalls.at(-1)!;
  assert.equal(last.q, "redirect");
  assert.equal(last.opts.role, "assistant");
  assert.equal(last.opts.projectId, undefined);
  // The facet is marked pressed and Escape clears the query first.
  const facet = [...document.querySelectorAll<HTMLButtonElement>(".session-search-facet")].find((b) => b.textContent === "From agent")!;
  assert.equal(facet.getAttribute("aria-pressed"), "true");
  await key("Escape");
  assert.equal(input().value, "");
  assert.ok(document.querySelector(".session-search-empty") === null, "cleared query falls back to recent chats");
  await view.unmount();
});

test("is:archived narrows recent and search results to archived chats", async () => {
  searchResults = [];
  const view = await mount(SessionSearch);
  await type("is:archived");
  assert.deepEqual(titles(), ["Archived notes"]);
  assert.equal(searchCalls.filter((c) => c.q === "").length, 0);
  await view.unmount();
});
