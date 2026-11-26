import { webSearchError } from "../errors.ts";
import type { RawSearchResult, SearchProvider } from "../types.ts";
import { callKeylessMcpTool, mcpExcerpt, mcpObject, type KeylessMcpOptions } from "./mcp.ts";

/** Parallel's Search MCP is free without a key, for light use. */
const ENDPOINT = "https://search.parallel.ai/mcp";
const TOOL = "web_search";
/** The tool has no date filter; its objective accepts freshness guidance in words. */
const FRESHNESS_HINT: Readonly<Record<string, string>> = {
  day: "the last 24 hours",
  week: "the last 7 days",
  month: "the last month",
  year: "the last year",
};

export function parseParallelResults(value: unknown): RawSearchResult[] {
  const root = mcpObject(value);
  if (!root || !Array.isArray(root.results)) {
    throw webSearchError("provider-invalid-response", "Parallel returned an unreadable response");
  }
  return root.results.map((result) => {
    const row = mcpObject(result);
    return {
      title: row?.title,
      url: row?.url,
      snippet: mcpExcerpt(row?.excerpts),
      publishedAt: row?.publish_date,
    };
  });
}

export function createParallelProvider(options: KeylessMcpOptions = {}): SearchProvider {
  return {
    id: "parallel",
    name: "Parallel",
    requiresCredential: false,
    async search(request) {
      const objective = request.freshness
        ? `${request.query}\n\nOnly include pages published within ${FRESHNESS_HINT[request.freshness]}.`
        : request.query;
      return parseParallelResults(await callKeylessMcpTool({
        endpoint: ENDPOINT,
        provider: "Parallel",
        tool: TOOL,
        arguments: { objective, search_queries: [request.query] },
        signal: request.signal,
        timeoutMs: 15_000,
        maxBytes: 2 * 1024 * 1024,
      }, options));
    },
  };
}
