import assert from "node:assert/strict";
import test from "node:test";
import { LOCALES, type LocaleBundle } from "@polyth/contracts";
import { discoverShellI18nPackages, localeIdentifier, type ShellI18nPackage } from "../generateI18n.ts";
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
  LOCALES as APP_LOCALES,
  LOCALE_NAMES,
  setLocale,
  tr,
  type Locale,
  type TranslationKey,
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

// Package catalogs the shell merges are discovered from manifests, never from
// a hand-maintained list: the shell never names a removable package, and a
// removed package simply stops being discovered.
interface DiscoveredBundle {
  pkg: ShellI18nPackage;
  bundle: LocaleBundle;
}

const discovered: DiscoveredBundle[] = await Promise.all(
  (await discoverShellI18nPackages()).map(async (pkg) => {
    const bundle: Record<string, Record<string, string>> = {};
    for (const locale of pkg.locales) {
      const module = await import(`${pkg.packageName}/i18n/${locale}`) as Record<string, unknown>;
      const messages = module[localeIdentifier(locale)];
      assert.ok(messages, `${pkg.id} exports its ${locale} catalog`);
      bundle[locale] = messages as Record<string, string>;
    }
    return { pkg, bundle: bundle as unknown as LocaleBundle };
  }),
);

// Every locale bundle merged by src/i18n/index.ts, keyed by owner for readable
// failure messages, plus the locales that owner actually ships.
const bundles: Record<string, LocaleBundle> = { app: appLocales };
const bundleLocales: Record<string, readonly Locale[]> = { app: LOCALES };
for (const { pkg, bundle } of discovered) {
  bundles[pkg.id] = bundle;
  bundleLocales[pkg.id] = pkg.locales;
}

