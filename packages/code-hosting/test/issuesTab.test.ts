// Mounted check for the issues tab presentation:
//   - the tab and its empty state use the plural provider label, not the prose
//     singular "issue";
//   - a held (in-flight) list request never renders a false "0" count.
//
// The client captures globalThis.fetch at context-render time (see
// createApiTransport), so swapping fetch before mount is enough to hold the
// activity responses while status resolves.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

const issue = {
  number: 7, title: "Server search result", state: "OPEN", isDraft: false, author: "dev",
  updatedAt: "2026-09-10", createdAt: "2026-09-10", url: "https://github.example/repo/issues/7", body: "Fix build",
};

test("issues tab uses the plural label and never claims 0 while loading", async () => {
  const dom = new Window();
  Object.assign(globalThis, { window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true });
  const originalFetch = globalThis.fetch;
  let releaseActivity: () => void = () => {};
  const activityGate = new Promise<void>((resolve) => { releaseActivity = resolve; });
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/status")) {
      return json({
        installed: true, authenticated: true, user: null,
        repo: { name: "repo", owner: "team", url: "https://github.example/repo", description: "", defaultBranch: "main", isPrivate: false, visibility: "private" },
        capabilities: { mergeStrategies: ["merge"], reviewEvents: ["COMMENT"], discussions: true, reply: true, resolve: true },
      });
    }
    if (url.includes("/issues") || url.includes("/prs")) {
      await activityGate;
      return json({ ok: true, data: [issue] });
    }
    return json({ ok: true, data: [] });
  };

  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const ui = await import("../../../apps/web/src/components/ui/index.ts");
  const { tr } = await import("../../../apps/web/src/i18n/index.ts");
  const { Icon } = await import("../../../apps/web/src/icons.tsx");
  const { CodeHostingProviderContext } = await import("../widgets/context.tsx");
  const { CodeHostingView } = await import("../widgets/CodeHostingView.tsx");

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
    t: tr,
  };

  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as HTMLElement);
  const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }); };
  const tabs = () => [...container.querySelectorAll<HTMLElement>('[role="tab"]')];
  try {
    await act(async () => {
      root.render(createElement(
        CodeHostingProviderContext,
        { host, provider },
        createElement(CodeHostingView, { renderDetail: () => null }),
      ));
    });

    // Status settles while the activity request is still in flight.
    for (let attempt = 0; attempt < 20 && tabs().length < 2; attempt += 1) await flush();
    assert.equal(tabs().length, 2, "the tab strip appears once status resolves");

    // Loading: a skeleton is shown, and neither tab asserts a count of 0.
    assert.ok(container.querySelector('[aria-busy="true"]'), "the list is visibly loading");
    assert.equal(tabs()[0]!.textContent, "Issues", "loading issues tab shows the plural label with no count");
    assert.equal(tabs()[1]!.textContent, "Pull requests", "loading changes tab shows no count");
    assert.ok(!container.textContent?.includes("Issues 0"), "loading never claims 0 issues");

    // Release the held responses: the settled count is the loaded-list length.
    releaseActivity();
    for (let attempt = 0; attempt < 20 && !container.textContent?.includes("Server search result"); attempt += 1) await flush();
    assert.match(tabs()[0]!.textContent ?? "", /^Issues\s+1$/, "settled issues tab is plural with the loaded count");
    assert.match(tabs()[1]!.textContent ?? "", /^Pull requests\s+1$/, "settled changes tab keeps the loaded count");
  } finally {
    await act(async () => { root.unmount(); });
    globalThis.fetch = originalFetch;
    await dom.happyDOM.close();
  }
});

test("tab counts equal the rows each tab lists, not the raw provider response", async () => {
  const dom = new Window();
  Object.assign(globalThis, { window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true });
  const originalFetch = globalThis.fetch;
  const issue = (number: number, state: string) => ({
    number, title: `Issue ${number}`, state, author: "dev",
    updatedAt: "2026-09-10", createdAt: "2026-09-10", url: `https://github.example/issues/${number}`, body: "",
  });
  const pr = (number: number, isDraft: boolean) => ({
    number, title: `PR ${number}`, state: "OPEN", isDraft, author: "dev",
    updatedAt: "2026-09-10", createdAt: "2026-09-10", url: `https://github.example/pulls/${number}`, body: "", headRefName: "feature",
  });
  // A provider that does not narrow by `state`, and the real Draft/Ready case
  // where `state=open` is a superset the client filters by isDraft.
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/status")) {
      return json({
        installed: true, authenticated: true, user: null,
        repo: { name: "repo", owner: "team", url: "https://github.example/repo", description: "", defaultBranch: "main", isPrivate: false, visibility: "private" },
        capabilities: { mergeStrategies: ["merge"], reviewEvents: ["COMMENT"], discussions: true, reply: true, resolve: true },
      });
    }
    if (url.includes("/issues")) return json({ ok: true, data: [issue(1, "OPEN"), issue(2, "CLOSED")] });
    if (url.includes("/prs")) return json({ ok: true, data: [pr(3, true), pr(4, false)] });
    return json({ ok: true, data: [] });
  };

  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const ui = await import("../../../apps/web/src/components/ui/index.ts");
  const { tr } = await import("../../../apps/web/src/i18n/index.ts");
  const { Icon } = await import("../../../apps/web/src/icons.tsx");
  const { CodeHostingProviderContext } = await import("../widgets/context.tsx");
  const { CodeHostingView } = await import("../widgets/CodeHostingView.tsx");

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
    t: tr,
  };

  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as HTMLElement);
  const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }); };
  const tabs = () => [...container.querySelectorAll<HTMLElement>('[role="tab"]')];
  const rows = () => container.querySelectorAll(".gh-card").length;
  const chip = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === label);
  const click = async (label: string) => { await act(async () => { chip(label)!.click(); }); };
  try {
    await act(async () => {
      root.render(createElement(
        CodeHostingProviderContext,
        { host, provider },
        createElement(CodeHostingView, { renderDetail: () => null }),
      ));
    });
    for (let attempt = 0; attempt < 20 && rows() < 2; attempt += 1) await flush();

    // Issues: the provider returns open+closed, so the "Open" filter narrows the
    // rows client-side; the counter must follow those rows, not the raw array.
    await click("Open");
    for (let attempt = 0; attempt < 20 && rows() !== 1; attempt += 1) await flush();
    assert.equal(rows(), 1, "the Open filter lists one issue");
    assert.equal(tabs()[0]!.textContent, "Issues 1", "the issues counter matches the listed issues");

    // Changes: Draft narrows the provider's `state=open` superset client-side.
    await act(async () => { tabs()[1]!.click(); });
    for (let attempt = 0; attempt < 20 && rows() !== 2; attempt += 1) await flush();
    await click("Drafts");
    for (let attempt = 0; attempt < 20 && rows() !== 1; attempt += 1) await flush();
    assert.equal(rows(), 1, "the Drafts filter lists one pull request");
    assert.equal(tabs()[1]!.textContent, "Pull requests 1", "the pull-request counter matches the listed pull requests");
  } finally {
    await act(async () => { root.unmount(); });
    globalThis.fetch = originalFetch;
    await dom.happyDOM.close();
  }
});
