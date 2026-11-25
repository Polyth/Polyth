/**
 * Settings store a region as `country-language` (`ua-uk`, `uk-en`, `jp-jp`).
 * Providers want an ISO country and a language tag, so the few codes that are
 * not already ISO are translated here.
 */
const COUNTRY_ALIASES: Readonly<Record<string, string>> = { uk: "GB" };
const LANGUAGE_ALIASES: Readonly<Record<string, string>> = { br: "pt", jp: "ja", kr: "ko" };

export interface RegionLocale {
  /** ISO 3166-1 alpha-2, upper case. */
  country: string;
  /** ISO 639-1, lower case. */
  language: string;
}

/** `null` for the worldwide region, which sends no location at all. */
export function regionLocale(region: string): RegionLocale | null {
  if (region === "wt-wt") return null;
  const [country, language] = region.split("-");
  if (!country || !language) return null;
  return {
    country: COUNTRY_ALIASES[country] ?? country.toUpperCase(),
    language: LANGUAGE_ALIASES[language] ?? language,
  };
}
