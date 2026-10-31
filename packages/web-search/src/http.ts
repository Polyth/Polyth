import {
  pinnedHttpRequest,
  resolvePublicHttpsUrl,
  type PinnedHttpRequest,
  type PinnedHttpResult,
  type Resolver,
} from "@polyth/outbound";
import { webSearchError } from "./errors.ts";

export type ProviderHttpTransport = (
  url: URL,
  pin: { address: string; family: 4 | 6 },
  init: PinnedHttpRequest,
) => Promise<PinnedHttpResult>;

export interface ProviderHttpRequest {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  signal: AbortSignal;
  timeoutMs: number;
  maxBytes: number;
}

export async function providerHttpRequest(
  rawUrl: string,
  request: ProviderHttpRequest,
  options: {
    resolve?: Resolver;
    transport?: ProviderHttpTransport;
  } = {},
): Promise<PinnedHttpResult> {
  let resolved: { url: URL; pin: { address: string; family: 4 | 6 } };
  try {
    resolved = await resolvePublicHttpsUrl(rawUrl, "public", options.resolve);
  } catch (cause) {
    if (request.signal.aborted) throw webSearchError("aborted", "web search was cancelled");
    if ((cause as { code?: string })?.code === "NETWORK_ORIGIN_DENIED") {
      throw webSearchError("provider-unavailable", "the search provider origin is unavailable");
    }
    throw webSearchError("provider-unavailable", "the search provider could not be resolved");
  }

  try {
    const result = await (options.transport ?? pinnedHttpRequest)(resolved.url, resolved.pin, {
      method: request.method ?? "GET",
      headers: request.headers,
      body: request.body,
      signal: request.signal,
      timeoutMs: request.timeoutMs,
      maxBytes: request.maxBytes,
    });
    if (result.status >= 300 && result.status < 400) {
      throw webSearchError("provider-unavailable", "the search provider returned an unsupported redirect");
    }
    return result;
  } catch (cause) {
    if (request.signal.aborted || (cause as { name?: string })?.name === "AbortError") {
      throw webSearchError("aborted", "web search was cancelled");
    }
    if ((cause as { code?: string })?.code === "NETWORK_ORIGIN_DENIED") {
      throw webSearchError("provider-unavailable", "the search provider origin is unavailable");
    }
    throw webSearchError("provider-unavailable", "the search provider is unreachable");
  }
}
