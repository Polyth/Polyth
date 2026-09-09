import {
  activeBrowserAccountId,
  normalizeAccountId,
  setActiveBrowserAccount,
} from "./accountStorage.ts";

export interface AccountChoice {
  id: string;
  name: string;
  current?: boolean;
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

const json = (method: string, body?: Record<string, unknown>): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

export const currentBrowserAccountId = (): string => activeBrowserAccountId();

export async function loginAccount(account: string, password: string): Promise<AccountLoginResult> {
  const accountId = normalizeAccountId(account);
  const response = await fetch("/api/auth/login", json("POST", { accountId, password }));
  if (response.ok) {
    setActiveBrowserAccount(accountId);
    return { ok: true };
  }
  const body = await response.json().catch(() => ({})) as {
    error?: string;
    message?: string;
    retryAfterSec?: number;
  };
  return {
    ok: false,
    ...(body.error ? { error: body.error } : {}),
    ...(body.message ? { message: body.message } : {}),
    ...(typeof body.retryAfterSec === "number" ? { retryAfterSec: body.retryAfterSec } : {}),
  };
}

export const accountState = (): Promise<AccountState> =>
  request<AccountState>("/api/auth/accounts");

export const createAccount = (name: string, password: string): Promise<AccountChoice> =>
  request<AccountChoice>("/api/auth/accounts", json("POST", { name, password }));

export const changeAccountPassword = (accountId: string, password: string): Promise<void> =>
  request(`/api/auth/accounts/${encodeURIComponent(accountId)}/password`, json("PUT", { password }));

export const removeAccount = (accountId: string): Promise<void> =>
  request(`/api/auth/accounts/${encodeURIComponent(accountId)}`, { method: "DELETE" });

export async function switchAccount(accountId: string, password: string): Promise<AccountLoginResult> {
  const result = await loginAccount(accountId, password);
  if (result.ok && typeof window !== "undefined") window.location.assign("/");
  return result;
}
