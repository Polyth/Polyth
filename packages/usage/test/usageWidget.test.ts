import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { QuotaSnapshotDto } from "@polyth/session/web-api";
import { emptyModel } from "../../../apps/web/src/reduce.ts";

register("./tsxHooks.mjs", import.meta.url);

const { SessionUsageStats } = await import("../widgets/usagePlugin.tsx");
const { formatQuotaReset } = await import("../widgets/usage/UsageDashboard.tsx");
const { visibleQuotaSnapshots } = await import("../widgets/usage/quotaUi.tsx");

test("quota reset labels interpolate the formatted reset time", () => {
  const label = formatQuotaReset(Date.UTC(2027, 0, 1));
  assert.match(label, /^Resets /);
  assert.doesNotMatch(label, /\{value\}/);
});

test("session usage renderer shows context percentage and all default metrics", () => {
  const model = emptyModel();
  model.totals = {
    input: 1_000,
    output: 250,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 1.25,
  };
  // Context % tracks the latest request's live footprint, not lifetime totals.
  model.contextUsage = { inputTokens: 800, cacheReadTokens: 200, cacheWriteTokens: 0 };
  const html = renderToStaticMarkup(createElement(SessionUsageStats, {
    model,
    contextTokens: 1_000,
    config: {},
  }));

  assert.match(html, /data-usage-metric="context"/);
  assert.match(html, />100%</);
  for (const metric of ["input", "output", "total", "cost"]) {
    assert.match(html, new RegExp(`data-usage-metric="${metric}"`));
  }
});

test("session usage renderer honors per-instance metric visibility", () => {
  const model = emptyModel();
  model.totals.input = 900;
  model.totals.output = 100;
  model.totals.cost = 2;
  model.contextUsage = { inputTokens: 900, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const html = renderToStaticMarkup(createElement(SessionUsageStats, {
    model,
    contextTokens: 2_000,
    config: {
      showContext: true,
      showCost: true,
      showInput: false,
      showOutput: false,
      showTotal: false,
    },
  }));

  assert.match(html, />45%</);
  assert.match(html, /data-usage-metric="cost"/);
  assert.doesNotMatch(html, /data-usage-metric="input"/);
  assert.doesNotMatch(html, /data-usage-metric="output"/);
  assert.doesNotMatch(html, /data-usage-metric="total"/);
});

const quotaSnapshot = (providerId: string): QuotaSnapshotDto => ({
  providerId,
  windows: [],
  fetchedAt: 0,
  stale: false,
  pace: {},
});

// Regression: the dashboard provider card hides by canonical provider id
// (claude → anthropic) while quota snapshots use the raw id (claude).
test("quota widgets hide providers by canonical key so a dashboard hide reaches them", () => {
  const snapshots = [quotaSnapshot("claude"), quotaSnapshot("codex"), quotaSnapshot("openrouter")];
  assert.deepEqual(
    visibleQuotaSnapshots(snapshots, ["anthropic", "openai"]).map((snapshot) => snapshot.providerId),
    ["openrouter"],
  );
  assert.deepEqual(
    visibleQuotaSnapshots(snapshots, ["claude"]).map((snapshot) => snapshot.providerId),
    ["codex", "openrouter"],
  );
  assert.deepEqual(
    visibleQuotaSnapshots(snapshots, []).map((snapshot) => snapshot.providerId),
    ["claude", "codex", "openrouter"],
  );
});
