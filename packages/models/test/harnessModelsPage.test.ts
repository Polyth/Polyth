import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const source = (path: string) => readFileSync(resolve(import.meta.dirname, path), "utf8");

test("large native harness catalogs register the shared Providers & Models settings surface", () => {
  const registry = source("../widgets/index.tsx");
  const page = source("../widgets/HarnessModelsPage.tsx");

  assert.match(registry, /harnessId:\s*"\*"/);
  assert.match(registry, /minModels:\s*HARNESS_MODEL_SETTINGS_MIN_MODELS/);
  assert.match(registry, /excludeHarnessIds:\s*\["opencode"\]/);
  assert.match(page, /HARNESS_MODEL_SETTINGS_MIN_MODELS\s*=\s*11/);

  assert.match(page, /model-visibility/);
  assert.match(page, /providers\/\$\{encodeURIComponent\(providerID\)\}\/enabled/);
  assert.match(page, /models\/enabled/);
  assert.match(page, /<Toggle/);
  assert.match(page, /<Switch/);
  assert.match(page, /ProviderLogo/);
});
