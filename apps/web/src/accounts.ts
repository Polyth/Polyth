import {
  activeBrowserAccountId,
  normalizeAccountId,
} from "./accountStorage.ts";
import { acceptAuthenticatedBrowserAccount } from "./authPrefetch.ts";
import { authJson } from "./authClient.ts";
import type {
  AccountGuardrails,
  AccountGuardrailsDto,
  AccountLimits,
  AccountLimitsDto,
  AccountPermission,
  AccountPermissionsDto,
  AccountUsageToday,
} from "@polyth/contracts";

export interface AccountChoice {
  id: string;
  name: string;
  login?: string;
  current?: boolean;
  status?: string;
  revision?: number;
  managed?: boolean;
  /** Owner-set guardrails are active for this account. */
  guarded?: boolean;
  /** Owner-set limits (owner's list only); null = none. */
  limits?: AccountLimits | null;
  /** Today's counted use (owner's list only). */
  usage?: AccountUsageToday;
}

export interface AccountState {
  currentAccountId: string;
  canManage: boolean;
  accounts: AccountChoice[];
}

export interface AccountLoginResult {
  ok: boolean;
  error?: string;
  message?: string;
  retryAfterSec?: number;
}

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, init);
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw Object.assign(
      new Error(typeof body.message === "string" ? body.message : `HTTP ${response.status}`),
      { status: response.status, code: typeof body.error === "string" ? body.error : undefined },
    );
  }
  return body as T;
};
const authFailure = (response: Response, body: Record<string, unknown>): Error => Object.assign(
  new Error(typeof body.message === "string"
    ? body.message
    : typeof body.error === "string" ? body.error.replace(/-/g, " ") : `HTTP ${response.status}`),
  { status: response.status, code: typeof body.error === "string" ? body.error : undefined },
);
const legacyJson = (method: string, body?: Record<string, unknown>): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

const LAST_LOGIN_KEY = "polyth.lastLogin";
export const currentBrowserAccountId = (): string => activeBrowserAccountId();
export const currentBrowserLogin = (): string => {
  try {
    const stored = localStorage.getItem(LAST_LOGIN_KEY)?.trim();
    if (stored) return stored;
  } catch { /* private mode */ }
  return activeBrowserAccountId() === "usr_owner" ? "owner" : "";
};
const rememberLogin = (login: string): void => {
  try { localStorage.setItem(LAST_LOGIN_KEY, login.trim().toLowerCase()); } catch { /* private mode */ }
};
const accountAuthResult = (
  response: Response,
  body: { error?: string; message?: string; retryAfterSec?: number },
): AccountLoginResult => {
  const retryHeader = Number(response.headers.get("retry-after"));
  return {
    ok: false,
    ...(body.error ? { error: body.error } : {}),
    ...(body.message ? { message: body.message } : {}),
    ...(typeof body.retryAfterSec === "number"
      ? { retryAfterSec: body.retryAfterSec }
      : Number.isFinite(retryHeader) && retryHeader > 0 ? { retryAfterSec: retryHeader } : {}),
  };
};

export async function loginAccount(login: string, password: string): Promise<AccountLoginResult> {
  const canonicalLogin = login.trim().toLowerCase();
  const legacyAccountId = normalizeAccountId(login);
  const { response, body } = await authJson<{
    ok?: unknown; error?: string; message?: string; retryAfterSec?: number;
  }>("/api/auth/login", { login: canonicalLogin, accountId: legacyAccountId, password });
  if (response.ok) {
    let accountId = legacyAccountId;
    try {
      const me = await request<{ id?: unknown }>("/api/auth/me");
      if (typeof me.id === "string" && me.id.trim()) accountId = me.id;
    } catch { /* legacy server may not expose canonical /me */ }
    acceptAuthenticatedBrowserAccount(accountId);
    rememberLogin(canonicalLogin);
    return { ok: true };
  }
  return accountAuthResult(response, body);
}

