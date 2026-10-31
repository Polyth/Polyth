import type { WebPackageHost } from "@polyth/web-sdk";
import { en, type TunnelMessageKey } from "../src/i18n/en.ts";

export type Translate = (key: TunnelMessageKey, values?: Record<string, string | number>) => string;

const fill = (message: string, values?: Record<string, string | number>): string =>
  values
    ? message.replace(/\{(\w+)\}/g, (match, name: string) => name in values ? String(values[name]) : match)
    : message;

/** English lookup for the few callers rendered without a package host. */
export const translateEnglish: Translate = (key, values) => fill(en[key], values);

/** Resolve catalog messages through the host locale, falling back to English
 *  when a page is mounted without the web package host (tests, embeds). */
export function createTranslate(host?: WebPackageHost): Translate {
  const lookup = host?.ui?.locale?.translate;
  if (typeof lookup !== "function") return translateEnglish;
  return (key, values) => lookup.call(host!.ui.locale, key, values);
}
