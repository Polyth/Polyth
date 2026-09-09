import type { RouteHandler } from "../http.ts";
import type { AuthService } from "../auth.ts";
import type { TenancyStore } from "@polyth/tenancy";

const invalid = (message: string): never => {
  throw Object.assign(new Error(message), { code: "invalid-input" });
};

export function accountRoutes(deps: {
  auth: AuthService;
  tenancy: TenancyStore;
  ownerUserId: string;
}): RouteHandler {
  const summaries = (currentUserId: string) => deps.auth.accountIds().flatMap((id) => {
    const user = deps.tenancy.user(id);
    return user ? [{ ...user, current: id === currentUserId }] : [];
  });

  const requireOwner = (userId: string): void => {
    if (userId !== deps.ownerUserId) {
      throw Object.assign(new Error("server account management requires the owner account"), { code: "forbidden" });
    }
  };

  return async (rc) => {
    if (!rc.path.startsWith("/api/accounts")) return false;
    const currentUserId = rc.space.userId;

    if (rc.path === "/api/accounts" && rc.method === "GET") {
      rc.json(200, {
        currentAccountId: currentUserId,
        canManage: currentUserId === deps.ownerUserId,
        accounts: summaries(currentUserId),
      });
      return true;
    }

    if (rc.path === "/api/accounts" && rc.method === "POST") {
      requireOwner(currentUserId);
      const body = await rc.body();
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const password = typeof body.password === "string" ? body.password : "";
      if (!name) invalid("account name is required");
      if (password.length < 8 || password.length > 1024) invalid("password must be 8-1024 characters");

      const user = deps.tenancy.createUser(name);
      try {
        deps.tenancy.addMember(currentUserId, rc.space.spaceId, user.id, "member");
        deps.auth.setPassword(user.id, password);
      } catch (error) {
        // The durable user record is intentionally retained on a partial write:
        // deleting tenant identity here could orphan future ownership recovery.
        throw error;
      }
      rc.json(201, { ...user, current: false });
      return true;
    }

    const passwordMatch = rc.path.match(/^\/api\/accounts\/([^/]+)\/password$/);
    if (passwordMatch && rc.method === "PUT") {
      const target = passwordMatch[1]!;
      if (target !== currentUserId) requireOwner(currentUserId);
      if (!deps.tenancy.user(target)) {
        rc.json(404, { error: "not-found", message: "account not found" });
        return true;
      }
      const body = await rc.body();
      const password = typeof body.password === "string" ? body.password : "";
      if (password.length < 8 || password.length > 1024) invalid("password must be 8-1024 characters");
      deps.auth.setPassword(target, password);
      rc.json(200, { ok: true });
      return true;
    }

    const accountMatch = rc.path.match(/^\/api\/accounts\/([^/]+)$/);
    if (accountMatch && rc.method === "DELETE") {
      requireOwner(currentUserId);
      const target = accountMatch[1]!;
      if (target === deps.ownerUserId) invalid("the bootstrap owner account cannot be removed");
      if (!deps.tenancy.user(target) || !deps.auth.hasCredential(target)) {
        rc.json(404, { error: "not-found", message: "account not found" });
        return true;
      }
      deps.auth.removeAccount(target);
      rc.json(200, { ok: true });
      return true;
    }

    return false;
  };
}
