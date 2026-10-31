// Moved from apps/web/test/providerLogo.test.ts: the positive check that the
// fusion view renders the shared provider mark belongs with the package.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("Fusion renders the shared provider mark", () => {
  const fusion = readFileSync(resolve(import.meta.dirname, "../widgets/FusionView.tsx"), "utf8");
  assert.match(fusion, /<ProviderLogo/);
});
