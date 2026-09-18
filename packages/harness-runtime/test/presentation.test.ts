import assert from "node:assert/strict";
import test from "node:test";
import type { HarnessSnapshot, ModelDescriptor } from "@polyth/contracts";

import { configurationSections, harnessDisplayName } from "../widgets/presentation.ts";

test("harness display names keep known brands readable and format unknown ids", () => {
  assert.equal(harnessDisplayName("claude"), "Claude");
  assert.equal(harnessDisplayName("codex"), "Codex");
  assert.equal(harnessDisplayName("open-code"), "Open Code");
  assert.equal(harnessDisplayName("custom_harness"), "Custom Harness");
  assert.equal(harnessDisplayName(""), "");
});

test("shared harness detail sections appear for every harness without leaking harness-specific sections", () => {
  const items = [
    { id: "system", order: 5, meta: { harnessId: "*", sectionId: "system-prompt", label: "System prompt" } },
    { id: "claude-runtime", order: 20, meta: { harnessId: "claude", sectionId: "runtime", label: "Runtime" } },
    { id: "codex-runtime", order: 20, meta: { harnessId: "codex", sectionId: "runtime", label: "Runtime" } },
  ];

  assert.deepEqual(configurationSections(items, "claude").map((section) => section.id), ["system-prompt", "runtime"]);
  assert.deepEqual(configurationSections(items, "codex").map((section) => section.id), ["system-prompt", "runtime"]);
  assert.deepEqual(configurationSections(items, "pi").map((section) => section.id), ["system-prompt"]);
});


test("Providers & Models is contributed only to non-OpenCode harnesses with more than ten models", () => {
  const items = [{
    id: "models.large-harness-catalog",
    order: 10,
    meta: {
      harnessId: "*",
      sectionId: "providers-models",
      label: "Providers & Models",
      minModels: 11,
      excludeHarnessIds: ["opencode"],
    },
  }];
  const snapshot = (harnessId: string, count: number) => ({
    identity: { id: harnessId },
    catalog: {
      models: Array.from({ length: count }, (_, index): ModelDescriptor => ({
        harnessId,
        providerID: "provider",
        modelID: `model-${index}`,
        name: `Model ${index}`,
      })),
    },
  }) as HarnessSnapshot;

  assert.deepEqual(configurationSections(items, "pi", snapshot("pi", 10)), []);
  assert.deepEqual(
    configurationSections(items, "pi", snapshot("pi", 11)).map((section) => section.id),
    ["providers-models"],
  );
  assert.deepEqual(
    configurationSections(items, "cursor", snapshot("cursor", 25)).map((section) => section.id),
    ["providers-models"],
  );
  assert.deepEqual(configurationSections(items, "opencode", snapshot("opencode", 50)), []);
});
