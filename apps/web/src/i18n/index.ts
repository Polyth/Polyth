import { LOCALES, type Locale, type LocaleBundle } from "@polyth/contracts";
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
import { ar } from "./locales/ar.ts";
import { bg } from "./locales/bg.ts";
import { de } from "./locales/de.ts";
import { en, type AppMessageKey } from "./locales/en.ts";
import { es } from "./locales/es.ts";
import { fr } from "./locales/fr.ts";
import { it } from "./locales/it.ts";
import { pl } from "./locales/pl.ts";
import { pt } from "./locales/pt.ts";
import { ptBR } from "./locales/pt-BR.ts";
import { uk } from "./locales/uk.ts";
import { zhCN } from "./locales/zh-CN.ts";
import { LOCALE_NAMES, type TranslationCatalog, type TranslationKey } from "./types.ts";

const STORAGE_KEY = "polyth.locale";
const RTL_LOCALES = new Set<Locale>(["ar"]);

/** Strings owned by the app shell itself (chrome, composer, settings shell). */
const appLocales: LocaleBundle<AppMessageKey> = {
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

// Feature strings live in their packages; the shell only assembles them.
// Ownership is a partition of the key space, so merge order cannot matter —
// the integrity test asserts bundles never overlap.
const bundles = [
  appLocales,
  browserLocales,
  commandsLocales,
  dictationLocales,
  filesLocales,
  fusionLocales,
  gitLocales,
  githubLocales,
  goalsLocales,
  homeAssistantLocales,
  hotkeysLocales,
  knowledgeLocales,
  modelsLocales,
  multirunLocales,
  permissionsLocales,
  pluginsLocales,
  scheduleLocales,
  secureSafeLocales,
  sshLocales,
  terminalLocales,
  usageLocales,
  walkthroughLocales,
  workflowLocales,
] as const;

function mergeCatalogs(): Record<Locale, TranslationCatalog> {
  const merged = {} as Record<Locale, TranslationCatalog>;
  for (const locale of LOCALES) {
    const catalog: Record<string, string> = {};
    for (const bundle of bundles) Object.assign(catalog, bundle[locale]);
    // Complete by construction: TranslationKey is the union of every bundle's
    // key set and each bundle is typed complete per locale.
    merged[locale] = catalog as TranslationCatalog;
  }
  return merged;
}

const catalogs: Record<Locale, TranslationCatalog> = mergeCatalogs();

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

export function setLocale(locale: Locale): void {
  if (locale === currentLocale) return;
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
  const template = catalogs[currentLocale][key] || catalogs.en[key];
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