/**
 * Consume one recovery code to replace the local password. Recovery deliberately
 * does not authenticate the browser: the caller must perform a fresh login so
 * the new session is minted after the old auth epoch and sessions were revoked.
 */
export async function recoverAccount(login: string, code: string, password: string): Promise<AccountLoginResult> {
  const canonicalLogin = login.trim().toLowerCase();
  const { response, body } = await authJson<{
    ok?: unknown; error?: string; message?: string; retryAfterSec?: number;
  }>("/api/auth/recover", { login: canonicalLogin, code: code.trim(), password });
  if (response.ok) {
    rememberLogin(canonicalLogin);
    return { ok: true };
  }
  return accountAuthResult(response, body);
}

export async function accountState(): Promise<AccountState> {
  const raw = await request<{
    currentAccountId: string;
    canManage?: boolean;
    accounts: Array<{
      id: string; name?: string; displayName?: string; login?: string; current?: boolean;
      status?: string; revision?: number; managed?: boolean; guarded?: boolean;
      limits?: AccountLimits | null; usage?: AccountUsageToday;
    }>;
  }>("/api/auth/accounts");
  return {
    currentAccountId: raw.currentAccountId,
    canManage: raw.canManage === true,
    accounts: raw.accounts.map((account) => ({
      id: account.id,
      name: account.name ?? account.displayName ?? account.id,
      ...(typeof account.login === "string" && account.login ? { login: account.login } : {}),
      current: account.current ?? account.id === raw.currentAccountId,
      ...(account.status ? { status: account.status } : {}),
      ...(typeof account.revision === "number" ? { revision: account.revision } : {}),
      ...(typeof account.managed === "boolean" ? { managed: account.managed } : {}),
      ...(account.guarded === true ? { guarded: true } : {}),
      ...(account.limits !== undefined ? { limits: account.limits } : {}),
      ...(account.usage ? { usage: account.usage } : {}),
    })),
  };
}

export async function renameCurrentAccount(
  account: Pick<AccountChoice, "id" | "revision">,
  name: string,
): Promise<AccountChoice> {
  if (!Number.isSafeInteger(account.revision) || account.revision! < 1) {
    throw Object.assign(new Error("Account revision is missing; refresh before renaming"), { code: "conflict" });
  }
  const result = await authJson<{
    id?: unknown; displayName?: unknown; status?: unknown; revision?: unknown; managed?: unknown;
  }>("/api/auth/me", { name: name.trim(), expectedRevision: account.revision });
  if (!result.response.ok) throw authFailure(result.response, result.body);
  if (typeof result.body.id !== "string" || typeof result.body.displayName !== "string"
    || typeof result.body.revision !== "number") {
    throw new Error("Invalid account profile response");
  }
  return {
    id: result.body.id,
    name: result.body.displayName,
    revision: result.body.revision,
    current: true,
    ...(typeof result.body.status === "string" ? { status: result.body.status } : {}),
    ...(typeof result.body.managed === "boolean" ? { managed: result.body.managed } : {}),
  };
}

export async function createAccount(login: string, name: string, password: string): Promise<AccountChoice> {
  const canonical = await authJson("/api/auth/accounts", { login, name, password });
  if (canonical.response.ok) return canonical.body as unknown as AccountChoice;
  if (canonical.response.status !== 404) throw authFailure(canonical.response, canonical.body);
  return request<AccountChoice>("/api/auth/accounts", legacyJson("POST", { name, password }));
}

export async function changeAccountPassword(
  accountId: string,
  currentPassword: string,
  password: string,
): Promise<void> {
  const reauth = await authJson("/api/auth/reauthenticate", { password: currentPassword });
  if (reauth.response.status === 404) {
    await request(`/api/auth/accounts/${encodeURIComponent(accountId)}/password`, legacyJson("PUT", { password }));
    return;
  }
  if (!reauth.response.ok) throw authFailure(reauth.response, reauth.body);
  const changed = await authJson("/api/auth/password", { password });
  if (!changed.response.ok) throw authFailure(changed.response, changed.body);
}

