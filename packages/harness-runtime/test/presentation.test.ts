import assert from "node:assert/strict";
import test from "node:test";

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
