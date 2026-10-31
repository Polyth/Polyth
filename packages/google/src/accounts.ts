// Google accounts have one of two owners (Spaces §14.4):
//
// - a PERSON: their own account, metadata in person storage outside every
//   Space and the refresh token in their person Credential Vault partition.
//   It works in a Space only after its owner turns it on there.
// - the SPACE: a *service account* an admin connected. Metadata lives in the
//   Space's package storage, the refresh token in the Space Credential Vault.
//   Every account connected before person ownership existed is one of these.
//
// Agent tools act only for the person who sent the turn: their enabled
// personal accounts, else the Space's service accounts when the Space policy
// lets agents use them, else a refusal. Access tokens stay in server memory.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { SecureSafeService, SpaceStorage } from "@polyth/contracts";
import { atomicWriteSync, resolveConnectionOwner, type PackageServicePolicy, type PeopleHost } from "@polyth/plugins";
import { createGoogleClient, GoogleError, googleError, type FetchLike, type GoogleClient, type GoogleTokenSource } from "./http.ts";
import { exchangeCode, fetchUserInfo, refreshAccessToken, revokeToken, type OAuthClient, type OAuthCompletion } from "./oauth.ts";
import { BUILTIN_CLIENT_CAPABILITIES, CAPABILITY_SPECS, grantedCapabilities, OWN_CLIENT_CAPABILITIES, type GoogleCapability } from "./scopes.ts";

export const GOOGLE_PACKAGE_ID = "google";

export type GoogleVault = Pick<SecureSafeService, "putOpaque" | "getOpaque" | "deleteOpaque">;

export type GoogleAccountStatus = "connected" | "reauthorization-required";

/** Whose account: a person's own, or the Space's service account. */
export type GoogleAccountOwner = { kind: "person"; userId: string } | { kind: "space" };

interface StoredAccount {
  id: string;
  email: string;
  name?: string;
  picture?: string;
  scopes: string[];
  status: GoogleAccountStatus;
  connectedAt: number;
  updatedAt: number;
  /** Personal accounts: the per-Space enablement id, fresh for every new connection. */
  connection?: string;
  /** Personal accounts: the OAuth client that issued the refresh token. */
  clientId?: string;
}

/** Account metadata safe for its owner (and, for service accounts, Space admins): no token material. */
export interface GoogleAccountDto {
  id: string;
  email: string;
  name?: string;
  picture?: string;
  status: GoogleAccountStatus;
  capabilities: GoogleCapability[];
  scopes: string[];
  connectedAt: number;
  updatedAt: number;
  /** Personal accounts only: turned on in the Space this was read in. */
  enabled?: boolean;
}

/** What a member who is not an admin sees of a Space service account. */
export interface GoogleServiceAccountLabelDto {
  label: string;
  status: GoogleAccountStatus;
  capabilities: GoogleCapability[];
}

export interface GoogleClientConfigDto {
  configured: boolean;
  /** `builtin` is Polyth's own Google app, baked into release builds. */
  source?: "space" | "environment" | "builtin";
  clientId?: string;
  hasSecret: boolean;
  /** What one consent asks for with this client; nothing else may be requested through the built-in app. */
  capabilities: GoogleCapability[];
}

export type GooglePeople = Pick<PeopleHost, "storage" | "vault" | "enabled" | "setEnabled" | "servicePolicy" | "setServicePolicy" | "isMember">;

export interface GoogleConnectorDeps {
  storage(spaceId: string): SpaceStorage;
  vault(spaceId: string): GoogleVault | undefined;
  /** Person-owned storage, secrets, enablement and the service policy (`host.people`). */
  people: GooglePeople;
  /** The default client for every Space: the server's own, or Polyth's built-in app. */
  env?: { clientId?: string; clientSecret?: string; builtin?: boolean };
  fetch?: FetchLike;
  now?: () => number;
}

export interface ResolvedGoogleAccount {
  owner: GoogleAccountOwner;
  account: GoogleAccountDto;
}

