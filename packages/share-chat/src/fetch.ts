// Bounded read of one public share page. Every hop is checked with
// @polyth/outbound `public-only` policy and connected through a socket pinned
// to the validated address; redirects must stay on the adapter's hosts.
import { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync } from "node:zlib";
import {
  inspectOutboundHttpUrl,
  pinnedHttpRequest,
  type PinnedHttpRequest,
  type PinnedHttpResult,
  type Resolver,
} from "@polyth/outbound";
import { shareChatError } from "./errors.ts";
import { resolveShareUrl, type ShareChatAdapter } from "./parser.ts";

export type ShareHttpTransport = (
  url: URL,
  addresses: readonly string[],
  init: PinnedHttpRequest,
) => Promise<PinnedHttpResult>;

export interface FetchSharePageOptions {
  signal?: AbortSignal;
  resolve?: Resolver;
  transport?: ShareHttpTransport;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

export interface FetchedSharePage {
  /** Canonical share URL. */
  url: string;
  finalUrl: string;
  adapter: ShareChatAdapter;
  html: string;
}

export const SHARE_FETCH_USER_AGENT = "Mozilla/5.0 (compatible; Polyth/1.0; +https://polyth.app)";
export const SHARE_FETCH_TIMEOUT_MS = 20_000;
/** Hard cap on the wire and again after decompression. */
export const SHARE_FETCH_MAX_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function httpError(status: number, host: string): Error {
  const detail = status === 404 || status === 410
    ? "the shared chat was not found; the link may be deleted, private or mistyped"
    : status === 401 || status === 403 || status === 429
      ? `${host} refused the request; the share may be private, or the site may be limiting automated readers`
      : `${host} could not serve the share page`;
  return shareChatError(`http-${status}`, `${detail} (HTTP ${status})`);
}

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
      } else throw shareChatError("unreadable-page", `the share page uses an unsupported content encoding (${coding})`);
    } catch (cause) {
      if ((cause as { code?: string }).code === "unreadable-page") throw cause;
      if ((cause as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") {
        throw shareChatError("too-large", "the share page is larger than shared_chat reads (8 MiB)");
      }
      throw shareChatError("unreadable-page", "the share page body could not be decompressed");
    }
  }
  return current;
}

function decode(body: Buffer, contentType: string): string {
  const charset = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType)?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

export async function fetchSharePage(rawUrl: unknown, options: FetchSharePageOptions = {}): Promise<FetchedSharePage> {
  const { url, adapter } = resolveShareUrl(rawUrl);
  const timeoutMs = options.timeoutMs ?? SHARE_FETCH_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? SHARE_FETCH_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const transport: ShareHttpTransport = options.transport ?? ((target, addresses, init) => pinnedHttpRequest(target, addresses, init));
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  try {
    return await read(url, adapter, { ...options, signal, timeoutMs, maxBytes, maxRedirects, transport });
  } catch (cause) {
    if (!signal.aborted) throw cause;
    throw options.signal?.aborted
      ? shareChatError("aborted", "the shared chat read was cancelled")
      : shareChatError("timeout", `the share page did not load within ${Math.round(timeoutMs / 1_000)} s`);
  } finally {
    clearTimeout(timer);
  }
}

async function read(
  url: string,
  adapter: ShareChatAdapter,
  options: Required<Omit<FetchSharePageOptions, "resolve">> & Pick<FetchSharePageOptions, "resolve">,
): Promise<FetchedSharePage> {
  const { signal, timeoutMs, maxBytes, maxRedirects, transport } = options;
  // fetchSharePage turns this into `aborted` or `timeout`.
  const stopped = (): Error => shareChatError("aborted", "the shared chat read was stopped");
  let current = new URL(url);
  for (let redirects = 0; ; redirects += 1) {
    if (signal.aborted) throw stopped();
    const inspected = await inspectOutboundHttpUrl(current.toString(), { policy: "public-only", resolve: options.resolve });
    if (signal.aborted) throw stopped();
    if (!inspected.ok) throw shareChatError("blocked", `shared_chat cannot open ${current.hostname}: ${inspected.reason}`);

    let response: PinnedHttpResult;
    try {
      response = await transport(inspected.url, inspected.addresses, {
        method: "GET",
        headers: {
          "user-agent": SHARE_FETCH_USER_AGENT,
          accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
          "accept-encoding": "gzip, deflate, br",
          "accept-language": "en;q=1.0, *;q=0.5",
        },
        signal,
        timeoutMs,
        maxBytes,
      });
    } catch (cause) {
      if (signal.aborted) throw stopped();
      const code = (cause as { code?: string })?.code;
      if (code === "NETWORK_TIMEOUT") throw shareChatError("timeout", `${current.hostname} stopped responding`);
      if (code === "INVALID_REQUEST") throw shareChatError("too-large", "the share page is larger than shared_chat reads (8 MiB)");
      throw shareChatError("network", `${current.hostname} could not be reached`);
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get("location")?.trim();
      if (!location) throw httpError(response.status, current.hostname);
      if (redirects >= maxRedirects) throw shareChatError("unreadable-page", "the share page redirected too many times");
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw shareChatError("unreadable-page", "the share page redirected to an invalid address");
      }
      if ((next.protocol !== "https:" && next.protocol !== "http:") || next.username || next.password
        || !adapter.hosts.includes(next.hostname.toLowerCase())) {
        throw shareChatError("unsupported-host", `the share link redirected away from ${adapter.hosts.join("/")}`);
      }
      next.hash = "";
      current = next;
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw httpError(response.status, current.hostname);

    const contentType = response.headers.get("content-type")?.trim().toLowerCase() ?? "";
    if (contentType && !/^text\/(?:html|plain)\b|^application\/xhtml\+xml\b/.test(contentType)) {
      throw shareChatError("unreadable-page", `the share link returned ${contentType.split(";")[0]}, not a web page`);
    }
    const body = decompress(response.body, response.headers.get("content-encoding") ?? "", maxBytes);
    if (body.subarray(0, 1_024).includes(0)) throw shareChatError("unreadable-page", "the share link returned binary data");
    return { url, finalUrl: current.toString(), adapter, html: decode(body, contentType) };
  }
}
