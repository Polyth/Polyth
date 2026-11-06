// Cookies ignore ports and share a host's jar. A request from the window to any
// other local port (a dev server, an image an agent put in a chat) would carry
// Polyth's session, and whatever listens there could replay it as the owner; a
// server opened at another port of this computer's host (an SSH tunnel, say)
// shares the jar too. The main process keeps each session on its own server.

/** Polyth identity cookies: the session and its CSRF nonce (`…_csrf`). */
const POLYTH_COOKIE = /^(?:__Host-)?polyth_auth_/;
/** A Link proxy's session names the proxy's own port. */
const LINK_PROXY_COOKIE = /^polyth_link_proxy_(\d+)$/;

export interface SessionCookieOwners {
  /** This computer's server. Each installation names its own session, so once
   *  that name is known the session goes nowhere else and takes no one else's. */
  local?: { url: string; cookieName?: string | null } | null;
  /** Servers opened by address: only they may receive the sessions they set. */
  addresses?: readonly string[];
}

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
};

/** The Cookie header to send to `requestUrl`, or null when it is unchanged. */
export function withoutForeignSessionCookies(cookieHeader: string, requestUrl: string, owners: SessionCookieOwners): string | null {
  let target: URL;
  try {
    target = new URL(requestUrl);
  } catch {
    return null;
  }
  const localHost = owners.local ? hostOf(owners.local.url) : null;
  const localName = owners.local?.cookieName ?? null;
  const addressHosts = new Set((owners.addresses ?? []).map(hostOf));
  const isLocalCookie = (name: string): boolean =>
    localName !== null && (name === localName || name === `${localName}_csrf`);
  const identityGoes = (name: string): boolean => {
    if (target.host === localHost) return localName === null || isLocalCookie(name);
    return addressHosts.has(target.host) && !isLocalCookie(name);
  };
  const kept = cookieHeader.split(";").map((part) => part.trim()).filter((part) => {
    if (!part) return false;
    const name = part.slice(0, Math.max(0, part.indexOf("="))).trim();
    if (POLYTH_COOKIE.test(name)) return identityGoes(name);
    const proxy = LINK_PROXY_COOKIE.exec(name);
    return !proxy || (target.hostname === "127.0.0.1" && target.port === proxy[1]);
  });
  const next = kept.join("; ");
  return next === cookieHeader.trim() ? null : next;
}
