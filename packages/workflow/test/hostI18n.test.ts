// Workflow's own catalog quality: no unjustified English fallbacks, real
// software-execution terminology, no literal-children wording, no embedded
// English operation words, and the reviewed locale strings. Moved out of
// apps/web/test/i18n.test.ts so the host i18n integrity test no longer names
// the removable package.
import assert from "node:assert/strict";
import test from "node:test";
import { LOCALES, type Locale } from "@polyth/contracts";
import { workflowLocales } from "@polyth/workflow/i18n";

const normalizeForFallbackAudit = (message: string): string =>
  message
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .replace(/[\p{P}\p{S}\s]+/gu, "");

const words = (message: string, locale: Locale): string[] =>
  message.normalize("NFKC").toLocaleLowerCase(locale).match(/\p{L}+/gu) ?? [];

const workflowUiEntries = (locale: Locale): Array<[string, string]> =>
  Object.entries(workflowLocales[locale]).filter(([key]) => key.startsWith("workflow"));

test("workflow catalogs contain no unjustified English-filled fallbacks", () => {
  const workflowKeys = Object.keys(workflowLocales.en) as Array<keyof typeof workflowLocales.en>;
  const sharedTechnicalCopy = new Set<keyof typeof workflowLocales.en>([
    "trackspanel.nodeTestPackagesExampleTestExampleTest",
    "trackspanel.s",
    "workflowview.message",
    // Every Latin-script glossary keeps "harness" and "Backend" as loanwords.
    "workflowview.harness",
    "workflowpreset.backendName",
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
      "workflowview.pipeline",
      "workflowview.details",
      "workflowcount.agentOne",
      // German UI copy keeps the glossary loanwords Workflow, Review(er) and Blocker.
      "workflowview.workflows",
      "statusbar.workflowsCount",
      "workflowpreset.reviewName",
      "workflowview.reviewer",
      "workflowview.reviewReviewer",
      "workflowview.reviewBlocker",
    ]),
    fr: new Set([
      "trackspanel.commit",
      "workflowview.agent",
      "workflowview.agentValue",
      "workflowview.instructions",
      "workflowview.pipeline",
      "workflowview.runOptions",
      "workflowview.description",
      "workflowcount.agentOne",
      "workflowcount.agentOther",
    ]),
    pl: new Set([
      "trackspanel.commit",
      "workflowview.agent",
      "workflowview.agentValue",
      "workflowview.model",
      "workflowcount.agentOne",
    ]),
    "pt-BR": new Set(["trackspanel.commit", "workflowview.pipeline"]),
    it: new Set(["trackspanel.commit", "workflowview.workflowValue", "workflowview.pipeline"]),
    es: new Set(["trackspanel.commit", "workflowview.pipeline"]),
    bg: new Set(["trackspanel.commit"]),
    pt: new Set(["trackspanel.commit", "workflowview.pipeline"]),
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
