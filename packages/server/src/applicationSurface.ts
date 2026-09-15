import type { ServerApplicationSurface } from "@polyth/plugins";

export interface ServerApplicationSurfaceOptions {
  /** Hosted tenants must not receive a server-loopback login primitive. */
  localTrustedDeployment: boolean;
  /** Address passed to Server.listen; wildcard binds are not browser targets. */
  hostname?: string;
  /** Null until the public listener has bound. */
  listeningPort(): number | null;
  /** Live auth state, including passwords stored before this boot. */
  authenticationRequired(): boolean;
  /** True when loopback requests may bypass UI authentication. */
  localhostAuthOptional: boolean;
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
 * Fail-closed self-origin seam for controlled Browser contexts. A caller gets
 * the login surface only after the listener is live and only when cookie-less
 * loopback traffic cannot be mistaken for the local operator.
 */
export function createServerApplicationSurface(
  opts: ServerApplicationSurfaceOptions,
): ServerApplicationSurface {
  return {
    controlledBrowserLoginOrigin() {
      if (!opts.localTrustedDeployment
        || !opts.authenticationRequired()
        || opts.localhostAuthOptional) return null;
      const port = opts.listeningPort();
      return port === null ? null : browserReachableHttpOrigin(opts.hostname, port);
    },
  };
}
