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

const normalizeForFallbackAudit = (message: string): string =>
  message
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .replace(/[\p{P}\p{S}\s]+/gu, "");

const words = (message: string, locale: Locale): string[] =>
  message.normalize("NFKC").toLocaleLowerCase(locale).match(/\p{L}+/gu) ?? [];

const workflowUiEntries = (locale: Locale): Array<[string, string]> =>
  Object.entries(workflowLocales[locale]).filter(([key]) => key.startsWith("workflow"));

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

test("workflow catalogs contain no unjustified English-filled fallbacks", () => {
  const workflowKeys = Object.keys(workflowLocales.en) as Array<keyof typeof workflowLocales.en>;
  const sharedTechnicalCopy = new Set<keyof typeof workflowLocales.en>([
    "trackspanel.nodeTestPackagesExampleTestExampleTest",
    "trackspanel.s",
    "workflowview.message",
  ]);
  // These are established technical loanwords or cognates in the named
  // locale, not broad exceptions that can hide arbitrary English sentences.
  const localeTechnicalCopy: Partial<Record<Locale, ReadonlySet<keyof typeof workflowLocales.en>>> = {
    uk: new Set(["trackspanel.commit"]),
    de: new Set([
      "trackspanel.commit",
      "workflowtimeline.workflow",
      "workflowview.agent",
      "workflowview.agentValue",
      "workflowview.parallel",
      "workflowview.workflowValue",
    ]),
    fr: new Set([
      "trackspanel.commit",
      "workflowview.agent",
      "workflowview.agentValue",
      "workflowview.instructions",
    ]),
    pl: new Set([
      "trackspanel.commit",
      "workflowview.agent",
      "workflowview.agentValue",
      "workflowview.model",
    ]),
    "pt-BR": new Set(["trackspanel.commit"]),
    it: new Set(["trackspanel.commit", "workflowview.workflowValue"]),
    es: new Set(["trackspanel.commit"]),
    bg: new Set(["trackspanel.commit"]),
    pt: new Set(["trackspanel.commit"]),
  };
  for (const locale of LOCALES) {
    if (locale === "en") continue;
    const englishFallbacks = workflowKeys.filter(
      (key) => !sharedTechnicalCopy.has(key)
        && !localeTechnicalCopy[locale]?.has(key)
        && normalizeForFallbackAudit(workflowLocales[locale][key])
          === normalizeForFallbackAudit(workflowLocales.en[key]),
    );
    assert.deepEqual(englishFallbacks, [], `workflow:${locale} has unjustified English fallbacks`);
  }
});

test("workflow English-fallback audit ignores case, spacing, and punctuation disguises", () => {
  const canonical = "Open workflow builder";
  for (const disguised of [
    "open workflow builder",
    "  OPEN   WORKFLOW BUILDER  ",
    "open-workflow—builder!",
    "ＯＰＥＮ　ＷＯＲＫＦＬＯＷ　ＢＵＩＬＤＥＲ",
  ]) {
    assert.equal(normalizeForFallbackAudit(disguised), normalizeForFallbackAudit(canonical));
  }
});

