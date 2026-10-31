import test, { after } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { Project } from "@polyth/contracts";
import { buildUsageStatsReport } from "../src/analytics/aggregate.ts";
import type { UsageObservation, UsageStatsQuery, UsageStatsReport } from "../src/analytics/contracts.ts";

register("./tsxHooks.mjs", import.meta.url);
const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const at = Date.UTC(2026, 6, 1, 12);
const observation = (
  id: string,
  harnessId: string | undefined,
  input: number,
  over: Partial<UsageObservation> = {},
): UsageObservation => ({
  id,
  timestamp: at,
  projectId: "project-a",
  sessionId: `session-${id}`,
  turnId: `turn-${id}`,
  ...(harnessId ? { harnessId } : {}),
  tokens: { input, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  quality: "exact",
  ...over,
});

let observations: UsageObservation[] = [];
let omitHarnesses = false;
const requests: UsageStatsQuery[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = String(input);
  if (path === "/api/usage/identity") return Response.json({ serverInstanceId: "server-test", spaceId: "space-test" });
  if (path === "/api/usage/stats") {
    const query = JSON.parse(String(init?.body)) as UsageStatsQuery;
    requests.push(query);
    const report = buildUsageStatsReport({
      serverInstanceId: "server-test",
      spaceId: "space-test",
      query,
      observations,
      projects: [{ id: "project-a", name: "Project A" }, { id: "project-b", name: "Project B" }],
      sessions: new Map(),
      now: Date.UTC(2026, 6, 10),
    });
    // happy-dom has no canvas; an empty chart takes the "nothing recorded" branch instead.
    const body: Partial<UsageStatsReport> = { ...report, chart: { bucket: "day", buckets: [] } };
    if (omitHarnesses) delete body.harnesses;
    return Response.json(body);
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
const { fmtCost } = await import("../../../apps/web/src/format.ts");
const { clearUsageStatsCache } = await import("../widgets/usage/usageStatsClient.ts");
const { UsageDashboard } = await import("../widgets/usage/UsageDashboard.tsx");

applyProjectAdded({ id: "project-a", name: "Project A", path: "/a", createdAt: 1 } as Project);

const settle = async (until: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 200 && !until(); attempt += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  }
};

async function withDashboard(run: (container: HTMLElement) => Promise<void>): Promise<void> {
  clearUsageStatsCache();
  requests.length = 0;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(UsageDashboard)));
    await run(container);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
}

const harnessSection = (container: HTMLElement): Element | null => container.querySelector(".usage-clean-harnesses");
const text = (node: Element | null | undefined): string => node?.textContent?.trim() ?? "";
const legend = (container: HTMLElement) => [...container.querySelectorAll(".usage-clean-harness-row")].map((row) => {
  const cells = [...row.querySelectorAll(":scope > span")].map(text);
  return { label: text(row.querySelector("strong")), share: cells[0], value: cells[1], tone: row.querySelector("i")?.getAttribute("data-tone") };
});
const chooseTab = async (scope: Element, label: string): Promise<void> => {
  const tab = [...scope.querySelectorAll('[role="tab"]')].find((candidate) => text(candidate) === label) as HTMLElement | undefined;
  assert.ok(tab, `${label} tab`);
  await act(async () => { tab.click(); });
};

