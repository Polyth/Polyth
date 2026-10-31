import { LOCALES, type Locale } from "@polyth/contracts";
// English is the fallback every tr() read can reach synchronously, so it is
// the only locale statically bundled. Every other locale loads on demand as
// its own chunk (PR #51 bundled all 12 eagerly — ~4.9MB of the 6MB main.js).
import { en as appEn } from "./locales/en.ts";
import { projectCompositionLocales } from "./projectComposition.ts";
// Package catalogs are discovered from package manifests by
// apps/web/generateI18n.ts; the shell must not name a package here.
import { packageEnCatalogs } from "./catalogs/packageCatalogs.generated.ts";
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
    ...packageEnCatalogs,
  ) as TranslationCatalog,
};

const isLocale = (value: unknown): value is Locale =>
  typeof value === "string" && (LOCALES as readonly string[]).includes(value);

/** The person's language choice: an explicit locale, or "system" to follow
 *  the OS/browser language. "system" is the default and is stored as the
 *  absence of the key, so only an explicit pick is ever persisted. */
export type LocalePreference = Locale | "system";

/** First supported locale for an ordered list of BCP 47 tags (the shape of
 *  `navigator.languages`), or undefined when none is supported. */
export function matchSystemLocale(tags: readonly string[]): Locale | undefined {
  for (const raw of tags) {
    const tag = raw.trim().replace(/_/g, "-").toLowerCase();
    if (!tag) continue;
    const exact = LOCALES.find((locale) => locale.toLowerCase() === tag);
    if (exact) return exact;
    const [language, ...subtags] = tag.split("-");
    if (language === "pt") return subtags.includes("br") ? "pt-BR" : "pt";
    if (language === "zh") {
      // Only Simplified Chinese ships; a Traditional reader falls through to
      // their next listed language rather than getting the other script.
      const traditional = subtags.includes("hant")
        || (!subtags.includes("hans") && subtags.some((s) => s === "tw" || s === "hk" || s === "mo"));
      if (traditional) continue;
      return "zh-CN";
    }
    if (isLocale(language)) return language;
  }
  return undefined;
}

function systemLanguageTags(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  if (Array.isArray(navigator.languages) && navigator.languages.length > 0) return navigator.languages;
  return typeof navigator.language === "string" ? [navigator.language] : [];
}

/** The supported locale the system language resolves to (English fallback). */
export function systemLocale(): Locale {
  return matchSystemLocale(systemLanguageTags()) ?? "en";
}

function storedPreference(): LocalePreference {
  // No Web Storage means no browser (Node tests): stay deterministic instead
  // of following the host's LANG.
  if (typeof localStorage === "undefined") return "en";
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return isLocale(value) ? value : "system";
  } catch {
    return "system";
  }
}

const resolveLocale = (preference: LocalePreference): Locale =>
  preference === "system" ? systemLocale() : preference;

let localePreference = storedPreference();
let currentLocale = resolveLocale(localePreference);
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

export function getLocalePreference(): LocalePreference {
  return localePreference;
}

export async function setLocale(preference: LocalePreference): Promise<void> {
  const locale = resolveLocale(preference);
  // The catalog must be merged BEFORE listeners fire: subscribers re-render
  // synchronously and tr() reads must already resolve in the new locale.
  await ensureLocale(locale);
  localePreference = preference;
  try {
    if (preference === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // A denied localStorage write must not prevent an in-memory language switch.
  }
  if (locale === currentLocale) return;
  currentLocale = locale;
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

// Building an Intl formatter costs far more than formatting with one, and
// transcript rows format on every render of a live turn: formatters are
// shared per locale and options.
const formatters = new Map<string, unknown>();
function cachedFormatter<T>(kind: string, locale: string, options: object | undefined, make: () => T): T {
  const key = `${kind}|${locale}|${options === undefined ? "" : JSON.stringify(options)}`;
  let formatter = formatters.get(key) as T | undefined;
  if (formatter === undefined) {
    if (formatters.size > 256) formatters.clear();
    formatter = make();
    formatters.set(key, formatter);
  }
  return formatter;
}

export function numberFormatter(locale: string, options?: Intl.NumberFormatOptions): Intl.NumberFormat {
  return cachedFormatter("number", locale, options, () => new Intl.NumberFormat(locale, options));
}

export function dateTimeFormatter(locale: string, options?: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  // A formatter keeps the zone it was built in; a device that travels or
  // changes its zone gets a fresh one.
  const zone = options?.timeZone ?? new Date().getTimezoneOffset();
  return cachedFormatter(`date@${zone}`, locale, options, () => new Intl.DateTimeFormat(locale, options));
}

export function formatNumber(
  value: number,
  options?: Intl.NumberFormatOptions,
): string {
  return numberFormatter(currentLocale, options).format(value);
}

export function formatDate(
  value: Date | number | string,
  options?: Intl.DateTimeFormatOptions,
): string {
  return dateTimeFormatter(currentLocale, options).format(new Date(value));
}

export function formatRelativeTime(
  value: number,
  unit: Intl.RelativeTimeFormatUnit,
  options?: Intl.RelativeTimeFormatOptions,
): string {
  return cachedFormatter("relative", currentLocale, options, () => new Intl.RelativeTimeFormat(currentLocale, options))
    .format(value, unit);
}

export function formatList(
  values: Iterable<string>,
  options?: Intl.ListFormatOptions,
): string {
  return cachedFormatter("list", currentLocale, options, () => new Intl.ListFormat(currentLocale, options)).format(values);
}

export function isRtl(locale: Locale = currentLocale): boolean {
  return RTL_LOCALES.has(locale);
}
