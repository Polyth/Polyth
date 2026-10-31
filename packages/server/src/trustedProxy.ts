/**
 * Reverse-proxy trust for a canonical public origin.
 *
 * Forwarded headers are untrusted by default and are stripped before any
 * handler sees them (see UNTRUSTED_INGRESS_HEADERS). A TLS-terminating proxy
 * is the one exception, and only when the operator names its exact peer
 * address: the decision is made once, at the listener, from the socket peer —
 * never from a header a client could set.
 */
import type { IncomingMessage } from "node:http";

/** Operator-listed proxy peers, exact addresses (no CIDR, no hostnames). */
const configured = (raw: string | undefined): ReadonlySet<string> =>
  new Set((raw ?? "").split(",").map((value) => normalizeAddress(value.trim())).filter(Boolean));

/** ::ffff:10.0.0.1 and 10.0.0.1 are the same peer to an operator. */
export function normalizeAddress(address: string | undefined): string {
  if (!address) return "";
  const value = address.trim().toLowerCase();
  return value.startsWith("::ffff:") ? value.slice(7) : value;
}

export interface ProxyTrust {
  /** True when this socket peer is an operator-listed proxy. */
  peer(address: string | undefined): boolean;
  /** True when a trusted proxy reports it terminated TLS for this request. */
  secure(req: IncomingMessage): boolean;
  readonly size: number;
}

export function createProxyTrust(raw?: string): ProxyTrust {
  const peers = configured(raw ?? process.env.POLYTH_TRUSTED_PROXIES);
  const header = (req: IncomingMessage, name: string): string => {
    const value = req.headers[name];
    return (Array.isArray(value) ? value[0] ?? "" : value ?? "").trim().toLowerCase();
  };
  const peer = (address: string | undefined): boolean =>
    peers.size > 0 && peers.has(normalizeAddress(address));
  return {
    peer,
    secure: (req) => peer(req.socket?.remoteAddress) && header(req, "x-forwarded-proto") === "https",
    get size() { return peers.size; },
  };
}
