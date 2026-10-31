import test, { after } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { Project } from "@polyth/contracts";
import type { SurfaceComponentProps } from "@polyth/web-sdk";
import { buildUsageStatsReport } from "../src/analytics/aggregate.ts";
import type { UsageObservation, UsageStatsQuery } from "../src/analytics/contracts.ts";

register("./tsxHooks.mjs", import.meta.url);
const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const day = 86_400_000;
const now = Date.UTC(2026, 6, 10, 12);
const observations: UsageObservation[] = Array.from({ length: 6 }, (_, index) => ({
  id: `o-${index}`,
  timestamp: now - (index * 3 + 1) * day,
  projectId: "project-a",
  sessionId: `session-${index % 2}`,
  turnId: `turn-${index}`,
  harnessId: index % 2 ? "codex" : "claude",
  modelId: index % 2 ? "gpt-5" : "sonnet",
  tokens: { input: 100 * (index + 1), output: 10, reasoning: 2, cacheRead: 50, cacheWrite: 5 },
  cost: 0.01 * (index + 1),
  quality: "exact",
}));

const requests: UsageStatsQuery[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = String(input);
  if (path === "/api/usage/identity") return Response.json({ serverInstanceId: "server-test", spaceId: "space-test" });
  if (path === "/api/usage/stats") {
    const query = JSON.parse(String(init?.body)) as UsageStatsQuery;
    requests.push(query);
    return Response.json(buildUsageStatsReport({
      serverInstanceId: "server-test",
      spaceId: "space-test",
      query,
      observations,
      projects: [{ id: "project-a", name: "Project A" }],
      sessions: new Map([["session-0", { id: "session-0", title: "First", status: "idle" }], ["session-1", { id: "session-1", title: "Second", status: "idle" }]]),
      now,
    }));
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;
after(async () => {
  globalThis.fetch = originalFetch;
  await dom.happyDOM.close();
});

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { applyProjectAdded } = await import("../../../apps/web/src/store.ts");
const { tr } = await import("../../../apps/web/src/i18n/index.ts");
const { clearUsageStatsCache } = await import("../widgets/usage/usageStatsClient.ts");
const { UsageDashboard } = await import("../widgets/usage/UsageDashboard.tsx");
const {
  DEFAULT_USAGE_DASHBOARD_PREFS,
  USAGE_DASHBOARD_PREFS_KEY,
  getUsageDashboardPrefs,
  replaceUsageDashboardPrefs,
} = await import("../widgets/usage/dashboardLayout.ts");

applyProjectAdded({ id: "project-a", name: "Project A", path: "/a", createdAt: 1 } as Project);

const settle = async (until: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 200 && !until(); attempt += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  }
};
const text = (node: Element | null | undefined): string => node?.textContent?.trim() ?? "";
const blocks = (container: HTMLElement): string[] =>
  [...container.querySelectorAll(".usage-clean-block")].map((block) => block.getAttribute("data-block") ?? "");
const button = (container: HTMLElement, label: string, prefix = false): HTMLButtonElement => {
  const found = [...container.querySelectorAll("button")].find((candidate) => {
    const name = candidate.getAttribute("aria-label") ?? text(candidate);
    return prefix ? name.startsWith(label) : name === label;
  });
  assert.ok(found, `button ${label}`);
  return found as HTMLButtonElement;
};

async function withDashboard(run: (container: HTMLElement, render: (active: boolean) => Promise<void>) => Promise<void>): Promise<void> {
  clearUsageStatsCache();
  replaceUsageDashboardPrefs(DEFAULT_USAGE_DASHBOARD_PREFS);
  requests.length = 0;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = async (active: boolean) => {
    await act(async () => root.render(createElement<SurfaceComponentProps>(UsageDashboard, { active, sessionId: null, projectId: "project-a" })));
  };
  try {
    await render(true);
    await settle(() => blocks(container).length > 0);
    await run(container, render);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
}

test("the Project view renders its default blocks with headline trends and an inspectable chart", async () => {
  await withDashboard(async (container) => {
    assert.deepEqual(blocks(container), ["overview", "activity", "tokens", "cache", "harnesses", "models", "sessions"]);
    assert.equal(container.querySelectorAll(".usage-clean-kpi").length, 6);
    assert.ok(container.querySelector(".usage-clean-kpi[data-primary] .usage-clean-spark-line"), "the headline carries a sparkline");
    assert.ok(container.querySelectorAll(".usage-clean-mix-bar > i").length >= 3, "token mix draws its parts");

    const columns = container.querySelectorAll(".usage-clean-chart-col");
    assert.equal(columns.length, 30, "one column per day of the 30-day range");
    assert.equal(container.querySelectorAll(".usage-clean-chart-col > i").length, observations.length);
    const plot = container.querySelector(".usage-clean-chart-plot") as HTMLElement;
    assert.equal(plot.getAttribute("tabindex"), "0");
    await act(async () => { plot.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "End", bubbles: true }) as unknown as Event); });
    const live = document.getElementById(plot.getAttribute("aria-describedby")!);
    assert.match(text(live), /:/, "the inspected period is announced");
    assert.ok(container.querySelector(".usage-clean-chart-col[data-active] .usage-clean-chart-tip"));
  });
});

