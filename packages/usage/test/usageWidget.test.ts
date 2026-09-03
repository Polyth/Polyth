import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { emptyModel } from "../../../apps/web/src/reduce.ts";

register("./tsxHooks.mjs", import.meta.url);

const { SessionUsageStats } = await import("../widgets/usagePlugin.tsx");

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
