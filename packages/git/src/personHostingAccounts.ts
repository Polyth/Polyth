// Person-owned code-hosting accounts (Spaces §14.4): a GitHub or GitLab token
// a person connected for themselves. Metadata lives in the person's package
// storage, the token in their own Credential Vault partition, and an account
// works in a Space only after its owner turned it on there. Nothing here is
// stored in a Space, and no call ever names another person's account.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { PeopleHost } from "@polyth/plugins/people";
import { atomicWriteSync } from "@polyth/plugins/atomic-write";
import { isPersonId } from "./actingPerson.ts";

/** Public metadata only; the token never leaves the vault through this type. */
export interface PersonHostingAccount {
  id: string;
  /** Web origin of the hosting instance, e.g. "https://github.com". */
  origin: string;
  login: string;
  label: string;
  createdAt: number;
  updatedAt: number;
}

/** One account as its owner sees it from one Space. */
export interface PersonHostingAccountView extends PersonHostingAccount {
  enabled: boolean;
}

export interface PersonHostingAccounts {
  /** The person's accounts, each with whether it is on in `spaceId`. */
  view(userId: string, spaceId: string): PersonHostingAccountView[];
  /** The person's accounts turned on in `spaceId`; empty unless they are a member. */
  enabledIn(userId: string | undefined, spaceId: string): PersonHostingAccount[];
  /** Store an already verified token (the caller checked it with the host). */
  connect(userId: string, input: { origin: string; login: string; label?: string }, token: string, enableIn?: string): PersonHostingAccount;
  remove(userId: string, accountId: string): boolean;
  setEnabled(userId: string, spaceId: string, accountId: string, on: boolean): void;
  /** The token of an account the person turned on in `spaceId`; refuses anything else. */
  token(userId: string | undefined, spaceId: string, accountId: string): string;
}

const fail = (code: string, message: string, status?: number): never => {
  throw Object.assign(new Error(message), { code, mutationOutcome: "not-started", ...(status ? { status } : {}) });
};
const ID = /^p-[0-9a-f-]{36}$/;
const vaultKey = (accountId: string): string => `account:${accountId}`;

const isAccount = (value: unknown): value is PersonHostingAccount => {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === "string" && ID.test(row.id)
    && ["origin", "login", "label"].every((key) => typeof row[key] === "string" && (row[key] as string).length > 0 && (row[key] as string).length <= 512)
    && typeof row.createdAt === "number" && typeof row.updatedAt === "number";
};

/** Normalized `https?://host[:port]` origin, or `invalid-input`. */
export function hostingOrigin(value: unknown): string {
  try {
    const url = new URL(String(value ?? "").trim());
    if ((url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password) return url.origin;
  } catch { /* fall through */ }
  return fail("invalid-input", "Enter the web address of the hosting instance, e.g. https://github.com.", 400);
}

export function createPersonHostingAccounts(people: PeopleHost | undefined, packageId: string): PersonHostingAccounts {
  const person = (userId: string | undefined): string => {
    if (!people) return fail("unavailable", "Personal accounts are unavailable on this server.", 503);
    if (!isPersonId(userId)) return fail("forbidden", "Personal accounts belong to a signed-in person.", 403);
    return userId;
  };
  const file = (userId: string) => people!.storage(person(userId), packageId).path("accounts.json");
  const load = (userId: string): PersonHostingAccount[] => {
    try {
      const value = JSON.parse(readFileSync(file(userId), "utf8")) as unknown;
      return Array.isArray(value) ? value.filter(isAccount) : [];
    } catch {
      return [];
    }
  };
  const save = (userId: string, rows: PersonHostingAccount[]): void =>
    atomicWriteSync(file(userId), JSON.stringify(rows, null, 2), 0o600);
  const enabledIds = (userId: string, spaceId: string): Set<string> => {
    try {
      if (!people!.isMember(userId, spaceId)) return new Set();
      return new Set(people!.enabled(userId, spaceId, packageId));
    } catch {
      return new Set();
    }
  };

  return {
    view(userId, spaceId) {
      const on = enabledIds(person(userId), spaceId);
      return load(userId).map((row) => ({ ...row, enabled: on.has(row.id) }));
    },
    enabledIn(userId, spaceId) {
      if (!people || !isPersonId(userId)) return [];
      const on = enabledIds(userId, spaceId);
      return on.size ? load(userId).filter((row) => on.has(row.id)) : [];
    },
    connect(userId, input, token, enableIn) {
      person(userId);
      const secret = typeof token === "string" ? token.trim() : "";
      if (!secret || secret.length > 4096 || /[\s\0]/.test(secret)) fail("invalid-input", "The token is invalid.", 400);
      const origin = hostingOrigin(input.origin);
      const login = String(input.login ?? "").trim();
      if (!login || login.length > 256 || /[\s\0]/.test(login)) fail("invalid-response", "The host returned an invalid account.", 502);
      const label = String(input.label ?? "").trim().slice(0, 128) || login;
      const rows = load(userId);
      const now = Date.now();
      const existing = rows.find((row) => row.origin === origin && row.login.toLowerCase() === login.toLowerCase());
      const account: PersonHostingAccount = existing
        ? { ...existing, login, label, updatedAt: now }
        : { id: `p-${randomUUID()}`, origin, login, label, createdAt: now, updatedAt: now };
      const vault = people!.vault(userId, packageId);
      const prior = vault.getOpaque(vaultKey(account.id));
      vault.putOpaque(vaultKey(account.id), secret);
      try {
        save(userId, [...rows.filter((row) => row.id !== account.id), account]);
      } catch (error) {
        try { prior === null ? vault.deleteOpaque(vaultKey(account.id)) : vault.putOpaque(vaultKey(account.id), prior); } catch { /* original error wins */ }
        throw error;
      }
      if (enableIn) people!.setEnabled(userId, enableIn, packageId, account.id, true);
      return { ...account };
    },
    remove(userId, accountId) {
      const rows = load(person(userId));
      if (!rows.some((row) => row.id === accountId)) return false;
      save(userId, rows.filter((row) => row.id !== accountId));
      people!.vault(userId, packageId).deleteOpaque(vaultKey(accountId));
      return true;
    },
    setEnabled(userId, spaceId, accountId, on) {
      if (!load(person(userId)).some((row) => row.id === accountId)) fail("not-found", "Account not found.", 404);
      people!.setEnabled(userId, spaceId, packageId, accountId, on);
    },
    token(userId, spaceId, accountId) {
      const owner = person(userId);
      if (!enabledIds(owner, spaceId).has(accountId) || !load(owner).some((row) => row.id === accountId)) {
        fail("not-found", "Account not found.", 404);
      }
      return people!.vault(owner, packageId).getOpaque(vaultKey(accountId))
        ?? fail("auth-required", "The account's token is unavailable; connect it again.", 409);
    },
  };
}
