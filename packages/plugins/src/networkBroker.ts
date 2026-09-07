import { lookup as dnsLookupNative } from "node:dns/promises";
import { pinnedHttpRequest, resolvePublicHttpsUrl } from "@polyth/outbound";

export { isBlockedIp, resolvePublicHttpsUrl } from "@polyth/outbound";

const BLOCKED_HEADERS = new Set([
  "authorization", "cookie", "cookie2", "host", "proxy-authorization",
  "x-polyth-space", "x-forwarded-for", "x-forwarded-host", "x-real-ip",
]);
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);
const MAX_BODY = 64 * 1024;
const MAX_RESPONSE = 256 * 1024;
export const MAX_INSTALL_BYTES = 32 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 20_000;

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

const defaultLookup = async (hostname: string): Promise<{ address: string }[]> => {
  const results = await dnsLookupNative(hostname, { all: true, verbatim: true });
  return results.map((row) => ({ address: row.address }));
};

const asResolver = (
  lookup: (hostname: string) => Promise<{ address: string }[]>,
) => async (hostname: string): Promise<string[]> =>
  (await lookup(hostname)).map((row) => row.address);

function headerRecord(headers: Headers): Record<string, string> {
  const contentType = headers.get("content-type");
  return contentType ? { "content-type": contentType } : {};
}

async function followHttps(
  raw: string,
  origins: readonly string[] | "public",
  init: {
    method: string;
    headers?: Record<string, string>;
    body?: string;
    authorization?: { header: string; value: string };
    timeoutMs?: number;
    maxBytes: number;
    dnsLookup?: (hostname: string) => Promise<{ address: string }[]>;
  },
): Promise<{ status: number; body: Buffer; headers: Record<string, string> }> {
  let current = raw;
  let redirected = 0;
  while (true) {
    const resolved = await resolvePublicHttpsUrl(
      current,
      origins,
      asResolver(init.dnsLookup ?? defaultLookup),
    );
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (init.authorization && redirected === 0) {
      headers[init.authorization.header] = init.authorization.value;
    }
    const result = await pinnedHttpRequest(resolved.url, resolved.pin, {
      method: redirected === 0 ? init.method : "GET",
      headers,
      body: redirected === 0 ? init.body : undefined,
      timeoutMs: init.timeoutMs ?? TIMEOUT_MS,
      maxBytes: init.maxBytes,
    });
    if (result.status >= 300 && result.status < 400) {
      const loc = result.headers.get("location");
      if (!loc || redirected >= MAX_REDIRECTS) fail("NETWORK_ORIGIN_DENIED", "redirect is not allowed");
      current = new URL(loc, resolved.url).toString();
      redirected += 1;
      continue;
    }
    return { status: result.status, body: result.body, headers: headerRecord(result.headers) };
  }
}

export interface BrokerFetchInput {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  authorization?: { header: string; value: string };
}

export interface BrokerFetchResult {
  status: number;
  body: string;
  headers: Record<string, string>;
}

export interface PublicFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  maxBytes?: number;
  timeoutMs?: number;
  dnsLookup?: (hostname: string) => Promise<{ address: string }[]>;
}

export async function fetchPublicHttps(raw: string, opts: PublicFetchOptions = {}): Promise<BrokerFetchResult> {
  const method = (opts.method ?? "GET").toUpperCase();
  if (!METHODS.has(method)) fail("INVALID_REQUEST", `method ${method} is not allowed`);
  const result = await followHttps(raw, "public", {
    method,
    headers: opts.headers,
    body: opts.body,
    timeoutMs: opts.timeoutMs,
    maxBytes: opts.maxBytes ?? MAX_RESPONSE,
    dnsLookup: opts.dnsLookup,
  });
  return { status: result.status, body: result.body.toString("utf8"), headers: result.headers };
}

export async function downloadPublicHttps(
  raw: string,
  opts: { maxBytes?: number; timeoutMs?: number; dnsLookup?: (hostname: string) => Promise<{ address: string }[]> } = {},
): Promise<Buffer> {
  const result = await followHttps(raw, "public", {
    method: "GET",
    timeoutMs: opts.timeoutMs ?? 60_000,
    maxBytes: opts.maxBytes ?? MAX_INSTALL_BYTES,
    dnsLookup: opts.dnsLookup,
  });
  if (result.status < 200 || result.status >= 300) {
    fail("invalid-input", `zip download failed (${result.status})`);
  }
  return result.body;
}

export async function brokerFetch(
  input: BrokerFetchInput,
  origins: readonly string[],
): Promise<BrokerFetchResult> {
  const method = (input.method ?? "GET").toUpperCase();
  if (!METHODS.has(method)) fail("INVALID_REQUEST", `method ${method} is not allowed`);
  if (input.body !== undefined && input.body.length > MAX_BODY) fail("INVALID_REQUEST", "request body exceeds limit");
  for (const key of Object.keys(input.headers ?? {})) {
    if (BLOCKED_HEADERS.has(key.toLowerCase())) fail("INVALID_REQUEST", `header ${key} is not allowed`);
  }
  const result = await followHttps(input.url, origins, {
    method,
    headers: input.headers,
    body: method === "GET" || method === "HEAD" ? undefined : input.body,
    authorization: input.authorization,
    maxBytes: MAX_RESPONSE,
  });
  return { status: result.status, body: result.body.toString("utf8"), headers: result.headers };
}
