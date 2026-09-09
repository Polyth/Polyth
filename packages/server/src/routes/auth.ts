// Auth routes. /api/auth/status and /api/auth/login are the only public
// /api endpoints (the http gate skips them); everything else here runs behind
// the gate like any other route. Cookies are httpOnly + SameSite=Strict so
// the token is invisible to page script and never rides cross-site requests.
import { REMOTE_CAPABILITY } from "@polyth/contracts";
import type { RouteHandler } from "../http.ts";
import {
  authCookieHeader,
  clearAuthCookieHeader,
  type AuthService,
} from "../auth.ts";

const COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // seconds — matches the session TTL

export function authRoutes(auth: AuthService): RouteHandler {
  return async (rc) => {
    const { path, method, ingress, principal } = rc;
    if (!path.startsWith("/api/auth/")) return false;
    const reqLike = {
      headers: rc.req.headers as { cookie?: string; "user-agent"?: string },
      socket: { remoteAddress: rc.req.socket?.remoteAddress },
    };
    const secure = ingress.kind === "public-http" && ingress.secure;
    const cookieName = auth.cookieName();

    if (path === "/api/auth/status" && method === "GET") {
      const resolution = auth.resolve(reqLike, ingress);
      rc.json(200, auth.statusDto(resolution));
      return true;
    }

    if (path === "/api/auth/login" && method === "POST") {
      if (principal.kind === "paired-device") {
        rc.json(403, { error: "forbidden", message: "not allowed" });
        return true;
      }
      const b = await rc.body();
      const accountId = typeof b.accountId === "string" && b.accountId ? b.accountId : undefined;
      const r = auth.login(
        String(b.password ?? ""),
        rc.req.socket?.remoteAddress,
        String(rc.req.headers["user-agent"] ?? ""),
        accountId,
      );
      if (!r.ok) {
        if (r.retryAfterSec !== undefined) rc.res.setHeader("retry-after", String(r.retryAfterSec));
        rc.json(r.status, {
          error: r.error, message: r.message,
          ...(r.retryAfterSec !== undefined ? { retryAfterSec: r.retryAfterSec } : {}),
        });
        return true;
      }
      rc.res.setHeader("set-cookie", authCookieHeader({
        name: cookieName, token: r.token, maxAgeSec: COOKIE_MAX_AGE, secure,
      }));
      rc.json(200, { ok: true });
      return true;
    }

    if (path === "/api/auth/logout" && method === "POST") {
      auth.logout(auth.tokenOf(reqLike));
      rc.res.setHeader("set-cookie", clearAuthCookieHeader({ name: cookieName, secure }));
      rc.json(200, { ok: true });
      return true;
    }

    if (path === "/api/auth/logout-all" && method === "POST") {
      rc.requireCapability(REMOTE_CAPABILITY.authSessionsManage);
      const userId = auth.userIdForPrincipal(principal);
      if (!userId) {
        rc.json(401, { error: "unauthorized", message: "authentication required" });
        return true;
      }
      auth.logoutAll(userId);
      rc.res.setHeader("set-cookie", clearAuthCookieHeader({ name: cookieName, secure }));
      rc.json(200, { ok: true });
      return true;
    }

    if (path === "/api/auth/sessions" && method === "GET") {
      rc.requireCapability(REMOTE_CAPABILITY.authSessionsManage);
      const userId = auth.userIdForPrincipal(principal);
      if (!userId) {
        rc.json(401, { error: "unauthorized", message: "authentication required" });
        return true;
      }
      rc.json(200, auth.listSessions(auth.tokenOf(reqLike), userId));
      return true;
    }

    const m = path.match(/^\/api\/auth\/sessions\/([^/]+)$/);
    if (m && method === "DELETE") {
      rc.requireCapability(REMOTE_CAPABILITY.authSessionsManage);
      const userId = auth.userIdForPrincipal(principal);
      if (!userId || !auth.revoke(m[1]!, userId)) {
        rc.json(404, { error: "not-found", message: "unknown device session" });
        return true;
      }
      rc.json(200, { ok: true });
      return true;
    }

    return false;
  };
}
