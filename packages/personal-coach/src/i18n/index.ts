import type { LocaleBundle } from "@polyth/contracts";
import { ar } from "./ar.ts";
import { bg } from "./bg.ts";
import { de } from "./de.ts";
import { en, type CoachMessageKey, type CoachMessages } from "./en.ts";
import { es } from "./es.ts";
import { fr } from "./fr.ts";
import { it } from "./it.ts";
import { pl } from "./pl.ts";
import { pt } from "./pt.ts";
import { ptBR } from "./pt-BR.ts";
import { uk } from "./uk.ts";
import { zhCN } from "./zh-CN.ts";

export type { CoachMessageKey, CoachMessages };
/** The name the shell's generated catalog wiring imports (`<PackageId>MessageKey`). */
export type PersonalCoachMessageKey = CoachMessageKey;

export const coachLocales: LocaleBundle<CoachMessageKey> = {
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

/** Resolve one Coach message in `locale`, falling back to English and then the
 *  key itself. Placeholders left without a value stay visible. */
export function coachMessage(
  locale: string,
  key: CoachMessageKey,
  values?: Record<string, string | number>,
): string {
  const catalog = (coachLocales as Record<string, Record<string, string>>)[locale] ?? coachLocales.en;
  const message = catalog[key] ?? coachLocales.en[key] ?? key;
  if (!values) return message;
  return message.replace(/\{(\w+)\}/g, (whole, name: string) =>
    values[name] === undefined ? whole : String(values[name]));
}
