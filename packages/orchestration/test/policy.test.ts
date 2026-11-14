import assert from "node:assert/strict";
import { test } from "node:test";
import { BUILTIN_ROLE_IDS, DEFAULT_POLICY } from "../src/contracts.ts";
import { normalizeStoredPolicy, parsePolicy, policyRevision } from "../src/policy.ts";

const throwsInvalid = (input: unknown, pattern: RegExp) =>
  assert.throws(() => parsePolicy(input), (error: Error & { code?: string }) => error.code === "invalid-input" && pattern.test(error.message));

const base = () => JSON.parse(JSON.stringify(DEFAULT_POLICY));
const choice = { harnessId: "claude", providerID: "anthropic", modelID: "sonnet" };

test("the default parses to itself with the six built-in roles in order", () => {
  const parsed = parsePolicy(base());
  assert.deepEqual(parsed, DEFAULT_POLICY);
  assert.deepEqual(parsed.roles.map((r) => r.id), [...BUILTIN_ROLE_IDS]);
  assert.deepEqual(parsePolicy({ mode: "roles", whenExhausted: "direct", quotaCeiling: 85, maxChildren: 3, overPaceCeiling: null }).roles.length, 6);
});

test("strict parsing names the first problem", () => {
  throwsInvalid({ ...base(), mode: "x" }, /mode/);
  throwsInvalid({ ...base(), whenExhausted: "x" }, /whenExhausted/);
  throwsInvalid({ ...base(), quotaCeiling: 49 }, /quotaCeiling/);
  throwsInvalid({ ...base(), quotaCeiling: 90, overPaceCeiling: 91 }, /overPaceCeiling/);
  throwsInvalid({ ...base(), maxChildren: 7 }, /maxChildren/);
  throwsInvalid({ ...base(), excluded: ["nonsense"] }, /excluded/);
  throwsInvalid({ ...base(), roles: [{ id: "explore", models: [{ ...choice, harnessId: "a::b" }] }] }, /harnessId/);
  throwsInvalid({ ...base(), roles: [{ id: "explore", models: [{ ...choice, providerID: "a/b" }] }] }, /providerID/);
  throwsInvalid({ ...base(), roles: [{ id: "explore", models: [choice, choice] }] }, /twice/);
  throwsInvalid({ ...base(), roles: [{ id: "explore", models: [{ ...choice, maxConcurrent: 9 }] }] }, /maxConcurrent/);
  throwsInvalid({ ...base(), roles: [{ id: "explore", models: Array.from({ length: 6 }, (_, i) => ({ ...choice, modelID: `m${i}` })) }] }, /at most 5/);
  throwsInvalid({ ...base(), roles: [{ id: "bogus" }] }, /role/);
  throwsInvalid({ ...base(), roles: [{ id: "custom-a", label: "", when: "x" }] }, /label/);
  throwsInvalid({ ...base(), roles: [{ id: "custom-a", label: "A", when: "x".repeat(281) }] }, /when/);
  throwsInvalid({ ...base(), roles: [{ id: "explore" }, { id: "explore" }] }, /duplicate/);
  throwsInvalid({ ...base(), roles: Array.from({ length: 5 }, (_, i) => ({ id: `custom-r${i}`, label: "L", when: "w" })) }, /custom/);
  throwsInvalid(null, /object/);
});

test("custom roles: one-line when, built-ins carry no label or when, unknown fields ignored", () => {
  const parsed = parsePolicy({
    ...base(),
    surprise: 1,
    roles: [
      { id: "review", label: "ignored", when: "ignored", models: [{ ...choice, maxConcurrent: 2 }] },
      { id: "custom-translations", label: " Translations ", when: "Translate\n  the\tUI\u0007 copy", models: [] },
    ],
  });
  const review = parsed.roles.find((r) => r.id === "review")!;
  assert.equal("label" in review, false);
  assert.equal("when" in review, false);
  assert.equal(review.models[0]!.maxConcurrent, 2);
  const custom = parsed.roles[6]!;
  assert.equal(custom.label, "Translations");
  assert.equal(custom.when, "Translate the UI copy");
  assert.equal(parsed.roles.length, 7);
});

test("excluded keys are parsed, deduped and capped at 24", () => {
  const parsed = parsePolicy({ ...base(), excluded: ["claude::anthropic/opus", " claude::anthropic/opus ", "cursor::cursor/grok/4"] });
  assert.deepEqual(parsed.excluded, ["claude::anthropic/opus", "cursor::cursor/grok/4"]);
  throwsInvalid({ ...base(), excluded: Array.from({ length: 25 }, (_, i) => `h::p/m${i}`) }, /at most 24/);
});

test("lenient normalization never throws and fills defaults", () => {
  for (const raw of [undefined, null, 5, "x", [], { roles: 7, excluded: 3, mode: 9 }]) {
    const policy = normalizeStoredPolicy(raw);
    assert.deepEqual(policy, DEFAULT_POLICY);
  }
  const partial = normalizeStoredPolicy({
    mode: "roles",
    quotaCeiling: 5,
    roles: [{ id: "explore", models: [choice, { harnessId: "", providerID: "p", modelID: "m" }, choice] }, { id: "nope" }],
    excluded: ["bad", "h::p/m"],
  });
  assert.equal(partial.mode, "roles");
  assert.equal(partial.quotaCeiling, 85);
  assert.equal(partial.roles[0]!.models.length, 1);
  assert.deepEqual(partial.excluded, ["h::p/m"]);
});

test("revision is a stable 12-hex content hash", () => {
  const a = policyRevision(DEFAULT_POLICY);
  assert.match(a, /^[0-9a-f]{12}$/);
  assert.equal(policyRevision(parsePolicy(base())), a);
  assert.notEqual(policyRevision({ ...DEFAULT_POLICY, maxChildren: 4 }), a);
});
