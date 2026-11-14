import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_POLICY, type ModelOption } from "../src/contracts.ts";
import { en } from "../src/i18n/en.ts";
import { orchestrationLocales } from "../src/i18n/index.ts";
import {
  customRoleId, formatContext, formatSpan, groupModels, meterTone, moveItem, percent, policiesEqual, policyOf, removeItem, slugify,
  skippedReasons, statusText, statusTone, withQuotaCeiling,
} from "../widgets/helpers.ts";
import { orchestrationTour } from "../widgets/tour.ts";

const t = (key: string, values: Record<string, string | number> = {}) =>
  `${key}${Object.keys(values).length ? JSON.stringify(values) : ""}`;

test("policiesEqual ignores bookkeeping and detects every editable field", () => {
  const a = policyOf({ ...DEFAULT_POLICY, revision: "r1", updatedAt: 5 });
  const b = policyOf(DEFAULT_POLICY);
  assert.ok(policiesEqual(a, b));
  assert.ok(!policiesEqual(a, { ...b, mode: "roles" }));
  assert.ok(!policiesEqual(a, { ...b, excluded: ["x::p/m"] }));
  const withModel = policyOf(DEFAULT_POLICY);
  withModel.roles[0]!.models.push({ harnessId: "h", providerID: "p", modelID: "m" });
  assert.ok(!policiesEqual(withModel, b));
  const limited = policyOf(withModel);
  limited.roles[0]!.models[0]!.maxConcurrent = 2;
  assert.ok(!policiesEqual(limited, withModel));
  assert.ok(policiesEqual(withModel, policyOf(withModel)));
});

test("policyOf deep-copies so edits never leak into the saved copy", () => {
  const copy = policyOf(DEFAULT_POLICY);
  copy.roles[0]!.models.push({ harnessId: "h", providerID: "p", modelID: "m" });
  copy.excluded.push("k");
  assert.equal(DEFAULT_POLICY.roles[0]!.models.length, 0);
  assert.equal(DEFAULT_POLICY.excluded.length, 0);
});

test("moveItem clamps and removeItem drops one entry", () => {
  assert.deepEqual(moveItem([1, 2, 3], 0, 1), [2, 1, 3]);
  assert.deepEqual(moveItem([1, 2, 3], 2, 0), [3, 1, 2]);
  assert.deepEqual(moveItem([1, 2, 3], 0, -4), [1, 2, 3]);
  assert.deepEqual(moveItem([1, 2, 3], 1, 9), [1, 3, 2]);
  assert.deepEqual(moveItem([1, 2, 3], 7, 0), [1, 2, 3]);
  assert.deepEqual(removeItem([1, 2, 3], 1), [1, 3]);
});

test("custom role ids are slugs with collision suffixes", () => {
  assert.equal(slugify("  Translations & QA! "), "translations-qa");
  assert.equal(slugify("Ünï Cödé"), "uni-code");
  assert.equal(slugify("Нова роль"), "");
  assert.ok(slugify("a".repeat(60)).length <= 32);
  assert.equal(customRoleId("Docs", []), "custom-docs");
  assert.equal(customRoleId("Docs", ["custom-docs"]), "custom-docs-2");
  assert.equal(customRoleId("Docs", ["custom-docs", "custom-docs-2"]), "custom-docs-3");
  assert.equal(customRoleId("Нова роль", []), "custom-role");
});

test("lowering the quota threshold pulls the over-pace level down with it", () => {
  const base = { ...policyOf(DEFAULT_POLICY), quotaCeiling: 90, overPaceCeiling: 80 };
  assert.equal(withQuotaCeiling(base, 60).overPaceCeiling, 60);
  assert.equal(withQuotaCeiling(base, 95).overPaceCeiling, 80);
  assert.equal(withQuotaCeiling({ ...base, overPaceCeiling: null }, 60).overPaceCeiling, null);
  assert.equal(withQuotaCeiling(base, 10).quotaCeiling, 50);
});

test("status vocabulary: tone, text and numbers", () => {
  assert.equal(statusTone("ready"), "success");
  assert.equal(statusTone("blocked"), "danger");
  assert.equal(statusTone("ceiling"), "warning");
  assert.equal(statusTone("over-pace"), "warning");
  assert.equal(statusTone("unavailable"), "neutral");
  assert.equal(statusText({ status: "ceiling", quotaUsed: 0.93 }, 85, 0, t), 'orchestration.status.ceiling{"used":93,"limit":85}');
  assert.equal(statusText({ status: "blocked", blockedUntil: 7_200_000 }, 85, 0, t), 'orchestration.status.blocked{"time":"orchestration.time.hours{\\"count\\":2}"}');
  assert.equal(statusText({ status: "blocked" }, 85, 0, t), "orchestration.status.blockedNoTime");
  assert.equal(statusText({ status: "unlisted" }, 85, 0, t), "orchestration.status.unlisted");
});

