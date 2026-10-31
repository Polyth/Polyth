// In-memory stand-in for Google's OAuth endpoints. It checks PKCE and the
// redirect URI exactly like Google does, so tests exercise the real flow.
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpaceStorage } from "@polyth/contracts";
import type { PackageServicePolicy } from "@polyth/plugins";
import { createSpaceStorage } from "@polyth/tenancy";
import type { GooglePeople, GoogleVault } from "../src/accounts.ts";
import type { FetchLike } from "../src/http.ts";

export interface FakeUser { sub: string; email: string; name?: string }

export function fakeGoogle(options: { user?: FakeUser; grantedScopes?: (requested: string[]) => string[] } = {}) {
  let user: FakeUser = options.user ?? { sub: "1001", email: "ada@example.com", name: "Ada" };
  const codes = new Map<string, { challenge: string; redirectUri: string; scopes: string[]; user: FakeUser }>();
  const refreshTokens = new Map<string, { scopes: string[]; user: FakeUser }>();
  const accessTokens = new Map<string, FakeUser>();
  const log: string[] = [];
  let counter = 0;
  let refreshFailure: string | undefined;
  let revokeStatus = 200;
  let refreshGate: Promise<void> | undefined;
  let api: ((url: URL, init: RequestInit) => Response | undefined) | undefined;

  /** Simulate the user approving the consent screen for an authorization URL. */
  const approve = (authorizationUrl: string): { code: string; state: string; redirectUri: string } => {
    const url = new URL(authorizationUrl);
    const requested = (url.searchParams.get("scope") ?? "").split(" ").filter(Boolean);
    const code = `code-${++counter}`;
    codes.set(code, {
      challenge: url.searchParams.get("code_challenge") ?? "",
      redirectUri: url.searchParams.get("redirect_uri") ?? "",
      scopes: options.grantedScopes ? options.grantedScopes(requested) : requested,
      user,
    });
    return { code, state: url.searchParams.get("state") ?? "", redirectUri: url.searchParams.get("redirect_uri") ?? "" };
  };

  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    log.push(`${init.method ?? "GET"} ${url.origin}${url.pathname}`);
    if (url.href === "https://oauth2.googleapis.com/token") {
      const form = new URLSearchParams(String(init.body));
      if (form.get("client_id") !== "123-test.apps.googleusercontent.com") return json(401, { error: "invalid_client" });
      // Like Google, a Desktop app client needs its secret even with PKCE.
      if (!form.get("client_secret")) return json(400, { error: "invalid_request", error_description: "client_secret is missing." });
      if (form.get("grant_type") === "authorization_code") {
        const grant = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
        if (!grant || grant.challenge !== challenge || grant.redirectUri !== form.get("redirect_uri")) return json(400, { error: "invalid_grant" });
        const access = `access-${++counter}`;
        const refresh = `refresh-${counter}`;
        accessTokens.set(access, grant.user);
        refreshTokens.set(refresh, { scopes: grant.scopes, user: grant.user });
        return json(200, { access_token: access, expires_in: 3599, refresh_token: refresh, scope: grant.scopes.join(" "), token_type: "Bearer" });
      }
      if (form.get("grant_type") === "refresh_token") {
        if (refreshGate) await refreshGate;
        if (refreshFailure) return json(400, { error: refreshFailure });
        const grant = refreshTokens.get(form.get("refresh_token") ?? "");
        if (!grant) return json(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
        const access = `access-${++counter}`;
        accessTokens.set(access, grant.user);
        return json(200, { access_token: access, expires_in: 3599, scope: grant.scopes.join(" "), token_type: "Bearer" });
      }
      return json(400, { error: "unsupported_grant_type" });
    }
    if (url.href === "https://oauth2.googleapis.com/revoke") {
      const token = new URLSearchParams(String(init.body)).get("token") ?? "";
      if (revokeStatus !== 200) return json(revokeStatus, { error: "server_error" });
      if (!refreshTokens.delete(token)) return json(400, { error: "invalid_token" });
      return json(200, {});
    }
    const bearer = new Headers(init.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
    const owner = accessTokens.get(bearer);
    if (url.href === "https://openidconnect.googleapis.com/v1/userinfo") {
      if (!owner) return json(401, { error: "invalid_token" });
      return json(200, { sub: owner.sub, email: owner.email, email_verified: true, ...(owner.name ? { name: owner.name } : {}) });
    }
    if (url.origin === "https://www.googleapis.com" || url.origin === "https://gmail.googleapis.com") {
      if (!owner) return json(401, { error: { code: 401, message: "Invalid Credentials", errors: [{ reason: "authError" }] } });
      return api?.(url, init) ?? json(200, { path: url.pathname, user: owner.email });
    }
    return json(404, {});
  };

  return {
    fetch,
    approve,
    log,
    refreshTokens,
    setUser(next: FakeUser) { user = next; },
    failRefresh(error: string | undefined) { refreshFailure = error; },
    failRevoke(status: number) { revokeStatus = status; },
    /** Answer Google API calls (after token checks); undefined falls back to an echo. */
    handleApi(handler: (url: URL, init: RequestInit) => Response | undefined) { api = handler; },
    /** Hold refresh-token requests until the returned function is called. */
    holdRefresh(): () => void {
      let release!: () => void;
      refreshGate = new Promise((resolve) => { release = resolve; });
      return () => { refreshGate = undefined; release(); };
    },
  };
}

export function memoryVault(): GoogleVault & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    putOpaque: (key, value) => { values.set(key, value); },
    getOpaque: (key) => values.get(key) ?? null,
    deleteOpaque: (key) => { values.delete(key); },
  };
}

