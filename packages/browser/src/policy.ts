// URL/origin policy for the controlled browser (WP14). Canonicalization,
// unsafe-scheme and private-network blocking, per-origin approvals, and a
// DNS lookup at policy time. Chromium may resolve the same hostname again
// when it connects, so DNS-rebinding TOCTOU is a residual V1 limitation —
// we do not pin the browser connection to the validated address.
import { lookup } from "node:dns/promises";

export type Resolver = (hostname: string) => Promise<string[]>;

/** How private/loopback/link-local destinations are treated.
 *  `allow` is the generic local-first Browser default.
 *  `explicit-only` is for third-party Chat Workspace pages: private
 *  destinations are allowed only when that origin is listed. */
export type PrivateNetworkPolicy = "allow" | "explicit-only";

/** Why a URL is being checked.
 *  `top-level` — user-visible destination (tab/popup). Unlisted public origins
 *  need approval.
 *  `subresource` — any other HTTP(S) request (fetch, image, iframe, redirect
 *  hop inside a nested frame, …). Public destinations are ordinary browser
 *  traffic; unlisted private destinations are still blocked. */
export type UrlCheckPurpose = "top-level" | "subresource";

export interface UrlPolicyOptions {
  /** Origins Polyth itself started (preview/dev servers) — loopback allowed. */
  allowedOrigins?: ReadonlyArray<string>;
  /** External origins the user explicitly approved. */
  approvedOrigins?: ReadonlySet<string>;
  /** Injectable DNS for tests; defaults to dns.lookup (all addresses). */
  resolve?: Resolver;
  /** Private-network handling. Defaults to `allow` (generic Browser). */
  privateNetwork?: PrivateNetworkPolicy;
  /** Defaults to `top-level` so existing callers keep approval semantics. */
  purpose?: UrlCheckPurpose;
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

/** Chromium internal documents that must not go through http(s) policy. */
export function isInternalBrowserUrl(raw: string): boolean {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "about:blank" || trimmed === "about:srcdoc") return true;
  if (trimmed.startsWith("about:blank#") || trimmed.startsWith("about:blank?")) return true;
  if (trimmed.startsWith("about:srcdoc#") || trimmed.startsWith("about:srcdoc?")) return true;
  return false;
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

/** Validate one URL (one navigation hop). Re-run per redirect hop with a
 *  fresh resolver call. This is not a pinned connection: Chromium may
 *  resolve again, so a rebinding hostname remains a residual risk. */
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
  const listed = listedHas(allowed, origin) || listedHas(approved, origin);
  const privateNetwork = opts.privateNetwork ?? "allow";

  const allowPrivate = (): UrlDecision => {
    if (privateNetwork === "allow" || listed) {
      return { ok: true, url: canonical, origin };
    }
    return {
      ok: false,
      code: "blocked-private",
      reason: `private-network origin ${origin} is not allowed`,
    };
  };

  // Loopback and private-network targets are local-first in generic Browser:
  // they open without approval. Chat Workspace uses `explicit-only` so a
  // third-party provider page cannot inherit that LAN/metadata access.
  if (isLoopbackHost(host) || (/^\d+\.\d+\.\d+\.\d+$/.test(host) && isLoopbackAddress(host))) {
    return allowPrivate();
  }

  // Literal IP host: no DNS ambiguity, decide directly.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith("[")) {
    const ip = host.replace(/^\[|\]$/g, "");
    if (isPrivateAddress(ip)) return allowPrivate();
  } else {
    // Hostname: resolving into a private/loopback range is a legitimate
    // intranet/local setup for generic Browser, not a reason to block.
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
    if (addrs.some(isPrivateAddress)) {
      return allowPrivate();
    }
  }

  if (listed) return { ok: true, url: canonical, origin };
  // Public subresources (CDN, API, nested iframe documents) are normal
  // browser traffic. Origin-approval UX is reserved for top-level changes.
  if (opts.purpose === "subresource") {
    return { ok: true, url: canonical, origin };
  }
  return { ok: false, code: "approval-required", reason: `external origin ${origin} needs a per-origin approval` };
}

export function checkTopLevelNavigation(raw: string, opts: UrlPolicyOptions = {}): Promise<UrlDecision> {
  return checkUrl(raw, { ...opts, purpose: "top-level" });
}

export function checkNetworkEgress(raw: string, opts: UrlPolicyOptions = {}): Promise<UrlDecision> {
  return checkUrl(raw, { ...opts, purpose: "subresource" });
}
