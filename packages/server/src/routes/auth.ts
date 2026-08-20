// F16 auth routes. /api/auth/status and /api/auth/login are the only public
// /api endpoints (the http gate skips them); everything else here runs behind
// the gate like any other route. Cookies are httpOnly + SameSite=Strict so
// the token is invisible to page script and never rides cross-site requests.
import type { RouteHandler } from "../http.ts";
import type { AuthService } from "../auth.ts";
import { AUTH_COOKIE } from "../auth.ts";

const COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // seconds — matches the session TTL

const setCookie = (token: string): string =>
  `${AUTH_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}`;

const clearCookie = (): string =>
  `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;

export function authRoutes(auth: AuthService): RouteHandler {
  return async (rc) => {
    const { path, method } = rc;
    if (!path.startsWith("/api/auth/")) return false;
    const reqLike = {
      headers: rc.req.headers as { cookie?: string; "user-agent"?: string },
      socket: { remoteAddress: rc.req.socket?.remoteAddress },
    };

    if (path === "/api/auth/status" && method === "GET") {
      rc.json(200, { required: auth.enabled(), authorized: auth.authorized(reqLike) });
      return true;
    }

    if (path === "/api/auth/login" && method === "POST") {
      const b = await rc.body();
      const r = auth.login(
        String(b.password ?? ""),
        rc.req.socket?.remoteAddress,
        String(rc.req.headers["user-agent"] ?? ""),
      );
      if (!r.ok) {
        if (r.retryAfterSec !== undefined) rc.res.setHeader("retry-after", String(r.retryAfterSec));
        rc.json(r.status, {
          error: r.error, message: r.message,
          ...(r.retryAfterSec !== undefined ? { retryAfterSec: r.retryAfterSec } : {}),
        });
        return true;
      }
      rc.res.setHeader("set-cookie", setCookie(r.token));
      rc.json(200, { ok: true });
      return true;
    }

    if (path === "/api/auth/logout" && method === "POST") {
      auth.logout(auth.tokenOf(reqLike));
      rc.res.setHeader("set-cookie", clearCookie());
      rc.json(200, { ok: true });
      return true;
    }

    if (path === "/api/auth/logout-all" && method === "POST") {
      auth.logoutAll();
      rc.res.setHeader("set-cookie", clearCookie());
      rc.json(200, { ok: true });
      return true;
    }

    if (path === "/api/auth/sessions" && method === "GET") {
      rc.json(200, auth.listSessions(auth.tokenOf(reqLike)));
      return true;
    }

    const m = path.match(/^\/api\/auth\/sessions\/([^/]+)$/);
    if (m && method === "DELETE") {
      if (!auth.revoke(m[1]!)) {
        rc.json(404, { error: "not-found", message: "unknown device session" });
        return true;
      }
      rc.json(200, { ok: true });
      return true;
    }

    return false;
  };
}