/**
 * In-memory `host.people` with the server's rules: person storage outside
 * every Space, a vault per person, enablement that needs membership to turn
 * on, and a Space policy that defaults to off.
 */
type PackageOpaqueVault = ReturnType<GooglePeople["vault"]>;
type PersonPackageStorage = ReturnType<GooglePeople["storage"]>;

export function people(members: Record<string, string[]> = {}): GooglePeople & {
  members: Map<string, Set<string>>;
  vaults: Map<string, ReturnType<typeof memoryVault>>;
  policies: Map<string, PackageServicePolicy>;
  roots: Map<string, string>;
} {
  const membership = new Map(Object.entries(members).map(([spaceId, users]) => [spaceId, new Set(users)]));
  const roots = new Map<string, string>();
  const vaults = new Map<string, ReturnType<typeof memoryVault>>();
  const enablement = new Map<string, string[]>();
  const policies = new Map<string, PackageServicePolicy>();
  const isMember = (userId: string, spaceId: string) => membership.get(spaceId)?.has(userId) === true;
  const own = (packageId: string) => { if (packageId !== "google") throw Object.assign(new Error("forbidden"), { code: "forbidden" }); };
  return {
    members: membership,
    vaults,
    policies,
    roots,
    storage(userId, packageId): PersonPackageStorage {
      own(packageId);
      let root = roots.get(userId);
      if (!root) { root = mkdtempSync(join(tmpdir(), `google-person-${userId}-`)); roots.set(userId, root); }
      return { root, path: (relative) => join(root, relative) };
    },
    vault(userId, packageId): PackageOpaqueVault {
      own(packageId);
      let vault = vaults.get(userId);
      if (!vault) { vault = memoryVault(); vaults.set(userId, vault); }
      return { ...vault, deleteOpaqueByPrefix: () => 0 } as unknown as PackageOpaqueVault;
    },
    enabled: (userId, spaceId, packageId) => { own(packageId); return [...(enablement.get(`${userId}|${spaceId}`) ?? [])]; },
    setEnabled(userId, spaceId, packageId, connectionId, on) {
      own(packageId);
      if (on && !isMember(userId, spaceId)) throw Object.assign(new Error("not a member of this Space"), { code: "forbidden" });
      const current = (enablement.get(`${userId}|${spaceId}`) ?? []).filter((id) => id !== connectionId);
      if (on) current.push(connectionId);
      enablement.set(`${userId}|${spaceId}`, current);
    },
    servicePolicy: (spaceId, packageId) => { own(packageId); return policies.get(spaceId) ?? { agentsMayUseService: false }; },
    setServicePolicy: (spaceId, packageId, policy) => { own(packageId); policies.set(spaceId, { ...policy }); },
    isMember,
  };
}

export function spaces(): { storage(spaceId: string): SpaceStorage; vault(spaceId: string): GoogleVault; vaults: Map<string, ReturnType<typeof memoryVault>> } {
  const storages = new Map<string, SpaceStorage>();
  const vaults = new Map<string, ReturnType<typeof memoryVault>>();
  return {
    vaults,
    storage(spaceId) {
      let storage = storages.get(spaceId);
      if (!storage) {
        storage = createSpaceStorage(mkdtempSync(join(tmpdir(), `google-${spaceId}-`)));
        storages.set(spaceId, storage);
      }
      return storage;
    },
    vault(spaceId) {
      let vault = vaults.get(spaceId);
      if (!vault) { vault = memoryVault(); vaults.set(spaceId, vault); }
      return vault;
    },
  };
}

export const TEST_CLIENT_ID = "123-test.apps.googleusercontent.com";
