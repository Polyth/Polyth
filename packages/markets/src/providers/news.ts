import type { MarketProvider } from "../providers.ts";
import type { MarketNewsItem } from "../types.ts";
import { createLimiter, fetchText, USER_AGENT, type FetchLike } from "./http.ts";

export interface NewsProviderOptions {
  fetch?: FetchLike;
}

function decodeXml(value: string): string {
  return value
    .replace(/^<!\[CDATA\[|\]\]>$/g, "")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .trim();
}

function tag(block: string, name: string): string | undefined {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i").exec(block);
  return match?.[1] ? decodeXml(match[1]) : undefined;
}

function safeUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function parseMarketRss(xml: string, symbol: string, source: string, fallbackPublisher: string): MarketNewsItem[] {
  const items = xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) ?? [];
  const out: MarketNewsItem[] = [];
  for (const item of items.slice(0, 50)) {
    const title = tag(item, "title");
    const url = safeUrl(tag(item, "link"));
    if (!title || !url) continue;
    const rawDate = tag(item, "pubDate");
    const time = rawDate ? Date.parse(rawDate) : Number.NaN;
    out.push({
      title,
      url,
      publisher: tag(item, "source") ?? fallbackPublisher,
      ...(Number.isFinite(time) ? { publishedAt: new Date(time).toISOString() } : {}),
      symbol,
      source,
    });
  }
  return out;
}

export function dedupeMarketNews(items: readonly MarketNewsItem[], limit = 30): MarketNewsItem[] {
  const seenTitles = new Set<string>();
  const seenUrls = new Set<string>();
  const out: MarketNewsItem[] = [];
  const sorted = [...items].sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
  for (const item of sorted) {
    const titleKey = item.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 100);
    if (!titleKey || seenTitles.has(titleKey) || seenUrls.has(item.url)) continue;
    seenTitles.add(titleKey);
    seenUrls.add(item.url);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

function createRssProvider(
  id: string,
  fallbackPublisher: string,
  urlFor: (symbol: string) => string,
  options: NewsProviderOptions,
): MarketProvider {
  const fetchImpl = options.fetch ?? fetch;
  const limit = createLimiter(2);
  return {
    id,
    async news(symbol, signal) {
      const xml = await limit(() => fetchText(fetchImpl, urlFor(symbol), {
        signal,
        headers: { "User-Agent": USER_AGENT, Accept: "application/rss+xml, application/xml, text/xml" },
      }, id));
      const items = parseMarketRss(xml, symbol, id, fallbackPublisher);
      if (items.length === 0) throw new Error(`${id}: empty feed for ${symbol}`);
      return items;
    },
  };
}

export function createYahooNewsProvider(options: NewsProviderOptions = {}): MarketProvider {
  return createRssProvider(
    "yahoo-news",
    "Yahoo Finance",
    (symbol) => `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(symbol)}&region=US&lang=en-US`,
    options,
  );
}

export function createGoogleNewsProvider(options: NewsProviderOptions = {}): MarketProvider {
  return createRssProvider(
    "google-news",
    "Google News",
    (symbol) => `https://news.google.com/rss/search?q=${encodeURIComponent(`${symbol} stock`)}&hl=en-US&gl=US&ceid=US:en`,
    options,
  );
}
