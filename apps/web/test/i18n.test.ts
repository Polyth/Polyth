import assert from "node:assert/strict";
import test from "node:test";
import type { LocaleBundle } from "@polyth/contracts";
import { browserLocales } from "@polyth/browser/i18n";
import { commandsLocales } from "@polyth/commands/i18n";
import { dictationLocales } from "@polyth/dictation/i18n";
import { filesLocales } from "@polyth/files/i18n";
import { fusionLocales } from "@polyth/fusion/i18n";
import { gitLocales } from "@polyth/git/i18n";
import { githubLocales } from "@polyth/github/i18n";
import { goalsLocales } from "@polyth/goals/i18n";
import { homeAssistantLocales } from "@polyth/home-assistant/i18n";
import { hotkeysLocales } from "@polyth/hotkeys/i18n";
import { knowledgeLocales } from "@polyth/knowledge/i18n";
import { modelsLocales } from "@polyth/models/i18n";
import { multirunLocales } from "@polyth/multirun/i18n";
import { permissionsLocales } from "@polyth/permissions/i18n";
import { pluginsLocales } from "@polyth/plugins/i18n";
import { scheduleLocales } from "@polyth/schedule/i18n";
import { secureSafeLocales } from "@polyth/secure-safe/i18n";
import { sshLocales } from "@polyth/ssh/i18n";
import { terminalLocales } from "@polyth/terminal/i18n";
import { usageLocales } from "@polyth/usage/i18n";
import { walkthroughLocales } from "@polyth/walkthrough/i18n";
import { workflowLocales } from "@polyth/workflow/i18n";
import { ar } from "../src/i18n/locales/ar.ts";
import { bg } from "../src/i18n/locales/bg.ts";
import { de } from "../src/i18n/locales/de.ts";
import { en } from "../src/i18n/locales/en.ts";
import { es } from "../src/i18n/locales/es.ts";
import { fr } from "../src/i18n/locales/fr.ts";
import { it } from "../src/i18n/locales/it.ts";
import { pl } from "../src/i18n/locales/pl.ts";
import { pt } from "../src/i18n/locales/pt.ts";
import { ptBR } from "../src/i18n/locales/pt-BR.ts";
import { uk } from "../src/i18n/locales/uk.ts";
import { zhCN } from "../src/i18n/locales/zh-CN.ts";
import {
  isRtl,
  LOCALES,
  LOCALE_NAMES,
  setLocale,
  tr,
  type Locale,
} from "../src/i18n/index.ts";

const appLocales: LocaleBundle = {
  uk,
  en,
  de,
  fr,
  pl,
  "pt-BR": ptBR,
  it,
  es,
  "zh-CN": zhCN,
  bg,
  ar,
  pt,
};

// Every locale bundle merged by src/i18n/index.ts, keyed by owner for
// readable failure messages.
const bundles: Record<string, LocaleBundle> = {
  app: appLocales,
  browser: browserLocales,
  commands: commandsLocales,
  dictation: dictationLocales,
  files: filesLocales,
  fusion: fusionLocales,
  git: gitLocales,
  github: githubLocales,
  goals: goalsLocales,
  "home-assistant": homeAssistantLocales,
  hotkeys: hotkeysLocales,
  knowledge: knowledgeLocales,
  models: modelsLocales,
  multirun: multirunLocales,
  permissions: permissionsLocales,
  plugins: pluginsLocales,
  schedule: scheduleLocales,
  "secure-safe": secureSafeLocales,
  ssh: sshLocales,
  terminal: terminalLocales,
  usage: usageLocales,
  walkthrough: walkthroughLocales,
  workflow: workflowLocales,
};

const placeholders = (message: string): string[] =>
  [...message.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();

test("every bundle has complete non-empty catalogs for all required locales", () => {
  assert.deepEqual(LOCALES, [
    "uk", "en", "de", "fr", "pl", "pt-BR", "it", "es", "zh-CN", "bg", "ar", "pt",
  ]);
  for (const locale of LOCALES) assert.ok(LOCALE_NAMES[locale]);
  for (const [owner, bundle] of Object.entries(bundles)) {
    const englishKeys = Object.keys(bundle.en).sort();
    assert.ok(englishKeys.length > 0, owner);
    for (const locale of LOCALES) {
      assert.deepEqual(Object.keys(bundle[locale]).sort(), englishKeys, `${owner}:${locale}`);
      for (const [key, value] of Object.entries(bundle[locale])) {
        assert.ok(value.trim(), `${owner}:${locale}:${key} is empty`);
        assert.equal(value.includes("&amp;"), false, `${owner}:${locale}:${key} contains an HTML entity`);
      }
    }
  }
});

test("bundles partition the key space and merge to a full catalog", () => {
  const owners = new Map<string, string>();
  for (const [owner, bundle] of Object.entries(bundles)) {
    for (const key of Object.keys(bundle.en)) {
      const existing = owners.get(key);
      assert.equal(existing, undefined, `${key} owned by both ${existing} and ${owner}`);
      owners.set(key, owner);
    }
  }
  assert.ok(owners.size > 3_000);
});

test("translations preserve every interpolation placeholder", () => {
  const mismatches: string[] = [];
  for (const [owner, bundle] of Object.entries(bundles)) {
    for (const locale of LOCALES) {
      for (const [key, message] of Object.entries(bundle.en)) {
        const actual = placeholders(bundle[locale][key]!);
        const expected = placeholders(message);
        if (actual.join("\0") !== expected.join("\0")) {
          mismatches.push(`${owner}:${locale}:${key} (${actual.join(",")} != ${expected.join(",")})`);
        }
      }
    }
  }
  assert.deepEqual(mismatches, []);
});

test("runtime switches locale, resolves package keys, and marks only Arabic RTL", () => {
  for (const locale of LOCALES) {
    setLocale(locale);
    assert.equal(tr("questionserializers.questionValue", { number: 7 }).includes("7"), true);
    // Package-owned keys must resolve through the merged catalog.
    assert.equal(tr("gitview.branch", {}).trim().length > 0, true);
    assert.equal(tr("terminalview.newTerminal", {}).trim().length > 0, true);
    assert.equal(tr("previewview.browserControls", {}).trim().length > 0, true);
    assert.equal(tr("usage.usagedashboard.dashboardDensity", {}).trim().length > 0, true);
    assert.equal(isRtl(), locale === "ar");
  }
  setLocale("en");
});

test("European and Brazilian Portuguese remain distinct catalogs", () => {
  let differing = 0;
  for (const bundle of Object.values(bundles)) {
    for (const key of Object.keys(bundle.en)) {
      if (bundle.pt[key] !== bundle["pt-BR"][key]) differing += 1;
    }
  }
  assert.ok(differing > 100, `${differing} differing Portuguese messages`);
});