export async function disableAccount(account: Pick<AccountChoice, "id" | "revision">): Promise<void> {
  if (!Number.isSafeInteger(account.revision) || account.revision! < 1) {
    throw Object.assign(new Error("Account revision is missing; refresh before disabling"), { code: "conflict" });
  }
  const canonical = await authJson(`/api/auth/accounts/${encodeURIComponent(account.id)}/status`, {
    status: "disabled",
    expectedRevision: account.revision,
  });
  if (canonical.response.ok) return;
  if (canonical.response.status !== 404) throw authFailure(canonical.response, canonical.body);
  await request(`/api/auth/accounts/${encodeURIComponent(account.id)}`, { method: "DELETE" });
}

export async function switchAccount(login: string, password: string): Promise<AccountLoginResult> {
  const result = await loginAccount(login, password);
  if (result.ok && typeof window !== "undefined") window.location.assign("/");
  return result;
}

/** Instance owner (or the account itself) reads an account's guardrails. */
export async function accountGuardrails(accountId: string): Promise<AccountGuardrailsDto> {
  return request<AccountGuardrailsDto>(`/api/auth/accounts/${encodeURIComponent(accountId)}/guardrails`);
}

/** Instance owner only. `null` removes the guardrails. Server-enforced; the UI
 *  only mirrors it. Rejects a stale `expectedRevision` with `conflict`. */
export async function setAccountGuardrails(
  accountId: string,
  guardrails: AccountGuardrails | null,
  expectedRevision: number,
): Promise<AccountGuardrailsDto> {
  const result = await authJson(`/api/auth/accounts/${encodeURIComponent(accountId)}/guardrails`, {
    guardrails,
    expectedRevision,
  });
  if (!result.response.ok) throw authFailure(result.response, result.body);
  return result.body as unknown as AccountGuardrailsDto;
}

/** The signed-in account's own guardrails (null = unrestricted). A server
 *  without the feature answers without the field, which also means none. */
export async function currentAccountGuardrails(): Promise<AccountGuardrails | null> {
  try {
    const me = await request<{ guardrails?: AccountGuardrails | null }>("/api/auth/me");
    return me.guardrails ?? null;
  } catch {
    return null;
  }
}

/** True when the owner has no password yet (`local` access) and the action
 *  admits someone or something else; protect the account first. */
export const isOwnerCredentialRequired = (cause: unknown): boolean =>
  (cause as { code?: unknown } | null)?.code === "owner-credential-required";

/** Step one of protecting a password-less owner: recovery codes to save. */
export async function prepareOwnerRecovery(): Promise<{ setId: string; codes: string[] }> {
  const result = await authJson<{ setId?: unknown; codes?: unknown }>("/api/auth/owner-credential/recovery", {});
  if (!result.response.ok) throw authFailure(result.response, result.body);
  const { setId, codes } = result.body;
  if (typeof setId !== "string" || !Array.isArray(codes) || !codes.every((code) => typeof code === "string")) {
    throw Object.assign(new Error("Invalid recovery codes response"), { code: "invalid-response" });
  }
  return { setId, codes: codes as string[] };
}

/** Step two: the password, once the owner saved the codes of `setId`. */
export async function protectOwnerAccount(password: string, recoverySetId: string): Promise<{ login: string }> {
  const result = await authJson<{ login?: unknown }>("/api/auth/owner-credential", {
    password,
    recoverySetId,
    recoveryAcknowledged: true,
  });
  if (!result.response.ok) throw authFailure(result.response, result.body);
  const login = typeof result.body.login === "string" ? result.body.login : "owner";
  rememberLogin(login);
  return { login };
}

