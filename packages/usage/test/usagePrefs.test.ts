// F13 quota half: model-family derivation, window grouping, and the
// localStorage-persisted usage prefs parser.
import test from "node:test";
import assert from "node:assert/strict";
import { familyLabel, groupQuotaWindows, modelFamily, moveUsageBlock, orderPinnedUsageBlocks, orderUsageBlocks, parseUsagePrefs } from "../widgets/usagePrefs.ts";

test("modelFamily recognizes vendor lines and folds sub-brands", () => {
  assert.equal(modelFamily("claude-3-5-sonnet-latest"), "claude");
  assert.equal(modelFamily("Claude Opus 4.1 (5h)"), "claude");
  assert.equal(modelFamily("sonnet-weekly"), "claude");
  assert.equal(modelFamily("gpt-4o-mini"), "gpt");
  assert.equal(modelFamily("chatgpt-4o-latest"), "gpt");
  assert.equal(modelFamily("gemini-2.5-pro"), "gemini");
  assert.equal(modelFamily("mixtral-8x22b"), "mistral");
  assert.equal(modelFamily("deepseek-r1"), "deepseek");
});

test("modelFamily handles glued versions and o-series generations", () => {
  assert.equal(modelFamily("gpt4o"), "gpt");
  assert.equal(modelFamily("claude3-haiku"), "claude");
  assert.equal(modelFamily("o3-mini"), "o3");
  assert.equal(modelFamily("o1-preview"), "o1");
  // o-series generations are distinct families
  assert.notEqual(modelFamily("o1-preview"), modelFamily("o3-mini"));
});

test("modelFamily returns null for non-model windows", () => {
  assert.equal(modelFamily("requests-day Requests (24h)"), null);
  assert.equal(modelFamily("spend-month Spend (month)"), null);
  assert.equal(modelFamily(""), null);
});

test("familyLabel casing", () => {
  assert.equal(familyLabel("claude"), "Claude");
  assert.equal(familyLabel("gpt"), "GPT");
  assert.equal(familyLabel("o3"), "o3");
});

test("groupQuotaWindows puts general first, families in appearance order", () => {
  const groups = groupQuotaWindows([
    { id: "gpt-4o-day", label: "GPT-4o (24h)" },
    { id: "requests-day", label: "Requests (24h)" },
    { id: "claude-sonnet-week", label: "Claude Sonnet (week)" },
    { id: "gpt-4o-mini-day", label: "GPT-4o mini (24h)" },
  ]);
  assert.deepEqual(groups.map((g) => g.family), [null, "gpt", "claude"]);
  assert.deepEqual(groups.map((g) => g.label), ["General", "GPT", "Claude"]);
  assert.deepEqual(groups[1]!.windows.map((w) => w.id), ["gpt-4o-day", "gpt-4o-mini-day"]);
  assert.deepEqual(groups[0]!.windows.map((w) => w.id), ["requests-day"]);
});

