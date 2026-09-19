import type { ServerApplicationSurface } from "@polyth/plugins";
import type { Server } from "node:http";

export interface ServerApplicationSurfaceOptions {
  /** Hosted tenants must not receive a server-loopback login primitive. */
  localTrustedDeployment: boolean;
  /** Address passed to Server.listen; wildcard binds are not browser targets. */
  hostname?: string;
  /** Null before composition/after shutdown; `listening` is checked live. */
  listener(): Server | null;
  /** Live auth state, including passwords stored before this boot. */
  authenticationRequired(): boolean;
  /** True when loopback requests may bypass UI authentication. */
  localhostAuthOptional: boolean;
  /** Operator-declared canonical identity origin (POLYTH_PUBLIC_ORIGIN) from
   *  the trusted bootstrap. Never derived from Host or forwarded headers. */
  canonicalOrigin?: string | null;
}

/** Turn a listener address into the exact origin a browser on this host uses. */
export function browserReachableHttpOrigin(
  hostname: string | undefined,
  port: number,
): string | null {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return null;
  const raw = hostname?.trim() || "127.0.0.1";
  const reachable = raw === "0.0.0.0"
    ? "127.0.0.1"
    : raw === "::" || raw === "[::]"
      ? "::1"
      : raw.replace(/^\[|\]$/g, "");
  const host = reachable.includes(":") ? `[${reachable}]` : reachable;
  try {
    return new URL(`http://${host}:${port}`).origin.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Fail-closed self-origin seam for controlled Browser contexts. The
 * operator-declared canonical origin is configuration, so it is always
 * reachable. The loopback login surface additionally requires a live listener
 * and strict UI authentication, because cookie-less loopback traffic must not
 * be mistaken for the local operator.
 */
export function createServerApplicationSurface(
  opts: ServerApplicationSurfaceOptions,
): ServerApplicationSurface {
  const canonicalOrigin = (): string | null => {
    const raw = opts.canonicalOrigin?.trim();
    if (!raw) return null;
    try {
      const url = new URL(raw);
      return url.protocol === "http:" || url.protocol === "https:"
        ? url.origin.toLowerCase()
        : null;
    } catch {
      return null;
    }
  };
  return {
    controlledBrowserSelfOrigins() {
      const origins: string[] = [];
      const canonical = canonicalOrigin();
      if (canonical) origins.push(canonical);
      if (opts.localTrustedDeployment
        && opts.authenticationRequired()
        && !opts.localhostAuthOptional) {
        const listener = opts.listener();
        if (listener?.listening) {
          const address = listener.address();
          const login = address && typeof address !== "string"
            ? browserReachableHttpOrigin(opts.hostname, address.port)
            : null;
          if (login) origins.push(login);
        }
      }
      return [...new Set(origins)];
    },
  };
}