test("meter tone and percent", () => {
  assert.equal(meterTone(0.5, 85), "neutral");
  assert.equal(meterTone(0.85, 85), "warning");
  assert.equal(meterTone(0.5, 85, true), "danger");
  assert.equal(meterTone(1, 85), "danger");
  assert.equal(meterTone(undefined, 85), "neutral");
  assert.equal(percent(0.934), 93);
  assert.equal(percent(undefined), undefined);
  assert.equal(percent(7), 100);
  assert.equal(formatSpan(30 * 60_000, t), 'orchestration.time.minutes{"count":30}');
  assert.equal(formatSpan(3 * 3_600_000, t), 'orchestration.time.hours{"count":3}');
  assert.equal(formatSpan(5 * 86_400_000, t), 'orchestration.time.days{"count":5}');
});

const model = (over: Partial<ModelOption> & { key: string; name: string }): ModelOption => ({
  harnessId: "claude", providerID: "anthropic", modelID: over.key, favorite: false, turns: 0, vision: false, tier: "balanced", available: true, ...over,
});

test("picker groups: starred in the person's order, then used, then harnesses, one group each", () => {
  const models = [
    model({ key: "a", name: "Alpha" }),
    model({ key: "b", name: "Beta", favorite: true, favoriteIndex: 1 }),
    model({ key: "c", name: "Gamma", favorite: true, favoriteIndex: 0, harnessId: "pi" }),
    model({ key: "d", name: "Delta", turns: 3 }),
    model({ key: "e", name: "Eps", harnessId: "pi" }),
  ];
  const groups = groupModels(models, "", (id) => id.toUpperCase(), { starred: "S", recent: "R" });
  assert.deepEqual(groups.map((g) => [g.id, g.models.map((m) => m.key)]), [
    ["starred", ["c", "b"]],
    ["recent", ["d"]],
    ["harness:claude", ["a"]],
    ["harness:pi", ["e"]],
  ]);
  const found = groupModels(models, "gam", (id) => id, { starred: "S", recent: "R" });
  assert.deepEqual(found.flatMap((g) => g.models.map((m) => m.key)), ["c"]);
  assert.deepEqual(groupModels(models, "pi::", (id) => id, { starred: "S", recent: "R" }).length, 0);
});

test("every locale carries exactly the English keys with the same placeholders", () => {
  const keys = Object.keys(en).sort();
  const holes = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
  for (const [locale, messages] of Object.entries(orchestrationLocales)) {
    assert.deepEqual(Object.keys(messages).sort(), keys, locale);
    for (const key of keys) {
      const text = (messages as Record<string, string>)[key]!;
      assert.ok(text.trim().length > 0, `${locale} ${key} is empty`);
      assert.equal(holes(text), holes((en as Record<string, string>)[key]!), `${locale} ${key} placeholders`);
    }
  }
});

test("the tour highlights the exact visible labels and opens on the branches pattern", () => {
  const tour = orchestrationTour((key) => (en as Record<string, string>)[key] ?? key);
  assert.equal(tour.packageId, "orchestration");
  assert.deepEqual(tour.steps.map((s) => s.highlight), [
    undefined, "How to choose", "Now", "Roles", "Fill from my models", "Quota threshold", "Never delegate to", "What the agent sees",
  ]);
  assert.deepEqual(tour.steps[0]!.media, { kind: "pattern", pattern: "branches" });
  assert.ok(tour.steps.every((s) => s.highlightWhere === "settings" && s.title && s.body));
});

test("a freshly loaded state is clean: policyOf(saved) equals what the page drafts from it", () => {
  const stored = {
    ...DEFAULT_POLICY,
    mode: "roles" as const,
    revision: "abc",
    updatedAt: 9,
    roles: [
      { id: "explore", enabled: true, models: [{ harnessId: "h", providerID: "p", modelID: "m", maxConcurrent: undefined }] },
      ...DEFAULT_POLICY.roles.slice(1),
      { id: "custom-docs", label: "Docs", when: "", enabled: false, models: [] },
    ],
  };
  const loaded = JSON.parse(JSON.stringify(stored));
  const draft = policyOf(loaded);
  assert.ok(policiesEqual(draft, policyOf(stored)));
  assert.ok(policiesEqual(policyOf(draft), draft));
  // An absent maxConcurrent is not a pending change, but 0/a number is.
  const withLimit = policyOf(draft);
  withLimit.roles[0]!.models[0]!.maxConcurrent = 1;
  assert.ok(!policiesEqual(withLimit, draft));
});

test("context sizes read 128K, 1M and 1.5M", () => {
  assert.equal(formatContext(128_000), "128K");
  assert.equal(formatContext(200_000), "200K");
  assert.equal(formatContext(1_000_000), "1M");
  assert.equal(formatContext(1_048_576), "1M");
  assert.equal(formatContext(1_500_000), "1.5M");
  assert.equal(formatContext(2_000_000), "2M");
});

test("an unusable role explains its first two skipped models", () => {
  const text = skippedReasons([
    { name: "Opus", status: "excluded" },
    { name: "Grok", status: "unavailable" },
    { name: "Third", status: "blocked" },
  ], 85, 0, t);
  assert.equal(text, "Opus — orchestration.status.excluded · Grok — orchestration.status.unavailable");
});
