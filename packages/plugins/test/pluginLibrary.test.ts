import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

type Matches = { all: number; enabled: number; disabled: number };

const PLUGINS = [
  {
    id: "release-radar",
    name: "Release Radar",
    version: "1.4.2",
    source: "upload:release-radar.zip",
    trust: "ui-only",
    enabled: false,
    status: "installed",
    runtimeKind: "sandboxed",
    description: "Quiet digests of new releases.",
    contributions: [],
    permissions: {
      effective: [],
      requested: [{ name: "ui.render" }, { name: "storage.package", required: false }],
      review: { capabilities: [{ name: "ui.render" }, { name: "storage.package", required: false }], connections: [] },
    },
  },
  {
    id: "focus-timer",
    name: "Focus Timer",
    version: "0.9.0",
    source: "upload:focus-timer.zip",
    trust: "ui-only",
    enabled: true,
    status: "ready",
    runtimeKind: "sandboxed",
    description: "A pomodoro timer.",
    contributions: [{
      slot: "widget.catalog",
      id: "focus-timer.widget.timer",
      module: "sandbox-contribution:widget:timer",
      props: { contributionKind: "widget", contributionId: "timer", title: "Focus timer", description: "Pomodoro" },
    }],
    permissions: { effective: ["ui.render"], requested: [{ name: "ui.render" }] },
  },
];

test("the library lists under the page's find state, reports its matches and takes the page over for a review", async () => {
  const dom = new Window({ url: "http://localhost/" });
  Object.assign(globalThis, {
    window: dom,
    document: dom.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: (time: number) => void) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
  });
  const state = structuredClone(PLUGINS) as Array<Record<string, any>>;
  const posts: Array<{ url: string; body: unknown }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "GET" && /\/api\/plugins$/.test(url)) return Response.json(state);
    const op = url.match(/\/api\/plugins\/([^/]+)\/(grants|enable|disable)$/);
    if (op && method === "POST") {
      posts.push({ url: `${op[1]}/${op[2]}`, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const plugin = state.find((item) => item.id === decodeURIComponent(op[1]!))!;
      if (op[2] === "grants") delete plugin.permissions.review;
      if (op[2] === "enable") Object.assign(plugin, { enabled: true, status: "ready" });
      if (op[2] === "disable") plugin.enabled = false;
      return Response.json(plugin);
    }
    return Response.json([]);
  };
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ManagedPluginsSection } = await import("../widgets/PluginsPage.tsx");
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as HTMLElement);
  const reports: Array<[string, Matches]> = [];
  const details: Array<[string, boolean]> = [];
  const context = (find: { query?: string; status?: string; category?: string | null } = {}) => ({
    packagesQuery: find.query ?? "",
    packagesStatus: find.status ?? "all",
    packagesCategory: find.category ?? null,
    reportPackageMatches: (owner: string, matches: Matches) => { reports.push([owner, { ...matches }]); },
    setPackageDetailOpen: (owner: string, open: boolean) => { details.push([owner, open]); },
  });
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  const render = (find: Parameters<typeof context>[0] = {}) => act(async () => {
    root.render(createElement(ManagedPluginsSection, { context: context(find) }));
  });
  const rows = () => [...container.querySelectorAll(".plugin-row")].map((row) => row.getAttribute("data-plugin-id"));
  const buttonByText = (text: string) => [...container.querySelectorAll("button")]
    .find((button) => button.textContent?.trim() === text) as unknown as { click(): void; disabled: boolean } | undefined;
  try {
    await render();
    await settle();
    // Alphabetical rows; a ready package has its switch, one waiting for
    // access offers the review instead of a switch it could not honour.
    assert.deepEqual(rows(), ["focus-timer", "release-radar"]);
    assert.equal(container.querySelector('[data-plugin-id="focus-timer"] [role="switch"]')?.getAttribute("aria-checked"), "true");
    assert.equal(container.querySelector('[data-plugin-id="release-radar"] [role="switch"]'), null);
    assert.match(container.querySelector('[data-plugin-id="release-radar"]')!.textContent!, /Needs review/);
    assert.deepEqual(reports.at(-1), ["plugins.package-library", { all: 2, enabled: 1, disabled: 1 }]);

    // One search for the whole page: the toolbar's words and status apply here too.
    await render({ query: "release" });
    assert.deepEqual(rows(), ["release-radar"]);
    assert.deepEqual(reports.at(-1)![1], { all: 1, enabled: 0, disabled: 1 });
    await render({ status: "enabled" });
    assert.deepEqual(rows(), ["focus-timer"]);
    // Added packages carry no host category: a chosen one hides the section.
    await render({ category: "engineering" });
    assert.equal(container.querySelector(".settings-section"), null);
    assert.deepEqual(reports.at(-1)![1], { all: 0, enabled: 0, disabled: 0 });

    // Review opens the detail in place of the page, on its permissions.
    await render();
    await act(async () => { buttonByText("Review & enable")!.click(); });
    assert.deepEqual(details.at(-1), ["plugins.package-library", true]);
    assert.equal(rows().length, 0);
    assert.match(container.querySelector(".plugin-hero-title")!.textContent!, /Release Radar/);
    assert.equal(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.startsWith("Permissions"), true);
    assert.match(container.querySelector(".plugin-review")!.textContent!, /Show its own interface/);
    // Approval grants only the required access, then enables.
    await act(async () => { buttonByText("Approve & enable")!.click(); });
    await settle();
    assert.deepEqual(posts, [
      { url: "release-radar/grants", body: { capabilities: ["ui.render"], connections: [] } },
      { url: "release-radar/enable", body: {} },
    ]);
    assert.equal(container.querySelector(".plugin-review"), null);
    // Back gives the page back and lists the package as enabled.
    await act(async () => { buttonByText("Packages")!.click(); });
    assert.deepEqual(details.at(-1), ["plugins.package-library", false]);
    assert.equal(container.querySelector('[data-plugin-id="release-radar"] [role="switch"]')?.getAttribute("aria-checked"), "true");
  } finally {
    await act(async () => { root.unmount(); });
    globalThis.fetch = originalFetch;
    await dom.happyDOM.close();
  }
});
