// Mounted render tests for the prompt-cache card line and the Cache burn block.
import test, { after, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { SessionEvent, SessionProjection } from "@polyth/contracts";
import { applyEvents, setSessions } from "../../../apps/web/src/store.ts";
import { buildUsageStatsReport } from "../src/analytics/aggregate.ts";
import { collectSessionObservations } from "../src/analytics/collect.ts";
import type { UsageObservation, UsageStatsQuery } from "../src/analytics/contracts.ts";
import { clearUsageStatsCache } from "../widgets/usage/usageStatsClient.ts";
import { cacheDuration } from "../widgets/usage/cacheWarmth.ts";
import { setLocale } from "../../../apps/web/src/i18n/index.ts";

register("./tsxHooks.mjs", import.meta.url);
const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, { window: dom, document: dom.document, sessionStorage: dom.sessionStorage, HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node });
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = globalThis.fetch;
after(async () => { globalThis.fetch = originalFetch; await dom.happyDOM.close(); });
afterEach(() => mock.timers.reset());
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { USAGE_WIDGET_PLUGIN } = await import("../widgets/usagePlugin.tsx");
const { CacheBurnBlock, TokenMix } = await import("../widgets/usage/dashboardBlocks.tsx");

const NOW = Date.UTC(2026, 9, 9, 10, 0, 0);
const MIN = 60_000;
const PROJECT = "cache-widget-project";
const anthropic = { providerID: "anthropic", modelID: "claude-sonnet-4-5" };
const openai = { providerID: "openai", modelID: "gpt-5.1-codex" };
const identity = { serverInstanceId: "cache-widget-test", spaceId: "cache-widget-space" };

type Tokens = { input: number; output: number; cacheRead?: number; cacheWrite?: number };
const sessions = new Map<string, { projection: SessionProjection; events: SessionEvent[] }>();

function seed(id: string, model: typeof anthropic, usage: Array<[number, Tokens]>, status: SessionProjection["status"] = "idle") {
  const projection = {
    id, projectId: PROJECT, title: id, status, createdAt: 1, updatedAt: 1, model, resolvedHarnessId: "claude",
  } as SessionProjection;
  const events = usage.map(([offset, tokens], index) => ({
    id: `${id}:u${index}`, sessionId: id, seq: index + 1, type: "usage/recorded", time: NOW + offset, v: 1,
    data: { model, tokens },
  } as SessionEvent));
  sessions.set(id, { projection, events });
}
seed("warm", anthropic, [[-MIN, { input: 10, output: 20, cacheRead: 30_000, cacheWrite: 2_000 }]]);
seed("expiring", anthropic, [[-260_000, { input: 10, output: 20, cacheRead: 64_000, cacheWrite: 4_000 }]]);
seed("expired", anthropic, [
  [-30 * MIN, { input: 10, output: 20, cacheRead: 0, cacheWrite: 150_000 }],
  [-20 * MIN, { input: 10, output: 20, cacheRead: 10_000, cacheWrite: 160_000 }],
  [-12 * MIN, { input: 10, output: 20, cacheRead: 170_000, cacheWrite: 12_000 }],
]);
seed("reads-only", openai, [[-3 * MIN, { input: 61_000, output: 3_100, cacheRead: 48_000 }]]);
seed("working", anthropic, [[-30_000, { input: 10, output: 20, cacheRead: 40_000, cacheWrite: 2_000 }]], "working");
setSessions(PROJECT, [...sessions.values()].map((entry) => entry.projection));
applyEvents([...sessions.values()].flatMap((entry) => entry.events));

globalThis.fetch = async (input, init) => {
  if (String(input).endsWith("/api/usage/identity")) return Response.json(identity);
  const query = JSON.parse(String(init?.body)) as UsageStatsQuery;
  const ids = query.sessionIds ?? [...sessions.keys()];
  const observations = ids.flatMap((id) => {
    const entry = sessions.get(id);
    return entry ? collectSessionObservations(entry.projection, entry.events) : [];
  });
  return Response.json(buildUsageStatsReport({
    ...identity, query, now: NOW, observations,
    projects: [{ id: PROJECT, name: "Project" }],
    sessions: new Map(ids.map((id) => [id, { id, title: id, status: sessions.get(id)?.projection.status ?? "idle" }])),
  }));
};