test("groupQuotaWindows without model windows yields a single unlabeled bucket", () => {
  const groups = groupQuotaWindows([
    { id: "requests-day", label: "Requests (24h)" },
    { id: "spend-month", label: "Spend (month)" },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.family, null);
  assert.equal(groups[0]!.windows.length, 2);
});

test("parseUsagePrefs migrates older prefs, defaults provider-first, and survives garbage", () => {
  const legacy = {
    hiddenProviders: ["anthropic"],
    hiddenBlocks: ["cache"],
    pinnedProviders: ["openai"],
    collapsedGroups: ["openai/gpt"],
    dashboard: {
      view: "providers",
      layout: "compact",
      rangeDays: 90,
      overviewOrder: ["models"],
      providerOrder: ["openai"],
    },
  };
  const parsedLegacy = parseUsagePrefs(JSON.stringify(legacy));
  assert.equal(parsedLegacy.dashboard.view, "providers");
  assert.equal(parsedLegacy.dashboard.layout, "compact");
  assert.equal(parsedLegacy.dashboard.rangeDays, 90);
  assert.equal(parsedLegacy.dashboard.rangeMode, "preset");
  assert.equal(parsedLegacy.dashboard.chartGrouping, "provider");
  assert.equal(parsedLegacy.dashboard.distributionGrouping, "model");
  assert.equal(parsedLegacy.dashboard.providerSort, "quota");
  assert.deepEqual(parsedLegacy.dashboard.cardMetrics, ["cost", "tokens", "sessions", "ttft", "tps", "cache"]);

  const defaults = parseUsagePrefs(null);
  assert.equal(defaults.dashboard.view, "providers");
  assert.equal(defaults.dashboard.layout, "compact");
  assert.equal(defaults.dashboard.rangeDays, 7);
  assert.equal(defaults.dashboard.rangeMode, "preset");
  assert.equal(defaults.dashboard.performanceStatistic, "p50");
  assert.equal(defaults.dashboard.showApiEquivalent, true);
  assert.equal(defaults.dashboard.showValueMultiplier, true);
  assert.equal(defaults.dashboard.showQuotaDetails, true);
  assert.deepEqual(defaults.modelPricing, {});
  assert.deepEqual(parseUsagePrefs("not json"), defaults);
  assert.deepEqual(
    parseUsagePrefs(JSON.stringify({
      hiddenProviders: ["a", 1, null, ""],
      collapsedGroups: "nope",
      dashboard: { view: "invalid", layout: "invalid", rangeDays: 365 },
    })),
    { ...defaults, hiddenProviders: ["a"] },
  );
});

test("parseUsagePrefs preserves the last explicit tab and sanitizes billing, budgets, and custom ranges", () => {
  assert.equal(parseUsagePrefs(JSON.stringify({ dashboard: { view: "overview" } })).dashboard.view, "overview");
  assert.equal(parseUsagePrefs(JSON.stringify({ dashboard: { view: "providers" } })).dashboard.view, "providers");

  const prefs = parseUsagePrefs(JSON.stringify({
    providerCosts: {
      openai: {
        billing: "subscription",
        monthlyCost: 20,
        monthlyBudget: 100,
        inputPerMillion: 2.5,
        outputPerMillion: 10,
      },
      anthropic: { billing: "api", monthlyCost: -4, monthlyBudget: 75.555 },
    },
    modelPricing: {
      "openai/gpt-5.6-sol": { inputPerMillion: 1.25, outputPerMillion: 7.5 },
      invalid: { inputPerMillion: -1, outputPerMillion: null },
    },
    dashboard: {
      rangeMode: "custom",
      customRange: { start: "2026-09-01", end: "2026-09-19" },
      chartGrouping: "harness",
      distributionGrouping: "project",
      providerSort: "spend",
      cardMetrics: ["tokens", "cache", "bogus"],
      performanceStatistic: "p95",
    },
  }));
  assert.deepEqual(prefs.providerCosts.openai, {
    billing: "subscription",
    monthlyCost: 20,
    monthlyBudget: 100,
    inputPerMillion: 2.5,
    outputPerMillion: 10,
  });
  assert.deepEqual(prefs.providerCosts.anthropic, {
    billing: "api",
    monthlyCost: null,
    monthlyBudget: 75.56,
    inputPerMillion: null,
    outputPerMillion: null,
  });
  assert.deepEqual(prefs.modelPricing, {
    "openai/gpt-5.6-sol": { inputPerMillion: 1.25, outputPerMillion: 7.5 },
  });
  assert.equal(prefs.dashboard.rangeMode, "custom");
  assert.deepEqual(prefs.dashboard.customRange, { start: "2026-09-01", end: "2026-09-19" });
  assert.equal(prefs.dashboard.chartGrouping, "harness");
  assert.equal(prefs.dashboard.distributionGrouping, "project");
  assert.equal(prefs.dashboard.providerSort, "spend");
  assert.deepEqual(prefs.dashboard.cardMetrics, ["tokens", "cache"]);
  assert.equal(prefs.dashboard.performanceStatistic, "p95");

  const invalidRange = parseUsagePrefs(JSON.stringify({
    dashboard: {
      rangeMode: "custom",
      customRange: { start: "2026-09-20", end: "2026-09-01" },
    },
  }));
  assert.equal(invalidRange.dashboard.rangeMode, "preset");
  assert.equal(invalidRange.dashboard.customRange, null);
});

test("pinned provider ordering stays above regular cards without losing manual order", () => {
  const items = [{ id: "anthropic" }, { id: "openai" }, { id: "google" }, { id: "summary" }];
  assert.deepEqual(
    orderPinnedUsageBlocks(items, ["google", "summary", "openai", "anthropic"], ["openai", "google"], (item) => item.id)
      .map((item) => item.id),
    ["google", "openai", "summary", "anthropic"],
  );
});

test("dashboard block ordering preserves new blocks and supports drag or keyboard moves", () => {
  const items = [{ id: "summary" }, { id: "models" }, { id: "providers" }];
  assert.deepEqual(orderUsageBlocks(items, ["models", "summary"], (item) => item.id).map((item) => item.id), ["models", "summary", "providers"]);
  assert.deepEqual(moveUsageBlock(["summary", "models", "providers"], "models", -1), ["models", "summary", "providers"]);
  assert.deepEqual(moveUsageBlock(["summary", "models", "providers"], "summary", "providers"), ["models", "providers", "summary"]);
});
