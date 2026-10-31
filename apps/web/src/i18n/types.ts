import type { Locale } from "@polyth/contracts";
import type { AppMessageKey } from "./locales/en.ts";
import type { ProjectCompositionMessageKey } from "./projectComposition.ts";
import type { PackageMessageKey } from "./catalogs/packageCatalogs.generated.ts";

export { LOCALES } from "@polyth/contracts";
export type { Locale } from "@polyth/contracts";

/** Every key `tr()` accepts: the app shell's own keys plus the keys of every
 *  package locale bundle merged into the runtime catalog. The package pieces
 *  are discovered from package manifests by apps/web/generateI18n.ts. */
export type TranslationKey =
  | AppMessageKey
  | ProjectCompositionMessageKey
  | PackageMessageKey;

export type TranslationCatalog = Record<TranslationKey, string>;

export const LOCALE_NAMES: Record<Locale, string> = {
  uk: "Українська",
  en: "English",
  de: "Deutsch",
  fr: "Français",
  pl: "Polski",
  "pt-BR": "Português (Brasil)",
  it: "Italiano",
  es: "Español",
  "zh-CN": "简体中文",
  bg: "Български",
  ar: "العربية",
  pt: "Português (Portugal)",
};