test("arranging hides and reorders blocks, persists the layout, and reset restores it", async () => {
  await withDashboard(async (container) => {
    await act(async () => { button(container, tr("usage.customizeLayout")).click(); });
    const rows = () => [...container.querySelectorAll("[data-arrange-row]")].map((row) => row.getAttribute("data-arrange-row"));
    assert.deepEqual(rows(), ["overview", "activity", "tokens", "cache", "harnesses", "models", "sessions"]);
    assert.equal(button(container, tr("usage.resetLayout")).disabled, true, "nothing to reset yet");

    await act(async () => { button(container, tr("usage.moveUp", { block: tr("usage.sessions") })).click(); });
    assert.deepEqual(rows(), ["overview", "activity", "tokens", "cache", "harnesses", "sessions", "models"]);
    // Keyboard reordering from the handle.
    const handle = button(container, tr("usage.dragBlock", { block: tr("usage.activity") }));
    await act(async () => { handle.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }) as unknown as Event); });
    assert.deepEqual(rows(), ["activity", "overview", "tokens", "cache", "harnesses", "sessions", "models"]);
    assert.match(text(container.querySelector(".usage-clean-arrange [aria-live]")), /1/);

    const modelsSwitch = container.querySelector(`[role="switch"][aria-label="${tr("usage.showBlock", { block: tr("usage.models") })}"]`) as HTMLElement;
    await act(async () => { modelsSwitch.click(); });
    assert.equal(modelsSwitch.getAttribute("aria-checked"), "false");
    assert.equal(container.querySelector('[data-arrange-row="models"]')?.getAttribute("data-hidden"), "true", "a hidden block keeps its row");

    await act(async () => { button(container, tr("usage.done")).click(); });
    assert.deepEqual(blocks(container), ["activity", "overview", "tokens", "cache", "harnesses", "sessions"]);
    const stored = JSON.parse(localStorage.getItem(USAGE_DASHBOARD_PREFS_KEY) ?? "{}");
    assert.deepEqual(stored.layouts.project.hidden, ["models"]);
    assert.deepEqual(getUsageDashboardPrefs().layouts.global.order, DEFAULT_USAGE_DASHBOARD_PREFS.layouts.global.order, "other scopes keep their own layout");

    // The toolbar control names how many blocks are hidden.
    assert.equal(button(container, tr("usage.customizeLayout"), true).getAttribute("aria-label"), `${tr("usage.customizeLayout")} · ${tr("usage.layoutHiddenCount", { count: 1 })}`);
    await act(async () => { button(container, tr("usage.customizeLayout"), true).click(); });
    await act(async () => { button(container, tr("usage.resetLayout")).click(); });
    await act(async () => { button(container, tr("usage.done")).click(); });
    assert.deepEqual(blocks(container), ["overview", "activity", "tokens", "cache", "harnesses", "models", "sessions"]);
  });
});

