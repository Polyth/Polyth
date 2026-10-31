import test, { after } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { ContextWindowState, ModelDescriptor, SessionEvent, SessionProjection } from "@polyth/contracts";
import { emptyModel } from "../../../apps/web/src/reduce.ts";
import { applyEvents, setModels, setSessions } from "../../../apps/web/src/store.ts";
import { latestContextWindow, sessionContextDisplay } from "../widgets/contextUsage.ts";

register("./tsxHooks.mjs", import.meta.url);
const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, { window: dom, document: dom.document, HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node });
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(JSON.stringify({ error: "No analytics fixture" }), { status: 503 });
after(async () => { globalThis.fetch = originalFetch; await dom.happyDOM.close(); });
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { USAGE_WIDGET_PLUGIN } = await import("../widgets/usagePlugin.tsx");

const ref = { providerID: "shared", modelID: "same" };
const catalog: ModelDescriptor[] = [{ ...ref, name: "Same", harnessId: "current", context: 128_000 }];
const session = (contextWindow?: ContextWindowState) => ({ model: ref, resolvedHarnessId: "current", contextWindow });

test("current native context is independent of analytics totals", () => {
  assert.deepEqual(sessionContextDisplay(emptyModel(), catalog, session({
    source: "native", updatedAt: 1, usedTokens: 32_000, limitTokens: 128_000,
  })), { value: "25%", detail: "32.0k / 128.0k", fraction: .25, level: "green" });
});

test("partial context keeps counts without an invented denominator", () => {
  assert.deepEqual(sessionContextDisplay(emptyModel(), [], session({
    source: "derived", updatedAt: 1, usedTokens: 12_000,
  })), { value: "12.0k tokens" });
});

for (const source of ["native", "derived"] as const) test(`${source} fraction-only context never claims zero tokens`, () => {
  for (const models of [[], catalog]) {
    assert.deepEqual(sessionContextDisplay(emptyModel(), models, session({
      source, updatedAt: 1, fraction: 0.72,
    })), { value: "72%", fraction: .72 });
  }
});

test("denominator-only context remains unknown", () => {
  assert.deepEqual(sessionContextDisplay(emptyModel(), catalog, session({
    source: "native", updatedAt: 1, limitTokens: 128_000,
  })), { value: "—" });
});

test("request usage never borrows another harness's denominator", () => {
  const model = emptyModel();
  model.contextUsage = { inputTokens: 32_000, cacheReadTokens: 0, cacheWriteTokens: 0, model: ref, harnessId: "current" };
  assert.deepEqual(sessionContextDisplay(model, [{ ...catalog[0]!, harnessId: "other" }], session()), {
    value: "~32.0k tokens",
  });
});

for (const stale of ["usage", "occupancy"] as const) test(`the scoped session widget preserves current context when ${stale} is stale`, async () => {
  const id = `context-${stale}`;
  setModels(catalog);
  setSessions("context-project", [{
    id, projectId: "context-project", title: id, status: "idle", createdAt: 1, updatedAt: 1,
    model: ref, resolvedHarnessId: "current",
    contextWindow: {
      source: "native", updatedAt: 2,
      usedTokens: stale === "occupancy" ? 90_000 : 32_000,
      limitTokens: stale === "occupancy" ? 200_000 : 128_000,
      harnessId: stale === "occupancy" ? "old" : "current",
    },
  } as SessionProjection]);
  applyEvents([{
    id: `${id}:usage`, sessionId: id, seq: 1, type: "usage/recorded", time: 1, v: 1,
    data: {
      model: stale === "usage" ? { ...ref, modelID: "previous" } : ref,
      tokens: { input: stale === "usage" ? 90_000 : 32_000, output: 0 },
      harnessId: stale === "usage" ? "old" : "current",
    },
  }]);
  const widget = USAGE_WIDGET_PLUGIN.widgets!.find((item) => item.id === "usage.session")!;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement("div", null, widget.render({
      sessionId: id, projectId: "context-project", instanceId: id,
      config: {}, updateConfig() {}, editing: false,
    }))));
    const html = container.innerHTML;
    const value = container.querySelector('[data-usage-metric="context"] dd')?.textContent;
    assert.equal(value, stale === "occupancy" ? "~25%" : "25%");
    assert.match(html, /32\.0k \/ 128\.0k/);
    assert.doesNotMatch(html, /90\.0k|200\.0k/);
    assert.equal(container.querySelector<HTMLElement>(".usage-widget-meter > i")?.style.inlineSize, "25%", "the meter draws the same share");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("the compacted transcript does not become a fresh visible-text estimate", () => {
  const model = emptyModel();
  model.messages.push({ kind: "user", id: "u", eventSeq: 1, text: "old text", time: 1 });
  model.contextEstimateAfterSeq = 2;
  model.contextResetAt = 2;
  assert.deepEqual(sessionContextDisplay(model, catalog, session({
    source: "native", updatedAt: 1, usedTokens: 90_000, limitTokens: 128_000,
  })), { value: "—" });
  model.messages.push({ kind: "user", id: "u2", eventSeq: 3, text: "abcd", time: 3 });
  model.version += 1;
  assert.deepEqual(sessionContextDisplay(model, catalog, session()), { value: "~0%", detail: "5 / 128.0k", fraction: 0, level: "green" });
});

test("the latest canonical context event retains its independent harness identity", () => {
  const events = [1, 2].map((seq) => ({
    id: String(seq), sessionId: "s", seq, time: seq, v: 1, type: "context/updated",
    data: { source: "native", usedTokens: seq * 10, harnessId: seq === 1 ? "old" : "current" },
  } as SessionEvent));
  const latest = latestContextWindow(events);
  assert.equal(latest?.usedTokens, 20);
  assert.equal(latest?.harnessId, "current");
  assert.equal(latest?.updatedAt, 2);
});

test("the session widget shows a live prompt-cache countdown from the loaded event tail", async () => {
  const id = "cache-countdown";
  setSessions("context-project", [{
    id, projectId: "context-project", title: id, status: "idle", createdAt: 1, updatedAt: 1,
    model: { providerID: "anthropic", modelID: "claude-sonnet" }, resolvedHarnessId: "claude",
  } as SessionProjection]);
  applyEvents([{
    id: `${id}:usage`, sessionId: id, seq: 1, type: "usage/recorded", time: Date.now() - 60_000, v: 1,
    data: { tokens: { input: 10, output: 20, cacheRead: 30_000, cacheWrite: 2_000 } },
  }]);
  const widget = USAGE_WIDGET_PLUGIN.widgets!.find((item) => item.id === "usage.session")!;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement("div", null, widget.render({
      sessionId: id, projectId: "context-project", instanceId: id,
      config: {}, updateConfig() {}, editing: false,
    }))));
    const html = container.innerHTML;
    assert.match(html, /data-usage-metric="cache-ttl"/);
    assert.match(html, /32\.0k/);
    assert.equal(container.querySelector('[data-usage-metric="cache-ttl"]')?.hasAttribute("data-tone"), false);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