test("the Project scope draws the harness pie beside a legend ranked by the selected metric", async () => {
  observations = [
    observation("a", "claude", 40, { cost: 1.5 }),
    observation("b", "claude", 20, { cost: 0.5 }),
    observation("c", "codex", 30),
    observation("d", undefined, 10),
    observation("elsewhere", "cursor", 999, { projectId: "project-b" }),
  ];
  omitHarnesses = false;
  await withDashboard(async (container) => {
    await settle(() => !!harnessSection(container));
    const section = harnessSection(container);
    assert.ok(section, "the section renders once the report arrives");
    assert.equal(text(section.querySelector("h3")), tr("usage.harnesses"));
    assert.equal(requests.at(-1)?.projectIds?.join(), "project-a");

    // Tokens by default: claude 60, codex 30, unknown 10; the other project's cursor is out of scope.
    assert.deepEqual(legend(container), [
      { label: "Claude Code", share: "60%", value: "60", tone: "1" },
      { label: "Codex", share: "30%", value: "30", tone: "2" },
      { label: tr("usage.unknownHarness"), share: "10%", value: "10", tone: "0" },
    ]);
    assert.equal(text(section.querySelector(".usage-clean-harness-center strong")), "100");
    assert.equal(text(section.querySelector(".usage-clean-harness-center small")), tr("usage.tokens"));
    const slices = [...section.querySelectorAll("path.usage-clean-harness-slice")];
    assert.deepEqual(slices.map((slice) => slice.getAttribute("data-tone")), ["1", "2", "0"]);
    assert.ok(slices.every((slice) => /^M [\d. ]+A /.test(slice.getAttribute("d") ?? "")));
    assert.equal(text(slices[0]?.querySelector("title")), "Claude Code · 60% · 60");
    assert.equal(section.querySelector("svg")?.getAttribute("aria-hidden"), "true");

    // Cost is known only for claude, so it takes the whole pie and the others stay listed unplotted.
    await chooseTab(section, tr("usage.cost"));
    assert.deepEqual(legend(container).map(({ label, share, value }) => ({ label, share, value })), [
      { label: "Claude Code", share: "100%", value: fmtCost(2) },
      { label: "Codex", share: "—", value: "—" },
      { label: tr("usage.unknownHarness"), share: "—", value: "—" },
    ]);
    assert.equal(text(section.querySelector(".usage-clean-harness-center strong")), `≥${fmtCost(2)}`);
    assert.equal(section.querySelectorAll("path.usage-clean-harness-slice").length, 1);
    assert.equal(legend(container)[1]?.tone, "2", "an unplotted harness keeps its tone across metrics");

    await chooseTab(section, tr("usage.turns"));
    assert.deepEqual(legend(container).map(({ label, share }) => [label, share]), [
      ["Claude Code", "50%"],
      ["Codex", "25%"],
      [tr("usage.unknownHarness"), "25%"],
    ]);
    assert.equal(text(section.querySelector(".usage-clean-harness-center small")), tr("usage.turns"));
  });
});

test("a harness under one percent reads <1% rather than a misleading 0%", async () => {
  observations = [observation("a", "claude", 100_000), observation("b", "cursor", 1)];
  omitHarnesses = false;
  await withDashboard(async (container) => {
    await settle(() => !!harnessSection(container));
    // A leading LRM stops the "<" from being mirrored inside right-to-left text.
    assert.deepEqual(legend(container).map(({ label, share }) => [label, share]), [
      ["Claude Code", "100%"],
      ["Cursor", "\u200E<1%"],
    ]);
    assert.equal(legend(container)[1]?.value, "1");
  });
});

test("the Global scope shows the same breakdown across every project", async () => {
  observations = [
    observation("a", "claude", 50),
    observation("b", "cursor", 50, { projectId: "project-b" }),
  ];
  omitHarnesses = false;
  await withDashboard(async (container) => {
    await settle(() => !!harnessSection(container));
    const scopeTabs = container.querySelector(".usage-clean-scope-tabs")!;
    await chooseTab(scopeTabs, tr("usage.global"));
    await settle(() => requests.some((query) => !query.projectIds) && legend(container).length === 2);
    assert.equal(requests.at(-1)?.projectIds, undefined);
    assert.deepEqual(legend(container).map(({ label, share }) => [label, share]), [
      ["Claude Code", "50%"],
      ["Cursor", "50%"],
    ]);
  });
});

test("a scope with no recorded usage says so instead of drawing an empty ring", async () => {
  observations = [];
  omitHarnesses = false;
  await withDashboard(async (container) => {
    await settle(() => !!harnessSection(container));
    const section = harnessSection(container);
    assert.ok(section);
    assert.equal(text(section.querySelector(".usage-clean-empty")), tr("usage.noHarnessUsage"));
    assert.ok(!section.querySelector("svg"));
  });
});

test("a report from before the breakdown existed hides the section rather than claiming no usage", async () => {
  observations = [observation("a", "claude", 10)];
  omitHarnesses = true;
  await withDashboard(async (container) => {
    await settle(() => container.querySelectorAll(".usage-clean-section").length > 0);
    assert.ok(container.querySelectorAll(".usage-clean-section").length > 0, "the rest of the report still renders");
    assert.ok(!harnessSection(container));
  });
  omitHarnesses = false;
});
