import { webSearchError } from "../errors.ts";
import { regionLocale } from "../region.ts";
import type { RawSearchResult, SearchProvider } from "../types.ts";
import { callKeylessMcpTool, mcpExcerpt, mcpObject, type KeylessMcpOptions } from "./mcp.ts";

/** Exa's hosted MCP endpoint serves search without a key, at its free rate limit. */
const ENDPOINT = "https://mcp.exa.ai/mcp?tools=web_search_advanced_exa";
const TOOL = "web_search_advanced_exa";
const FRESHNESS_DAYS: Readonly<Record<string, number>> = {
  day: 1,
  week: 7,
  month: 31,
  year: 366,
};
const DAY_MS = 24 * 60 * 60 * 1000;

export function parseExaResults(value: unknown): RawSearchResult[] {
  const root = mcpObject(value);
  if (!root || !Array.isArray(root.results)) {
    throw webSearchError("provider-invalid-response", "Exa returned an unreadable response");
  }
  return root.results.map((result) => {
    const row = mcpObject(result);
    return {
      title: row?.title,
      url: row?.url,
      snippet: mcpExcerpt(row?.highlights),
      publishedAt: row?.publishedDate,
    };
  });
}

export function createExaProvider(options: KeylessMcpOptions & { now?: () => number } = {}): SearchProvider {
  return {
    id: "exa",
    name: "Exa",
    requiresCredential: false,
    async search(request) {
      const args: Record<string, unknown> = {
        query: request.query,
        numResults: request.count,
        enableHighlights: true,
        highlightsMaxCharacters: 500,
        moderation: request.safeSearch !== "off",
      };
      const locale = regionLocale(request.region);
      if (locale) args.userLocation = locale.country;
      if (request.freshness) {
        const since = (options.now ?? Date.now)() - FRESHNESS_DAYS[request.freshness]! * DAY_MS;
        args.startPublishedDate = new Date(since).toISOString().slice(0, 10);
      }
      return parseExaResults(await callKeylessMcpTool({
        endpoint: ENDPOINT,
        provider: "Exa",
        tool: TOOL,
        arguments: args,
        signal: request.signal,
        timeoutMs: 12_000,
        maxBytes: 1024 * 1024,
      }, options));
    },
  };
}
