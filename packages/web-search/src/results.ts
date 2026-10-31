import { isIP } from "node:net";
import { isBlockedIp } from "@polyth/outbound";
import type { RawSearchResult, WebSearchResult } from "./types.ts";

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  gt: ">",
  hellip: "…",
  laquo: "«",
  ldquo: "“",
  lsquo: "‘",
  lt: "<",
  mdash: "—",
  nbsp: " ",
  ndash: "–",
  quot: '"',
  raquo: "»",
  rdquo: "”",
  rsquo: "’",
};

export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

export function htmlToText(value: string): string {
  return decodeHtmlEntities(
    value
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}

const bounded = (value: string, maximum: number): string => {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, Math.max(0, maximum - 1)).trimEnd()}…`;
};

export function normalizeResultUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim() || value.length > 4_096) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return null;
  if (isIP(hostname) && isBlockedIp(hostname)) return null;
  url.hash = "";
  return url.toString();
}

export function normalizePublishedAt(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

export function normalizeSearchResults(raw: readonly RawSearchResult[]): WebSearchResult[] {
  const seen = new Set<string>();
  const results: WebSearchResult[] = [];
  for (const item of raw) {
    const url = normalizeResultUrl(item.url);
    if (!url) continue;
    let key = url;
    try {
      const parsed = new URL(url);
      key = `${parsed.hostname.toLowerCase()}${parsed.pathname}${parsed.search}`;
    } catch {
      // normalizeResultUrl already produced a valid URL.
    }
    if (seen.has(key)) continue;
    seen.add(key);
    const title = typeof item.title === "string" ? bounded(item.title, 500) : "";
    const snippet = typeof item.snippet === "string" ? bounded(item.snippet, 4_000) : "";
    results.push({
      rank: results.length + 1,
      title: title || new URL(url).hostname,
      url,
      snippet: snippet || null,
      publishedAt: normalizePublishedAt(item.publishedAt),
    });
  }
  return results;
}
