import type { Resolver } from "@polyth/outbound";
import { webSearchError } from "../errors.ts";
import { providerHttpRequest, type ProviderHttpTransport } from "../http.ts";
import type { RawSearchResult, SearchProvider } from "../types.ts";

const ENDPOINT = "https://api.tavily.com/search";
const TIME_RANGE: Readonly<Record<string, string>> = {
  day: "day",
  week: "week",
  month: "month",
  year: "year",
};

const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

export function parseTavilyResults(value: unknown): RawSearchResult[] {
  const root = object(value);
  if (!root || !Array.isArray(root.results)) {
    throw webSearchError("provider-invalid-response", "Tavily returned an unreadable response");
  }
  return root.results.map((result) => {
    const row = object(result);
    return {
      title: row?.title,
      url: row?.url,
      snippet: row?.content,
      publishedAt: row?.published_date,
    };
  });
}

export function createTavilyProvider(options: {
  resolve?: Resolver;
  transport?: ProviderHttpTransport;
} = {}): SearchProvider {
  return {
    id: "tavily",
    name: "Tavily",
    requiresCredential: true,
    async search(request, credential) {
      if (!credential) throw webSearchError("auth-required", "Tavily is not configured for this Space");
      const payload: Record<string, unknown> = {
        query: request.query,
        search_depth: "basic",
        max_results: request.count,
        topic: "general",
        include_answer: false,
        include_raw_content: false,
        include_images: false,
        include_published_date: true,
        safe_search: request.safeSearch !== "off",
      };
      if (request.freshness) payload.time_range = TIME_RANGE[request.freshness];

      const result = await providerHttpRequest(ENDPOINT, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${credential}`,
          "content-type": "application/json",
          "user-agent": "Polyth/0.1 WebSearch",
        },
        body: JSON.stringify(payload),
        signal: request.signal,
        timeoutMs: 12_000,
        maxBytes: 1024 * 1024,
      }, options);
      if (result.status === 401 || result.status === 403) {
        throw webSearchError("auth-required", "Tavily rejected the configured Credential Vault handle");
      }
      if (result.status === 429) throw webSearchError("rate-limited", "Tavily rate limit reached");
      if (result.status === 432 || result.status === 433) {
        throw webSearchError("tavily-plan-exhausted", "the configured Tavily plan is exhausted");
      }
      if (result.status < 200 || result.status >= 300) {
        throw webSearchError("provider-unavailable", `Tavily search failed (${result.status})`);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(result.body.toString("utf8"));
      } catch {
        throw webSearchError("provider-invalid-response", "Tavily returned invalid JSON");
      }
      return parseTavilyResults(parsed);
    },
  };
}
