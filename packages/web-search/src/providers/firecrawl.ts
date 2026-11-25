import { webSearchError } from "../errors.ts";
import { regionLocale } from "../region.ts";
import type { RawSearchResult, SearchProvider } from "../types.ts";
import { callKeylessMcpTool, mcpExcerpt, mcpObject, type KeylessMcpOptions } from "./mcp.ts";

/** Firecrawl's hosted MCP endpoint serves search without a key, capped per address. */
const ENDPOINT = "https://mcp.firecrawl.dev/mcp";
const TOOL = "firecrawl_search";
/**
 * The tool requires an objective and asks that it carry no user words, so
 * every search sends this fixed one.
 */
const OBJECTIVE = "Find web pages that answer a search query.";
const FRESHNESS_TBS: Readonly<Record<string, string>> = {
  day: "qdr:d",
  week: "qdr:w",
  month: "qdr:m",
  year: "qdr:y",
};

/** Firecrawl takes the location as an English country name. */
const countryName = (code: string): string | undefined => {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code);
  } catch {
    return undefined;
  }
};

export function parseFirecrawlResults(value: unknown): RawSearchResult[] {
  const root = mcpObject(value);
  if (root?.success === false) throw webSearchError("provider-unavailable", "Firecrawl search failed");
  const web = mcpObject(root?.data)?.web;
  if (!Array.isArray(web)) {
    throw webSearchError("provider-invalid-response", "Firecrawl returned an unreadable response");
  }
  return web.map((result) => {
    const row = mcpObject(result);
    return {
      title: row?.title,
      url: row?.url,
      snippet: mcpExcerpt(row?.description),
      publishedAt: null,
    };
  });
}

export function createFirecrawlProvider(options: KeylessMcpOptions = {}): SearchProvider {
  return {
    id: "firecrawl",
    name: "Firecrawl",
    requiresCredential: false,
    async search(request) {
      const args: Record<string, unknown> = {
        query: request.query,
        objective: OBJECTIVE,
        limit: request.count,
        sources: ["web"],
      };
      const locale = regionLocale(request.region);
      const location = locale ? countryName(locale.country) : undefined;
      if (location) args.location = location;
      if (request.freshness) args.tbs = FRESHNESS_TBS[request.freshness];
      return parseFirecrawlResults(await callKeylessMcpTool({
        endpoint: ENDPOINT,
        provider: "Firecrawl",
        tool: TOOL,
        arguments: args,
        signal: request.signal,
        timeoutMs: 15_000,
        maxBytes: 2 * 1024 * 1024,
      }, options));
    },
  };
}
