import type { Locale } from "@polyth/contracts";
import { ar } from "./ar.ts";
import { bg } from "./bg.ts";
import { de } from "./de.ts";
import { en, type PlannerMessageKey, type PlannerMessages } from "./en.ts";
import { es } from "./es.ts";
import { fr } from "./fr.ts";
import { it } from "./it.ts";
import { pl } from "./pl.ts";
import { pt } from "./pt.ts";
import { ptBR } from "./pt-BR.ts";
import { uk } from "./uk.ts";
import { zhCN } from "./zh-CN.ts";

export type { PlannerMessageKey, PlannerMessages };
export { en };

/** Package-owned catalogs, one per app locale. */
export const plannerLocales: Record<Locale, PlannerMessages> = {
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

export function translatePlanner(
  locale: string,
  key: PlannerMessageKey,
  params: Record<string, string | number> = {},
): string {
  const catalog = plannerLocales[locale as Locale] as PlannerMessages | undefined;
  const template = catalog?.[key] || en[key] || key;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}