async function flush() {
  for (let index = 0; index < 5; index += 1) await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

async function mountCard(sessionId: string, widgetId = "usage.session", panelSize?: "compact" | "standard") {
  clearUsageStatsCache();
  const widget = USAGE_WIDGET_PLUGIN.widgets!.find((entry) => entry.id === widgetId)!;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(widget.render({
    sessionId, projectId: PROJECT, instanceId: sessionId, config: {}, updateConfig() {}, editing: false,
    ...(panelSize ? { panelSize } : {}),
  })));
  await flush();
  return {
    container,
    metric: (id: string) => container.querySelector<HTMLElement>(`[data-usage-metric="${id}"]`),
    dispose: async () => { await act(async () => root.unmount()); container.remove(); },
  };
}

/** A ledger value as label, value and detail; the value's digits and unit are separate nodes. */
const parts = (element: Element | null | undefined): string[] => element
  ? [element.querySelector("dt"), element.querySelector("dd"), element.querySelector("small")].map((node) => node?.textContent ?? "")
  : [];

/** Visible words with a space between elements, as a reader hears them. */
const text = (element: Node | null | undefined): string => {
  if (!element) return "";
  const parts: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === 3) parts.push(node.textContent ?? "");
    else node.childNodes.forEach(walk);
  };
  walk(element);
  return parts.map((part) => part.trim()).filter(Boolean).join(" ").replace(/\s+/g, " ");
};

test("cache spans drop zero parts and round a countdown up to whole minutes", () => {
  assert.equal(cacheDuration(5 * MIN), "5 min");
  assert.equal(cacheDuration(60 * MIN), "1 hr");
  assert.equal(cacheDuration(65 * MIN), "1 hr 5 min");
  assert.equal(cacheDuration(100_000), "1 min 40 sec");
  assert.equal(cacheDuration(40_000), "40 sec");
  assert.equal(cacheDuration(3 * MIN + 10_000, true), "4 min");
  assert.equal(cacheDuration(3 * MIN + 10_000), "3 min");
});

test("a warm cache shows time left right after context, without a tone", async () => {
  mock.timers.enable({ apis: ["Date"], now: NOW });
  const card = await mountCard("warm");
  try {
    const metric = card.metric("cache-ttl");
    assert.ok(metric);
    assert.equal(metric.hasAttribute("data-tone"), false);
    assert.equal(text(metric), "Prompt cache 4 min left", "the chip beside the hero holds the countdown alone");
    assert.equal(metric.getAttribute("data-state"), "warm");
    assert.equal(metric.querySelector("circle + circle")?.getAttribute("stroke-dasharray"), "80 100", "the ring shows the lifetime left");
    assert.deepEqual(parts(card.metric("cached")), ["Cached", "32.0k", "5 min lifetime (provider default)"], "the Cache group says what it protects");
    const order = [...card.container.querySelectorAll("[data-usage-metric]")].map((item) => item.getAttribute("data-usage-metric"));
    assert.deepEqual(order.slice(0, 3), ["context", "cache-ttl", "tokens"]);
    // The rest of the card is a ledger: quiet headings over short rows.
    assert.deepEqual([...card.container.querySelectorAll(".usage-widget-group > h4")].map(text), ["Spend", "Cache"]);
    assert.deepEqual(
      [...card.container.querySelectorAll(".usage-widget-group")].map((group) =>
        [...group.querySelectorAll("[data-usage-metric]")].map((item) => item.getAttribute("data-usage-metric"))),
      [["tokens", "cost"], ["cache", "cached", "cache-burn"]],
    );
  } finally {
    await card.dispose();
  }
});

