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
    const error = Object.assign(
      new Error(typeof body.message === "string" ? body.message : `HTTP ${response.status}`),
      {
        status: response.status,
        code: typeof body.error === "string" ? body.error : undefined,
      },
    );
    throw error;
  }
  return body as T;
};

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
  const retryHeader = Number(response.headers.get("retry-after"));
  return {
    ok: false,
    ...(body.error ? { error: body.error } : {}),
    ...(body.message ? { message: body.message } : {}),
    ...(typeof body.retryAfterSec === "number"
      ? { retryAfterSec: body.retryAfterSec }
      : Number.isFinite(retryHeader) && retryHeader > 0 ? { retryAfterSec: retryHeader } : {}),
  };
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

export async function createAccount(name: string, password: string): Promise<AccountChoice> {
  // Legacy compatibility surface. Canonical account creation requires an
  // explicit login and is exposed by the redesigned access page separately.
  const result = await request<AccountChoice>("/api/auth/accounts", legacyJson("POST", { name, password }));
  return result;
}

export async function changeAccountPassword(accountId: string, password: string): Promise<void> {
  const canonical = await authJson("/api/auth/password", { password });
  if (canonical.response.ok) return;
  if (canonical.response.status !== 404) {
    throw Object.assign(new Error(typeof canonical.body.message === "string" ? canonical.body.message : `HTTP ${canonical.response.status}`), {
      status: canonical.response.status,
      code: typeof canonical.body.error === "string" ? canonical.body.error : undefined,
    });
  }
  await request(`/api/auth/accounts/${encodeURIComponent(accountId)}/password`, legacyJson("PUT", { password }));
}

export const removeAccount = (accountId: string): Promise<void> =>
  request(`/api/auth/accounts/${encodeURIComponent(accountId)}`, { method: "DELETE" });

export async function switchAccount(login: string, password: string): Promise<AccountLoginResult> {
  const result = await loginAccount(login, password);
  if (result.ok && typeof window !== "undefined") window.location.assign("/");
  return result;
}
