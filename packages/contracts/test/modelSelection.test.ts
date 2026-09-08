import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelDescriptor } from "@polyth/contracts";
import { findModelDescriptor, harnessModels, resolveModelSelection, resolveVariantPreference } from "../src/index.ts";

const catalog: ModelDescriptor[] = [
  {
    harnessId: "codex",
    providerID: "openai",
    modelID: "gpt-5.5-codex",
    name: "GPT-5.5 Codex",
    variants: ["low", "medium", "high", "xhigh"],
    defaultVariant: "medium",
  },
  { harnessId: "codex", providerID: "openai", modelID: "gpt-5.5-codex-mini", name: "Mini" },
  { harnessId: "claude", providerID: "anthropic", modelID: "sonnet", name: "Sonnet", variants: ["low", "high", "max"] },
];

test("an absent model ref is always sendable — the backend picks its own default", () => {
  assert.deepEqual(resolveModelSelection(catalog, undefined, "codex"), { ok: true });
});

test("a model belonging to another harness is rejected before it can be sent", () => {
  const result = resolveModelSelection(catalog, { providerID: "anthropic", modelID: "sonnet" }, "codex");
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.code, "invalid-model");
  assert.match(result.ok === false ? result.message : "", /sonnet is not available on this engine/);
});

test("an empty catalog for the harness defers to the adapter instead of inventing a rejection", () => {
  const result = resolveModelSelection([], { providerID: "x", modelID: "y", variant: "high" }, "cursor");
  assert.deepEqual(result, { ok: true, variant: "high" });
});

test("a wrong provider is rejected even when the model id exists", () => {
  const result = resolveModelSelection(
    catalog,
    { providerID: "azure", modelID: "gpt-5.5-codex", variant: "xhigh" },
    "codex",
  );
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.code, "invalid-model");
});

test("duplicate model ids resolve only within the requested provider", () => {
  const duplicates: ModelDescriptor[] = [
    { harnessId: "shared", providerID: "provider-a", modelID: "same", name: "A" },
    { harnessId: "shared", providerID: "provider-b", modelID: "same", name: "B" },
  ];
  assert.equal(findModelDescriptor(duplicates, { providerID: "provider-b", modelID: "same" }, "shared")?.name, "B");
  assert.equal(findModelDescriptor(duplicates, { providerID: "provider-c", modelID: "same" }, "shared"), undefined);
});

test("a harness switch with identical provider/model ids stays harness-scoped", () => {
  const duplicates: ModelDescriptor[] = [
    { harnessId: "left", providerID: "shared", modelID: "same", name: "Left" },
    { harnessId: "right", providerID: "shared", modelID: "same", name: "Right" },
  ];
  assert.equal(findModelDescriptor(duplicates, { providerID: "shared", modelID: "same" }, "left")?.name, "Left");
  assert.equal(findModelDescriptor(duplicates, { providerID: "shared", modelID: "same" }, "right")?.name, "Right");
});

test("a variant the model does not advertise is rejected, never silently dropped", () => {
  const result = resolveModelSelection(
    catalog,
    { providerID: "openai", modelID: "gpt-5.5-codex", variant: "ultra" },
    "codex",
  );
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.code, "invalid-variant");
  assert.match(result.ok === false ? result.message : "", /low, medium, high, xhigh/);
});

test("a variant on a model with no thinking levels is rejected with that reason", () => {
  const result = resolveModelSelection(
    catalog,
    { providerID: "openai", modelID: "gpt-5.5-codex-mini", variant: "high" },
    "codex",
  );
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.code, "invalid-variant");
  assert.match(result.ok === false ? result.message : "", /does not offer a thinking level/);
});

test("an empty-string variant means the native default", () => {
  const result = resolveModelSelection(
    catalog,
    { providerID: "openai", modelID: "gpt-5.5-codex", variant: "" },
    "codex",
  );
  assert.deepEqual(result, { ok: true, descriptor: catalog[0] });
});

test("a descriptor without a harnessId is visible to every harness", () => {
  const legacy: ModelDescriptor[] = [{ providerID: "opencode", modelID: "grok", name: "Grok" }];
  assert.equal(harnessModels(legacy, "codex").length, 1);
  assert.equal(findModelDescriptor(legacy, { providerID: "opencode", modelID: "grok" }, "claude")?.name, "Grok");
});

test("no preference takes the model's default variant", () => {
  assert.deepEqual(resolveVariantPreference(catalog[0], undefined), { variant: "medium", reconciled: false });
});

test("a stale variant is reconciled to the default and reported as reconciled", () => {
  assert.deepEqual(resolveVariantPreference(catalog[0], "ultra"), { variant: "medium", reconciled: true });
});

test("a model with variants but no default reconciles to no variant", () => {
  assert.deepEqual(resolveVariantPreference(catalog[2], "medium"), { reconciled: true });
  assert.deepEqual(resolveVariantPreference(catalog[2], "max"), { variant: "max", reconciled: false });
});

test("a model with no variants at all cannot carry one", () => {
  assert.deepEqual(resolveVariantPreference(catalog[1], "high"), { reconciled: true });
  assert.deepEqual(resolveVariantPreference(catalog[1], undefined), { reconciled: false });
});
