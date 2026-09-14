import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { emptyModel } from "../../../apps/web/src/reduce.ts";

register("./tsxHooks.mjs", import.meta.url);

const {
  SessionUsageStats,
  latestContextWindow,
  sessionUsageTotals,
} = await import("../widgets/sessionUsagePlugin.tsx");

test("session usage uses native context telemetry without inventing token totals", () => {
  const model = emptyModel();
  const html = renderToStaticMarkup(createElement(SessionUsageStats, {
    model,
    contextTokens: 200_000,
    contextWindow: {
      source: "native",
      updatedAt: 1,
      usedTokens: 80_000,
      limitTokens: 200_000,
    },
    contextTelemetry: "reported",
    usageTelemetry: "unavailable",
    config: {},
  }));

  assert.match(html, /data-usage-metric="context"/);
  assert.match(html, />40%</);
  assert.match(html, /80\.0k/i);
  assert.match(html, /200\.0k/i);
  for (const metric of ["input", "output", "total"]) {
    assert.match(html, new RegExp(`data-usage-metric="${metric}"[^>]*>[\\s\\S]*?—`));
  }
});

test("canonical projection totals win over a partial event-window model", () => {
  const model = emptyModel();
  model.totals.input = 10;
  model.totals.output = 2;
  const totals = sessionUsageTotals(
    model,
    { input: 12_000, output: 3_000 },
    1.5,
    "reported",
  );
  assert.deepEqual(totals, {
    input: 12_000,
    output: 3_000,
    total: 15_000,
    cost: 1.5,
    tokensKnown: true,
    costKnown: true,
  });
});

test("latest context event is selected as the live occupancy fallback", () => {
  const first = {
    id: "e1",
    sessionId: "s",
    seq: 1,
    type: "context/updated",
    time: 10,
    data: { source: "native", updatedAt: 10, usedTokens: 10, limitTokens: 100 },
    v: 1,
  } as const;
  const second = {
    id: "e2",
    sessionId: "s",
    seq: 2,
    type: "context/updated",
    time: 20,
    data: { source: "native", updatedAt: 20, usedTokens: 40, limitTokens: 100 },
    v: 1,
  } as const;
  const latest = latestContextWindow([first, second]);
  assert.equal(latest?.usedTokens, 40);
  assert.equal(latest?.fraction, undefined);
});

test("session usage widget avoids rendering metrics without a resolved session", async () => {
  const source = await readFile(new URL("../widgets/sessionUsagePlugin.tsx", import.meta.url), "utf8");
  assert.match(source, /chooseASessionForUsage/);
  assert.match(source, /if \(!resolvedSessionId\)/);
});
