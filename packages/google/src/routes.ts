import type { RouteHandler, RouteRequest } from "@polyth/contracts";
import { roleAtLeast } from "@polyth/contracts";
import type { GoogleAccountOwner, GoogleConnector } from "./accounts.ts";
import { GoogleError, googleError, googleErrorStatus } from "./http.ts";
import type { OAuthFlowOwner, OAuthFlows } from "./oauth.ts";
import { isGoogleCapability, scopesForRequest, type GoogleCapability } from "./scopes.ts";

const capabilitiesFrom = (value: unknown): GoogleCapability[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(isGoogleCapability)) {
    return googleError("invalid-request", "capabilities must list Google capabilities such as gmail.read or drive.write.");
  }
  return [...new Set(value)];
};

/**
 * Settings → Google. Every member manages their OWN accounts (connect, turn
 * on in this Space, disconnect); the OAuth client, Space service accounts and
 * the policy that lets agents use them are Space-admin only. Members see
 * service accounts only as a label, never another person's account.
 */
export function googleRoutes(deps: { connector: GoogleConnector; flows: OAuthFlows }): RouteHandler {
  const { connector, flows } = deps;

  const handle = async (rc: RouteRequest): Promise<boolean> => {
    const spaceId = rc.space.spaceId;
    const userId = rc.space.userId;
    const admin = roleAtLeast(rc.space.role, "admin");
    const self: GoogleAccountOwner = { kind: "person", userId };
    const ok = (data: unknown) => { rc.json(200, { ok: true, data }); return true; };
    const requireAdmin = (): void => {
      if (!admin) googleError("permission-denied", "Only Space admins can manage the Space's Google setup and service accounts.");
    };

    if (rc.path === "/api/google" && rc.method === "GET") {
      return ok({
        client: connector.clientConfig(spaceId),
        accounts: connector.listAccounts(spaceId, self),
        service: admin ? connector.listAccounts(spaceId, { kind: "space" }) : connector.serviceLabels(spaceId),
        policy: connector.policy(spaceId),
        canManage: admin,
      });
    }

    if (rc.path === "/api/google/client") {
      if (rc.method === "PUT") {
        requireAdmin();
        const input = await rc.body();
        return ok(connector.setClientConfig(spaceId, {
          clientId: String(input.clientId ?? ""),
          ...(typeof input.clientSecret === "string" ? { clientSecret: input.clientSecret } : {}),
        }));
      }
      if (rc.method === "DELETE") { requireAdmin(); return ok(connector.clearClientConfig(spaceId)); }
      return false;
    }

    if (rc.path === "/api/google/policy" && rc.method === "PUT") {
      requireAdmin();
      const input = await rc.body();
      return ok(connector.setPolicy(spaceId, { agentsMayUseService: input.agentsMayUseService as boolean }));
    }

    if (rc.path === "/api/google/connect" && rc.method === "POST") {
      const input = await rc.body();
      const capabilities = capabilitiesFrom(input.capabilities);
      if (input.owner !== undefined && input.owner !== "person" && input.owner !== "space") {
        return googleError("invalid-request", "owner must be person or space.");
      }
      const flowOwner: OAuthFlowOwner = input.owner === "space" ? "space" : "person";
      if (flowOwner === "space") requireAdmin();
      const owner: GoogleAccountOwner = flowOwner === "space" ? { kind: "space" } : self;
      const accountId = typeof input.accountId === "string" && input.accountId ? input.accountId : undefined;
      const account = accountId ? connector.account(spaceId, owner, accountId) : undefined;
      if (accountId && !account) return googleError("not-found", "Google account not found.");
      // Polyth's built-in app is verified only for its own scopes; Google
      // blocks the rest, so ask for them only through the Space's own client.
      const client = connector.clientConfig(spaceId);
      const allowed = client.source === "builtin" ? client.capabilities : undefined;
      if (allowed && !capabilities.every((capability) => allowed.includes(capability))) {
        return googleError("invalid-request", "Reading mail and full Drive access need your own Google Cloud client. Add it under Settings → Google → Advanced.");
      }
      const flow = await flows.start({
        spaceId,
        userId,
        owner: flowOwner,
        client: connector.oauthClient(spaceId),
        scopes: scopesForRequest(account?.scopes ?? [], capabilities, allowed),
        ...(account ? { accountId: account.id, loginHint: account.email } : {}),
      });
      return ok(flow);
    }

    const flowPath = rc.path.match(/^\/api\/google\/connect\/([A-Za-z0-9_-]{16,64})(\/complete)?$/);
    if (flowPath) {
      const state = flowPath[1]!;
      if (rc.method === "GET" && !flowPath[2]) return ok(flows.status(spaceId, userId, state));
      if (rc.method === "DELETE" && !flowPath[2]) return ok(flows.cancel(spaceId, userId, state));
      if (rc.method === "POST" && flowPath[2]) {
        const input = await rc.body();
        const pasted = String(input.url ?? "").trim();
        let pastedState: string | null = null;
        try { pastedState = new URL(pasted).searchParams.get("state"); } catch { /* reported below */ }
        if (pastedState !== state) {
          flows.status(spaceId, userId, state);
          return googleError("invalid-request", "Paste the full address from the browser's address bar after approving access to this sign-in.");
        }
        return ok(await flows.completeFromUrl(spaceId, userId, pasted));
      }
      return false;
    }

    // The caller's own accounts: turn on/off in this Space, or disconnect.
    const accountPath = rc.path.match(/^\/api\/google\/accounts\/([0-9A-Za-z_-]{1,128})$/);
    if (accountPath && rc.method === "PUT") {
      const input = await rc.body();
      if (typeof input.enabled !== "boolean") return googleError("invalid-request", "enabled must be true or false.");
      return ok(connector.setEnabled(spaceId, userId, accountPath[1]!, input.enabled));
    }
    if (accountPath && rc.method === "DELETE") {
      const result = await connector.disconnect(spaceId, self, accountPath[1]!);
      if (!result.removed) return googleError("not-found", "Google account not found.");
      return ok(result);
    }

    const servicePath = rc.path.match(/^\/api\/google\/service-accounts\/([0-9A-Za-z_-]{1,128})$/);
    if (servicePath && rc.method === "DELETE") {
      requireAdmin();
      const result = await connector.disconnect(spaceId, { kind: "space" }, servicePath[1]!);
      if (!result.removed) return googleError("not-found", "Google account not found.");
      return ok(result);
    }
    return false;
  };

  return async (rc) => {
    if (rc.path !== "/api/google" && !rc.path.startsWith("/api/google/")) return false;
    try {
      return await handle(rc);
    } catch (error) {
      const code = error instanceof GoogleError ? error.code : undefined;
      rc.json(googleErrorStatus(code), {
        ok: false,
        error: code ?? "google-unavailable",
        message: error instanceof GoogleError ? error.message : "The Google connector is unavailable.",
      });
      return true;
    }
  };
}
