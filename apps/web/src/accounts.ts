import {
  activeBrowserAccountId,
  normalizeAccountId,
} from "./accountStorage.ts";
import { acceptAuthenticatedBrowserAccount } from "./authPrefetch.ts";
import { authJson } from "./authClient.ts";

export interface AccountChoice {
  id: string;
  name: string;
  current?: boolean;
  status?: string;
  revision?: number;
  managed?: boolean;
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
      id: string; name?: string; displayName?: string; current?: boolean;
      status?: string; revision?: number; managed?: boolean;
    }>;
  }>("/api/auth/accounts");
  return {
    currentAccountId: raw.currentAccountId,
    canManage: raw.canManage === true,
    accounts: raw.accounts.map((account) => ({
      id: account.id,
      name: account.name ?? account.displayName ?? account.id,
      current: account.current ?? account.id === raw.currentAccountId,
      ...(account.status ? { status: account.status } : {}),
      ...(typeof account.revision === "number" ? { revision: account.revision } : {}),
      ...(typeof account.managed === "boolean" ? { managed: account.managed } : {}),
    })),
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
