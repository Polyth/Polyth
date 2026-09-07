import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { Readable } from "node:stream";

export type Resolver = (hostname: string) => Promise<string[]>;

const defaultResolve: Resolver = async (hostname) => {
  const results = await lookup(hostname, { all: true });
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
PRIVATE.addSubnet("0.0.0.0", 8, "ipv4");
PRIVATE.addSubnet("::1", 128, "ipv6");
PRIVATE.addSubnet("::", 128, "ipv6");
PRIVATE.addSubnet("fe80::", 10, "ipv6");
PRIVATE.addSubnet("fc00::", 7, "ipv6");
PRIVATE.addSubnet("fd00:ec2::", 32, "ipv6");

const listed = (list: BlockList, ip: string): boolean => {
  const host = ip.replace(/^\[|\]$/g, "");
  const version = isIP(host);
  if (version === 4) return list.check(host, "ipv4");
  if (version === 6) return list.check(host, "ipv6");
  return true;
};

/** Link-local, cloud metadata, unspecified. Always blocked. */
export const isMetadataOrLinkLocal = (ip: string): boolean => listed(METADATA_OR_LINK_LOCAL, ip);

export const isLoopbackAddress = (ip: string): boolean => listed(LOOPBACK, ip);

/** RFC1918, ULA, loopback, CGNAT, link-local, metadata. */
export const isPrivateAddress = (ip: string): boolean => listed(PRIVATE, ip);

export type OutboundDecision =
  | { ok: true; url: URL; addresses: string[] }
  | { ok: false; reason: string };

/**
 * public-only: reject any private/loopback/metadata resolution.
 * user-origin: the operator typed this origin. Private LAN is allowed.
 * metadata and link-local stay blocked in both modes.
 */
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
  if (META_HOSTS.has(host)) return { ok: false, reason: "metadata host is blocked" };

  const literalIp = /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":");
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
    if (isMetadataOrLinkLocal(address)) return { ok: false, reason: "hostname resolved to a metadata or link-local address" };
    if (opts.policy === "public-only" && isPrivateAddress(address)) {
      return { ok: false, reason: "hostname resolved to a private address" };
    }
  }
  return { ok: true, url, addresses };
};

const familyOf = (address: string): 4 | 6 => (address.includes(":") ? 6 : 4);

/** Connect to an already-inspected IP so a second DNS lookup cannot rebind. */
export const fetchPinnedHttp = (
  url: URL,
  addresses: readonly string[],
  init: {
    method?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  } = {},
): Promise<Response> => {
  const address = addresses[0];
  if (!address) return Promise.reject(new Error("no pinned address"));
  const tls = url.protocol === "https:";
  const send = tls ? httpsRequest : httpRequest;
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const port = url.port ? Number(url.port) : tls ? 443 : 80;
  const family = familyOf(address);
  return new Promise((resolve, reject) => {
    const req = send({
      protocol: url.protocol,
      hostname: address,
      port,
      path: `${url.pathname}${url.search}`,
      method: init.method ?? "GET",
      headers: { accept: "application/json", ...init.headers, host: url.host },
      ...(tls ? { servername: hostname } : {}),
      family,
      lookup: (_host, _opts, callback) => {
        (callback as (err: NodeJS.ErrnoException | null, address: string, family: number) => void)(
          null,
          address,
          family,
        );
      },
      signal: init.signal,
    }, (incoming) => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (typeof value === "string") headers.append(key, value);
        else if (Array.isArray(value)) {
          for (const item of value) headers.append(key, item);
        }
      }
      resolve(new Response(Readable.toWeb(incoming) as ReadableStream<Uint8Array>, {
        status: incoming.statusCode ?? 0,
        headers,
      }));
    });
    req.on("error", reject);
    req.end();
  });
};