test("hiding every block offers the way back instead of an empty page", async () => {
  await withDashboard(async (container) => {
    replaceUsageDashboardPrefs({
      ...DEFAULT_USAGE_DASHBOARD_PREFS,
      layouts: { ...DEFAULT_USAGE_DASHBOARD_PREFS.layouts, project: { order: DEFAULT_USAGE_DASHBOARD_PREFS.layouts.project.order, hidden: DEFAULT_USAGE_DASHBOARD_PREFS.layouts.project.order } },
    });
    await settle(() => blocks(container).length === 0);
    assert.match(text(container), new RegExp(tr("usage.allBlocksHidden")));
    await act(async () => { button(container, tr("usage.customizeLayout")).click(); });
    assert.equal(container.querySelectorAll("[data-arrange-row]").length, 7);
  });
});

test("the range choice is remembered, and a hidden pane keeps its report without querying", async () => {
  await withDashboard(async (container, render) => {
    const rangeTab = [...container.querySelectorAll(".usage-clean-range [role=tab]")].find((tab) => text(tab) === tr("usage.daysShort", { count: 7 })) as HTMLElement;
    await act(async () => { rangeTab.click(); });
    await settle(() => requests.at(-1)?.range === "7d");
    assert.equal(getUsageDashboardPrefs().range, "7d");
    await settle(() => !container.querySelector(".usage-clean")?.getAttribute("aria-busy")?.includes("true"));

    const before = requests.length;
    await render(false);
    assert.ok(blocks(container).length > 0, "the last report stays mounted while hidden");
    await act(async () => { button(container, tr("usage.refresh")).click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    assert.equal(requests.length, before, "a hidden pane does not query");

    await render(true);
    await settle(() => requests.length > before);
    assert.equal(requests.length, before + 1, "showing it again revalidates once");
  });
});

test("the chosen tab survives a remount, and a moment without a session does not overwrite it", async () => {
  clearUsageStatsCache();
  replaceUsageDashboardPrefs(DEFAULT_USAGE_DASHBOARD_PREFS);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const selected = () => text(container.querySelector(".usage-clean-scope-tabs [role=tab][aria-selected=true]"));
  const scopeTab = (label: string) => [...container.querySelectorAll(".usage-clean-scope-tabs [role=tab]")].find((tab) => text(tab) === label) as HTMLElement;
  const mount = async (sessionId: string | null) => {
    const root = createRoot(container);
    await act(async () => root.render(createElement<SurfaceComponentProps>(UsageDashboard, { sessionId, projectId: "project-a" })));
    return root;
  };
  try {
    let root = await mount(null);
    assert.equal(selected(), tr("usage.project"), "a remembered Session tab shows Project without a session");
    await act(async () => { scopeTab(tr("usage.global")).click(); });
    assert.equal(getUsageDashboardPrefs().view, "global");
    await act(async () => root.unmount());

    root = await mount(null);
    assert.equal(selected(), tr("usage.global"), "reopening keeps the tab");
    await act(async () => root.unmount());

    replaceUsageDashboardPrefs({ ...getUsageDashboardPrefs(), view: "session" });
    root = await mount("session-0");
    assert.equal(selected(), tr("usage.session"));
    await act(async () => root.render(createElement<SurfaceComponentProps>(UsageDashboard, { sessionId: null, projectId: "project-a" })));
    assert.equal(selected(), tr("usage.project"));
    await act(async () => root.render(createElement<SurfaceComponentProps>(UsageDashboard, { sessionId: "session-0", projectId: "project-a" })));
    assert.equal(selected(), tr("usage.session"), "the Session tab returns with a session");
    assert.equal(getUsageDashboardPrefs().view, "session");
    await act(async () => root.unmount());
  } finally {
    replaceUsageDashboardPrefs(DEFAULT_USAGE_DASHBOARD_PREFS);
    container.remove();
  }
});
