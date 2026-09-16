import assert from "node:assert/strict";
import test from "node:test";
import { LOCALES } from "@polyth/contracts";
import { projectCompositionLocales } from "../src/i18n/projectComposition.ts";

const placeholders = (message: string): string[] =>
  [...message.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();

test("Project Composition locales expose the same non-empty key set", () => {
  const englishKeys = Object.keys(projectCompositionLocales.en).sort();
  assert.ok(englishKeys.length > 40);
  for (const locale of LOCALES) {
    const catalog = projectCompositionLocales[locale];
    assert.deepEqual(Object.keys(catalog).sort(), englishKeys, locale);
    for (const [key, value] of Object.entries(catalog)) {
      assert.ok(value.trim(), `${locale}:${key} is empty`);
    }
  }
});

test("Project Composition translations preserve interpolation placeholders", () => {
  for (const locale of LOCALES) {
    const catalog = projectCompositionLocales[locale];
    for (const [key, english] of Object.entries(projectCompositionLocales.en)) {
      assert.deepEqual(placeholders(catalog[key as keyof typeof catalog]), placeholders(english), `${locale}:${key}`);
    }
  }
});

test("Project Composition has first-class Ukrainian product copy", () => {
  assert.equal(projectCompositionLocales.uk["projectcomposition.settingsTitle"], "Налаштування проєкту");
  assert.equal(projectCompositionLocales.uk["projectcomposition.direction.engineering"], "Розробка");
  assert.equal(projectCompositionLocales.uk["projectcomposition.chooseProjectSource"], "Обрати джерело проєкту");
});