const placeholders = (message: string): string[] =>
  [...message.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();

test("every bundle has complete non-empty catalogs for all required locales", () => {
  assert.deepEqual(APP_LOCALES, [
    "uk", "en", "de", "fr", "pl", "pt-BR", "it", "es", "zh-CN", "bg", "ar", "pt",
  ]);
  for (const locale of LOCALES) assert.ok(LOCALE_NAMES[locale]);
  for (const [owner, bundle] of Object.entries(bundles)) {
    const englishKeys = Object.keys(bundle.en).sort();
    assert.ok(englishKeys.length > 0, owner);
    for (const locale of bundleLocales[owner] ?? LOCALES) {
      assert.deepEqual(Object.keys(bundle[locale]).sort(), englishKeys, `${owner}:${locale}`);
      for (const [key, value] of Object.entries(bundle[locale])) {
        assert.ok(value.trim(), `${owner}:${locale}:${key} is empty`);
        assert.equal(
          /&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/i.test(value),
          false,
          `${owner}:${locale}:${key} contains an encoded HTML entity`,
        );
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

test("visual-fix localization keys exist in every app and harness locale", () => {
  const harnessRuntime = bundles["harness-runtime"];
  assert.ok(harnessRuntime, "the harness-runtime catalog is discovered");
  const appKeys = [
    "sessionActivity.usageTab",
    "sessionActivity.contentTab",
    "format.durationSeconds",
    "format.durationMinutes",
    "format.durationHours",
    "sessionStatus.approvalRequired",
    "sessionStatus.replyNeeded",
    "sessionStatus.working",
    "sessionStatus.waitingForYou",
    "sessionStatus.failed",
    "sessionStatus.reconnecting",
    "sessionStatus.statusUnknown",
    "sessionStatus.unreadActivity",
    "sessionStatus.idle",
    "sessionStatus.recentSessions",
    "sessionStatus.noRecentSessions",
  ] as const;
  const harnessKeys = [
    "harnessruntime.compaction.ariaLabel",
    "harnessruntime.compaction.heading",
    "harnessruntime.compaction.description",
  ] as const;
  for (const locale of LOCALES) {
    for (const key of appKeys) assert.ok(appLocales[locale][key]?.trim(), `app:${locale}:${key}`);
    for (const key of harnessKeys) assert.ok(harnessRuntime[locale][key]?.trim(), `harness-runtime:${locale}:${key}`);
  }
});

test("context and usage display keys are populated in every locale", () => {
  const appKeys = [
    "context.observedTokensWindowUnavailable",
    "context.indicatorPercent",
    "context.usageUnavailable",
    "context.tokens",
    "sessionStatus.sessionStatusValue",
    "mobile.island.openNavigation",
    "mobile.island.workspaceNavigation",
    "mobile.island.viewNavigation",
    "mobile.island.newSession",
    "mobile.island.openTools",
    "railsurfaces.contextDescription",
    "railsurfaces.eventsDescription",
  ] as const;
  for (const locale of LOCALES) {
    for (const key of appKeys) assert.ok(appLocales[locale][key]?.trim(), `app:${locale}:${key}`);
  }
  const observedTokens = appLocales.uk["context.observedTokensWindowUnavailable"];
  assert.ok(observedTokens);
  assert.match(observedTokens, /токенів/);
});

test("translations preserve every interpolation placeholder", () => {
  const mismatches: string[] = [];
  for (const [owner, bundle] of Object.entries(bundles)) {
    for (const locale of bundleLocales[owner] ?? LOCALES) {
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

test("workflow onboarding uses localized orchestration terminology", () => {
  const key = "packages.onboarding.tours.builtin.workflowsBuildsADirectedGraphOfRoles" as const;
  assert.deepEqual(
    {
      ar: appLocales.ar[key],
      de: appLocales.de[key],
      en: appLocales.en[key],
      es: appLocales.es[key],
      zhCN: appLocales["zh-CN"][key],
    },
    {
      ar: "تنشئ مسارات العمل رسمًا بيانيًا موجهًا للأدوار، ثم تشغّل كل طبقة جاهزة بالتوازي مع الاحتفاظ بسجل الجلسة الرئيسية.",
      de: "Workflows erstellen einen gerichteten Graphen aus Rollen und führen jede bereite Ebene parallel aus, während das Protokoll der übergeordneten Sitzung erhalten bleibt.",
      en: "Workflows build a directed graph of roles, then run each ready layer in parallel while preserving a parent-session log.",
      es: "Los flujos de trabajo crean un grafo dirigido de roles y luego ejecutan cada capa lista en paralelo, conservando el registro de la sesión principal.",
      zhCN: "工作流构建角色有向图，然后并行运行每个就绪层，同时保留父会话日志。",
    },
  );
});

test("runtime switches locale, resolves package keys, and marks only Arabic RTL", async () => {
  for (const locale of LOCALES) {
    await setLocale(locale);
    assert.equal(tr("questionserializers.questionValue", { number: 7 }).includes("7"), true);
    // Package-owned keys must resolve through the merged catalog.
    assert.equal(tr("gitview.branch", {}).trim().length > 0, true);
    assert.equal(tr("terminalview.newTerminal", {}).trim().length > 0, true);
    assert.equal(tr("previewview.browserControls", {}).trim().length > 0, true);
    assert.match(tr("pullrequestview.mergeNumberValue", { number: 8 }), /8/);
    assert.equal(isRtl(), locale === "ar");
  }
  await setLocale("en");
});

test("tr degrades to the key instead of throwing when a catalog entry is missing", () => {
  const missing = "planner.missingCatalogKey" as TranslationKey;
  assert.equal(tr(missing), "planner.missingCatalogKey");
});

test("European and Brazilian Portuguese remain distinct catalogs", () => {
  let differing = 0;
  for (const bundle of Object.values(bundles)) {
    if (!bundle.pt || !bundle["pt-BR"]) continue;
    for (const key of Object.keys(bundle.en)) {
      if (bundle.pt[key] !== bundle["pt-BR"][key]) differing += 1;
    }
  }
  assert.ok(differing > 100, `${differing} differing Portuguese messages`);
});
