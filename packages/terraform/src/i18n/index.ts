import type { LocaleBundle } from "@polyth/contracts";
import { ar } from "./ar.ts";
import { bg } from "./bg.ts";
import { de } from "./de.ts";
import { en, type TerraformMessageKey, type TerraformMessages } from "./en.ts";
import { es } from "./es.ts";
import { fr } from "./fr.ts";
import { it } from "./it.ts";
import { pl } from "./pl.ts";
import { pt } from "./pt.ts";
import { ptBR } from "./pt-BR.ts";
import { uk } from "./uk.ts";
import { zhCN } from "./zh-CN.ts";

export type { TerraformMessageKey, TerraformMessages };

export const terraformLocales: LocaleBundle<TerraformMessageKey> = {
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

/**
 * Package copy for a host. The shell's merged catalog is authoritative; the
 * package's English catalog is a safe fallback for a host or test stub that
 * has no translation service yet.
 */
export function terraformText(
  host: { ui?: { locale?: { translate(key: string, values?: Record<string, string | number>): string } } },
  key: TerraformMessageKey,
  values?: Record<string, string | number>,
): string {
  const translated = host.ui?.locale?.translate(key, values);
  if (translated !== undefined && translated !== key) return translated;
  return (en[key] ?? key).replace(/\{(\w+)\}/g, (match, name: string) => String(values?.[name] ?? match));
}
