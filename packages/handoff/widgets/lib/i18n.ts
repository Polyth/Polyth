import { en, type HandoffMessageKey } from "../../src/i18n/en.ts";
import { handoffLocales } from "../../src/i18n/index.ts";

/** Translation lookup for the handoff surfaces. */
export type HandoffTranslate = (key: HandoffMessageKey, values?: Record<string, string | number>) => string;

/** Fill `{name}` placeholders; an unknown name is left verbatim. */
export function formatMessage(template: string, values: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => name in values ? String(values[name]) : match);
}

const bundles = handoffLocales as Record<string, Record<HandoffMessageKey, string> | undefined>;

/**
 * A lookup for one locale. These surfaces can be mounted outside the shell's
 * translation context, so they read the package catalog directly; an unknown
 * or missing locale falls back to English.
 */
export function handoffTranslate(locale?: string | null): HandoffTranslate {
  const exact = locale ? bundles[locale] : undefined;
  const base = locale ? bundles[locale.split("-")[0]!] : undefined;
  const bundle = exact ?? base ?? en;
  return (key, values) => formatMessage(bundle[key] ?? en[key], values);
}

export const englishHandoff: HandoffTranslate = handoffTranslate("en");
