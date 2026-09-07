import { lookup as dnsLookupNative } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { Readable } from "node:stream";

export type Resolver = (hostname: string) => Promise<string[]>;

const defaultResolve: Resolver = async (hostname) => {
  const results = await dnsLookupNative(hostname, { all: true, verbatim: true });
  return results.map((row) => row.address);
};

const META_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.google.com",
  "instance-data",
]);

const BLOCKED_SCHEMES = new Set([
  "file:", "data:", "javascript:", "about:", "chrome:", "blob:", "ws:", "wss:", "ftp:", "vbscript:",
]);

const METADATA_OR_LINK_LOCAL = new BlockList();
METADATA_OR_LINK_LOCAL.addSubnet("169.254.0.0", 16, "ipv4");
METADATA_OR_LINK_LOCAL.addSubnet("0.0.0.0", 8, "ipv4");
METADATA_OR_LINK_LOCAL.addSubnet("fe80::", 10, "ipv6");
METADATA_OR_LINK_LOCAL.addSubnet("::", 128, "ipv6");
METADATA_OR_LINK_LOCAL.addSubnet("fd00:ec2::", 32, "ipv6");

const LOOPBACK = new BlockList();
LOOPBACK.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK.addSubnet("::1", 128, "ipv6");

const PRIVATE = new BlockList();
PRIVATE.addSubnet("10.0.0.0", 8, "ipv4");
PRIVATE.addSubnet("127.0.0.0", 8, "ipv4");
PRIVATE.addSubnet("169.254.0.0", 16, "ipv4");
PRIVATE.addSubnet("172.16.0.0", 12, "ipv4");
PRIVATE.addSubnet("192.168.0.0", 16, "ipv4");
PRIVATE.addSubnet("100.64.0.0", 10, "ipv4");
PRIVATE.addSubnet("198.18.0.0", 15, "ipv4");
PRIVATE.addSubnet("192.0.0.0", 24, "ipv4");
PRIVATE.addSubnet("224.0.0.0", 4, "ipv4");
PRIVATE.addSubnet("240.0.0.0", 4, "ipv4");
PRIVATE.addSubnet("0.0.0.0", 8, "ipv4");
PRIVATE.addSubnet("::1", 128, "ipv6");
PRIVATE.addSubnet("::", 128, "ipv6");
PRIVATE.addSubnet("fe80::", 10, "ipv6");
PRIVATE.addSubnet("fc00::", 7, "ipv6");
PRIVATE.addSubnet("fd00:ec2::", 32, "ipv6");

const listed = (list: BlockList, ip: string): boolean => {
  const host = ip.replace(/^\[|\]$/g, "");
  if (host.startsWith("::ffff:")) return listed(list, host.slice("::ffff:".length));
  const version = isIP(host);
  if (version === 4) return list.check(host, "ipv4");
  if (version === 6) return list.check(host, "ipv6");
  return true;
};

export function isBlockedIp(ip: string): boolean {
  return isMetadataOrLinkLocal(ip) || isPrivateAddress(ip);
}

export const isMetadataOrLinkLocal = (ip: string): boolean => listed(METADATA_OR_LINK_LOCAL, ip);

export const isLoopbackAddress = (ip: string): boolean => listed(LOOPBACK, ip);

export const isPrivateAddress = (ip: string): boolean => listed(PRIVATE, ip);

export type OutboundDecision =
  | { ok: true; url: URL; addresses: string[] }
  | { ok: false; reason: string };

export const inspectOutboundHttpUrl = async (
  raw: string,
  opts: {
    policy: "public-only" | "user-origin";
    resolve?: Resolver;
  },
): Promise<OutboundDecision> => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  const scheme = url.protocol.toLowerCase();
  if (BLOCKED_SCHEMES.has(scheme) || (scheme !== "http:" && scheme !== "https:")) {
    return { ok: false, reason: `scheme ${scheme} is not allowed` };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "URLs with embedded credentials are not allowed" };
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (META_HOSTS.has(host) || host.endsWith(".metadata.google.internal")) {
    return { ok: false, reason: "metadata host is blocked" };
  }

  const literalIp = isIP(host);
  if (literalIp) {
    if (isMetadataOrLinkLocal(host)) return { ok: false, reason: "metadata or link-local address is blocked" };
    if (opts.policy === "public-only" && isPrivateAddress(host)) {
      return { ok: false, reason: "private network address is blocked" };
    }
    return { ok: true, url, addresses: [host] };
  }

  let addresses: string[];
  try {
    addresses = await (opts.resolve ?? defaultResolve)(host);
  } catch {
    return { ok: false, reason: "DNS lookup failed" };
  }
  if (!addresses.length) return { ok: false, reason: "DNS lookup returned no addresses" };
  for (const address of addresses) {
    if (isMetadataOrLinkLocal(address)) {
      return { ok: false, reason: "hostname resolved to a metadata or link-local address" };
    }
    if (opts.policy === "public-only" && isPrivateAddress(address)) {
      return { ok: false, reason: "hostname resolved to a private address" };
    }
  }
  return { ok: true, url, addresses };
};

