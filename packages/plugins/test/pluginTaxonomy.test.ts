import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PACKAGE_CLASSIFIER_ORDER } from "@polyth/package-sdk/classify";
import { PACKAGE_CAPABILITY_NAMES } from "@polyth/package-sdk/browser";
import { pluginsLocales } from "../src/i18n/index.ts";
import { CONTRIBUTION_KIND_CLASSIFIER } from "../widgets/pluginTaxonomy.ts";

test("every published classifier has a label in every locale", () => {
  const locales = Object.keys(pluginsLocales) as Array<keyof typeof pluginsLocales>;
  assert.ok(locales.length >= 12);
  for (const locale of locales) {
    const messages = pluginsLocales[locale] as Record<string, string>;
    for (const { id, group } of PACKAGE_CLASSIFIER_ORDER) {
      assert.ok(
        messages[`packages.plugins.classifier.${id}`]?.trim(),
        `${locale} is missing a label for classifier ${id}`,
      );
      assert.ok(
        messages[`packages.plugins.classifierGroup${group[0]!.toUpperCase()}${group.slice(1)}`]?.trim(),
        `${locale} is missing the ${group} group label`,
      );
    }
  }
});

test("the settings page derives filters from the shared taxonomy", () => {
  // The page must not keep a second opinion about which categories exist: the
  // server sends ids and the UI renders the published order plus i18n labels.
  const taxonomy = readFileSync(new URL("../widgets/pluginTaxonomy.ts", import.meta.url), "utf8");
  assert.match(taxonomy, /from "@polyth\/package-sdk\/classify"/);
  assert.match(taxonomy, /PACKAGE_CLASSIFIER_ORDER/);
  assert.equal(
    /(surface|widget|command|tool)["']\s*:\s*["']/.test(taxonomy),
    false,
    "classifier ids are not re-declared in the widget",
  );

  const install = readFileSync(new URL("../widgets/PluginInstallDialog.tsx", import.meta.url), "utf8");
  assert.match(install, /installSourceContract/);
  // One search for the whole Packages page: the library lists under the
  // host toolbar's find state and keeps no search field or chips of its own.
  const page = readFileSync(new URL("../widgets/PluginsPage.tsx", import.meta.url), "utf8");
  assert.match(page, /readPackagesContext/);
  assert.equal(/type="search"/.test(page), false);
});

test("every package capability has a plain-language label in every locale", () => {
  const english = pluginsLocales.en as Record<string, string>;
  for (const locale of Object.keys(pluginsLocales) as Array<keyof typeof pluginsLocales>) {
    const messages = pluginsLocales[locale] as Record<string, string>;
    for (const name of PACKAGE_CAPABILITY_NAMES) {
      const label = messages[`packages.plugins.capability.${name}`];
      assert.ok(label?.trim(), `${locale} is missing a label for capability ${name}`);
      if (locale !== "en") {
        assert.notEqual(label, english[`packages.plugins.capability.${name}`], `${locale} leaves capability ${name} in English`);
      }
    }
  }
});

test("every contribution kind the registry emits is named by a shared classifier", () => {
  const registry = readFileSync(new URL("../src/managedRegistry.ts", import.meta.url), "utf8");
  const kinds = [...registry.matchAll(/\bkind: "([a-z-]+)", id:/g)].map((match) => match[1]!);
  assert.ok(kinds.length >= 9, `found ${kinds.length} contribution kinds`);
  const classifiers = new Set(PACKAGE_CLASSIFIER_ORDER.map((item) => item.id as string));
  for (const kind of kinds) {
    const id = CONTRIBUTION_KIND_CLASSIFIER[kind];
    assert.ok(id && classifiers.has(id), `${kind} maps to a published classifier`);
  }
});
