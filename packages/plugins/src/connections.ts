import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import type { PackageConnectionPublicDto, SecureSafeService, SpaceStorage } from "@polyth/contracts";
import type { PackageConnectionContribution } from "@polyth/package-sdk/manifest";
import { fetchPublicHttps } from "./networkBroker.ts";
import { createOauthTx, type OauthTx } from "./oauthTx.ts";
import { connectionFingerprint } from "./connectionFingerprint.ts";
import { readConnectionFingerprints } from "./grants.ts";
import { readJsonFile, spacePackageFile, writeJsonFile } from "./spaceJson.ts";

export type PackageOpaqueVault = Pick<
  SecureSafeService,
  "putOpaque" | "getOpaque" | "deleteOpaque" | "deleteOpaqueByPrefix"
>;

export interface ConnectionScope {
  storage: SpaceStorage;
  spaceId: string;
  vault: PackageOpaqueVault;
  /** Test seam for OAuth token HTTP. Production uses the package network broker. */
  oauthHttp?: typeof fetchPublicHttps;
}

interface StoredConnection {
  status: PackageConnectionPublicDto["status"];
  account?: string;
  error?: string;
  expiresAt?: number;
}

interface ConnectionSecret {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
}

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

const publicFile = (storage: SpaceStorage, packageId: string): string =>
  spacePackageFile(storage, packageId, "connections.json");

function vaultKey(spaceId: string, packageId: string, connectionId: string): string {
  return `pkgconn:${spaceId}:${packageId}:${connectionId}`;
}

function loadPublic(storage: SpaceStorage, packageId: string): Record<string, StoredConnection> {
  return readJsonFile<Record<string, StoredConnection>>(publicFile(storage, packageId), {});
}

function savePublic(storage: SpaceStorage, packageId: string, data: Record<string, StoredConnection>): void {
  writeJsonFile(publicFile(storage, packageId), data);
}

function readSecret(scope: ConnectionScope, packageId: string, connectionId: string): ConnectionSecret | null {
  const raw = scope.vault.getOpaque(vaultKey(scope.spaceId, packageId, connectionId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ConnectionSecret;
  } catch {
    return null;
  }
}

function putSecret(
  scope: ConnectionScope,
  packageId: string,
  connectionId: string,
  secret: ConnectionSecret,
): void {
  scope.vault.putOpaque(vaultKey(scope.spaceId, packageId, connectionId), JSON.stringify(secret));
}

function deleteSecret(scope: ConnectionScope, packageId: string, connectionId: string): void {
  scope.vault.deleteOpaque(vaultKey(scope.spaceId, packageId, connectionId));
}

const mutationLocks = new Map<string, Promise<void>>();

function mutationKey(spaceId: string, packageId: string): string {
  return `${spaceId}:${packageId}`;
}

async function withPackageSecretsLock<T>(
  spaceId: string,
  packageId: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const key = mutationKey(spaceId, packageId);
  const previous = mutationLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  const held = previous.then(() => gate);
  mutationLocks.set(key, held);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (mutationLocks.get(key) === held) mutationLocks.delete(key);
  }
}

async function withConnectionMutation<T>(
  scope: ConnectionScope,
  packageId: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  return withPackageSecretsLock(scope.spaceId, packageId, fn);
}

export function publicConnection(
  conn: StoredConnection,
  spec: PackageConnectionContribution,
): PackageConnectionPublicDto {
  return {
    id: spec.id,
    label: spec.label,
    kind: spec.kind,
    status: conn.status,
    ...(conn.account ? { account: conn.account } : {}),
    ...(conn.error ? { error: conn.error } : {}),
  };
}

export function listPublicConnections(
  storage: SpaceStorage,
  packageId: string,
  specs: readonly PackageConnectionContribution[],
): PackageConnectionPublicDto[] {
  const stored = loadPublic(storage, packageId);
  return specs.map((spec) => publicConnection(stored[spec.id] ?? { status: "disconnected" }, spec));
}

export function assertApprovedConnection(
  storage: SpaceStorage,
  packageId: string,
  spec: PackageConnectionContribution,
): void {
  const approved = readConnectionFingerprints(storage, packageId)[spec.id];
  if (!approved || approved !== connectionFingerprint(spec)) {
    return fail("CAPABILITY_DENIED", "connection declaration changed and needs review");
  }
}

