// Mounted checks for how the hosting list talks to its provider:
//   - search waits for a typing pause instead of one request per keystroke;
//   - reopening the view shows the cached list without asking again;
//   - Refresh bypasses the cache and keeps the list on screen meanwhile;
//   - a write through the client drops that project's cached lists.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

const issue = {
  number: 7, title: "Cached issue", state: "OPEN", isDraft: false, author: "dev",
  updatedAt: "2026-09-10", createdAt: "2026-09-10", url: "https://github.example/repo/issues/7", body: "",
};

async function mount() {
  const dom = new Window();
  Object.assign(globalThis, { window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true });
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  let gate: Promise<void> | null = null;
  globalThis.fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("/status")) {
      return json({
        installed: true, authenticated: true, user: null,
        repo: { name: "repo", owner: "team", url: "https://github.example/repo", description: "", defaultBranch: "main", isPrivate: false, visibility: "private" },
        capabilities: { mergeStrategies: ["merge"], reviewEvents: ["COMMENT"], discussions: true, reply: true, resolve: true },
      });
    }
    if (gate) await gate;
    if (url.includes("/issues")) return json({ ok: true, data: [issue] });
    return json({ ok: true, data: [] });
  };

  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const ui = await import("../../../apps/web/src/components/ui/index.ts");
  const { tr } = await import("../../../apps/web/src/i18n/index.ts");
  const { Icon } = await import("../../../apps/web/src/icons.tsx");
  const { CodeHostingProviderContext } = await import("../widgets/context.tsx");
  const { CodeHostingView } = await import("../widgets/CodeHostingView.tsx");
  const cache = await import("../widgets/listCache.ts");
  cache.clearHostingLists();

  const snapshot = { activeProjectId: "p1", activeSessionId: null, settings: { conflictAgentTarget: "new-session", conflictAgentPrompt: "" } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const host: any = {
    ui: { components: { ...ui }, icons: Icon, locale: { get: () => "en", translate: tr } },
    store: { subscribe: () => () => {}, getSnapshot: () => snapshot },
    errors: { friendly: (message: string, cause: unknown) => `${message}: ${String(cause)}` },
    conversation: { openSession: async () => {}, insert: () => {}, startNewSession: () => {} },
    navigation: {},
  };
  const provider = {
    id: "github", apiBase: "/api/github",
    presentation: { serviceName: "GitHub", command: "gh", issueLabel: "issue", issuePlural: "Issues", changeLabel: "PR", changePlural: "Pull requests", changeNumberPrefix: "#" as const, icon: () => null },
    t: tr as unknown as (key: string) => string,
  };

  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  let root = createRoot(container as unknown as HTMLElement);
  const render = async () => {
    await act(async () => {
      root.render(createElement(CodeHostingProviderContext, { host, provider }, createElement(CodeHostingView, { renderDetail: () => null })));
    });
  };
  const wait = async (ms: number) => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); }); };
  const settle = async () => { for (let attempt = 0; attempt < 20 && !container.textContent?.includes("Cached issue"); attempt += 1) await wait(5); };
  return {
    act, container, requests, cache, render, wait, settle,
    hold: () => { let release = () => {}; gate = new Promise<void>((resolve) => { release = resolve; }); return () => { gate = null; release(); }; },
    remount: async () => { await act(async () => { root.unmount(); }); root = createRoot(container as unknown as HTMLElement); await render(); },
    count: (path: string) => requests.filter((url) => url.includes(path)).length,
    button: (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === label),
    close: async () => {
      await act(async () => { root.unmount(); });
      globalThis.fetch = originalFetch;
      await dom.happyDOM.close();
    },
  };
}

