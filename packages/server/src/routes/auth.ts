// Auth routes. /api/auth/status and /api/auth/login are public; account
// management stays behind the ordinary HTTP auth gate. Cookies are httpOnly +
// SameSite=Strict so tokens remain invisible to page script and never ride
// cross-site requests.
import { REMOTE_CAPABILITY } from "@polyth/contracts";
import type { RouteHandler } from "../http.ts";
import {
  authCookieHeader,
  clearAuthCookieHeader,
  type AuthService,
} from "../auth.ts";

const COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // seconds — matches the session TTL
const OWNER_USER_ID = "usr_owner";

const accountName = (userId: string): string => {
  const raw = userId.startsWith("usr_") ? userId.slice(4) : userId;
  const name = raw.replace(/[-_]+/g, " ").trim();
  return name ? name.replace(/\b\w/g, (letter) => letter.toUpperCase()) : "User";
};

const accountIdFor = (name: string): string => {
  const slug = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  if (!slug) throw Object.assign(new Error("account name must contain letters or digits"), { code: "invalid-input" });
  return `usr_${slug}`;
};

const accountList = (auth: AuthService) => auth.accountIds().map((id) => ({ id, name: accountName(id) }));

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
      rc.json(200, { ...auth.statusDto(resolution), accounts: accountList(auth) });
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

    const currentUserId = auth.userIdForPrincipal(principal);

    if (path === "/api/auth/accounts" && method === "GET") {
      if (!currentUserId) {
        rc.json(401, { error: "unauthorized", message: "authentication required" });
        return true;
      }
      rc.json(200, {
        currentAccountId: currentUserId,
        canManage: currentUserId === OWNER_USER_ID,
        accounts: accountList(auth).map((account) => ({ ...account, current: account.id === currentUserId })),
      });
      return true;
    }

    if (path === "/api/auth/accounts" && method === "POST") {
      if (currentUserId !== OWNER_USER_ID) {
        rc.json(403, { error: "forbidden", message: "server account management requires the owner account" });
        return true;
      }
      const body = await rc.body();
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const password = typeof body.password === "string" ? body.password : "";
      const accountId = accountIdFor(name);
      if (password.length < 8 || password.length > 1024) {
        rc.json(400, { error: "invalid-input", message: "password must be 8-1024 characters" });
        return true;
      }
      if (auth.hasCredential(accountId)) {
        rc.json(409, { error: "conflict", message: "account already exists" });
        return true;
      }
      auth.setPassword(accountId, password);
      rc.json(201, { id: accountId, name: accountName(accountId), current: false });
      return true;
    }

    const passwordMatch = path.match(/^\/api\/auth\/accounts\/([^/]+)\/password$/);
    if (passwordMatch && method === "PUT") {
      const target = passwordMatch[1]!;
      if (!currentUserId || (target !== currentUserId && currentUserId !== OWNER_USER_ID)) {
        rc.json(403, { error: "forbidden", message: "not allowed" });
        return true;
      }
      if (!auth.hasCredential(target)) {
        rc.json(404, { error: "not-found", message: "account not found" });
        return true;
      }
      const body = await rc.body();
      const password = typeof body.password === "string" ? body.password : "";
      if (password.length < 8 || password.length > 1024) {
        rc.json(400, { error: "invalid-input", message: "password must be 8-1024 characters" });
        return true;
      }
      auth.setPassword(target, password);
      rc.json(200, { ok: true });
      return true;
    }

    const accountMatch = path.match(/^\/api\/auth\/accounts\/([^/]+)$/);
    if (accountMatch && method === "DELETE") {
      if (currentUserId !== OWNER_USER_ID) {
        rc.json(403, { error: "forbidden", message: "server account management requires the owner account" });
        return true;
      }
      const target = accountMatch[1]!;
      if (target === OWNER_USER_ID) {
        rc.json(400, { error: "invalid-input", message: "the bootstrap owner account cannot be removed" });
        return true;
      }
      if (!auth.hasCredential(target) || !auth.removeAccount(target)) {
        rc.json(404, { error: "not-found", message: "account not found" });
        return true;
      }
      rc.json(200, { ok: true });
      return true;
    }

    if (path === "/api/auth/logout-all" && method === "POST") {
      rc.requireCapability(REMOTE_CAPABILITY.authSessionsManage);
      if (!currentUserId) {
        rc.json(401, { error: "unauthorized", message: "authentication required" });
        return true;
      }
      auth.logoutAll(currentUserId);
      rc.res.setHeader("set-cookie", clearAuthCookieHeader({ name: cookieName, secure }));
      rc.json(200, { ok: true });
      return true;
    }

    if (path === "/api/auth/sessions" && method === "GET") {
      rc.requireCapability(REMOTE_CAPABILITY.authSessionsManage);
      if (!currentUserId) {
        rc.json(401, { error: "unauthorized", message: "authentication required" });
        return true;
      }
      rc.json(200, auth.listSessions(auth.tokenOf(reqLike), currentUserId));
      return true;
    }

    const m = path.match(/^\/api\/auth\/sessions\/([^/]+)$/);
    if (m && method === "DELETE") {
      rc.requireCapability(REMOTE_CAPABILITY.authSessionsManage);
      if (!currentUserId || !auth.revoke(m[1]!, currentUserId)) {
        rc.json(404, { error: "not-found", message: "unknown device session" });
        return true;
      }
      rc.json(200, { ok: true });
      return true;
    }

    return false;
  };
}