function connectionStillLive(
  scope: ConnectionScope,
  packageId: string,
  spec: PackageConnectionContribution,
): StoredConnection | null {
  const current = loadPublic(scope.storage, packageId)[spec.id];
  if (!current || current.status === "disconnected") return null;
  try {
    assertApprovedConnection(scope.storage, packageId, spec);
  } catch {
    return null;
  }
  return current;
}

async function refreshOauth(
  scope: ConnectionScope,
  packageId: string,
  spec: PackageConnectionContribution,
  secret: ConnectionSecret,
): Promise<ConnectionSecret | null> {
  const oauth = spec.kind === "oauth" ? spec.oauth : undefined;
  if (!oauth || !secret.refreshToken) return null;
  return withConnectionMutation(scope, packageId, async () => {
    if (!connectionStillLive(scope, packageId, spec)) return null;
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: secret.refreshToken!,
      client_id: oauth.clientId,
    });
    const http = scope.oauthHttp ?? fetchPublicHttps;
    try {
      const response = await http(oauth.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: body.toString(),
        maxBytes: 64 * 1024,
      });
      const live = connectionStillLive(scope, packageId, spec);
      if (!live) return null;
      const stored = loadPublic(scope.storage, packageId);
      const json = JSON.parse(response.body) as {
        access_token?: unknown;
        refresh_token?: unknown;
        token_type?: unknown;
        expires_in?: unknown;
      };
      if (response.status >= 400 || typeof json.access_token !== "string") {
        live.status = "error";
        live.error = "oauth refresh failed";
        stored[spec.id] = live;
        savePublic(scope.storage, packageId, stored);
        return null;
      }
      const next: ConnectionSecret = {
        accessToken: json.access_token,
        refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : secret.refreshToken,
        tokenType: typeof json.token_type === "string" ? json.token_type : secret.tokenType,
      };
      if (!connectionStillLive(scope, packageId, spec)) return null;
      putSecret(scope, packageId, spec.id, next);
      live.status = "connected";
      delete live.error;
      if (typeof json.expires_in === "number") live.expiresAt = Date.now() + json.expires_in * 1000;
      else delete live.expiresAt;
      stored[spec.id] = live;
      savePublic(scope.storage, packageId, stored);
      return next;
    } catch {
      const live = connectionStillLive(scope, packageId, spec);
      if (live) {
        const stored = loadPublic(scope.storage, packageId);
        live.status = "error";
        live.error = "oauth refresh failed";
        stored[spec.id] = live;
        savePublic(scope.storage, packageId, stored);
      }
      return null;
    }
  });
}

export async function connectionAuthorization(
  scope: ConnectionScope,
  packageId: string,
  spec: PackageConnectionContribution,
): Promise<{ header: string; value: string } | null> {
  const conn = loadPublic(scope.storage, packageId)[spec.id];
  if (conn?.status !== "connected") return null;
  assertApprovedConnection(scope.storage, packageId, spec);
  let secret = readSecret(scope, packageId, spec.id);
  if (!secret?.accessToken) return null;
  if (conn.expiresAt && conn.expiresAt < Date.now() + 5_000) {
    const refreshed = await refreshOauth(scope, packageId, spec, secret);
    if (!refreshed) return null;
    secret = refreshed;
  }
  if (spec.kind === "token") return { header: "authorization", value: secret.accessToken };
  return { header: "authorization", value: `${secret.tokenType ?? "Bearer"} ${secret.accessToken}` };
}

/** Credentials may only be attached to origins declared on the connection. */
export function assertConnectionOrigin(spec: PackageConnectionContribution, url: string): void {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return fail("NETWORK_ORIGIN_DENIED", "URL is invalid");
  }
  if (!spec.origins?.includes(origin)) {
    return fail("NETWORK_ORIGIN_DENIED", `connection "${spec.id}" is not bound to ${origin}`);
  }
}

export async function setTokenConnection(
  scope: ConnectionScope,
  packageId: string,
  spec: PackageConnectionContribution,
  token: string,
): Promise<PackageConnectionPublicDto> {
  if (spec.kind !== "token") fail("INVALID_REQUEST", "connection is not token-based");
  if (typeof token !== "string" || token.trim().length < 4) fail("INVALID_REQUEST", "token is required");
  return withConnectionMutation(scope, packageId, () => {
    const accessToken = token.startsWith("Bearer ") ? token : `Bearer ${token.trim()}`;
    putSecret(scope, packageId, spec.id, { accessToken });
    const stored = loadPublic(scope.storage, packageId);
    stored[spec.id] = { status: "connected" };
    savePublic(scope.storage, packageId, stored);
    return publicConnection(stored[spec.id]!, spec);
  });
}

