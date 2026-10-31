import type { WebPackageHost } from "@polyth/web-sdk";
import { en, type TaskTrackersMessageKey } from "../src/i18n/en.ts";

/**
 * The package's text lookup. The shell merges the catalog through the manifest,
 * so `host.ui.locale.translate` resolves the active locale; without a host (a
 * unit test or an early render) the canonical English text is used unchanged.
 */
let localeHost: WebPackageHost | null = null;

export function setTaskTrackersLocaleHost(host: WebPackageHost | null): void {
  localeHost = host;
}

const fill = (template: string, values?: Record<string, string | number>): string =>
  values
    ? template.replace(/\{(\w+)\}/g, (match, name: string) =>
      values[name] === undefined ? match : String(values[name]))
    : template;

export function tt(
  key: TaskTrackersMessageKey,
  values?: Record<string, string | number>,
): string {
  const translate = localeHost?.ui?.locale?.translate;
  if (typeof translate === "function") {
    const translated = translate(key, values);
    if (translated && translated !== key) return translated;
  }
  return fill(en[key] ?? key, values);
}

/** Whether a real host translation seam is available. */
export function hasLocale(): boolean {
  return typeof localeHost?.ui?.locale?.translate === "function";
}

/** The active BCP 47 locale, for `Intl` formatting. */
export function uiLocale(): string {
  const get = localeHost?.ui?.locale?.get;
  return typeof get === "function" ? get.call(localeHost!.ui.locale) : "en";
}
