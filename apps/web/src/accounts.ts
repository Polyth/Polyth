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
  /** A full-access paired device's own account (name, password, passkeys,
   *  command-line tokens) still changes only in a browser signed in here. */
  readOnly: boolean;
  /** With `readOnly`: this account is an owner who administers this instance. */
  canManageInBrowser: boolean;
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
/** An account this browser signed in to before. Only this device knows the
 *  list: the server never tells an anonymous caller which logins exist. */
export interface KnownBrowserLogin {
  login: string;
  name?: string;
}
const KNOWN_LOGINS_KEY = "polyth.knownLogins";
const MAX_KNOWN_LOGINS = 5;
const knownLoginName = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** Most recent first. Falls back to the single last login older shells kept. */
export const knownBrowserLogins = (): KnownBrowserLogin[] => {
  const known: KnownBrowserLogin[] = [];
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KNOWN_LOGINS_KEY) ?? "[]");
    if (Array.isArray(raw)) {
      for (const entry of raw) {
        const login = typeof entry?.login === "string" ? entry.login.trim().toLowerCase() : "";
        if (!knownLoginName.test(login) || known.some((item) => item.login === login)) continue;
        const name = typeof entry.name === "string" ? entry.name.trim().slice(0, 120) : "";
        known.push(name ? { login, name } : { login });
        if (known.length >= MAX_KNOWN_LOGINS) break;
      }
    }
  } catch { /* private mode or a damaged entry */ }
  if (known.length === 0) {
    let last = "";
    try { last = localStorage.getItem(LAST_LOGIN_KEY)?.trim().toLowerCase() ?? ""; } catch { /* private mode */ }
    if (knownLoginName.test(last)) known.push({ login: last });
  }
  return known;
};
/** Put this login first among the accounts this device knows. */
export const rememberBrowserLogin = (login: string, name?: string): void => rememberLogin(login, name);
function rememberLogin(login: string, name?: string): void {
  const canonical = login.trim().toLowerCase();
  try {
    localStorage.setItem(LAST_LOGIN_KEY, canonical);
    const previous = knownBrowserLogins().find((item) => item.login === canonical);
    const label = name?.trim() || previous?.name;
    const next = [label ? { login: canonical, name: label } : { login: canonical },
      ...knownBrowserLogins().filter((item) => item.login !== canonical)].slice(0, MAX_KNOWN_LOGINS);
    localStorage.setItem(KNOWN_LOGINS_KEY, JSON.stringify(next));
  } catch { /* private mode */ }
}
/** "Remove from this device": the tile goes, the account itself is untouched. */
export const forgetBrowserLogin = (login: string): void => {
  const canonical = login.trim().toLowerCase();
  try {
    const next = knownBrowserLogins().filter((item) => item.login !== canonical);
    localStorage.setItem(KNOWN_LOGINS_KEY, JSON.stringify(next));
    if (localStorage.getItem(LAST_LOGIN_KEY)?.trim().toLowerCase() === canonical) {
      if (next[0]) localStorage.setItem(LAST_LOGIN_KEY, next[0].login);
      else localStorage.removeItem(LAST_LOGIN_KEY);
    }
  } catch { /* private mode */ }
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
    let displayName: string | undefined;
    try {
      const me = await request<{ id?: unknown; displayName?: unknown }>("/api/auth/me");
      if (typeof me.id === "string" && me.id.trim()) accountId = me.id;
      if (typeof me.displayName === "string") displayName = me.displayName;
    } catch { /* legacy server may not expose canonical /me */ }
    acceptAuthenticatedBrowserAccount(accountId);
    rememberLogin(canonicalLogin, displayName);
    return { ok: true };
  }
  return accountAuthResult(response, body);
}

/**
 * Consume one recovery code to replace the local password. Recovery deliberately
 * does not authenticate the browser: the caller must perform a fresh login so
 * the new session is minted after the old auth epoch and sessions were revoked.
 * The code alone identifies the account; the server answers with its login so
 * the person can sign in (and learns it). `login` is undefined only when an
 * older server answered without one. `loginHint` (the account picked on this
 * device) is sent only because a server older than code-only recovery still
 * requires the field; a current server ignores it.
 */
