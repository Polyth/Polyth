// URL/origin policy for the controlled browser (WP14). Canonicalization,
// unsafe-scheme and private-network blocking, per-origin approvals, and
// per-hop DNS re-resolution so redirects cannot rebind into private ranges.
import { lookup } from "node:dns/promises";

export type Resolver = (hostname: string) => Promise<string[]>;

export interface UrlPolicyOptions {
  /** Origins Polyth itself started (preview/dev servers) — loopback allowed. */
  allowedOrigins?: ReadonlyArray<string>;
  /** External origins the user explicitly approved. */
  approvedOrigins?: ReadonlySet<string>;
  /** Injectable DNS for tests; defaults to dns.lookup (all addresses). */
  resolve?: Resolver;
}

export type UrlDecision =
  | { ok: true; url: string; origin: string }
  | { ok: false; code: "invalid-url" | "blocked-scheme" | "blocked-credentials" | "blocked-private" | "approval-required" | "dns-error"; reason: string };

const BLOCKED_SCHEMES = new Set([
  "file:", "data:", "javascript:", "about:", "chrome:", "chrome-extension:",
  "view-source:", "blob:", "ws:", "wss:", "ftp:", "vbscript:",
]);

const defaultResolve: Resolver = async (hostname) => {
  const results = await lookup(hostname, { all: true });
  return results.map((r) => r.address);
};

export function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]" || host.endsWith(".localhost");
}

/** Canonical origins that share one approval (www ↔ apex). Loopback and literal IPs are not aliased. */
export function originAliases(origin: string): string[] {
  try {
    const url = new URL(origin);
    const host = url.hostname.toLowerCase();
    const canonical = url.origin.toLowerCase();
    if (isLoopbackHost(host)) return [canonical];
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith("[")) return [canonical];
    if (host.startsWith("www.")) {
      const apexUrl = new URL(origin);
      apexUrl.hostname = host.slice(4);
      return [...new Set([canonical, apexUrl.origin.toLowerCase()])];
    }
    const wwwUrl = new URL(origin);
    wwwUrl.hostname = `www.${host}`;
    return [...new Set([canonical, wwwUrl.origin.toLowerCase()])];
  } catch {
    return [origin.toLowerCase()];
  }
}

function listedHas(listed: ReadonlySet<string>, origin: string): boolean {
  for (const alias of originAliases(origin)) {
    if (listed.has(alias)) return true;
  }
  return false;
}

/** Private / link-local / metadata / CGNAT / unspecified addresses. */
export function isPrivateAddress(ip: string): boolean {
  if (ip.includes(":")) {
    const v6 = ip.toLowerCase().replace(/^\[|\]$/g, "");
    if (v6 === "::1" || v6 === "::") return true;
    if (v6.startsWith("fe80") || v6.startsWith("fc") || v6.startsWith("fd")) return true;
    // v4-mapped (::ffff:10.0.0.1)
    const mapped = v6.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return false;
  }
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true; // malformed = treat as unsafe
  const [a, b] = parts as [number, number, number, number];
  if (a === 127 || a === 10 || a === 0) return true;
  if (a === 172 && b! >= 16 && b! <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
  if (a === 100 && b! >= 64 && b! <= 127) return true; // CGNAT
  return false;
}

export function isLoopbackAddress(ip: string): boolean {
  if (ip.includes(":")) return ip.replace(/^\[|\]$/g, "").toLowerCase() === "::1";
  return ip.startsWith("127.");
}

/** Canonical origin string for approvals ("https://example.com"). */
export function originOf(raw: string): string | null {
  try {
    // Navigation accepts a convenient host:port shorthand. Approvals must use
    // the identical parsing rule; otherwise a user can reach the approval
    // dialog for `localhost:3000` only to have the approval POST rejected.
    const trimmed = raw.trim();
    const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
      ? trimmed
      : `http://${trimmed}`;
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

/** Validate one URL (one navigation hop). Re-run per redirect hop with a fresh
 *  resolver call — the second resolution is what defeats DNS rebinding. */
export async function checkUrl(raw: string, opts: UrlPolicyOptions = {}): Promise<UrlDecision> {
  // Bare "localhost:5173" style input gets an http scheme; "localhost:5173"
  // would otherwise parse as scheme "localhost:".
  const trimmed = raw.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || /^(javascript|data|about|chrome|file|blob|mailto|vbscript|view-source):/i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, code: "invalid-url", reason: `not a valid URL: ${raw}` };
  }
  const scheme = url.protocol.toLowerCase();
  if (BLOCKED_SCHEMES.has(scheme)) {
    return { ok: false, code: "blocked-scheme", reason: `scheme ${scheme} is not allowed` };
  }
  if (scheme !== "http:" && scheme !== "https:") {
    return { ok: false, code: "blocked-scheme", reason: `only http/https navigation is allowed (got ${scheme})` };
  }
  if (url.username || url.password) {
    return { ok: false, code: "blocked-credentials", reason: "URLs with embedded credentials are not allowed" };
  }
  const canonical = url.toString();
  const origin = url.origin.toLowerCase();
  const allowed = new Set((opts.allowedOrigins ?? []).map((o) => o.toLowerCase()));
  const approved = new Set([...(opts.approvedOrigins ?? [])].map((o) => o.toLowerCase()));
  const host = url.hostname.toLowerCase();

  // Loopback: only origins Polyth started or the user approved.
  if (isLoopbackHost(host) || (!host.includes(":") && /^\d+\.\d+\.\d+\.\d+$/.test(host) && isLoopbackAddress(host))) {
    if (listedHas(allowed, origin) || listedHas(approved, origin)) return { ok: true, url: canonical, origin };
    return { ok: false, code: "approval-required", reason: `loopback origin ${origin} needs approval` };
  }

  // Literal IP host: no DNS ambiguity, decide directly.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith("[")) {
    const ip = host.replace(/^\[|\]$/g, "");
    if (isPrivateAddress(ip)) {
      return { ok: false, code: "blocked-private", reason: `private-network address ${ip} is blocked` };
    }
  } else {
    // Hostname: every resolved address must be public (rebinding defense).
    const resolve = opts.resolve ?? defaultResolve;
    let addrs: string[];
    try {
      addrs = await resolve(host);
    } catch (err) {
      return { ok: false, code: "dns-error", reason: `cannot resolve ${host}: ${String(err)}` };
    }
    if (addrs.length === 0) {
      return { ok: false, code: "dns-error", reason: `cannot resolve ${host}: no addresses` };
    }
    const bad = addrs.find((ip) => isPrivateAddress(ip) && !isLoopbackAddress(ip));
    if (bad) {
      return { ok: false, code: "blocked-private", reason: `${host} resolves to private address ${bad}` };
    }
    if (addrs.some(isLoopbackAddress)) {
      // A public name resolving to loopback is a rebinding attempt. Only
      // origins Polyth itself started may do this; user approval of an
      // external origin never grants loopback access.
      if (!listedHas(allowed, origin)) {
        return { ok: false, code: "blocked-private", reason: `${host} resolves to a loopback address` };
      }
    }
  }

  if (listedHas(allowed, origin) || listedHas(approved, origin)) return { ok: true, url: canonical, origin };
  return { ok: false, code: "approval-required", reason: `external origin ${origin} needs a per-origin approval` };
}