test("workflow operation families use software-execution terminology in every locale", () => {
  const executionCopy: Record<Locale, readonly [string, string, string, string, string, string]> = {
    uk: ["Виконати", "Виконується", "Останній запуск", "Виконати знову", "Зупинити виконання", "Виконання зупинено."],
    en: ["Run", "Running", "Latest run", "Run again", "Stop run", "The run was stopped."],
    de: ["Ausführen", "Wird ausgeführt", "Neueste Ausführung", "Erneut ausführen", "Ausführung stoppen", "Die Ausführung wurde gestoppt."],
    fr: ["Exécuter", "En cours d’exécution", "Dernière exécution", "Exécuter à nouveau", "Arrêter l’exécution", "L’exécution a été arrêtée."],
    pl: ["Uruchom", "W trakcie wykonywania", "Najnowsze wykonanie", "Uruchom ponownie", "Zatrzymaj wykonanie", "Wykonanie zostało zatrzymane."],
    "pt-BR": ["Executar", "Em execução", "Última execução", "Executar novamente", "Parar execução", "A execução foi interrompida."],
    it: ["Esegui", "In esecuzione", "Ultima esecuzione", "Esegui nuovamente", "Interrompi esecuzione", "L'esecuzione è stata interrotta."],
    es: ["Ejecutar", "En ejecución", "Última ejecución", "Ejecutar de nuevo", "Detener ejecución", "La ejecución se detuvo."],
    "zh-CN": ["运行", "运行中", "最新运行", "再次运行", "停止运行", "运行已停止。"],
    bg: ["Изпълни", "Изпълнява се", "Последно изпълнение", "Изпълни отново", "Спри изпълнението", "Изпълнението беше спряно."],
    ar: ["تشغيل", "قيد التشغيل", "أحدث تشغيل", "تشغيل مرة أخرى", "إيقاف التشغيل", "تم إيقاف التشغيل."],
    pt: ["Executar", "Em execução", "Última execução", "Executar novamente", "Parar execução", "A execução foi interrompida."],
  };
  const keys = [
    "workflowlauncher.run",
    "workflowstatus.running",
    "workflowview.latestRun",
    "workflowview.runAgain",
    "workflowview.stopRun",
    "workflowview.workflowRunStopped",
  ] as const;
  for (const locale of LOCALES) {
    assert.deepEqual(
      keys.map((key) => workflowLocales[locale][key]),
      executionCopy[locale],
      `workflow:${locale} execution copy`,
    );
  }

  const sportTerms: Partial<Record<Locale, ReadonlySet<string>>> = {
    uk: new Set(["бігти", "біг", "біжи"]),
    fr: new Set(["courir", "course"]),
    pl: new Set(["biegnij", "bieganie", "bieg"]),
    "pt-BR": new Set(["corrida", "correndo", "corra"]),
    it: new Set(["corri", "correre", "corsa"]),
    bg: new Set(["тичам", "бягане", "бягането"]),
    pt: new Set(["corrida", "correndo", "corra"]),
  };
  for (const [locale, banned] of Object.entries(sportTerms) as Array<[Locale, ReadonlySet<string>]>) {
    const violations = workflowUiEntries(locale).flatMap(([key, message]) =>
      words(message, locale).filter((word) => banned.has(word)).map((word) => `${key}:${word}`));
    assert.deepEqual(violations, [], `workflow:${locale} contains race/jog terminology`);
  }
});

test("workflow hierarchy copy avoids literal-children wording", () => {
  const literalChildren: Partial<Record<Locale, ReadonlySet<string>>> = {
    uk: new Set(["дитячий", "дитяча", "дитячу"]),
    pl: new Set(["dzieci"]),
    "pt-BR": new Set(["infantil"]),
    it: new Set(["bambino", "bambini"]),
    bg: new Set(["детска", "детската"]),
    pt: new Set(["infantil"]),
  };
  for (const [locale, banned] of Object.entries(literalChildren) as Array<[Locale, ReadonlySet<string>]>) {
    const violations = workflowUiEntries(locale).flatMap(([key, message]) =>
      words(message, locale).filter((word) => banned.has(word)).map((word) => `${key}:${word}`));
    assert.deepEqual(violations, [], `workflow:${locale} uses literal children terminology for child sessions`);
  }
});

