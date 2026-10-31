import assert from "node:assert/strict";
import test from "node:test";

// The i18n module reads the stored preference and the system language when it
// loads, so both are staged before the dynamic import below.
const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
});
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { language: "uk-UA", languages: ["uk-UA", "en-US"] },
});

const { getLocale, getLocalePreference, matchSystemLocale, setLocale, systemLocale, tr } =
  await import("../src/i18n/index.ts");

test("system language tags resolve to the first supported locale", () => {
  assert.equal(matchSystemLocale(["uk-UA"]), "uk");
  assert.equal(matchSystemLocale(["de-AT", "en"]), "de");
  assert.equal(matchSystemLocale(["ru-RU", "es-MX", "en"]), "es");
  assert.equal(matchSystemLocale(["EN_gb"]), "en");
  assert.equal(matchSystemLocale(["pt-BR"]), "pt-BR");
  assert.equal(matchSystemLocale(["pt-PT"]), "pt");
  assert.equal(matchSystemLocale(["pt"]), "pt");
  assert.equal(matchSystemLocale(["zh-CN"]), "zh-CN");
  assert.equal(matchSystemLocale(["zh-Hans-SG"]), "zh-CN");
  assert.equal(matchSystemLocale(["zh"]), "zh-CN");
  assert.equal(matchSystemLocale(["zh-TW", "fr-CA"]), "fr");
  assert.equal(matchSystemLocale(["zh-Hant-HK"]), undefined);
  assert.equal(matchSystemLocale(["ja-JP", "ko"]), undefined);
  assert.equal(matchSystemLocale([""]), undefined);
});

test("with no stored choice the interface follows the system language", () => {
  assert.equal(systemLocale(), "uk");
  assert.equal(getLocalePreference(), "system");
  assert.equal(getLocale(), "uk");
});

test("an explicit choice persists and switching back to system clears it", async () => {
  await setLocale("de");
  assert.equal(getLocalePreference(), "de");
  assert.equal(getLocale(), "de");
  assert.equal(store.get("polyth.locale"), "de");

  await setLocale("system");
  assert.equal(getLocalePreference(), "system");
  assert.equal(getLocale(), "uk");
  assert.equal(store.has("polyth.locale"), false);
  assert.equal(tr("settings.pages.languageSystem", { language: "Українська" }), "Системна (Українська)");
});