export async function recoverAccount(code: string, password: string, loginHint?: string): Promise<AccountLoginResult & { login?: string }> {
  const hint = loginHint?.trim().toLowerCase();
  const { response, body } = await authJson<{
    ok?: unknown; login?: unknown; error?: string; message?: string; retryAfterSec?: number;
  }>("/api/auth/recover", { ...(hint ? { login: hint } : {}), code: code.trim(), password });
  if (response.ok) {
    const login = typeof body.login === "string" && body.login.trim() ? body.login.trim().toLowerCase() : undefined;
    if (login) rememberLogin(login);
    return login ? { ok: true, login } : { ok: true };
  }
  return accountAuthResult(response, body);
}

export async function accountState(): Promise<AccountState> {
  const raw = await request<{
    currentAccountId: string;
    canManage?: boolean;
    readOnly?: boolean;
    canManageInBrowser?: boolean;
    accounts: Array<{
      id: string; name?: string; displayName?: string; login?: string; current?: boolean;
      status?: string; revision?: number; managed?: boolean; guarded?: boolean;
      limits?: AccountLimits | null; usage?: AccountUsageToday;
    }>;
  }>("/api/auth/accounts");
  return {
    currentAccountId: raw.currentAccountId,
    canManage: raw.canManage === true,
    readOnly: raw.readOnly === true,
    canManageInBrowser: raw.readOnly === true && raw.canManageInBrowser === true,
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

/** The longest account name the server accepts (identity `displayName`). The
 *  name is what agents and people call someone; Git commit names stay separate. */
export const ACCOUNT_NAME_MAX = 80;

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

/** Sign-in names the server accepts (identity `loginName`): stored lowercase. */
export const ACCOUNT_LOGIN_MAX = 64;
export const normalizeLogin = (value: string): string => value.trim().toLowerCase();
export const validLogin = (value: string): boolean => /^[a-z0-9][a-z0-9._-]{0,63}$/.test(normalizeLogin(value));

/** A person moves their own sign-in to a new login (needs a recent password
 *  confirmation; no session ends). This browser's lock screen follows it. */
export async function changeCurrentLogin(account: Pick<AccountChoice, "id" | "revision" | "login">, login: string): Promise<void> {
  const next = normalizeLogin(login);
  const result = await authJson("/api/auth/me/login", { login: next, expectedRevision: revisionOf(account, "changing the login") });
  if (!result.response.ok) throw authFailure(result.response, result.body);
  if (!account.login || currentBrowserLogin() === account.login) rememberLogin(next);
}

/** Instance owner moves another account to a new login; its password stays. */
export async function changeAccountLogin(account: Pick<AccountChoice, "id" | "revision">, login: string): Promise<void> {
  const result = await authJson(`/api/auth/accounts/${encodeURIComponent(account.id)}/login`, {
    login: normalizeLogin(login),
    expectedRevision: revisionOf(account, "changing the login"),
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

/** Erase what only this disabled account could open. Instance owner only; the
 *  owner never sees it first. */
export async function erasePrivateData(accountId: string): Promise<void> {
  const result = await authJson(`/api/accounts/${encodeURIComponent(accountId)}/erase-private-data`, {});
  if (!result.response.ok) throw authFailure(result.response, result.body);
}

/** How much only this account can open: one number, never what it is. Null for
 *  anyone but the instance owner. */
export async function privateDataBytes(accountId: string): Promise<number | null> {
  try {
    const { bytes } = await request<{ bytes?: unknown }>(`/api/accounts/${encodeURIComponent(accountId)}/private-data`);
    return typeof bytes === "number" ? bytes : null;
  } catch {
    return null;
  }
}

/** When an administrator last set this person's password, while they haven't
 *  set their own since. */
export async function adminPasswordResetAt(): Promise<number | null> {
  try {
    const me = await request<{ adminPasswordResetAt?: unknown }>("/api/auth/me");
    return typeof me.adminPasswordResetAt === "number" ? me.adminPasswordResetAt : null;
  } catch {
    return null;
  }
}

/** Guardrails and limits from one `/api/auth/me` answer (null = none): both
 *  ride on it, and boot needs both. Unreachable or older server → both null. */
export async function currentAccountRestrictions(): Promise<{ guardrails: AccountGuardrails | null; limits: AccountLimits | null }> {
  try {
    const me = await request<{ guardrails?: AccountGuardrails | null; limits?: AccountLimits | null }>("/api/auth/me");
    return { guardrails: me.guardrails ?? null, limits: me.limits ?? null };
  } catch {
    return { guardrails: null, limits: null };
  }
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