test("translated workflow UI contains no embedded English operation words", () => {
  const untranslatedOperations = new Set([
    "child",
    "delete",
    "edge",
    "jog",
    "latest",
    "open",
    "race",
    "retry",
    "run",
    "running",
    "save",
    "self",
    "stop",
  ]);
  for (const locale of LOCALES) {
    if (locale === "en") continue;
    const violations = workflowUiEntries(locale).flatMap(([key, message]) =>
      words(message, locale).filter((word) => untranslatedOperations.has(word)).map((word) => `${key}:${word}`));
    assert.deepEqual(violations, [], `workflow:${locale} contains untranslated English operation words`);
  }
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
      de: "Arbeitsabläufe erstellen einen gerichteten Graphen aus Rollen und führen dann jede bereite Ebene parallel aus, während das Protokoll der übergeordneten Sitzung erhalten bleibt.",
      en: "Workflows build a directed graph of roles, then run each ready layer in parallel while preserving a parent-session log.",
      es: "Los flujos de trabajo crean un grafo dirigido de roles y luego ejecutan cada capa lista en paralelo, conservando el registro de la sesión principal.",
      zhCN: "工作流构建角色有向图，然后并行运行每个就绪层，同时保留父会话日志。",
    },
  );
});

test("reviewed workflow locale copy keeps operational terms unambiguous", () => {
  assert.equal(workflowLocales.es["workflowlauncher.openBuilder"], "Abrir el constructor de flujos de trabajo");
  assert.equal(workflowLocales.ar["workflowstatus.running"], "قيد التشغيل");
  assert.equal(workflowLocales.ar["workflowview.deleteBusy"], "جارٍ الحذف…");
  assert.equal(workflowLocales["zh-CN"]["workflowtimeline.nodeRange"], "显示第 {start}–{end} 个，共 {total} 个");
  assert.equal(workflowLocales.de["workflowview.executionOrder"], "Ausführungsreihenfolge");
  assert.deepEqual(
    {
      arCollapse: workflowLocales.ar["workflowtimeline.collapseNodes"],
      arParent: workflowLocales.ar["workflowview.openParentChat"],
      deParent: workflowLocales.de["workflowview.openParentChat"],
      deStopped: workflowLocales.de["workflowview.workflowRunStopped"],
      esRunning: workflowLocales.es["workflowstatus.running"],
      esParent: workflowLocales.es["workflowview.openParentChat"],
      esStopped: workflowLocales.es["workflowview.workflowRunStopped"],
      zhCollapse: workflowLocales["zh-CN"]["workflowtimeline.collapseNodes"],
      zhParent: workflowLocales["zh-CN"]["workflowview.openParentChat"],
      zhParallel: workflowLocales["zh-CN"]["workflowview.parallel"],
      zhStopped: workflowLocales["zh-CN"]["workflowview.workflowRunStopped"],
    },
    {
      arCollapse: "طي العقد",
      arParent: "فتح محادثة الجلسة الرئيسية",
      deParent: "Chat der übergeordneten Sitzung öffnen",
      deStopped: "Die Ausführung wurde gestoppt.",
      esRunning: "En ejecución",
      esParent: "Abrir el chat de la sesión principal",
      esStopped: "La ejecución se detuvo.",
      zhCollapse: "收起节点",
      zhParent: "打开父会话聊天",
      zhParallel: "并行",
      zhStopped: "运行已停止。",
    },
  );
  assert.deepEqual(
    {
      bg: workflowLocales.bg["workflowview.workflowRunStopped"],
      fr: workflowLocales.fr["workflowtimeline.openSession"],
      it: workflowLocales.it["workflowtimeline.stopRun"],
      pl: workflowLocales.pl["workflowview.openParentChat"],
      pt: workflowLocales.pt["workflowview.worker"],
      ptBR: workflowLocales["pt-BR"]["workflowview.worker"],
      uk: workflowLocales.uk["workflowtimeline.stopRun"],
    },
    {
      bg: "Изпълнението беше спряно.",
      fr: "Ouvrir la session",
      it: "Interrompi esecuzione",
      pl: "Otwórz czat sesji nadrzędnej",
      pt: "Executor",
      ptBR: "Executor",
      uk: "Зупинити виконання",
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
    assert.equal(tr("usage.usagedashboard.dashboardDensity", {}).trim().length > 0, true);
    assert.equal(isRtl(), locale === "ar");
  }
  await setLocale("en");
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
