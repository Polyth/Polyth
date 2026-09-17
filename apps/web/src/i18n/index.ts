import { LOCALES, type Locale } from "@polyth/contracts";
// English is the fallback every tr() read can reach synchronously, so it is
// the only locale statically bundled. Every other locale loads on demand as
// its own chunk (PR #51 bundled all 12 eagerly — ~4.9MB of the 6MB main.js).
import { en as appEn } from "./locales/en.ts";
import { projectCompositionLocales } from "./projectComposition.ts";
import { en as browserEn } from "@polyth/browser/i18n/en";
import { en as chatWorkspaceEn } from "@polyth/chat-workspace/i18n/en";
import { en as commandsEn } from "@polyth/commands/i18n/en";
import { en as dictationEn } from "@polyth/dictation/i18n/en";
import { en as editorEn } from "@polyth/editor/i18n/en";
import { en as filesEn } from "@polyth/files/i18n/en";
import { en as fusionEn } from "@polyth/fusion/i18n/en";
import { en as gitEn } from "@polyth/git/i18n/en";
import { en as githubEn } from "@polyth/github/i18n/en";
import { en as goalsEn } from "@polyth/goals/i18n/en";
import { en as homeAssistantEn } from "@polyth/home-assistant/i18n/en";
import { en as hotkeysEn } from "@polyth/hotkeys/i18n/en";
import { en as knowledgeEn } from "@polyth/knowledge/i18n/en";
import { en as modelsEn } from "@polyth/models/i18n/en";
import { en as multirunEn } from "@polyth/multirun/i18n/en";
import { en as permissionsEn } from "@polyth/permissions/i18n/en";
import { en as pluginsEn } from "@polyth/plugins/i18n/en";
import { en as scheduleEn } from "@polyth/schedule/i18n/en";
import { en as secureSafeEn } from "@polyth/secure-safe/i18n/en";
import { en as sshEn } from "@polyth/ssh/i18n/en";
import { en as terminalEn } from "@polyth/terminal/i18n/en";
import { en as usageEn } from "@polyth/usage/i18n/en";
import { en as walkthroughEn } from "@polyth/walkthrough/i18n/en";
import { en as workflowEn } from "@polyth/workflow/i18n/en";
import { LOCALE_NAMES, type TranslationCatalog, type TranslationKey } from "./types.ts";

const STORAGE_KEY = "polyth.locale";
const RTL_LOCALES = new Set<Locale>(["ar"]);

// Catalog ownership is a partition of the key space (asserted by the i18n
// integrity test), so merge order cannot matter.
const catalogs: Partial<Record<Locale, TranslationCatalog>> = {
  en: Object.assign(
    {},
    appEn,
    projectCompositionLocales.en,
    chatWorkspaceEn,
    browserEn,
    commandsEn,
    dictationEn,
    editorEn,
    filesEn,
    fusionEn,
    gitEn,
    githubEn,
    goalsEn,
    homeAssistantEn,
    hotkeysEn,
    knowledgeEn,
    modelsEn,
    multirunEn,
    permissionsEn,
    pluginsEn,
    scheduleEn,
    secureSafeEn,
    sshEn,
    terminalEn,
    usageEn,
    walkthroughEn,
    workflowEn,
  ) as TranslationCatalog,
};

const isLocale = (value: unknown): value is Locale =>
  typeof value === "string" && (LOCALES as readonly string[]).includes(value);

function storedLocale(): Locale {
  if (typeof localStorage === "undefined") return "en";
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return isLocale(value) ? value : "en";
  } catch {
    return "en";
  }
}

let currentLocale = storedLocale();
const listeners = new Set<() => void>();

function applyLocaleToDocument(locale: Locale): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.lang = locale;
  root.dir = RTL_LOCALES.has(locale) ? "rtl" : "ltr";
  root.dataset.locale = locale;
  root.classList.toggle("rtl", RTL_LOCALES.has(locale));
}

applyLocaleToDocument(currentLocale);

/** Load one locale's catalog chunk (idempotent). Static specifiers keep
 *  esbuild code-splitting honest — a dynamic template would not resolve. */
export function ensureLocale(locale: Locale): Promise<void> {
  if (catalogs[locale]) return Promise.resolve();
  const load = (): Promise<{ catalog: Record<string, string> }> => {
    switch (locale) {
      case "uk": return import("./catalogs/uk.ts");
      case "de": return import("./catalogs/de.ts");
      case "fr": return import("./catalogs/fr.ts");
      case "pl": return import("./catalogs/pl.ts");
      case "pt-BR": return import("./catalogs/pt-BR.ts");
      case "it": return import("./catalogs/it.ts");
      case "es": return import("./catalogs/es.ts");
      case "zh-CN": return import("./catalogs/zh-CN.ts");
      case "bg": return import("./catalogs/bg.ts");
      case "ar": return import("./catalogs/ar.ts");
      case "pt": return import("./catalogs/pt.ts");
      default: return Promise.resolve({ catalog: {} });
    }
  };
  return load().then((mod) => {
    catalogs[locale] = Object.assign({}, mod.catalog, projectCompositionLocales[locale]) as TranslationCatalog;
  });
}

export { LOCALES, LOCALE_NAMES };
export type { Locale, TranslationKey };

export function getLocale(): Locale {
  return currentLocale;
}

export function getLocaleSnapshot(): Locale {
  return currentLocale;
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function setLocale(locale: Locale): Promise<void> {
  if (locale === currentLocale) return;
  // The catalog must be merged BEFORE listeners fire: subscribers re-render
  // synchronously and tr() reads must already resolve in the new locale.
  await ensureLocale(locale);
  currentLocale = locale;
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // A denied localStorage write must not prevent an in-memory language switch.
  }
  applyLocaleToDocument(locale);
  for (const listener of listeners) listener();
}

type TranslationValue = string | number | boolean | null | undefined;
export type TranslationParams = Record<string, TranslationValue>;

export function tr(key: TranslationKey, params: TranslationParams = {}): string {
  // The en catalog is always present; a still-loading locale degrades to en
  // until its chunk lands (callers re-render once setLocale resolves).
  const template = catalogs[currentLocale]?.[key] || catalogs.en![key];
  if (!template) return String(key);
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined || value === null ? match : String(value);
  });
}

export function formatNumber(
  value: number,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(currentLocale, options).format(value);
}

export function formatDate(
  value: Date | number | string,
  options?: Intl.DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat(currentLocale, options).format(new Date(value));
}

export function formatRelativeTime(
  value: number,
  unit: Intl.RelativeTimeFormatUnit,
  options?: Intl.RelativeTimeFormatOptions,
): string {
  return new Intl.RelativeTimeFormat(currentLocale, options).format(value, unit);
}

export function formatList(
  values: Iterable<string>,
  options?: Intl.ListFormatOptions,
): string {
  return new Intl.ListFormat(currentLocale, options).format(values);
}

export function isRtl(locale: Locale = currentLocale): boolean {
  return RTL_LOCALES.has(locale);
}
