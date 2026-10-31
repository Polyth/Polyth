import { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync } from "node:zlib";
import {
  inspectOutboundHttpUrl,
  pinnedHttpRequest,
  type PinnedHttpRequest,
  type PinnedHttpResult,
  type Resolver,
} from "@polyth/outbound";
import { webSearchError } from "./errors.ts";

export type PageHttpTransport = (
  url: URL,
  addresses: readonly string[],
  init: PinnedHttpRequest,
) => Promise<PinnedHttpResult>;

export interface FetchedDocument {
  finalUrl: string;
  status: number;
  contentType: string;
  /** Decoded body text; binary content is rejected before decoding. */
  body: string;
  redirects: number;
}

export interface FetchDocumentOptions {
  signal: AbortSignal;
  resolve?: Resolver;
  transport?: PageHttpTransport;
  timeoutMs?: number;
  maxBytes?: number;
  maxDecodedBytes?: number;
  maxRedirects?: number;
}

export const WEB_FETCH_USER_AGENT = "Mozilla/5.0 (compatible; Polyth/1.0; +https://polyth.app)";
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_DECODED_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const TEXTUAL = /^(?:text\/|application\/(?:[\w.+-]*\+)?(?:json|xml)\b|application\/(?:javascript|ecmascript|x-javascript|x-ndjson|x-yaml|yaml|toml|x-sh|rss\+xml|atom\+xml)\b)/i;

export function isTextualContentType(contentType: string): boolean {
  return TEXTUAL.test(contentType.trim());
}

export function normalizeFetchUrl(value: unknown): URL {
  if (typeof value !== "string" || !value.trim()) throw webSearchError("invalid-input", "url is required");
  if (value.length > 4_096) throw webSearchError("invalid-input", "url must be at most 4096 characters");
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw webSearchError("invalid-input", "url must be an absolute http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw webSearchError("invalid-input", "url must use http or https");
  }
  if (url.username || url.password) throw webSearchError("invalid-input", "URLs with embedded credentials are not allowed");
  url.hash = "";
  return url;
}

const header = (headers: Headers, name: string): string => headers.get(name)?.trim() ?? "";

function decompress(body: Buffer, encoding: string, maxOutputLength: number): Buffer {
  const codings = encoding.toLowerCase().split(",").map((item) => item.trim()).filter((item) => item && item !== "identity");
  let current = body;
  for (const coding of codings.toReversed()) {
    try {
      if (coding === "gzip" || coding === "x-gzip") current = gunzipSync(current, { maxOutputLength });
      else if (coding === "br") current = brotliDecompressSync(current, { maxOutputLength });
      else if (coding === "deflate") {
        try {
          current = inflateSync(current, { maxOutputLength });
        } catch {
          current = inflateRawSync(current, { maxOutputLength });
        }
      } else throw webSearchError("fetch-unsupported", `the page uses an unsupported content encoding (${coding})`);
    } catch (cause) {
      if ((cause as { code?: string }).code === "fetch-unsupported") throw cause;
      if ((cause as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") {
        throw webSearchError("fetch-too-large", "the page is larger than web_fetch reads");
      }
      throw webSearchError("fetch-failed", "the page body could not be decompressed");
    }
  }
  return current;
}

function sniffCharset(contentType: string, body: Buffer): string {
  const declared = contentType.match(/charset\s*=\s*["']?([\w.:-]+)/i)?.[1];
  if (declared) return declared;
  if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) return "utf-8";
  if (body[0] === 0xff && body[1] === 0xfe) return "utf-16le";
  if (body[0] === 0xfe && body[1] === 0xff) return "utf-16be";
  if (/html|xml/i.test(contentType) || !contentType) {
    const head = body.subarray(0, 4_096).toString("latin1");
    const meta = head.match(/<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i)?.[1]
      ?? head.match(/<\?xml[^>]+encoding\s*=\s*["']([\w.:-]+)/i)?.[1];
    if (meta) return meta;
  }
  return "utf-8";
}

export function decodeBody(body: Buffer, contentType: string): string {
  const charset = sniffCharset(contentType, body);
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    decoder = new TextDecoder("utf-8");
  }
  return decoder.decode(body);
}

/** Looks binary when a sample has NUL bytes; servers often mislabel downloads as text. */
const looksBinary = (body: Buffer): boolean => body.subarray(0, 1_024).includes(0);

export async function fetchDocument(rawUrl: unknown, options: FetchDocumentOptions): Promise<FetchedDocument> {
  const transport = options.transport ?? ((url, addresses, init) => pinnedHttpRequest(url, addresses, init));
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  let url = normalizeFetchUrl(rawUrl);
  for (let redirects = 0; ; redirects += 1) {
    if (options.signal.aborted) throw webSearchError("aborted", "web fetch was cancelled");
    const inspected = await inspectOutboundHttpUrl(url.toString(), { policy: "public-only", resolve: options.resolve });
    if (!inspected.ok) throw webSearchError("fetch-blocked", `web_fetch cannot open this address: ${inspected.reason}`);

    let response: PinnedHttpResult;
    try {
      response = await transport(inspected.url, inspected.addresses, {
        method: "GET",
        headers: {
          "user-agent": WEB_FETCH_USER_AGENT,
          accept: "text/html,application/xhtml+xml,text/markdown;q=0.95,text/plain;q=0.9,application/json;q=0.9,application/xml;q=0.8,*/*;q=0.5",
          "accept-encoding": "gzip, deflate, br",
          "accept-language": "en;q=1.0, *;q=0.5",
        },
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
      });
    } catch (cause) {
      if (options.signal.aborted) throw webSearchError("aborted", "web fetch was cancelled");
      const code = (cause as { code?: string })?.code;
      if (code === "NETWORK_TIMEOUT") throw webSearchError("fetch-failed", "the page did not respond in time");
      if (code === "INVALID_REQUEST") throw webSearchError("fetch-too-large", "the page is larger than web_fetch reads");
      throw webSearchError("fetch-failed", "the page could not be reached");
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = header(response.headers, "location");
      if (!location) throw webSearchError("fetch-failed", `the page redirected (HTTP ${response.status}) without a location`);
      if (redirects >= maxRedirects) throw webSearchError("fetch-failed", "the page redirected too many times");
      try {
        url = normalizeFetchUrl(new URL(location, url).toString());
      } catch {
        throw webSearchError("fetch-blocked", "the page redirected to an address web_fetch cannot open");
      }
      continue;
    }

    const contentType = header(response.headers, "content-type").toLowerCase() || "";
    if (response.status >= 400) {
      throw webSearchError(
        "fetch-http-error",
        `the site answered HTTP ${response.status}${response.status === 401 || response.status === 403 || response.status === 429
          ? "; it may block automated readers, so open it with polyth_browser instead"
          : ""}`,
      );
    }
    const body = decompress(response.body, header(response.headers, "content-encoding"), options.maxDecodedBytes ?? DEFAULT_MAX_DECODED_BYTES);
    if ((contentType && !isTextualContentType(contentType)) || looksBinary(body)) {
      throw webSearchError(
        "fetch-unsupported",
        `web_fetch reads text pages only; this one is ${contentType.split(";")[0] || "binary"}${/pdf/.test(contentType)
          ? ". Download it with a shell tool and convert it locally, or open it with polyth_browser"
          : ""}`,
      );
    }
    return {
      finalUrl: url.toString(),
      status: response.status,
      contentType: contentType.split(";")[0]?.trim() || "text/plain",
      body: decodeBody(body, contentType),
      redirects,
    };
  }
}
