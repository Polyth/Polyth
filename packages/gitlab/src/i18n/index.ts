import { ar } from "./ar.ts";
import { bg } from "./bg.ts";
import { de } from "./de.ts";
import { en, type GitlabMessageKey, type GitlabMessages } from "./en.ts";
import { es } from "./es.ts";
import { fr } from "./fr.ts";
import { it } from "./it.ts";
import { pl } from "./pl.ts";
import { pt } from "./pt.ts";
import { ptBR } from "./pt-BR.ts";
import { uk } from "./uk.ts";
import { zhCN } from "./zh-CN.ts";

export type { GitlabMessageKey, GitlabMessages };
export const gitlabLocales: Record<string, Partial<GitlabMessages>> = {
  en, uk, de, ar, bg, es, fr, it, pl, pt, "pt-BR": ptBR, "zh-CN": zhCN,
};
export function gitlabText(locale: string, key: GitlabMessageKey, vars: Record<string, string | number> = {}): string {
  let value = gitlabLocales[locale]?.[key] ?? en[key];
  return value.replace(/\{(\w+)(?:,\s*plural,[^{}]*(?:\{[^{}]*\}[^{}]*)*)?\}/g, (match, name: string) => String(vars[name] ?? match));
}