/** True when the server wants a fresh password before an owner action. */
export const isReauthRequired = (cause: unknown): boolean =>
  (cause as { code?: unknown } | null)?.code === "reauth-required";

/** Confirm the signed-in owner's password; elevation lasts a few minutes. */
export async function reauthenticate(password: string): Promise<void> {
  const result = await authJson("/api/auth/reauthenticate", { password });
  if (!result.response.ok) throw authFailure(result.response, result.body);
}

const revisionOf = (account: Pick<AccountChoice, "revision">, action: string): number => {
  if (!Number.isSafeInteger(account.revision) || account.revision! < 1) {
    throw Object.assign(new Error(`Account revision is missing; refresh before ${action}`), { code: "conflict" });
  }
  return account.revision!;
};

/** Instance owner: suspend (reversible) or reactivate an account. */
export async function setAccountStatus(
  account: Pick<AccountChoice, "id" | "revision">,
  status: "active" | "suspended",
): Promise<void> {
  const result = await authJson(`/api/auth/accounts/${encodeURIComponent(account.id)}/status`, {
    status,
    expectedRevision: revisionOf(account, "changing sign-in"),
  });
  if (!result.response.ok) throw authFailure(result.response, result.body);
}

/** Instance owner renames another account. */
export async function renameAccount(account: Pick<AccountChoice, "id" | "revision">, name: string): Promise<void> {
  const result = await authJson(`/api/auth/accounts/${encodeURIComponent(account.id)}/profile`, {
    name: name.trim(),
    expectedRevision: revisionOf(account, "renaming"),
  });
  if (!result.response.ok) throw authFailure(result.response, result.body);
}

/** Instance owner sets a new password for another account; it is signed out everywhere. */
export async function resetAccountPassword(accountId: string, password: string): Promise<void> {
  const result = await authJson(`/api/auth/accounts/${encodeURIComponent(accountId)}/password`, { password });
  if (!result.response.ok) throw authFailure(result.response, result.body);
}

/** Instance owner (or the account itself) reads an account's limits and today's use. */
export async function accountLimits(accountId: string): Promise<AccountLimitsDto> {
  return request<AccountLimitsDto>(`/api/auth/accounts/${encodeURIComponent(accountId)}/limits`);
}

/** Instance owner only. `null` removes the limits. Server-enforced; rejects a
 *  stale `expectedRevision` with `conflict`. */
export async function setAccountLimits(
  accountId: string,
  limits: AccountLimits | null,
  expectedRevision: number,
): Promise<AccountLimitsDto> {
  const result = await authJson(`/api/auth/accounts/${encodeURIComponent(accountId)}/limits`, {
    limits,
    expectedRevision,
  });
  if (!result.response.ok) throw authFailure(result.response, result.body);
  return result.body as unknown as AccountLimitsDto;
}

/** Instance owner (or the account itself) reads an account's permissions. */
export async function accountPermissions(accountId: string): Promise<AccountPermissionsDto> {
  return request<AccountPermissionsDto>(`/api/auth/accounts/${encodeURIComponent(accountId)}/permissions`);
}

/** Instance owner only. Replaces the account's permissions. Server-enforced;
 *  rejects a stale `expectedRevision` with `conflict`. */
export async function setAccountPermissions(
  accountId: string,
  permissions: AccountPermission[],
  expectedRevision: number,
): Promise<AccountPermissionsDto> {
  const result = await authJson(`/api/auth/accounts/${encodeURIComponent(accountId)}/permissions`, {
    permissions,
    expectedRevision,
  });
  if (!result.response.ok) throw authFailure(result.response, result.body);
  return result.body as unknown as AccountPermissionsDto;
}

/** The signed-in account's own limits (null = none). */
export async function currentAccountLimits(): Promise<AccountLimits | null> {
  try {
    const me = await request<{ limits?: AccountLimits | null }>("/api/auth/me");
    return me.limits ?? null;
  } catch {
    return null;
  }
}
