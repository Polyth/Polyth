// The window's Polyth session is a host-only cookie for 127.0.0.1, and cookies
// ignore ports: a request from the window to any other local port (a dev
// server, an image an agent put in a chat) would carry it, and whatever listens
// there could replay it as the owner. The main process strips Polyth's own
// cookies from every request that does not go to this window's server.

/** Polyth identity cookies: the session and its CSRF nonce (`…_csrf`). */
const POLYTH_COOKIE = /^(?:__Host-)?polyth_auth_/;

/** The Cookie header to send to `requestUrl`, or null when it is unchanged. */
export function withoutForeignSessionCookies(cookieHeader: string, requestUrl: string, appUrl: string): string | null {
  let target: URL, app: URL;
  try {
    target = new URL(requestUrl);
    app = new URL(appUrl);
  } catch {
    return null;
  }
  // http(s) and ws(s) to the app's own host and port keep everything.
  if (target.host === app.host) return null;
  const kept = cookieHeader.split(";").map((part) => part.trim()).filter((part) => {
    const name = part.slice(0, Math.max(0, part.indexOf("="))).trim();
    return part && !POLYTH_COOKIE.test(name);
  });
  const next = kept.join("; ");
  return next === cookieHeader.trim() ? null : next;
}