test("the compact session glance keeps context, the cache chip and spend on two lines", async () => {
  mock.timers.enable({ apis: ["Date"], now: NOW });
  const card = await mountCard("expired", "usage.session", "compact");
  try {
    const lead = card.container.querySelector(".usage-widget-glance")!;
    assert.equal(lead.getAttribute("data-usage-metric"), "context");
    const chip = lead.querySelector(".usage-widget-glance-lead .usage-widget-chip")!;
    assert.equal(chip.getAttribute("data-tone"), "critical", "the chip keeps its state beside the lead");
    assert.equal(text(chip), "Prompt cache Expired");
    assert.deepEqual([...lead.querySelectorAll(".usage-widget-glance-values dt")].map(text), ["Tokens", "Cost"]);
    assert.equal(card.container.querySelector(".usage-widget-group, .usage-widget-ledger"), null, "groups stay in the full card");
    assert.equal(card.metric("cache-burn"), null);
  } finally {
    await card.dispose();
  }
  const full = await mountCard("expired", "usage.session", "standard");
  try {
    assert.equal(full.container.querySelector(".usage-widget-glance"), null);
    assert.ok(full.metric("cache-burn"), "the standard size is the full ledger");
  } finally {
    await full.dispose();
  }
});

test("the countdown ticks every second near expiry, turns amber, then red with the re-write size", async () => {
  mock.timers.enable({ apis: ["Date", "setTimeout"], now: NOW });
  const card = await mountCard("expiring");
  try {
    assert.equal(card.metric("cache-ttl")?.getAttribute("data-tone"), "warning");
    assert.match(text(card.metric("cache-ttl")), /40 sec left/);
    await act(async () => { mock.timers.tick(1_000); });
    assert.match(text(card.metric("cache-ttl")), /39 sec left/);
    for (let second = 0; second < 40; second += 1) await act(async () => { mock.timers.tick(1_000); });
    const metric = card.metric("cache-ttl");
    assert.equal(metric?.getAttribute("data-tone"), "critical");
    assert.equal(text(metric), "Prompt cache Expired");
    assert.equal(metric?.querySelector("svg"), null, "an expired cache has no countdown ring");
    assert.deepEqual(parts(card.metric("cached")), ["Cached", "68.0k", "Re-written next turn"]);
  } finally {
    await card.dispose();
  }
});

test("an expired cache is red and the card reports the burn behind it", async () => {
  mock.timers.enable({ apis: ["Date"], now: NOW });
  const card = await mountCard("expired");
  try {
    assert.equal(card.metric("cache-ttl")?.getAttribute("data-tone"), "critical");
    assert.equal(text(card.metric("cache-ttl")), "Prompt cache Expired");
    assert.deepEqual(parts(card.metric("cached")), ["Cached", "182.0k", "Re-written next turn"]);
    assert.match(card.metric("cache-ttl")?.getAttribute("title") ?? "", /Next turn re-writes ~182\.0k/);
    assert.deepEqual(parts(card.metric("cache-burn")), ["Cache burn", "140.0k", "Re-writes after expiry: 1"]);
  } finally {
    await card.dispose();
  }
});

test("an unknown lifetime only reports idle time and reads-only telemetry has no burn", async () => {
  mock.timers.enable({ apis: ["Date"], now: NOW });
  const card = await mountCard("reads-only");
  try {
    const metric = card.metric("cache-ttl");
    assert.equal(metric?.hasAttribute("data-tone"), false);
    assert.equal(text(metric), "Prompt cache Idle 3 min");
    assert.deepEqual(parts(card.metric("cached")), ["Cached", "48.0k", "Lifetime not reported"]);
    assert.equal(card.metric("cache-burn"), null);
  } finally {
    await card.dispose();
  }
});

test("a working session pauses the countdown", async () => {
  mock.timers.enable({ apis: ["Date"], now: NOW });
  const card = await mountCard("working");
  try {
    assert.match(text(card.metric("cache-ttl")), /In use/);
    assert.equal(card.metric("cache-ttl")?.hasAttribute("data-tone"), false);
  } finally {
    await card.dispose();
  }
});