export interface GoogleConnector {
  clientConfig(spaceId: string): GoogleClientConfigDto;
  /** The OAuth client for a sign-in. Throws `not-configured`. */
  oauthClient(spaceId: string): OAuthClient;
  setClientConfig(spaceId: string, input: { clientId: string; clientSecret?: string }): GoogleClientConfigDto;
  clearClientConfig(spaceId: string): GoogleClientConfigDto;
  /** A person's own accounts (with `enabled` for this Space), or the Space's service accounts. */
  listAccounts(spaceId: string, owner: GoogleAccountOwner): GoogleAccountDto[];
  account(spaceId: string, owner: GoogleAccountOwner, accountId: string): GoogleAccountDto | undefined;
  /** Service accounts without email or ids, for members who are not admins. */
  serviceLabels(spaceId: string): GoogleServiceAccountLabelDto[];
  policy(spaceId: string): PackageServicePolicy;
  /** The calling route enforces Space admin. */
  setPolicy(spaceId: string, policy: PackageServicePolicy): PackageServicePolicy;
  /** Turn one of the person's own accounts on or off in a Space. */
  setEnabled(spaceId: string, userId: string, accountId: string, on: boolean): GoogleAccountDto;
  /**
   * The account an agent call uses, chosen only among the accounts the acting
   * person may use here (their enabled accounts, else service accounts under
   * the Space policy). `selector` matches only those; errors name only them.
   */
  resolveAccount(spaceId: string, actorUserId: string | undefined, capability: GoogleCapability, selector?: string): ResolvedGoogleAccount;
  /**
   * Capabilities whose tools may be offered in this Space. Tool visibility has
   * no acting person, so this is everything once an OAuth client is set up
   * (any member may connect their own account), plus what service accounts
   * hold; the call itself decides whose account, if any, may be used.
   */
  toolCapabilities(spaceId: string): Set<GoogleCapability>;
  client(spaceId: string, owner: GoogleAccountOwner, accountId: string): GoogleClient;
  completeAuthorization(completion: OAuthCompletion): Promise<{ accountId: string; email: string }>;
  disconnect(spaceId: string, owner: GoogleAccountOwner, accountId: string): Promise<{ removed: boolean; revoked: boolean }>;
  /** Drop cached access tokens (package disable). */
  reset(): void;
}

const ACCOUNTS_FILE = "accounts.json";
const CLIENT_FILE = "client.json";
const REFRESH_MARGIN_MS = 60_000;
const CLIENT_ID = /^[0-9A-Za-z._-]{8,200}\.apps\.googleusercontent\.com$/;
const CONNECTION_ID = /^g[0-9A-Za-z_-]{8,64}$/;

const spaceAccountKey = (spaceId: string, accountId: string): string => `google:${spaceId}:account:${accountId}`;
const personAccountKey = (accountId: string): string => `account:${accountId}`;
const clientSecretKey = (spaceId: string): string => `google:${spaceId}:client-secret`;

const isStoredAccount = (value: unknown): value is StoredAccount => {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<StoredAccount>;
  return typeof row.id === "string" && /^[0-9A-Za-z_-]{1,128}$/.test(row.id)
    && typeof row.email === "string"
    && (row.name === undefined || typeof row.name === "string")
    && (row.picture === undefined || typeof row.picture === "string")
    && Array.isArray(row.scopes) && row.scopes.every((scope) => typeof scope === "string")
    && (row.status === "connected" || row.status === "reauthorization-required")
    && typeof row.connectedAt === "number" && typeof row.updatedAt === "number"
    && (row.connection === undefined || (typeof row.connection === "string" && CONNECTION_ID.test(row.connection)))
    && (row.clientId === undefined || typeof row.clientId === "string");
};

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return googleError("invalid-state", "Google connector state is unreadable; restore it before continuing.");
  }
}

function writeJsonIn(dir: string, file: string, value: unknown): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  atomicWriteSync(join(dir, file), JSON.stringify(value, null, 2), 0o600);
}

function parseAccounts(value: unknown): StoredAccount[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(isStoredAccount)) {
    return googleError("invalid-state", "Google account state is malformed; restore it before continuing.");
  }
  return value;
}

const dto = (row: StoredAccount): GoogleAccountDto => ({
  id: row.id,
  email: row.email,
  ...(row.name ? { name: row.name } : {}),
  ...(row.picture ? { picture: row.picture } : {}),
  status: row.status,
  capabilities: grantedCapabilities(row.scopes),
  scopes: [...row.scopes],
  connectedAt: row.connectedAt,
  updatedAt: row.updatedAt,
});

