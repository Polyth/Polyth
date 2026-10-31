import type { LocaleBundle } from "@polyth/contracts";
import { ar } from "./ar.ts";
import { bg } from "./bg.ts";
import { de } from "./de.ts";
import { en, type TunnelMessageKey, type TunnelMessages } from "./en.ts";
import { es } from "./es.ts";
import { fr } from "./fr.ts";
import { it } from "./it.ts";
import { pl } from "./pl.ts";
import { pt } from "./pt.ts";
import { ptBR } from "./pt-BR.ts";
import { uk } from "./uk.ts";
import { zhCN } from "./zh-CN.ts";

export type { TunnelMessageKey, TunnelMessages };

export const tunnelLocales: LocaleBundle<TunnelMessageKey> = {
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
