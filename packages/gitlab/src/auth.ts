import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SpaceContext, SpaceStorage } from "@polyth/contracts";
import { atomicWriteSync } from "@polyth/plugins";

export type GitlabAuthKind = "pat" | "glab";

/** Public, Space-owned account metadata. Credential values never enter this record. */
export interface GitlabAccount {
  id: string;
  instanceId: string;
  label: string;
  authKind: GitlabAuthKind;
  username: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface GitlabAccountInput {
  instanceId: string;
  label: string;
  username: string;
}

export interface GitlabOpaqueVault {
  putOpaque(key: string, value: string): void;
  getOpaque(key: string): string | null;
  deleteOpaque(key: string): void;
}

export type ResolvedGitlabAuth =
  | { kind: "pat"; token: string; username: string }
  | { kind: "glab"; username: string };

const fail = (code: string, message: string): never => {
  throw Object.assign(new Error(message), { code });
};

const required = (value: unknown, field: string, max = 160): string => {
  if (typeof value !== "string") return fail("invalid-input", `${field} must be a string`);
  const clean = value.trim();
  if (!clean || clean.length > max) return fail("invalid-input", `${field} is invalid`);
  return clean;
};

const accountFile = (storage: SpaceStorage): string =>
  join(storage.packageDir("gitlab"), "accounts.json");

const vaultKey = (spaceId: string, accountId: string): string =>
  `gitlab:${spaceId}:account:${accountId}`;

function load(storage: SpaceStorage): GitlabAccount[] {
  try {
    const value = JSON.parse(readFileSync(accountFile(storage), "utf8")) as unknown;
    if (!Array.isArray(value)) return fail("invalid-state", "GitLab account state is malformed");
    const rows = value.map((row): GitlabAccount => {
      if (!row || typeof row !== "object") return fail("invalid-state", "GitLab account state is malformed");
      const item = row as Partial<GitlabAccount>;
      const keys = Object.keys(item).sort();
      const expectedKeys = [
        "authKind", "createdAt", "id", "instanceId", "label", "revision", "updatedAt", "username",
      ];
      const valid = typeof item.id === "string"
        && typeof item.instanceId === "string"
        && typeof item.label === "string"
        && (item.authKind === "pat" || item.authKind === "glab")
        && typeof item.username === "string"
        && Number.isSafeInteger(item.revision) && item.revision! > 0
        && typeof item.createdAt === "number" && Number.isFinite(item.createdAt)
        && typeof item.updatedAt === "number" && Number.isFinite(item.updatedAt)
        && keys.length === expectedKeys.length
        && keys.every((key, index) => key === expectedKeys[index]);
      if (!valid) return fail("invalid-state", "GitLab account state is malformed");
      return item as GitlabAccount;
    });
    const ids = new Set<string>();
    const identities = new Set<string>();
    for (const row of rows) {
      const identity = `${row.instanceId}\0${row.authKind}\0${row.username.toLocaleLowerCase()}`;
      if (ids.has(row.id) || identities.has(identity)) {
        return fail("invalid-state", "GitLab account state contains duplicate accounts");
      }
      ids.add(row.id);
      identities.add(identity);
    }
    return rows;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    if ((error as { code?: string }).code === "invalid-state") throw error;
    return fail("invalid-state", "GitLab account state could not be read");
  }
}

function save(storage: SpaceStorage, accounts: GitlabAccount[]): void {
  try {
    mkdirSync(storage.packageDir("gitlab"), { recursive: true });
    atomicWriteSync(accountFile(storage), JSON.stringify(accounts, null, 2), 0o600);
  } catch {
    return fail("account-state-write-failed", "GitLab account state could not be saved");
  }
}

export interface GitlabAccountStore {
  list(storage: SpaceStorage): GitlabAccount[];
  get(storage: SpaceStorage, accountId: string): GitlabAccount | undefined;
  connectPat(
    space: SpaceContext,
    storage: SpaceStorage,
    input: GitlabAccountInput,
    token: string,
    verify: (token: string) => Promise<{ username: string }>,
  ): Promise<GitlabAccount>;
  connectGlab(
    space: SpaceContext,
    storage: SpaceStorage,
    input: GitlabAccountInput,
    verify: () => Promise<{ username: string }>,
  ): Promise<GitlabAccount>;
  resolve(space: SpaceContext, storage: SpaceStorage, accountId: string): ResolvedGitlabAuth;
  remove(space: SpaceContext, storage: SpaceStorage, accountId: string): boolean;
}

/**
 * GitLab credentials follow the package-connection convention: public metadata
 * is stored inside one Space, while PATs are opaque values keyed by Space and
 * account. A glab account is only a reference to that host's active CLI login.
 */
export function createGitlabAccountStore(vault: GitlabOpaqueVault): GitlabAccountStore {
  const connect = (
    storage: SpaceStorage,
    input: GitlabAccountInput,
    authKind: GitlabAuthKind,
    verifiedUsername: string,
    beforeSave?: (account: GitlabAccount) => (() => void),
  ): GitlabAccount => {
    const instanceId = required(input.instanceId, "instanceId", 200);
    const label = required(input.label, "label", 128);
    const expected = required(input.username, "username", 200);
    const actual = required(verifiedUsername, "verified username", 200);
    if (expected.toLocaleLowerCase() !== actual.toLocaleLowerCase()) {
      return fail("auth-account-mismatch", "GitLab authenticated as a different account");
    }
    const rows = load(storage);
    const duplicate = rows.find((row) =>
      row.instanceId === instanceId
      && row.username.toLocaleLowerCase() === actual.toLocaleLowerCase()
      && row.authKind === authKind
    );
    const now = Date.now();
    if (duplicate) {
      duplicate.label = label;
      duplicate.username = actual;
      duplicate.revision += 1;
      duplicate.updatedAt = now;
      const rollback = beforeSave?.(duplicate);
      try { save(storage, rows); } catch (error) { try { rollback?.(); } catch { /* original error wins */ } throw error; }
      return { ...duplicate };
    }
    const account: GitlabAccount = {
      id: randomUUID(), instanceId, label, authKind, username: actual,
      revision: 1, createdAt: now, updatedAt: now,
    };
    rows.push(account);
    const rollback = beforeSave?.(account);
    try { save(storage, rows); } catch (error) { try { rollback?.(); } catch { /* original error wins */ } throw error; }
    return { ...account };
  };

  return {
    list: (storage) => load(storage).map((row) => ({ ...row })),
    get: (storage, accountId) => {
      const row = load(storage).find((item) => item.id === accountId);
      return row ? { ...row } : undefined;
    },
    async connectPat(space, storage, input, token, verify) {
      const secret = required(token, "token", 4096);
      const identity = await verify(secret);
      return connect(storage, input, "pat", identity.username, (account) => {
        const key = vaultKey(space.spaceId, account.id);
        const prior = vault.getOpaque(key);
        try {
          vault.putOpaque(key, secret);
        } catch {
          try { prior === null ? vault.deleteOpaque(key) : vault.putOpaque(key, prior); } catch { /* original error wins */ }
          return fail("credential-store-failed", "GitLab credential could not be saved");
        }
        return () => prior === null ? vault.deleteOpaque(key) : vault.putOpaque(key, prior);
      });
    },
    async connectGlab(space, storage, input, verify) {
      if (space.deployment !== "local-trusted") {
        return fail("forbidden", "existing glab login is available only in local-trusted deployments");
      }
      const identity = await verify();
      return connect(storage, input, "glab", identity.username);
    },
    resolve(space, storage, accountId) {
      const row = load(storage).find((item) => item.id === accountId);
      if (!row) return fail("not-found", "GitLab account not found");
      if (row.authKind === "glab") return { kind: "glab", username: row.username };
      const token = vault.getOpaque(vaultKey(space.spaceId, row.id));
      if (!token) return fail("auth-required", "GitLab account credential is unavailable");
      return { kind: "pat", token, username: row.username };
    },
    remove(space, storage, accountId) {
      const rows = load(storage);
      const index = rows.findIndex((row) => row.id === accountId);
      if (index < 0) return false;
      const [removed] = rows.splice(index, 1);
      const key = vaultKey(space.spaceId, accountId);
      const prior = removed?.authKind === "pat" ? vault.getOpaque(key) : null;
      if (removed?.authKind === "pat") try {
        vault.deleteOpaque(key);
      } catch {
        try { if (prior !== null) vault.putOpaque(key, prior); } catch { /* preserve the sanitized failure */ }
        return fail("credential-store-failed", "GitLab credential could not be removed");
      }
      try {
        save(storage, rows);
      } catch (error) {
        try { if (prior !== null) vault.putOpaque(key, prior); } catch { /* account state remains authoritative */ }
        throw error;
      }
      return true;
    },
  };
}
