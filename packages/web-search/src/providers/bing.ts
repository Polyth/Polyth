import type { Resolver } from "@polyth/outbound";
import { webSearchError } from "../errors.ts";
import { providerHttpRequest, type ProviderHttpTransport } from "../http.ts";
import { regionLocale } from "../region.ts";
import { decodeHtmlEntities, htmlToText } from "../results.ts";
import type { RawSearchResult, SearchProvider } from "../types.ts";

/**
 * Bing's ordinary results page, read without a key. It is the last resort of
 * the keyless chain: the markup is not a contract, and Bing answers clients it
 * distrusts with a normal-looking page about something else entirely, which
 * `bingResultsMatchQuery` turns back into an error.
 */
const ENDPOINT = "https://www.bing.com/search";
const SAFE_SEARCH_PARAM: Readonly<Record<string, string>> = {
  strict: "strict",
  moderate: "demote",
  off: "off",
};
const FRESHNESS_FILTER: Readonly<Record<string, string>> = {
  day: 'ex1:"ez1"',
  week: 'ex1:"ez2"',
  month: 'ex1:"ez3"',
};
const DAY_MS = 24 * 60 * 60 * 1000;
const RESULT_START_RE = /<li\b[^>]*\bclass\s*=\s*"b_algo\b/i;
const RESULT_LIST_END_RE = /<li\b[^>]*\bclass\s*=\s*"b_pag\b|<\/ol>/i;
const NO_WORD_BREAKS_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;
const STOP_WORDS = new Set([
  "about", "and", "are", "can", "does", "for", "from", "how", "into", "not", "that", "the", "this",
  "use", "using", "was", "what", "when", "where", "which", "who", "why", "with", "you", "your",
]);

const attribute = (source: string, name: string): string | null => {
  const match = source.match(new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i"));
  return match?.[2] ?? null;
};

/** Bing links results through `/ck/a?...&u=a1<base64url of the target>`. */
const unwrapBingUrl = (raw: string): string | null => {
  let url: URL;
  try {
    url = new URL(decodeHtmlEntities(raw.trim()), "https://www.bing.com");
  } catch {
    return null;
  }
  const onBing = url.hostname === "bing.com" || url.hostname.endsWith(".bing.com");
  if (!onBing || !url.pathname.startsWith("/ck/")) return url.toString();
  const target = url.searchParams.get("u");
  if (!target?.startsWith("a1")) return null;
  const decoded = Buffer.from(target.slice(2), "base64url").toString("utf8");
  return /^https?:\/\//i.test(decoded) ? decoded : null;
};

export function parseBingResults(html: string): RawSearchResult[] {
  const results: RawSearchResult[] = [];
  const blocks = html.split(new RegExp(RESULT_START_RE.source, "gi")).slice(1);
  blocks.forEach((raw, index) => {
    const end = index === blocks.length - 1 ? raw.search(RESULT_LIST_END_RE) : -1;
    const block = end >= 0 ? raw.slice(0, end) : raw;
    const link = block.match(/<h2\b[^>]*>\s*<a\b([^>]*)>([\s\S]*?)<\/a>/i);
    const href = link ? attribute(link[1] ?? "", "href") : null;
    const url = href ? unwrapBingUrl(href) : null;
    if (!link || !url) return;
    const snippet = block.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
    results.push({
      title: htmlToText(link[2] ?? ""),
      url,
      snippet: snippet ? htmlToText(snippet[1] ?? "") : "",
      publishedAt: null,
    });
  });
  return results;
}

const stem = (word: string): string => word.length > 5 ? word.slice(0, -2) : word;

/**
 * Whether a result page is about the query at all: at least a third of the
 * results must mention one of its significant words. Queries in scripts
 * without word breaks, and queries of stop words only, are not judged.
 */
export function bingResultsMatchQuery(query: string, results: readonly RawSearchResult[]): boolean {
  if (results.length === 0 || NO_WORD_BREAKS_RE.test(query)) return true;
  const words = query.toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word))
    .map(stem);
  if (words.length === 0) return true;
  const matching = results.filter((result) => {
    const text = `${String(result.title ?? "")} ${String(result.snippet ?? "")} ${String(result.url ?? "")}`.toLocaleLowerCase();
    return words.some((word) => text.includes(word));
  }).length;
  return matching * 3 >= results.length;
}

export function createBingProvider(options: {
  resolve?: Resolver;
  transport?: ProviderHttpTransport;
  now?: () => number;
} = {}): SearchProvider {
  return {
    id: "bing",
    name: "Bing",
    requiresCredential: false,
    async search(request) {
      const url = new URL(ENDPOINT);
      url.searchParams.set("q", request.query);
      url.searchParams.set("count", String(request.count));
      url.searchParams.set("adlt", SAFE_SEARCH_PARAM[request.safeSearch]!);
      const locale = regionLocale(request.region);
      if (locale) {
        url.searchParams.set("mkt", `${locale.language}-${locale.country}`);
        url.searchParams.set("setlang", locale.language);
      }
      if (request.freshness === "year") {
        const today = Math.floor((options.now ?? Date.now)() / DAY_MS);
        url.searchParams.set("filters", `ex1:"ez5_${today - 365}_${today}"`);
      } else if (request.freshness) {
        url.searchParams.set("filters", FRESHNESS_FILTER[request.freshness]!);
      }

      const result = await providerHttpRequest(url.toString(), {
        method: "GET",
        headers: {
          accept: "text/html,application/xhtml+xml",
          "accept-language": locale ? `${locale.language}-${locale.country},${locale.language};q=0.8,en;q=0.5` : "en-US,en;q=0.8",
          "user-agent": "Polyth/0.1 WebSearch",
        },
        signal: request.signal,
        timeoutMs: 10_000,
        maxBytes: 2 * 1024 * 1024,
      }, options);
      if (result.status === 429) throw webSearchError("rate-limited", "Bing rate limit reached");
      if (result.status < 200 || result.status >= 300) {
        throw webSearchError("provider-unavailable", `Bing search failed (${result.status})`);
      }
      const html = result.body.toString("utf8");
      const results = parseBingResults(html);
      if (results.length === 0) {
        // Bing marks a genuine empty page; anything else is a challenge or changed markup.
        if (/\bclass\s*=\s*"b_no\b/i.test(html)) return [];
        if (/captcha|challenge/i.test(html)) throw webSearchError("rate-limited", "Bing asked for a verification");
        throw webSearchError("provider-invalid-response", "Bing returned an unreadable response");
      }
      if (!bingResultsMatchQuery(request.query, results)) {
        throw webSearchError("provider-invalid-response", "Bing returned results unrelated to the query");
      }
      return results;
    },
  };
}
