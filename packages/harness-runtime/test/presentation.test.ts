import assert from "node:assert/strict";
import test from "node:test";

import { harnessDisplayName } from "../widgets/presentation.ts";

test("harness display names keep known brands readable and format unknown ids", () => {
  assert.equal(harnessDisplayName("claude"), "Claude");
  assert.equal(harnessDisplayName("codex"), "Codex");
  assert.equal(harnessDisplayName("open-code"), "Open Code");
  assert.equal(harnessDisplayName("custom_harness"), "Custom Harness");
  assert.equal(harnessDisplayName(""), "");
});
