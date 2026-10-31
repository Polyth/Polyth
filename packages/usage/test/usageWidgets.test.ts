import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { JsonObject, PanelItemSize } from "@polyth/contracts";
import { buildUsageStatsReport } from "../src/analytics/aggregate.ts";
import type { UsageStatsQuery } from "../src/analytics/contracts.ts";
import { clearUsageStatsCache } from "../widgets/usage/usageStatsClient.ts";

register("./tsxHooks.mjs", import.meta.url);
const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, { window: dom, document: dom.document, sessionStorage: dom.sessionStorage, HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node });
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = globalThis.fetch;
after(async () => { globalThis.fetch = originalFetch; await dom.happyDOM.close(); });
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { USAGE_WIDGET_PLUGIN } = await import("../widgets/usagePlugin.tsx");

const identity = { serverInstanceId: "widget-test", spaceId: "widget-space" };
let fail = false;
let empty = false;
let requests: UsageStatsQuery[] = [];
const makeReport = (query: UsageStatsQuery) => buildUsageStatsReport({
  ...identity, query, now: Date.now(),
  observations: empty ? [] : [{
    id: "observation-a", timestamp: Date.now() - 60_000, projectId: "project-a", sessionId: "session-a",
    tokens: { input: 12_000, output: 1_000, reasoning: null, cacheRead: null, cacheWrite: null }, quality: "exact",
  }],
  projects: [{ id: "project-a", name: "Project A" }],
  sessions: new Map([["session-a", { id: "session-a", title: "Session A", status: "idle" }]]),
});

beforeEach(() => {
  clearUsageStatsCache();
  fail = false;
  empty = false;
  requests = [];
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/api/usage/identity")) return Response.json(identity);
    const query = JSON.parse(String(init?.body)) as UsageStatsQuery;
    requests.push(query);
    if (fail) return Response.json({ error: "Telemetry temporarily unavailable" }, { status: 503 });
    return Response.json(makeReport(query));
  };
});

async function mount(widgetId: string, initial: JsonObject = {}, projectId: string | null = "project-a", panelSize?: PanelItemSize) {
  const widget = USAGE_WIDGET_PLUGIN.widgets!.find((entry) => entry.id === widgetId)!;
  const element = document.createElement("div");
  document.body.appendChild(element);
  const root = createRoot(element);
  let config = initial;
  const render = async (next = config) => {
    config = next;
    await act(async () => root.render(createElement("div", null, widget.render({
      instanceId: widgetId, projectId, sessionId: "session-a", config, editing: false, updateConfig() {},
      ...(panelSize ? { panelSize } : {}),
    }))));
  };
  await render();
  return {
    element, render,
    remount: async () => { await act(async () => root.render(null)); await render(); },
    dispose: async () => { await act(async () => root.unmount()); element.remove(); },
  };
}

test("session-scoped usage widgets advertise when the host should omit them", () => {
  const widget = (id: string) => USAGE_WIDGET_PLUGIN.widgets!.find((entry) => entry.id === id)!;
  const at = (sessionId: string | null, config: JsonObject = {}) => ({ projectId: "project-a", sessionId, config });
  const session = widget("usage.session");
  assert.equal(session.isAvailable!(at(null)), false);
  assert.equal(session.isAvailable!(at("session-a")), true);
  const limits = widget("usage.limits");
  assert.equal(limits.isAvailable!(at(null)), false, "the default current source reads the active session");
  assert.equal(limits.isAvailable!(at("session-a")), true);
  assert.equal(limits.isAvailable!(at(null, { source: "all" })), true, "a source shared by every project needs no session");
  assert.equal(widget("usage.project").isAvailable, undefined, "project and global cards are never session-gated");
});

test("duplicated cards keep independent ranges and layouts; presentation-only changes do not fetch", async () => {
  const first = await mount("usage.project");
  const second = await mount("usage.project", { range: "90d", primary: "cost", layout: "metrics" });
  try {
    assert.equal(first.element.querySelector("[data-layout]")?.getAttribute("data-layout"), "auto");
    assert.equal(second.element.querySelector("[data-layout]")?.getAttribute("data-layout"), "metrics");
    assert.deepEqual(requests.map((query) => query.range), ["30d", "90d"]);
    assert.ok(requests.every((query) => query.projectIds?.[0] === "project-a" && !query.sessionIds));
    const before = requests.length;
    await first.render({ layout: "summary", primary: "cost", showActivity: false });
    assert.equal(requests.length, before);
    assert.equal(first.element.querySelectorAll("[data-usage-metric]").length, 3);
    assert.equal(second.element.querySelectorAll("[data-usage-metric]").length, 5);
    assert.match(first.element.textContent!, /30 days/);
    assert.match(second.element.textContent!, /90 days/);
  } finally { await first.dispose(); await second.dispose(); }
});