/** One owner's accounts: where the metadata and the refresh tokens live. */
interface AccountStore {
  /** Token-cache namespace: `person:<userId>` or `space:<spaceId>`. */
  cacheKey: string;
  load(): StoredAccount[];
  save(rows: StoredAccount[]): void;
  vault(): GoogleVault | undefined;
  secretKey(accountId: string): string;
}

interface CachedToken { accessToken: string; expiresAt: number }

export function createGoogleConnector(deps: GoogleConnectorDeps): GoogleConnector {
  const fetcher: FetchLike = deps.fetch ?? ((input, init) => fetch(input, init));
  const now = deps.now ?? Date.now;
  const people = deps.people;
  const tokens = new Map<string, CachedToken>();
  const refreshing = new Map<string, Promise<string>>();
  // Bumped by disconnect so a refresh that was already in flight cannot
  // cache a token or store a rotated secret for a removed account.
  const generations = new Map<string, number>();
  const env = {
    clientId: deps.env?.clientId?.trim() || undefined,
    clientSecret: deps.env?.clientSecret?.trim() || undefined,
    builtin: deps.env?.builtin === true,
  };

  const storeFor = (spaceId: string, owner: GoogleAccountOwner): AccountStore => {
    if (owner.kind === "space") {
      return {
        cacheKey: `space:${spaceId}`,
        load: () => parseAccounts(readJson(join(deps.storage(spaceId).packageDir(GOOGLE_PACKAGE_ID), ACCOUNTS_FILE))),
        save: (rows) => writeJsonIn(deps.storage(spaceId).packageDir(GOOGLE_PACKAGE_ID), ACCOUNTS_FILE, rows),
        vault: () => deps.vault(spaceId),
        secretKey: (accountId) => spaceAccountKey(spaceId, accountId),
      };
    }
    const { userId } = owner;
    return {
      cacheKey: `person:${userId}`,
      load: () => parseAccounts(readJson(people.storage(userId, GOOGLE_PACKAGE_ID).path(ACCOUNTS_FILE))),
      save: (rows) => writeJsonIn(people.storage(userId, GOOGLE_PACKAGE_ID).root, ACCOUNTS_FILE, rows),
      vault: () => people.vault(userId, GOOGLE_PACKAGE_ID),
      secretKey: personAccountKey,
    };
  };

  const requireVault = (store: AccountStore): GoogleVault => store.vault()
    ?? googleError("not-configured", "Credential Vault is unavailable, so Google credentials cannot be stored. Enable the Credential Vault package.");

  const spaceClient = (spaceId: string): { clientId: string } | undefined => {
    const value = readJson(join(deps.storage(spaceId).packageDir(GOOGLE_PACKAGE_ID), CLIENT_FILE));
    if (value === undefined) return undefined;
    const clientId = value && typeof value === "object" ? (value as { clientId?: unknown }).clientId : undefined;
    if (typeof clientId !== "string" || !CLIENT_ID.test(clientId)) {
      return googleError("invalid-state", "Google OAuth client state is malformed; set the client again.");
    }
    return { clientId };
  };

  const oauthClient = (spaceId: string): OAuthClient => {
    const own = spaceClient(spaceId);
    if (own) {
      const secret = deps.vault(spaceId)?.getOpaque(clientSecretKey(spaceId)) ?? undefined;
      return { clientId: own.clientId, ...(secret ? { clientSecret: secret } : {}) };
    }
    if (env.clientId) return { clientId: env.clientId, ...(env.clientSecret ? { clientSecret: env.clientSecret } : {}) };
    return googleError("not-configured", "No Google OAuth client is set up. Add one in Settings → Google.");
  };

  const effectiveSpaceClientId = (spaceId: string): string | undefined => {
    try {
      return spaceClient(spaceId)?.clientId;
    } catch {
      return undefined;
    }
  };

  const effectiveClientId = (spaceId: string): string | undefined => {
    try {
      return spaceClient(spaceId)?.clientId ?? env.clientId;
    } catch {
      return undefined;
    }
  };

  /**
   * A refresh token only works with the OAuth client that issued it. A
   * personal account connected through another client (another Space's, or
   * an older environment client) needs to be reconnected here.
   */
  const usableHere = (row: StoredAccount, owner: GoogleAccountOwner, spaceId: string): boolean =>
    owner.kind === "space" || row.clientId === effectiveClientId(spaceId);

  const mutateAccounts = (store: AccountStore, change: (rows: StoredAccount[]) => void): StoredAccount[] => {
    const rows = store.load();
    change(rows);
    store.save(rows);
    return rows;
  };

  const markReauthorization = (store: AccountStore, accountId: string): void => {
    tokens.delete(`${store.cacheKey}:${accountId}`);
    try { store.vault()?.deleteOpaque(store.secretKey(accountId)); } catch { /* status below still blocks use */ }
    mutateAccounts(store, (rows) => {
      const row = rows.find((item) => item.id === accountId);
      if (row) { row.status = "reauthorization-required"; row.updatedAt = now(); }
    });
  };

  const refreshTokenFor = (store: AccountStore, accountId: string): string | undefined => {
    const raw = store.vault()?.getOpaque(store.secretKey(accountId));
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as { refreshToken?: unknown };
      return typeof parsed.refreshToken === "string" && parsed.refreshToken ? parsed.refreshToken : undefined;
    } catch {
      return undefined;
    }
  };

  const accessToken = async (spaceId: string, owner: GoogleAccountOwner, accountId: string, force: boolean): Promise<string> => {
    const store = storeFor(spaceId, owner);
    const key = `${store.cacheKey}:${accountId}`;
    if (owner.kind === "person") {
      // A person's token is shared by every Space they use it in, so check
      // this Space's client before handing out even a cached token.
      const row = store.load().find((item) => item.id === accountId);
      if (!row) return googleError("not-connected", "This Google account is no longer connected.");
      if (!usableHere(row, owner, spaceId)) {
        return googleError("authorization-revoked", `${row.email} was connected through a different Google OAuth client than this Space uses. Reconnect it here in Settings → Google.`);
      }
    }
    const cached = tokens.get(key);
    if (!force && cached && cached.expiresAt - REFRESH_MARGIN_MS > now()) return cached.accessToken;
    const pending = refreshing.get(key);
    if (pending) return pending;
    const run = (async () => {
      const row = store.load().find((item) => item.id === accountId);
      if (!row) return googleError("not-connected", "This Google account is no longer connected.");
      if (row.status !== "connected") {
        return googleError("authorization-revoked", `Google access for ${row.email} needs to be renewed. Reconnect the account in Settings → Google.`);
      }
      const refreshToken = refreshTokenFor(store, accountId);
      if (!refreshToken) {
        markReauthorization(store, accountId);
        return googleError("authorization-revoked", `The stored Google credential for ${row.email} is missing. Reconnect the account in Settings → Google.`);
      }
      const generation = generations.get(key) ?? 0;
      try {
        // Shared by every concurrent caller, so no single caller's abort signal
        // applies; the token request has its own timeout.
        const grant = await refreshAccessToken({ client: oauthClient(spaceId), refreshToken, fetch: fetcher, now });
        if ((generations.get(key) ?? 0) !== generation) {
          return googleError("not-connected", "This Google account was disconnected.");
        }
        tokens.set(key, { accessToken: grant.accessToken, expiresAt: grant.expiresAt });
        if (grant.refreshToken && grant.refreshToken !== refreshToken) {
          requireVault(store).putOpaque(store.secretKey(accountId), JSON.stringify({ refreshToken: grant.refreshToken }));
        }
        if (grant.scopes.length && grant.scopes.join(" ") !== [...row.scopes].sort().join(" ")) {
          mutateAccounts(store, (rows) => {
            const current = rows.find((item) => item.id === accountId);
            if (current) { current.scopes = grant.scopes; current.updatedAt = now(); }
          });
        }
        return grant.accessToken;
      } catch (error) {
        if ((generations.get(key) ?? 0) !== generation) return googleError("not-connected", "This Google account was disconnected.");
        if (error instanceof GoogleError && error.code === "authorization-revoked") markReauthorization(store, accountId);
        throw error;
      }
    })();
    refreshing.set(key, run);
    try {
      return await run;
    } finally {
      if (refreshing.get(key) === run) refreshing.delete(key);
    }
  };

  const tokenSource = (spaceId: string, owner: GoogleAccountOwner, accountId: string): GoogleTokenSource => ({
    accessToken: (options) => accessToken(spaceId, owner, accountId, options?.refresh === true),
  });

  const listAccounts = (spaceId: string, owner: GoogleAccountOwner): GoogleAccountDto[] => {
    const rows = storeFor(spaceId, owner).load();
    if (owner.kind === "space") return rows.map(dto);
    const enabled = new Set(people.enabled(owner.userId, spaceId, GOOGLE_PACKAGE_ID));
    return rows.map((row) => ({
      ...dto(row),
      ...(usableHere(row, owner, spaceId) ? {} : { status: "reauthorization-required" as const }),
      enabled: row.connection !== undefined && enabled.has(row.connection),
    }));
  };

  const clientConfig = (spaceId: string): GoogleClientConfigDto => {
    const own = spaceClient(spaceId);
    if (own) {
      return {
        configured: true,
        source: "space",
        clientId: own.clientId,
        hasSecret: Boolean(deps.vault(spaceId)?.getOpaque(clientSecretKey(spaceId))),
        capabilities: [...OWN_CLIENT_CAPABILITIES],
      };
    }
    if (env.clientId) {
      return {
        configured: true,
        source: env.builtin ? "builtin" : "environment",
        clientId: env.clientId,
        hasSecret: Boolean(env.clientSecret),
        capabilities: [...(env.builtin ? BUILTIN_CLIENT_CAPABILITIES : OWN_CLIENT_CAPABILITIES)],
      };
    }
    return { configured: false, hasSecret: false, capabilities: [] };
  };

  const policy = (spaceId: string): PackageServicePolicy => {
    try {
      return { agentsMayUseService: people.servicePolicy(spaceId, GOOGLE_PACKAGE_ID).agentsMayUseService === true };
    } catch {
      return { agentsMayUseService: false };
    }
  };

  /** The accounts the acting person may use here, or the refusal that explains why none. */
  const candidates = (spaceId: string, actorUserId: string | undefined): { owner: GoogleAccountOwner; accounts: GoogleAccountDto[] } => {
    const actor = actorUserId || undefined;
    const member = actor ? people.isMember(actor, spaceId) : false;
    const personal = actor && member ? listAccounts(spaceId, { kind: "person", userId: actor }).filter((row) => row.enabled) : [];
    const service = listAccounts(spaceId, { kind: "space" });
    const decision = resolveConnectionOwner({
      actorUserId: actor,
      spaceId,
      isMember: () => member,
      personalEnabled: personal.map((row) => row.id),
      hasService: service.length > 0,
      policy: policy(spaceId),
      origin: "agent",
    });
    if (decision.kind === "personal") return { owner: { kind: "person", userId: decision.userId }, accounts: personal };
    if (decision.kind === "service") return { owner: { kind: "space" }, accounts: service };
    switch (decision.reason) {
      case "not-a-member":
        return googleError("permission-denied", "The person this turn acts for is not a member of this Space, so no Google account can be used.");
      case "service-not-allowed":
        return googleError("not-connected", "No person started this turn, and this Space does not let agents use its Google service accounts. A Space admin can allow it in Settings → Google.");
      default:
        return googleError("not-connected", "Connect your Google account in Settings → Google and turn it on for this Space.");
    }
  };

  return {
    clientConfig,
    oauthClient,
    setClientConfig(spaceId, input) {
      const clientId = String(input.clientId ?? "").trim();
      if (!CLIENT_ID.test(clientId)) {
        return googleError("invalid-request", "Enter the client ID of a Google OAuth client (it ends with .apps.googleusercontent.com).");
      }
      const secret = typeof input.clientSecret === "string" ? input.clientSecret.trim() : "";
      if (secret && (secret.length > 200 || /\s/.test(secret))) return googleError("invalid-request", "The client secret is not valid.");
      const vault = deps.vault(spaceId)
        ?? googleError("not-configured", "Credential Vault is unavailable, so Google credentials cannot be stored. Enable the Credential Vault package.");
      // Google's token endpoint refuses a Desktop app client without its
      // secret ("client_secret is missing"), so a client is never saved
      // without one. Saving the same client again may keep the stored secret.
      if (!secret && (effectiveSpaceClientId(spaceId) !== clientId || !vault.getOpaque(clientSecretKey(spaceId)))) {
        return googleError("invalid-request", "Enter the client secret too. Google shows it next to the client ID, and it is in the file Google lets you download.");
      }
      if (secret) vault.putOpaque(clientSecretKey(spaceId), secret);
      writeJsonIn(deps.storage(spaceId).packageDir(GOOGLE_PACKAGE_ID), CLIENT_FILE, { clientId });
      return clientConfig(spaceId);
    },
    clearClientConfig(spaceId) {
      deps.vault(spaceId)?.deleteOpaque(clientSecretKey(spaceId));
      rmSync(join(deps.storage(spaceId).packageDir(GOOGLE_PACKAGE_ID), CLIENT_FILE), { force: true });
      return clientConfig(spaceId);
    },
    listAccounts,
    account(spaceId, owner, accountId) {
      return listAccounts(spaceId, owner).find((row) => row.id === accountId);
    },
    serviceLabels(spaceId) {
      return storeFor(spaceId, { kind: "space" }).load().map((row) => ({
        label: row.name || "Space Google account",
        status: row.status,
        capabilities: grantedCapabilities(row.scopes),
      }));
    },
    policy,
    setPolicy(spaceId, next) {
      if (typeof next?.agentsMayUseService !== "boolean") return googleError("invalid-request", "agentsMayUseService must be true or false.");
      people.setServicePolicy(spaceId, GOOGLE_PACKAGE_ID, { agentsMayUseService: next.agentsMayUseService });
      return policy(spaceId);
    },
    setEnabled(spaceId, userId, accountId, on) {
      const owner: GoogleAccountOwner = { kind: "person", userId };
      const row = storeFor(spaceId, owner).load().find((item) => item.id === accountId);
      if (!row?.connection) return googleError("not-found", "Google account not found.");
      if (on && !people.isMember(userId, spaceId)) return googleError("permission-denied", "Only members of this Space can use their Google account in it.");
      people.setEnabled(userId, spaceId, GOOGLE_PACKAGE_ID, row.connection, on);
      return listAccounts(spaceId, owner).find((item) => item.id === accountId)!;
    },
    resolveAccount(spaceId, actorUserId, capability, selector) {
      const { owner, accounts } = candidates(spaceId, actorUserId);
      const wanted = typeof selector === "string" ? selector.trim().toLowerCase() : "";
      if (wanted) {
        const match = accounts.find((row) => row.id === wanted || row.email.toLowerCase() === wanted);
        if (!match) {
          return googleError("not-connected", `None of the Google accounts you can use here matches "account". Available: ${accounts.map((row) => row.email).join(", ") || "none"}.`);
        }
        if (!match.capabilities.includes(capability)) {
          return googleError("insufficient-scope", `${match.email} has not authorized ${capability}. Ask the user to allow it in Settings → Google.`);
        }
        return { owner, account: match };
      }
      const able = accounts.filter((row) => row.capabilities.includes(capability));
      if (able.length === 1) return { owner, account: able[0]! };
      if (!able.length) {
        return googleError("insufficient-scope", `No Google account you can use here has authorized ${capability}. Ask the user to allow it in Settings → Google.`);
      }
      return googleError("account-ambiguous", `Several Google accounts can do this; pass "account" with one of: ${able.map((row) => row.email).join(", ")}.`);
    },
    toolCapabilities(spaceId) {
      const capabilities = new Set<GoogleCapability>();
      // What the Space's client can be granted: everything through its own
      // client, only the light set through Polyth's built-in app.
      try {
        const client = clientConfig(spaceId);
        if (client.configured) {
          const requested = client.capabilities.flatMap((capability) => CAPABILITY_SPECS[capability].request);
          for (const capability of grantedCapabilities(requested)) capabilities.add(capability);
        }
      } catch {
        // An unreadable client configuration grants nothing.
      }
      try {
        for (const row of listAccounts(spaceId, { kind: "space" })) for (const capability of row.capabilities) capabilities.add(capability);
      } catch {
        // Unreadable state exposes no service tools; routes report the error.
      }
      return capabilities;
    },
    client(spaceId, owner, accountId) {
      return createGoogleClient({ tokens: tokenSource(spaceId, owner, accountId), fetch: fetcher });
    },
    async completeAuthorization(completion) {
      const { spaceId } = completion;
      const owner: GoogleAccountOwner = completion.owner === "person" ? { kind: "person", userId: completion.userId } : { kind: "space" };
      if (owner.kind === "person" && !people.isMember(owner.userId, spaceId)) {
        return googleError("permission-denied", "Only members of this Space can connect a Google account here.");
      }
      const store = storeFor(spaceId, owner);
      const client = oauthClient(spaceId);
      const grant = await exchangeCode({
        client,
        code: completion.code,
        verifier: completion.verifier,
        redirectUri: completion.redirectUri,
        fetch: fetcher,
        now,
      });
      const profile = await fetchUserInfo(grant.accessToken, fetcher);
      if (completion.accountId && profile.sub !== completion.accountId) {
        const expected = store.load().find((row) => row.id === completion.accountId)?.email ?? "the selected account";
        return googleError("invalid-request", `You signed in to Google as ${profile.email}, but this was a request for ${expected}. Try again and choose ${expected}.`);
      }
      const existing = store.load().find((row) => row.id === profile.sub);
      // A token from another OAuth client cannot be refreshed with this one.
      const reusable = existing && (owner.kind === "space" || existing.clientId === client.clientId);
      const refreshToken = grant.refreshToken ?? (existing && reusable ? refreshTokenFor(store, existing.id) : undefined);
      if (!refreshToken) {
        return googleError("authorization-required", "Google did not grant offline access. Remove Polyth from your Google account's third-party access and connect again.");
      }
      const vault = requireVault(store);
      const key = store.secretKey(profile.sub);
      const prior = vault.getOpaque(key);
      vault.putOpaque(key, JSON.stringify({ refreshToken }));
      let connection: string | undefined;
      try {
        mutateAccounts(store, (rows) => {
          const at = now();
          const row = rows.find((item) => item.id === profile.sub);
          connection = owner.kind === "person" ? row?.connection ?? `g${randomBytes(12).toString("base64url")}` : undefined;
          const next: StoredAccount = {
            id: profile.sub,
            email: profile.email,
            ...(profile.name ? { name: profile.name } : {}),
            ...(profile.picture ? { picture: profile.picture } : {}),
            scopes: grant.scopes,
            status: "connected",
            connectedAt: row?.connectedAt ?? at,
            updatedAt: at,
            ...(connection ? { connection, clientId: client.clientId } : {}),
          };
          if (row) rows.splice(rows.indexOf(row), 1, next);
          else rows.push(next);
        });
      } catch (error) {
        try { prior === null ? vault.deleteOpaque(key) : vault.putOpaque(key, prior); } catch { /* original error wins */ }
        throw error;
      }
      // Connecting from a Space turns the account on there; a reauthorization
      // (adding a service, renewing) keeps whatever the owner chose.
      if (owner.kind === "person" && connection && !completion.accountId) {
        people.setEnabled(owner.userId, spaceId, GOOGLE_PACKAGE_ID, connection, true);
      }
      tokens.set(`${store.cacheKey}:${profile.sub}`, { accessToken: grant.accessToken, expiresAt: grant.expiresAt });
      return { accountId: profile.sub, email: profile.email };
    },
    async disconnect(spaceId, owner, accountId) {
      const store = storeFor(spaceId, owner);
      const row = store.load().find((item) => item.id === accountId);
      if (!row) return { removed: false, revoked: false };
      const refreshToken = refreshTokenFor(store, accountId);
      // Revoke first so a failed local cleanup never leaves a live grant behind silently.
      const revoked = refreshToken ? await revokeToken(refreshToken, fetcher) : true;
      const key = `${store.cacheKey}:${accountId}`;
      generations.set(key, (generations.get(key) ?? 0) + 1);
      tokens.delete(key);
      store.vault()?.deleteOpaque(store.secretKey(accountId));
      mutateAccounts(store, (rows) => {
        const index = rows.findIndex((item) => item.id === accountId);
        if (index >= 0) rows.splice(index, 1);
      });
      // Enablement elsewhere names this connection id, which a reconnection
      // never reuses, so other Spaces do not silently get it back.
      if (owner.kind === "person" && row.connection) {
        try { people.setEnabled(owner.userId, spaceId, GOOGLE_PACKAGE_ID, row.connection, false); } catch { /* the account is gone either way */ }
      }
      return { removed: true, revoked };
    },
    reset() {
      tokens.clear();
      refreshing.clear();
    },
  };
}
