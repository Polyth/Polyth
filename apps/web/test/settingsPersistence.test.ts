import test from "node:test";
import assert from "node:assert/strict";

const stored = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => { stored.set(key, value); },
  removeItem: (key: string) => { stored.delete(key); },
};

stored.set("polyth.settings", JSON.stringify({
  theme: "midnight",
  density: "compact",
  productName: "Legacy name",
  chatWidth: "wide",
}));

const product = await import("../src/settings.ts");
const ui = await import("../src/uiPrefs.ts");

test("legacy mixed settings migrate into independent versioned records", () => {
  const productSettings = product.loadSettings();
  assert.equal(productSettings.productName, "Legacy name");
  assert.equal(productSettings.theme, "midnight");
  assert.equal(productSettings.appearanceMode, "system");
  assert.equal(productSettings.fontFamily, "sans");
  assert.equal(ui.getUiSettings().chatWidth, "wide");

  assert.ok(stored.has(product.SETTINGS_KEY));
  assert.ok(stored.has(ui.UI_SETTINGS_KEY));
  assert.notEqual(product.SETTINGS_KEY, ui.UI_SETTINGS_KEY);
});

test("legacy system theme migrates to an independent system appearance mode", () => {
  const migrated = product.normalizeSettings({ theme: "system" });
  assert.equal(migrated.theme, "dark");
  assert.equal(migrated.appearanceMode, "system");
});

test("interface font catalog accepts programmer fonts and rejects unknown values", () => {
  assert.equal(product.normalizeSettings({ fontFamily: "jetbrains-mono" }).fontFamily, "jetbrains-mono");
  assert.equal(product.normalizeSettings({ fontFamily: "unknown-font" }).fontFamily, "sans");
  assert.ok(product.INTERFACE_FONTS.filter((font) => font.mono).length >= 15);
});

test("saving either settings domain preserves the other domain byte-for-byte", () => {
  const uiBefore = stored.get(ui.UI_SETTINGS_KEY);
  product.saveSettings({ ...product.loadSettings(), productName: "Product only" });
  assert.equal(stored.get(ui.UI_SETTINGS_KEY), uiBefore);

  const productBefore = stored.get(product.SETTINGS_KEY);
  ui.setUiSettings({ chatWidth: "normal" });
  assert.equal(stored.get(product.SETTINGS_KEY), productBefore);
  assert.equal(product.loadSettings().productName, "Product only");
  assert.equal(ui.getUiSettings().chatWidth, "normal");
  assert.equal(stored.get("polyth.settings")?.includes("Legacy name"), true, "migration source remains read-only");
});

test("header metric and response action layouts preserve order and reject unknown ids", () => {
  const parsed = ui.parseUiSettings(JSON.stringify({
    headerMetrics: ["cost", "tokens", "bogus", "cost"],
    responseActions: ["pin", "copy", "unknown"],
  }));
  assert.deepEqual(parsed.headerMetrics, ["cost", "tokens"]);
  assert.deepEqual(parsed.responseActions, ["pin", "copy"]);
  const defaults = ui.parseUiSettings(null);
  assert.deepEqual(defaults.headerMetrics, [...ui.HEADER_METRIC_IDS]);
  assert.deepEqual(defaults.responseActions, [...ui.RESPONSE_ACTION_IDS]);
});

test("top rail alignment defaults to center and accepts only supported positions", () => {
  assert.equal(ui.parseUiSettings(null).topRailAlignment, "center");
  assert.equal(ui.parseUiSettings(JSON.stringify({ topRailAlignment: "left" })).topRailAlignment, "left");
  assert.equal(ui.parseUiSettings(JSON.stringify({ topRailAlignment: "floating" })).topRailAlignment, "center");
});
