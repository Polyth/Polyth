export const WEB_SEARCH_PACKAGE_ID = "web-search";
export const WEB_SEARCH_SETTINGS_VERSION = 1;

export const WEB_SEARCH_REGIONS = [
  "wt-wt",
  "us-en",
  "us-es",
  "ca-en",
  "ca-fr",
  "uk-en",
  "de-de",
  "fr-fr",
  "it-it",
  "es-es",
  "pt-br",
  "nl-nl",
  "pl-pl",
  "ua-uk",
  "tr-tr",
  "ru-ru",
  "jp-jp",
  "kr-kr",
  "cn-zh",
  "in-en",
  "au-en",
  "sg-en",
] as const;

export type WebSearchRegion = (typeof WEB_SEARCH_REGIONS)[number];
export type WebSearchProviderChoice = "auto" | "duckduckgo" | "tavily";
export type WebSearchProviderId = "duckduckgo" | "tavily";
export type WebSearchSafeSearch = "strict" | "moderate" | "off";
export type WebSearchFreshness = "day" | "week" | "month" | "year";

export interface WebSearchSettings {
  enabled: boolean;
  provider: WebSearchProviderChoice;
  region: WebSearchRegion;
  safeSearch: WebSearchSafeSearch;
  maxResults: number;
  tavilyCredentialHandle?: string;
}

export const DEFAULT_WEB_SEARCH_SETTINGS: Readonly<WebSearchSettings> = Object.freeze({
  enabled: true,
  provider: "auto",
  region: "wt-wt",
  safeSearch: "moderate",
  maxResults: 8,
});

const PROVIDER_CHOICES = new Set<WebSearchProviderChoice>(["auto", "duckduckgo", "tavily"]);
const SAFE_SEARCH_VALUES = new Set<WebSearchSafeSearch>(["strict", "moderate", "off"]);
const REGION_VALUES = new Set<string>(WEB_SEARCH_REGIONS);
const HANDLE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const invalid = (message: string): never => {
  throw Object.assign(new Error(message), { code: "invalid-input" });
};

const record = (value: unknown, label = "settings"): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
};

export function parseWebSearchSettings(value: unknown): WebSearchSettings {
  const input = record(value);
  const enabled = input.enabled;
  if (typeof enabled !== "boolean") return invalid("enabled must be a boolean");
  if (typeof input.provider !== "string" || !PROVIDER_CHOICES.has(input.provider as WebSearchProviderChoice)) {
    return invalid("provider must be auto, duckduckgo, or tavily");
  }
  if (typeof input.region !== "string" || !REGION_VALUES.has(input.region)) return invalid("region is not supported");
  if (typeof input.safeSearch !== "string" || !SAFE_SEARCH_VALUES.has(input.safeSearch as WebSearchSafeSearch)) {
    return invalid("safeSearch must be strict, moderate, or off");
  }
  const handle = input.tavilyCredentialHandle;
  if (handle !== undefined && (typeof handle !== "string" || !HANDLE_RE.test(handle))) {
    return invalid("tavilyCredentialHandle must be a valid Credential Vault handle");
  }

  const maxResults = input.maxResults;
  if (typeof maxResults !== "number" || !Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 10) {
    return invalid("maxResults must be an integer from 1 to 10");
  }
  return {
    enabled,
    provider: input.provider as WebSearchProviderChoice,
    region: input.region as WebSearchRegion,
    safeSearch: input.safeSearch as WebSearchSafeSearch,
    maxResults,
    ...(typeof handle === "string" ? { tavilyCredentialHandle: handle } : {}),
  };
}

export function webSearchSettingsEqual(left: WebSearchSettings, right: WebSearchSettings): boolean {
  return left.enabled === right.enabled
    && left.provider === right.provider
    && left.region === right.region
    && left.safeSearch === right.safeSearch
    && left.maxResults === right.maxResults
    && left.tavilyCredentialHandle === right.tavilyCredentialHandle;
}

export function parseWebSearchFreshness(value: unknown): WebSearchFreshness | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "day" || value === "week" || value === "month" || value === "year") return value;
  return invalid("freshness must be day, week, month, or year");
}

export function parseWebSearchCount(value: unknown, configuredMaximum: number): number {
  if (value === undefined || value === null) return configuredMaximum;
  const count = value;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1 || count > 10) {
    return invalid("count must be an integer from 1 to 10");
  }
  return Math.min(count, configuredMaximum);
}

export function normalizeWebSearchQuery(value: unknown): string {
  if (typeof value !== "string") return invalid("query must be a string");
  const query = value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!query) return invalid("query is required");
  if (query.length > 2_048) return invalid("query must be at most 2048 characters");
  return query;
}
