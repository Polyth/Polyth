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

export async function loginAccounts(): Promise<AccountChoice[]> {
  const response = await fetch("/api/auth/status");
  if (!response.ok) return [];
  const body = await response.json().catch(() => ({})) as { accounts?: unknown };
  if (!Array.isArray(body.accounts)) return [];
  return body.accounts.flatMap((account) => {
    if (!account || typeof account !== "object") return [];
    const row = account as { id?: unknown; name?: unknown };
    return typeof row.id === "string" && typeof row.name === "string"
      ? [{ id: row.id, name: row.name }]
      : [];
  });
}

export async function loginAccount(accountId: string, password: string): Promise<AccountLoginResult> {
  const response = await fetch("/api/auth/login", json("POST", { accountId, password }));
  if (response.ok) return { ok: true };
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