test("search waits for a typing pause before asking the provider", async () => {
  const view = await mount();
  try {
    await view.render();
    await view.settle();
    const input = view.container.querySelector<HTMLInputElement>(".gh-search input")!;
    const type = async (value: string) => {
      await view.act(async () => {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!;
        setter.call(input, value);
        input.dispatchEvent(new (globalThis as unknown as { window: { Event: typeof Event } }).window.Event("input", { bubbles: true }));
      });
    };
    for (const value of ["c", "ca", "cac", "cach"]) { await type(value); await view.wait(20); }
    assert.equal(view.requests.filter((url) => url.includes("search=")).length, 0, "no request while typing");
    await view.wait(450);
    const searches = view.requests.filter((url) => url.includes("/issues") && url.includes("search="));
    assert.equal(searches.length, 1, "one search after the pause");
    assert.match(searches[0]!, /search=cach/);
  } finally { await view.close(); }
});

test("reopening shows the cached list without asking again; Refresh does ask", async () => {
  const view = await mount();
  try {
    await view.render();
    await view.settle();
    assert.equal(view.count("/status"), 1);

    await view.remount();
    assert.ok(view.container.textContent?.includes("Cached issue"), "the cached list shows on the first paint");
    await view.wait(20);
    assert.equal(view.count("/status"), 1, "a fresh cache entry is not re-requested");

    const release = view.hold();
    await view.act(async () => { view.button("Refresh")!.click(); });
    await view.wait(10);
    assert.equal(view.count("/status"), 2, "Refresh bypasses the cache");
    assert.ok(view.container.textContent?.includes("Cached issue"), "the list stays visible while refreshing");
    assert.ok(!view.container.querySelector(".gh-skeleton-list"), "refreshing a shown list does not fall back to skeletons");
    release();
    await view.wait(20);
    assert.ok(view.container.textContent?.includes("Cached issue"));
  } finally { await view.close(); }
});

test("a stale cache entry shows at once and refreshes in the background", async () => {
  const view = await mount();
  try {
    await view.render();
    await view.settle();
    const key = view.cache.hostingListKey("/api/github", "p1", { tab: "issues", state: "all", search: "" });
    const entry = view.cache.readHostingList(key)!;
    view.cache.writeHostingList(key, "/api/github", "p1", entry.value, Date.now() - view.cache.HOSTING_LIST_FRESH_MS - 1);

    await view.remount();
    assert.ok(view.container.textContent?.includes("Cached issue"), "stale data still paints immediately");
    await view.wait(20);
    assert.equal(view.count("/status"), 2, "stale data is revalidated");
  } finally { await view.close(); }
});

test("a write through the client drops the project's cached lists", async () => {
  const { clearHostingLists, hostingListKey, readHostingList, writeHostingList, invalidateHostingLists } = await import("../widgets/listCache.ts");
  clearHostingLists();
  const value = { status: { installed: true, authenticated: true, user: null, repo: null }, issues: [], changes: [], reason: "" };
  const mine = hostingListKey("/api/github", "p1", { tab: "issues", state: "all", search: "" });
  const other = hostingListKey("/api/github", "p2", { tab: "issues", state: "all", search: "" });
  const gitlab = hostingListKey("/api/gitlab", "p1", { tab: "issues", state: "all", search: "" });
  writeHostingList(mine, "/api/github", "p1", value);
  writeHostingList(other, "/api/github", "p2", value);
  writeHostingList(gitlab, "/api/gitlab", "p1", value);

  const { createCodeHostingClient } = await import("../widgets/client.ts");
  const transport = { get: async () => ({}), post: async () => ({ ok: true, data: { url: "u" } }) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = createCodeHostingClient({ id: "github", apiBase: "/api/github" } as any, transport as any);
  await client.addComment({ kind: "issue", projectId: "p1", number: 7, body: "hi" });
  assert.equal(readHostingList(mine), null, "the written project's lists are dropped");
  assert.ok(readHostingList(other), "other projects keep their lists");
  assert.ok(readHostingList(gitlab), "other providers keep their lists");
  invalidateHostingLists("/api/github");
  assert.equal(readHostingList(other), null);
});