export function startOauth(
  scope: ConnectionScope,
  packageId: string,
  spec: PackageConnectionContribution,
  input: { redirectUri: string; version: string; integrity: string; installGeneration: string },
): { url: string; state: string } {
  const oauth = spec.kind === "oauth" ? spec.oauth : undefined;
  if (!oauth) return fail("INVALID_REQUEST", "connection is not oauth");
  assertApprovedConnection(scope.storage, packageId, spec);
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const tx = createOauthTx({
    spaceId: scope.spaceId,
    packageId,
    version: input.version,
    integrity: input.integrity,
    installGeneration: input.installGeneration,
    connectionId: spec.id,
    connectionFingerprint: connectionFingerprint(spec),
    redirectUri: input.redirectUri,
    verifier,
  });
  const url = new URL(oauth.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", oauth.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", tx.oauthTxId);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (oauth.scopes?.length) url.searchParams.set("scope", oauth.scopes.join(" "));
  return { url: url.toString(), state: tx.oauthTxId };
}

export async function completeOauthFromTx(
  scope: ConnectionScope,
  spec: PackageConnectionContribution,
  tx: OauthTx,
  code: string,
): Promise<PackageConnectionPublicDto> {
  if (tx.connectionId !== spec.id) return fail("invalid-input", "oauth callback is invalid");
  const oauth = spec.kind === "oauth" ? spec.oauth : undefined;
  if (!oauth) return fail("INVALID_REQUEST", "connection is not oauth");
  return withConnectionMutation(scope, tx.packageId, async () => {
    assertApprovedConnection(scope.storage, tx.packageId, spec);
    const stored = loadPublic(scope.storage, tx.packageId);
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: tx.redirectUri,
      client_id: oauth.clientId,
      code_verifier: tx.verifier,
    });
    const http = scope.oauthHttp ?? fetchPublicHttps;
    const response = await http(oauth.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString(),
      maxBytes: 64 * 1024,
    });
    assertApprovedConnection(scope.storage, tx.packageId, spec);
    const json = JSON.parse(response.body) as {
      access_token?: unknown;
      refresh_token?: unknown;
      token_type?: unknown;
      expires_in?: unknown;
    };
    if (response.status >= 400 || typeof json.access_token !== "string") {
      stored[spec.id] = { status: "error", error: "oauth token exchange failed" };
      savePublic(scope.storage, tx.packageId, stored);
      return fail("HOST_REJECTED", "oauth token exchange failed");
    }
    putSecret(scope, tx.packageId, spec.id, {
      accessToken: json.access_token,
      ...(typeof json.refresh_token === "string" ? { refreshToken: json.refresh_token } : {}),
      ...(typeof json.token_type === "string" ? { tokenType: json.token_type } : {}),
    });
    stored[spec.id] = {
      status: "connected",
      ...(typeof json.expires_in === "number" ? { expiresAt: Date.now() + json.expires_in * 1000 } : {}),
    };
    savePublic(scope.storage, tx.packageId, stored);
    return publicConnection(stored[spec.id]!, spec);
  });
}

export async function disconnectConnection(
  scope: ConnectionScope,
  packageId: string,
  spec: PackageConnectionContribution,
): Promise<PackageConnectionPublicDto> {
  return withConnectionMutation(scope, packageId, () => {
    deleteSecret(scope, packageId, spec.id);
    const stored = loadPublic(scope.storage, packageId);
    stored[spec.id] = { status: "disconnected" };
    savePublic(scope.storage, packageId, stored);
    return publicConnection(stored[spec.id]!, spec);
  });
}

export async function deleteConnectionSecrets(
  vault: PackageOpaqueVault | undefined,
  storage: SpaceStorage,
  packageId: string,
  spaceId: string,
): Promise<void> {
  await withPackageSecretsLock(spaceId, packageId, () => {
    if (vault) vault.deleteOpaqueByPrefix(`pkgconn:${spaceId}:${packageId}:`);
    const pub = publicFile(storage, packageId);
    if (existsSync(pub)) writeJsonFile(pub, {});
  });
}
