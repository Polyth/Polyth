import test from "node:test";
import assert from "node:assert/strict";
import { POLICY_MANIFEST, type PolicyManifest } from "../src/policies.ts";
import { resolveModelPrivacy } from "../src/resolvePolicy.ts";
import { privacyAnnotations } from "../widgets/presentation.ts";

const FREE = { input: 0, output: 0 };
const PAID = { input: 3, output: 15 };
const checked = Date.parse(`${POLICY_MANIFEST.checkedAt}T12:00:00Z`);

test("manifest: unique entries, known sources, https urls, ISO date", () => {
  assert.match(POLICY_MANIFEST.checkedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(!Number.isNaN(Date.parse(POLICY_MANIFEST.checkedAt)));
  const keys = POLICY_MANIFEST.entries.map((entry) => `${entry.providerID}/${entry.modelID}`);
  assert.equal(new Set(keys).size, keys.length, "duplicate entry");
  for (const source of Object.values(POLICY_MANIFEST.sources)) assert.match(source.url, /^https:\/\//);
  for (const item of [...POLICY_MANIFEST.entries, ...POLICY_MANIFEST.providers]) {
    assert.ok(POLICY_MANIFEST.sources[item.source], `unknown source ${item.source}`);
  }
  for (const rule of POLICY_MANIFEST.providers) {
    for (const modelID of rule.listed) {
      assert.ok(!keys.includes(`${rule.providerID}/${modelID}`), `${modelID} is both listed and an exception`);
    }
  }
});

test("named exceptions win over the provider default", () => {
  assert.equal(resolveModelPrivacy({ providerID: "opencode", modelID: "big-pickle", cost: FREE }, checked)?.policy, "may-improve");
  assert.equal(resolveModelPrivacy({ providerID: "opencode", modelID: "iceman-free", cost: FREE }, checked)?.policy, "retained-training");
  const flint = resolveModelPrivacy({ providerID: "opencode", modelID: "flint-40b-free", cost: FREE }, checked);
  assert.equal(flint?.retentionDays, 30);
  assert.equal(resolveModelPrivacy({ providerID: "opencode", modelID: "nemotron-3.5-lightning-free" }, checked)?.trialOnly, true);
  assert.equal(resolveModelPrivacy({ providerID: "opencode", modelID: "mimo-v2.6-flash-free", cost: FREE }, checked)?.policy, "unclear");
});

test("a free model the snapshot does not name is unverified, never assumed safe", () => {
  assert.equal(resolveModelPrivacy({ providerID: "opencode", modelID: "brand-new-free", cost: FREE }, checked)?.policy, "unverified");
  assert.equal(resolveModelPrivacy({ providerID: "opencode", modelID: "hy4-flash-free", cost: FREE }, checked)?.policy, "zero-retention");
});

test("paid routes and other providers", () => {
  assert.equal(resolveModelPrivacy({ providerID: "opencode", modelID: "claude-sonnet", cost: PAID }, checked)?.policy, "upstream-terms");
  assert.equal(resolveModelPrivacy({ providerID: "opencode", modelID: "unknown-price" }, checked), undefined);
  assert.equal(resolveModelPrivacy({ providerID: "anthropic", modelID: "claude-sonnet", cost: FREE }, checked), undefined);
});

test("an old snapshot withholds the zero-retention answer", () => {
  const later = checked + (POLICY_MANIFEST.staleAfterDays + 1) * 86_400_000;
  const resolved = resolveModelPrivacy({ providerID: "opencode", modelID: "hy4-flash-free", cost: FREE }, later);
  assert.equal(resolved?.policy, "unverified");
  assert.equal(resolved?.stale, true);
  assert.equal(resolveModelPrivacy({ providerID: "opencode", modelID: "big-pickle" }, later)?.policy, "may-improve");
});

test("a manifest entry naming a missing source answers nothing", () => {
  const broken: PolicyManifest = {
    ...POLICY_MANIFEST,
    entries: [{ providerID: "x", modelID: "y", policy: "may-improve", source: "missing" }],
  };
  assert.equal(resolveModelPrivacy({ providerID: "x", modelID: "y" }, checked, broken), undefined);
});

test("annotations: cautions are row marks; reassurance only with showAll; vendor terms never", () => {
  const prefs = { showAll: false, composerChip: true };
  const [pickle] = privacyAnnotations({ providerID: "opencode", modelID: "big-pickle", cost: FREE }, "uk", prefs, checked);
  assert.equal(pickle?.inline, true);
  assert.equal(pickle?.tone, "notice");
  assert.equal(pickle?.label, "Може використовуватись для покращення моделі");
  assert.equal(pickle?.href, "https://opencode.ai/docs/console/models/");
  const [safe] = privacyAnnotations({ providerID: "opencode", modelID: "hy4-flash-free", cost: FREE }, "en", prefs, checked);
  assert.equal(safe?.inline, false);
  const [safeAll] = privacyAnnotations({ providerID: "opencode", modelID: "hy4-flash-free", cost: FREE }, "en", { ...prefs, showAll: true }, checked);
  assert.equal(safeAll?.inline, true);
  const [paid] = privacyAnnotations({ providerID: "opencode", modelID: "gpt", cost: PAID }, "en", { ...prefs, showAll: true }, checked);
  assert.equal(paid?.inline, false);
  const [flint] = privacyAnnotations({ providerID: "opencode", modelID: "flint-40b-free", cost: FREE }, "en", prefs, checked);
  assert.match(flint?.detail ?? "", /kept for 30 days/);
});
