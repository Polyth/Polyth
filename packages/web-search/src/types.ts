import type {
  WebSearchFreshness,
  WebSearchProviderId,
  WebSearchSafeSearch,
} from "./settings.ts";

export interface WebSearchRequest {
  query: string;
  count?: number;
  freshness?: WebSearchFreshness;
}

export interface ProviderSearchRequest {
  query: string;
  count: number;
  region: string;
  safeSearch: WebSearchSafeSearch;
  freshness?: WebSearchFreshness;
  signal: AbortSignal;
}

export interface RawSearchResult {
  title?: unknown;
  url: unknown;
  snippet?: unknown;
  publishedAt?: unknown;
}

export interface WebSearchResult {
  rank: number;
  title: string;
  url: string;
  snippet: string | null;
  publishedAt: string | null;
}

export interface WebSearchResponse {
  query: string;
  provider: WebSearchProviderId;
  results: WebSearchResult[];
  truncated: boolean;
  fallbackFrom?: WebSearchProviderId;
}

export interface SearchProvider {
  id: WebSearchProviderId;
  name: string;
  requiresCredential: boolean;
  search(request: ProviderSearchRequest, credential?: string): Promise<RawSearchResult[]>;
}
