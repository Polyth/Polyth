import { en } from "../src/i18n/en.ts";

/** Looks up `harnessruntime.<key>`; callers pass the key relative to that prefix. */
export type Translate = (key: string, values?: Record<string, string | number>) => string;

/** English lookup for helpers called without the active locale's translator
 *  (tests, callers not yet localized). Components pass `host.ui.locale.translate`. */
export const englishTranslate: Translate = (key, values) => {
  const text = (en as Record<string, string>)[`harnessruntime.${key}`] ?? key;
  return values ? text.replace(/\{(\w+)\}/g, (match, name: string) => name in values ? String(values[name]) : match) : text;
};

/** Binds the host translator to the `harnessruntime.` prefix. */
export const hostTranslate = (translate: (key: string, values?: Record<string, string | number>) => string): Translate =>
  (key, values) => translate(`harnessruntime.${key}`, values);

/** `one` for exactly 1, otherwise `other`: the English split. Locales whose
 *  grammar needs more forms word both keys so either reads correctly. */
export const pluralKey = (base: string, count: number): string => `${base}.${count === 1 ? "one" : "other"}`;
