import type { Resolver } from "@polyth/outbound";
import { webSearchError } from "../errors.ts";
import { providerHttpRequest, type ProviderHttpTransport } from "../http.ts";
import { decodeHtmlEntities, htmlToText } from "../results.ts";
import type { RawSearchResult, SearchProvider } from "../types.ts";

const ENDPOINT = "https://lite.duckduckgo.com/lite/";
const FRESHNESS_PARAM: Readonly<Record<string, string>> = {
  day: "d",
  week: "w",
  month: "m",
  year: "y",
};
const SAFE_SEARCH_PARAM: Readonly<Record<string, string>> = {
  strict: "-2",
  moderate: "-1",
  off: "1",
};

const attribute = (source: string, name: string): string | null => {
  const match = source.match(new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i"));
  return match?.[2] ?? null;
};

const unwrapDuckDuckGoUrl = (raw: string): string | null => {
  const decoded = decodeHtmlEntities(raw.trim());
  let url: URL;
  try {
    url = new URL(decoded, "https://duckduckgo.com");
  } catch {
    return null;
  }
  if (url.hostname === "duckduckgo.com" && url.pathname === "/l/") {
    return url.searchParams.get("uddg");
  }
  return url.toString();
};

export function parseDuckDuckGoResults(html: string): RawSearchResult[] {
  const results: RawSearchResult[] = [];
  let pending: RawSearchResult | undefined;
  for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const source = row[1] ?? "";
    const link = source.match(/<a\b([^>]*\bclass\s*=\s*(["'])result-link\2[^>]*)>([\s\S]*?)<\/a>/i);
    if (link) {
      if (pending) results.push(pending);
      const href = attribute(link[1] ?? "", "href");
      const url = href ? unwrapDuckDuckGoUrl(href) : null;
      pending = url ? {
        title: htmlToText(link[3] ?? ""),
        url,
        snippet: "",
        publishedAt: null,
      } : undefined;
      continue;
    }
    if (pending) {
      const snippet = source.match(/<td\b[^>]*\bclass\s*=\s*(["'])result-snippet\1[^>]*>([\s\S]*?)<\/td>/i);
      pending.snippet = snippet ? htmlToText(snippet[2] ?? "") : "";
      results.push(pending);
      pending = undefined;
    }
  }
  if (pending) results.push(pending);
  return results;
}

export function createDuckDuckGoProvider(options: {
  resolve?: Resolver;
  transport?: ProviderHttpTransport;
} = {}): SearchProvider {
  return {
    id: "duckduckgo",
    name: "DuckDuckGo",
    requiresCredential: false,
    async search(request) {
      const url = new URL(ENDPOINT);
      url.searchParams.set("q", request.query);
      url.searchParams.set("kp", SAFE_SEARCH_PARAM[request.safeSearch]!);
      if (request.region !== "wt-wt") url.searchParams.set("kl", request.region);
      if (request.freshness) url.searchParams.set("df", FRESHNESS_PARAM[request.freshness]!);

      const result = await providerHttpRequest(url.toString(), {
        method: "GET",
        headers: {
          accept: "text/html,application/xhtml+xml",
          "accept-language": "en-US,en;q=0.8",
          "user-agent": "Polyth/0.1 WebSearch",
        },
        signal: request.signal,
        timeoutMs: 10_000,
        maxBytes: 2 * 1024 * 1024,
      }, options);
      if (result.status < 200 || result.status >= 300) {
        if (result.status === 429) throw webSearchError("rate-limited", "DuckDuckGo rate limit reached");
        throw webSearchError("provider-unavailable", `DuckDuckGo search failed (${result.status})`);
      }
      const html = result.body.toString("utf8");
      if (!/<title\b/i.test(html) || !/duckduckgo/i.test(html)) {
        throw webSearchError("provider-invalid-response", "DuckDuckGo returned an unreadable response");
      }
      return parseDuckDuckGoResults(html);
    },
  };
}
