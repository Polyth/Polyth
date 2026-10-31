// Package-owned copy. The host catalogs carry no chat-block keys; locales
// without a table fall back to English.
import { en, type ChatBlockStrings } from "./i18n/en.ts";
import { uk } from "./i18n/uk.ts";
import { ar } from "./i18n/ar.ts";
import { bg } from "./i18n/bg.ts";
import { de } from "./i18n/de.ts";
import { es } from "./i18n/es.ts";
import { fr } from "./i18n/fr.ts";
import { it } from "./i18n/it.ts";
import { pl } from "./i18n/pl.ts";
import { ptBR } from "./i18n/pt-BR.ts";
import { pt } from "./i18n/pt.ts";
import { zhCN } from "./i18n/zh-CN.ts";

export type { ChatBlockStrings };
export { en, uk, ar, bg, de, es, fr, it, pl, ptBR, pt, zhCN };

export const LOCALES: Readonly<Record<string, ChatBlockStrings>> = {
  ar,
  bg,
  de,
  en,
  es,
  fr,
  it,
  pl,
  pt,
  "pt-BR": ptBR,
  uk,
  zh: zhCN,
  "zh-CN": zhCN,
};

export function chatBlockStrings(locale: string): ChatBlockStrings {
  if (!locale) return en;
  const direct = LOCALES[locale];
  if (direct) return direct;
  const normalized = locale.replace("_", "-");
  if (LOCALES[normalized]) return LOCALES[normalized];
  for (const key of Object.keys(LOCALES)) {
    if (key.toLowerCase() === normalized.toLowerCase()) {
      return LOCALES[key]!;
    }
  }
  const language = normalized.split("-")[0]!.toLowerCase();
  return LOCALES[language] ?? en;
}

export const fill = (template: string, values: Record<string, string | number>): string =>
  template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match));
