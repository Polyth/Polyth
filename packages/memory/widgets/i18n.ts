import { en } from "../src/i18n/en.ts";

/** Host translation lookup, as exposed by `host.ui.locale.translate`. */
export type Translate = (key: string, values?: Record<string, string | number>) => string;

/** Fill `{name}` placeholders; an unknown name is left verbatim. */
export function formatMessage(template: string, values: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => name in values ? String(values[name]) : match);
}

/**
 * English fallback for callers without a host (tests, older hosts). The shell
 * passes its own live `translate`, so a locale switch re-renders.
 */
export const englishTranslate: Translate = (key, values) =>
  formatMessage((en as Record<string, string>)[key] ?? key, values);

/** A catalog label for an enum value, or the raw value when it is unknown. */
export function enumLabel(translate: Translate, prefix: string, value: string): string {
  const key = `${prefix}.${value}`;
  const text = translate(key);
  return text === key ? value : text;
}
