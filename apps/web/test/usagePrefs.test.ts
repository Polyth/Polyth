// F13 quota half: model-family derivation, window grouping, and the
// localStorage-persisted usage prefs parser.
import test from "node:test";
import assert from "node:assert/strict";
import { familyLabel, groupQuotaWindows, modelFamily, parseUsagePrefs } from "../src/usagePrefs.ts";

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

test("parseUsagePrefs round-trips and survives garbage", () => {
  const prefs = {
    hiddenProviders: ["anthropic"],
    collapsedGroups: ["openai/gpt"],
    dashboard: { view: "providers", layout: "compact", rangeDays: 90 },
  };
  assert.deepEqual(parseUsagePrefs(JSON.stringify(prefs)), prefs);
  const defaults = {
    hiddenProviders: [],
    collapsedGroups: [],
    dashboard: { view: "overview", layout: "expanded", rangeDays: 7 },
  };
  assert.deepEqual(parseUsagePrefs(null), defaults);
  assert.deepEqual(parseUsagePrefs("not json"), defaults);
  // non-string entries are dropped
  assert.deepEqual(
    parseUsagePrefs(JSON.stringify({
      hiddenProviders: ["a", 1, null, ""],
      collapsedGroups: "nope",
      dashboard: { view: "invalid", layout: "invalid", rangeDays: 365 },
    })),
    { ...defaults, hiddenProviders: ["a"] },
  );
});