export interface ResolvedHttpsUrl {
  url: URL;
  pin: { address: string; family: 4 | 6 };
}

export async function resolvePublicHttpsUrl(
  raw: string,
  origins: readonly string[] | "public",
  dnsLookup: Resolver = defaultResolve,
): Promise<ResolvedHttpsUrl> {
  const fail = (message: string) => {
    throw Object.assign(new Error(message), { code: "NETWORK_ORIGIN_DENIED" });
  };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail("not a valid URL");
  }
  if (url.protocol !== "https:") return fail("only https URLs are allowed");
  if (origins !== "public" && !origins.includes(url.origin)) {
    return fail(`origin ${url.origin} is not declared`);
  }
  const inspected = await inspectOutboundHttpUrl(raw, {
    policy: "public-only",
    resolve: dnsLookup,
  });
  if (!inspected.ok) return fail(inspected.reason);
  url = inspected.url;
  const address = inspected.addresses[0]!;
  const family: 4 | 6 = isIP(address) === 6 ? 6 : 4;
  return { url, pin: { address, family } };
}

export interface PinnedHttpRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface PinnedHttpResult {
  status: number;
  headers: Headers;
  body: Buffer;
}

const familyOf = (address: string): 4 | 6 => (address.includes(":") ? 6 : 4);

function pinOf(
  pin: { address: string; family: 4 | 6 } | readonly string[],
): { address: string; family: 4 | 6 } | null {
  if ("address" in pin) return pin.address ? pin : null;
  const address = pin[0];
  if (!address) return null;
  return { address, family: familyOf(address) };
}

/** Connect to an already-validated pinned IP. Preserves TLS SNI and Host. */
export function pinnedHttpRequest(
  url: URL,
  pin: { address: string; family: 4 | 6 } | readonly string[],
  init: PinnedHttpRequest = {},
): Promise<PinnedHttpResult> {
  const resolved = pinOf(pin);
  if (!resolved) return Promise.reject(new Error("no pinned address"));
  const tls = url.protocol === "https:";
  const send = tls ? httpsRequest : httpRequest;
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const port = url.port ? Number(url.port) : tls ? 443 : 80;
  const method = (init.method ?? "GET").toUpperCase();
  const maxBytes = init.maxBytes;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const req = send({
      protocol: url.protocol,
      hostname: resolved.address,
      port,
      path: `${url.pathname}${url.search}`,
      method,
      headers: { ...init.headers, host: url.host },
      ...(tls ? { servername: hostname } : {}),
      family: resolved.family,
      lookup: (_host, _opts, callback) => {
        (callback as (err: NodeJS.ErrnoException | null, address: string, family: number) => void)(
          null,
          resolved.address,
          resolved.family,
        );
      },
      signal: init.signal,
    }, (incoming) => {
      const chunks: Buffer[] = [];
      let size = 0;
      incoming.on("data", (chunk: Buffer | string) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buf.length;
        if (maxBytes !== undefined && size > maxBytes) {
          incoming.destroy();
          req.destroy();
          finish(() => reject(Object.assign(new Error("response exceeds limit"), { code: "INVALID_REQUEST" })));
          return;
        }
        chunks.push(buf);
      });
      incoming.on("error", (cause) => finish(() => reject(cause)));
      incoming.on("end", () => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(incoming.headers)) {
          if (typeof value === "string") headers.append(key, value);
          else if (Array.isArray(value)) {
            for (const item of value) headers.append(key, item);
          }
        }
        finish(() => resolve({
          status: incoming.statusCode ?? 0,
          headers,
          body: Buffer.concat(chunks, size),
        }));
      });
    });
    if (init.timeoutMs && init.timeoutMs > 0) {
      req.setTimeout(init.timeoutMs, () => {
        req.destroy();
        finish(() => reject(Object.assign(new Error("network request timed out"), {
          code: "NETWORK_TIMEOUT",
          name: "AbortError",
        })));
      });
    }
    req.on("error", (cause) => finish(() => reject(cause)));
    if (init.body && method !== "GET" && method !== "HEAD") req.write(init.body);
    req.end();
  });
}

export const fetchPinnedHttp = (
  url: URL,
  addresses: readonly string[],
  init: PinnedHttpRequest = {},
): Promise<Response> =>
  pinnedHttpRequest(url, addresses, init).then((result) =>
    new Response(Readable.toWeb(Readable.from(result.body)) as ReadableStream<Uint8Array>, {
      status: result.status,
      headers: result.headers,
    }));