/** Give a happy-dom element the scroll geometry it cannot lay out, then scroll it. */
async function scrollTo(element: HTMLElement, top: number, height = 600, client = 272) {
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: height });
  Object.defineProperty(element, "clientHeight", { configurable: true, value: client });
  Object.defineProperty(element, "scrollTop", { configurable: true, value: top });
  await act(async () => { element.dispatchEvent(new dom.Event("scroll") as unknown as Event); });
}

test("the card fades a clipped tail and clears the fade at the end", async () => {
  mock.timers.enable({ apis: ["Date"], now: NOW });
  const card = await mountCard("expired");
  try {
    const scroller = card.container.querySelector<HTMLElement>(".usage-widget-scroll")!;
    assert.equal(scroller.getAttribute("role"), "region");
    await scrollTo(scroller, 0);
    assert.equal(scroller.getAttribute("data-more"), "true");
    await scrollTo(scroller, 600 - 272);
    assert.equal(scroller.hasAttribute("data-more"), false);
  } finally {
    await card.dispose();
  }
});

test("unreported turn telemetry is left out of the card; unknown cache hit keeps its dash", async () => {
  mock.timers.enable({ apis: ["Date"], now: NOW });
  const card = await mountCard("warm");
  try {
    for (const id of ["response", "whole-turn", "ttft", "steps"]) assert.equal(card.metric(id), null, id);
    assert.ok(card.metric("cache"));
  } finally {
    await card.dispose();
  }
});

test("the session card has no trend plot: an all-time session chart is one month bucket", async () => {
  mock.timers.enable({ apis: ["Date"], now: NOW });
  const card = await mountCard("expired");
  try {
    assert.equal(card.container.querySelector(".usage-widget-activity"), null);
    assert.equal(card.container.querySelector(".usage-widget-bars"), null);
    // The metrics that made the card useful are still there.
    assert.ok(card.metric("tokens"));
    assert.ok(card.metric("cache-burn"));
  } finally {
    await card.dispose();
  }
});

test("activity axis labels follow the host locale, not the server's en-US labels", async () => {
  mock.timers.enable({ apis: ["Date"], now: NOW });
  await setLocale("uk");
  // The plot lives on the scopes that span buckets; the session card has none.
  const card = await mountCard("expired", "usage.project");
  try {
    const axis = text(card.container.querySelector(".usage-widget-axis"));
    assert.ok(axis.length > 0);
    assert.doesNotMatch(axis, /Oct/);
    assert.match(axis, /жовт/);
    assert.doesNotMatch(card.container.querySelector(".usage-widget-bars li")?.getAttribute("title") ?? "", /Oct/);
  } finally {
    await card.dispose();
    await setLocale("en");
  }
});

// ---- Cache burn block -------------------------------------------------------

const LONG_MODEL = "claude-opus-4-5-20251101-extended-thinking-preview";
function burnReport(kind: "burn" | "zero" | "reads") {
  const observations: UsageObservation[] = [];
  const models = [LONG_MODEL, "claude-sonnet-4-5", "claude-haiku-4-5"];
  for (let index = 0; index < 6; index += 1) {
    const sessionId = `burn-${kind}-${index}`;
    const modelId = models[index % models.length]!;
    const prefix = 20_000 + index * 10_000;
    const base = NOW - (index + 1) * 3 * 60 * MIN;
    const gaps = kind === "burn" ? [0, 2 * MIN, 15 * MIN] : [0, 2 * MIN, 3 * MIN];
    let time = base;
    gaps.forEach((gap, step) => {
      time += gap;
      const cold = kind === "burn" && step === 2 && index % 2 === 0;
      observations.push({
        id: `${sessionId}:${step}`, timestamp: time, projectId: index < 3 ? "alpha" : "beta", sessionId, turnId: `${sessionId}:t${step}`,
        providerId: kind === "reads" ? "openai" : "anthropic", modelId, harnessId: index % 2 ? "claude" : "opencode",
        tokens: kind === "reads"
          ? { input: prefix, output: 100, reasoning: null, cacheRead: step ? prefix / 2 : 0, cacheWrite: null }
          : { input: 100, output: 100, reasoning: null, cacheRead: step === 0 || cold ? 0 : prefix, cacheWrite: step === 0 || cold ? prefix : 500 },
        quality: "exact",
      });
    });
  }
  return buildUsageStatsReport({
    ...identity, query: { range: "30d", timezone: "UTC", detailLimit: 50, detailSort: "activity" }, now: NOW, observations,
    projects: [{ id: "alpha", name: "Alpha" }, { id: "beta", name: "Beta" }],
    sessions: new Map(observations.map((item) => [item.sessionId, { id: item.sessionId, title: item.sessionId, status: "idle" as const }])),
  });
}