test("the Workspace panel's smaller size draws a glance; its larger size and every other host the full card", async () => {
  const glance = await mount("usage.project", {}, "project-a", "wide");
  try {
    assert.equal(glance.element.querySelector(".usage-widget")!.hasAttribute("data-compact"), true);
    const lead = glance.element.querySelector(".usage-widget-glance")!;
    assert.equal(lead.getAttribute("data-usage-metric"), "tokens", "the primary value leads");
    assert.equal(lead.querySelector(".usage-widget-glance-caption")!.textContent, "Tokens · 30 days", "the range moves into the caption");
    assert.deepEqual([...lead.querySelectorAll(".usage-widget-glance-values dt")].map((node) => node.textContent), ["Cost", "Cache hit"]);
    assert.ok(lead.querySelector(".usage-widget-glance-lead .usage-widget-spark"), "activity shrinks to a sparkline beside the lead");
    assert.equal(glance.element.querySelector(".usage-widget-activity, .usage-widget-ledger, .usage-widget-projects"), null);
    assert.ok(glance.element.querySelector(".usage-widget-heading")!.classList.contains("sr-only"), "the panel header already names the card");
    await glance.render({ showActivity: false });
    assert.equal(glance.element.querySelector(".usage-widget-spark"), null, "no sparkline when activity is off");
  } finally { await glance.dispose(); }

  for (const panelSize of ["large", undefined] as const) {
    const full = await mount("usage.project", {}, "project-a", panelSize);
    try {
      assert.equal(full.element.querySelector(".usage-widget")!.hasAttribute("data-compact"), false, `${panelSize ?? "canvas"} is the full card`);
      assert.equal(full.element.querySelector(".usage-widget-glance, .usage-widget-spark"), null);
      assert.ok(full.element.querySelector(".usage-widget-ledger"));
      assert.ok(full.element.querySelector(".usage-widget-activity"));
    } finally { await full.dispose(); }
  }

  const strip = await mount("usage.global", { layout: "metrics" }, "project-a", "compact");
  try {
    const row = strip.element.querySelector(".usage-widget-strip")!;
    assert.deepEqual([...row.querySelectorAll("[data-usage-metric]")].map((node) => node.getAttribute("data-usage-metric")), ["tokens", "cost", "cache", "sessions"]);
    assert.equal(strip.element.querySelector(".usage-widget-projects, .usage-widget-activity"), null);
    const heading = strip.element.querySelector(".usage-widget-heading")!;
    assert.equal(heading.classList.contains("sr-only"), false, "without a caption the range keeps its line");
    assert.match(heading.textContent!, /30 days/);
  } finally { await strip.dispose(); }
});

test("each project's share of the total sits under its row in the full card", async () => {
  const card = await mount("usage.global");
  try {
    const rows = [...card.element.querySelectorAll<HTMLElement>(".usage-widget-projects dl > div")];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.style.getPropertyValue("--usage-share"), "1", "the only project is the whole total");
  } finally { await card.dispose(); }
});

test("partial tokens remain a lower bound and unknown cost, cache, and turns do not claim zero", async () => {
  const card = await mount("usage.global", { layout: "metrics" });
  try {
    assert.match(card.element.querySelector('[data-usage-metric="tokens"] dd')!.textContent!, /^≥13/);
    for (const id of ["cost", "cache", "turns"]) {
      assert.equal(card.element.querySelector(`[data-usage-metric="${id}"] dd`)!.textContent, "—");
    }
    assert.equal(card.element.querySelectorAll(".usage-widget-projects dl > div").length, 1);
    assert.ok(card.element.querySelector(".usage-widget-bars"));
  } finally { await card.dispose(); }
});

test("a failed refresh keeps the last report and retry restores a current card", async () => {
  const card = await mount("usage.project");
  try {
    fail = true;
    await card.remount();
    assert.ok(card.element.querySelector('[data-usage-metric="tokens"]'));
    assert.match(card.element.querySelector(".usage-widget-note")!.textContent!, /last successful report/);
    fail = false;
    const retry = card.element.querySelector<HTMLButtonElement>(".usage-widget-note button")!;
    await act(async () => retry.click());
    assert.equal(card.element.querySelector(".usage-widget-note"), null);
    assert.equal(card.element.querySelector(".usage-widget")!.getAttribute("aria-busy"), "false");
  } finally { await card.dispose(); }
});

test("unavailable, empty and missing-scope cards stay distinct and missing scope never queries globally", async () => {
  const missing = await mount("usage.project", {}, null);
  try {
    assert.match(missing.element.textContent!, /No project selected/);
    assert.equal(requests.length, 0);
  } finally { await missing.dispose(); }
  fail = true;
  const unavailable = await mount("usage.global");
  try {
    assert.match(unavailable.element.textContent!, /Usage unavailable/);
    assert.match(unavailable.element.textContent!, /Telemetry temporarily unavailable/);
    assert.ok(unavailable.element.querySelector("button"));
  } finally { await unavailable.dispose(); }
  fail = false;
  empty = true;
  const noData = await mount("usage.global");
  try {
    assert.match(noData.element.textContent!, /No usage data/);
    assert.equal(noData.element.querySelector("button"), null);
    assert.equal(noData.element.querySelector("[data-usage-metric]"), null);
  } finally { await noData.dispose(); }
});
