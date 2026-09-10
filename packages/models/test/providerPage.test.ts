import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../widgets/ModelsPage.tsx");
const source = () => readFileSync(root, "utf8");

test("Providers page no longer has Connected/All, chips, or global model search", () => {
  const page = source();
  assert.equal(page.includes('tr("sidebar.connected")'), false);
  assert.equal(page.includes("providerFilter"), false);
  assert.equal(page.includes("provider-chips"), false);
  assert.equal(page.includes("settings.modelspage.searchModels"), false);
  assert.equal(page.includes("noProvidersToAdd"), false);
  assert.equal(page.includes("type Scope"), false);
});

test("Add provider stays actionable and Custom provider is always reachable", () => {
  const page = source();
  assert.match(page, /customProvider/);
  assert.equal(page.includes("disabled={providerOptionsLoaded"), false);
  assert.match(page, /searchPlaceholder/);
  assert.match(page, /allBuiltinsAdded/);
  assert.match(page, /catalogueFailed/);
  assert.match(page, /providerSettings/);
  assert.equal(page.includes("provider-custom-tools"), false);
  assert.equal(page.includes("__retry__"), false);
  assert.equal(page.includes("__empty__"), false);
});

test("model filtering is local to a provider card", () => {
  const page = source();
  assert.match(page, /filterProviderModels\(p\.models, query\)/);
  assert.match(page, /filterProviderModels/);
});

test("header rows are real name/value fields, not a free-form textarea", () => {
  const dialog = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../widgets/CustomProviderDialog.tsx"), "utf8");
  assert.match(dialog, /custom-provider-header-row/);
  assert.equal(dialog.includes("Textarea"), false);
  assert.equal(dialog.includes("parseHeaderLines"), false);
  assert.match(dialog, /headerPatch/);
  assert.match(dialog, /configuredOutside/);
  assert.match(dialog, /rediscoverNeedsKey/);
  assert.match(dialog, /removeCustomProviderModel/);
  assert.match(dialog, /configuredModels/);
});

test("enable toggle is not labeled as connection", () => {
  const page = source();
  assert.equal(page.includes("notConnected"), false);
  assert.match(page, /statusLabel\(p\.status\)/);
  assert.match(page, /overlayStatus\(provider, on\)/);
  assert.match(page, /deriveProviderStatus/);
  assert.equal(page.includes("statusError"), false);
  assert.equal(page.includes("runtimeError"), false);
  assert.equal(page.includes("models.map((model) => ({ ...model, enabled: on }))"), false);
});

test("initial provider catalog load does not invalidate its harness settings parent", () => {
  const page = source();
  assert.match(page, /void refreshCatalog\(\{ invalidateRuntime: false \}\)/);
  assert.match(page, /if \(invalidateRuntime\) invalidateRuntimeCatalogs\(\)/);
});