async function mountBlock(element: ReturnType<typeof createElement>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  return { container, dispose: async () => { await act(async () => root.unmount()); container.remove(); } };
}

const rowNames = (container: Element) =>
  [...container.querySelectorAll('[data-kind="burn"] .usage-clean-row:not(.usage-clean-list-head) .usage-clean-row-main > strong')].map(text);

test("the burn block lists only burned groups, largest first, and switches dimension", async () => {
  const report = burnReport("burn");
  assert.ok(report.totals.cacheBurn && report.totals.cacheBurn.rewrites === 3);
  const block = await mountBlock(createElement(CacheBurnBlock, { report, scope: "global" }));
  try {
    const tabs = [...block.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    assert.deepEqual(tabs.map(text), ["Models", "Projects", "Harnesses", "Sessions"]);
    assert.match(text(block.container.querySelector(".usage-clean-burn-total")), /re-written after expiry \(3×\)/);
    // Sessions 0, 2 and 4 burned: one per model.
    const models = rowNames(block.container);
    assert.deepEqual(new Set(models), new Set([LONG_MODEL, "claude-haiku-4-5", "claude-sonnet-4-5"]));
    const values = [...block.container.querySelectorAll('[data-kind="burn"] .usage-clean-row:not(.usage-clean-list-head)')]
      .map((row) => Number.parseFloat(text(row.querySelector(".usage-clean-cell"))?.replace(/^.*: /, "")));
    assert.deepEqual(values, [...values].sort((a, b) => b - a));
    assert.equal(block.container.querySelector('[data-kind="burn"] strong')?.getAttribute("dir"), "auto");
    await act(async () => tabs[1]!.click());
    assert.deepEqual(new Set(rowNames(block.container)), new Set(["Alpha", "Beta"]));
    await act(async () => tabs[3]!.click());
    assert.equal(rowNames(block.container).length, 3);
  } finally {
    await block.dispose();
  }
});

test("zero burn and reads-only telemetry are stated, never drawn as rows", async () => {
  const zero = await mountBlock(createElement(CacheBurnBlock, { report: burnReport("zero"), scope: "project" }));
  const reads = await mountBlock(createElement(CacheBurnBlock, { report: burnReport("reads"), scope: "global" }));
  try {
    assert.match(text(zero.container), /No cache re-written after expiry/);
    assert.equal(zero.container.querySelector('[role="tab"]'), null);
    assert.equal(zero.container.querySelector('[data-kind="burn"]'), null);
    assert.match(text(reads.container), /No cache-write data has been recorded for this scope yet\./);
    assert.equal(reads.container.querySelector('[data-kind="burn"]'), null);
  } finally {
    await zero.dispose();
    await reads.dispose();
  }
});

test("session scope breaks burn down by turn without tabs; Token mix carries the total", async () => {
  const report = burnReport("burn");
  const block = await mountBlock(createElement(CacheBurnBlock, { report, scope: "session" }));
  const mix = await mountBlock(createElement(TokenMix, { metrics: report.totals, description: "mix" }));
  try {
    assert.equal(block.container.querySelector('[role="tab"]'), null);
    assert.equal(rowNames(block.container).length, 3);
    assert.match(text(block.container.querySelector(".usage-clean-list-head")), /Turns/);
    assert.equal(mix.container.querySelector("[data-usage-cache-burn]")?.getAttribute("data-usage-cache-burn"), "burned");
  } finally {
    await block.dispose();
    await mix.dispose();
  }
});
