import { join } from "node:path";
import type { QuotaSnapshot } from "@polyth/contracts";
import {
  getAuthEntry,
  numberValue,
  objectValue,
  readJson,
  stringValue,
  timestampValue,
  type QuotaRuntime,
} from "../opencodeAuth.ts";
import { mapProviderUsage, usageWindow, type ProviderUsageWindow } from "../ocWindows.ts";
import type { UsageLimitAccount } from "../limits.ts";
import type { DiscoverableProvider } from "./adapters.ts";

export const CODEX_PROVIDER_ID = "codex";
export const CODEX_PROVIDER_NAME = "Codex";
export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
export const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

export interface CodexCredential {
  source: "native" | "opencode" | "env";
  accessToken: string | null;
  refreshToken: string | null;
  accountId: string | null;
  expires: number | null;
  apiKey?: string | null;
}

export const jwtAccountId = (token: string): string | null => {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const json = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
    const custom = objectValue(json["https://api.openai.com/auth"]);
    const accountId = stringValue(custom?.chatgpt_account_id) ?? stringValue(json.chatgpt_account_id);
    return accountId;
  } catch {
    return null;
  }
};

export const jwtExpiresAt = (token: string): number | null => {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const json = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
    const exp = numberValue(json.exp);
    return exp !== null ? exp * 1000 : null;
  } catch {
    return null;
  }
};

const bearer = (secret: string): Record<string, string> => ({
  Authorization: `Bearer ${secret}`,
  "Content-Type": "application/json",
});

const windowLabel = (seconds: number | null): string => {
  if (!seconds) return "limit";
  if (seconds % 86400 === 0) {
    const days = seconds / 86400;
    return `${days}d`;
  }
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
};

const authErrorMessage = (status: number): string =>
  status === 401
    ? "Codex quota feed authentication failed (HTTP 401); this does not indicate that the active Codex session expired. Check the Usage credential."
    : "Codex quota feed access was denied (HTTP 403); this does not indicate that the active Codex session expired. Check the Usage account scope.";

export function loadNativeCodexCredential(runtime: QuotaRuntime): CodexCredential | null {
  const paths = runtime.paths?.codexAuthFiles
    ?? [join(runtime.home ?? "", ".codex", "auth.json")];
  for (const path of paths) {
    const file = readJson(runtime, path);
    if (!file) continue;
    const tokens = objectValue(file.tokens);
    const accessToken = stringValue(tokens?.access_token)
      ?? stringValue(tokens?.accessToken)
      ?? stringValue(file.access_token)
      ?? stringValue(file.accessToken)
      ?? stringValue(tokens?.access)
      ?? stringValue(file.access)
      ?? stringValue(file.token);

    const refreshToken = stringValue(tokens?.refresh_token)
      ?? stringValue(tokens?.refreshToken)
      ?? stringValue(file.refresh_token)
      ?? stringValue(file.refreshToken)
      ?? stringValue(tokens?.refresh)
      ?? stringValue(file.refresh);

    let accountId = stringValue(tokens?.account_id)
      ?? stringValue(tokens?.accountId)
      ?? stringValue(file.account_id)
      ?? stringValue(file.accountId);

    if (accessToken && !accountId) {
      accountId = jwtAccountId(accessToken);
    }

    const expires = (accessToken ? jwtExpiresAt(accessToken) : null)
      ?? timestampValue(tokens?.expires ?? tokens?.expiry ?? file.expires ?? file.expiry);

    const apiKey = stringValue(file.OPENAI_API_KEY)
      ?? stringValue(file.openaiApiKey)
      ?? stringValue(file.apiKey);

    if (accessToken || refreshToken || apiKey) {
      return {
        source: "native",
        accessToken: accessToken ?? apiKey ?? null,
        refreshToken,
        accountId,
        expires,
        apiKey,
      };
    }
  }
  return null;
}

export function loadOpenCodeCodexCredential(runtime: QuotaRuntime): CodexCredential | null {
  const aliases = ["openai", "codex", "chatgpt"] as const;
  const auth = runtime.readAuth ? runtime.readAuth() : {};
  const entry = getAuthEntry(auth, aliases);
  if (!entry) return null;

  const accessToken = stringValue(entry.access)
    ?? stringValue(entry.accessToken)
    ?? stringValue(entry.token)
    ?? stringValue(entry.key);

  const refreshToken = stringValue(entry.refresh)
    ?? stringValue(entry.refreshToken);

  let accountId = stringValue(entry.accountId)
    ?? stringValue(entry.account_id);

  if (accessToken && !accountId) {
    accountId = jwtAccountId(accessToken);
  }

  const expires = timestampValue(entry.expires)
    ?? (accessToken ? jwtExpiresAt(accessToken) : null);

  const apiKey = stringValue(entry.key);

  if (accessToken || refreshToken || apiKey) {
    return {
      source: "opencode",
      accessToken: accessToken ?? apiKey ?? null,
      refreshToken,
      accountId,
      expires,
      apiKey,
    };
  }
  return null;
}

export function loadEnvCodexCredential(runtime: QuotaRuntime): CodexCredential | null {
  const env = runtime.env ?? {};
  const envAccess = stringValue(env.CODEX_ACCESS_TOKEN)
    ?? stringValue(env.CHATGPT_ACCESS_TOKEN)
    ?? stringValue(env.OPENAI_ACCESS_TOKEN);
  const envApiKey = stringValue(env.OPENAI_API_KEY);
  const accessToken = envAccess ?? envApiKey ?? null;
  if (!accessToken) return null;

  let accountId = stringValue(env.CHATGPT_ACCOUNT_ID)
    ?? stringValue(env.OPENAI_ACCOUNT_ID);
  if (!accountId && accessToken) {
    accountId = jwtAccountId(accessToken);
  }
  const expires = accessToken ? jwtExpiresAt(accessToken) : null;
  return {
    source: "env",
    accessToken,
    refreshToken: null,
    accountId,
    expires,
    apiKey: envApiKey,
  };
}

export function loadCodexCredential(runtime: QuotaRuntime): CodexCredential | null {
  const candidates: CodexCredential[] = [];

  const native = loadNativeCodexCredential(runtime);
  if (native) candidates.push(native);

  const env = loadEnvCodexCredential(runtime);
  if (env) candidates.push(env);

  const opencode = loadOpenCodeCodexCredential(runtime);
  if (opencode) candidates.push(opencode);

  if (candidates.length === 0) return null;

  const now = runtime.now ? runtime.now() : Date.now();
  // Fresh if has accessToken and expires is null or in the future (+ 30s buffer)
  const isFresh = (c: CodexCredential) =>
    Boolean(c.accessToken) && (c.expires === null || c.expires > now + 30_000);

  // 1. Prefer first fresh candidate (native -> env -> opencode)
  for (const c of candidates) {
    if (isFresh(c)) return c;
  }

  // 2. Prefer first candidate that can be refreshed
  for (const c of candidates) {
    if (c.refreshToken) return c;
  }

  // 3. Fall back to first candidate
  return candidates[0]!;
}

export async function refreshCodexToken(
  runtime: QuotaRuntime,
  refreshToken: string,
  signal?: AbortSignal,
): Promise<{ accessToken: string; refreshToken?: string; accountId?: string; expires?: number }> {
  let response: Response;
  try {
    response = await runtime.fetchImpl(CODEX_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CODEX_CLIENT_ID,
      }),
      signal,
    });
  } catch {
    throw new Error("Codex token refresh request failed");
  }

  if (!response.ok) {
    throw new Error(`Codex token refresh failed (HTTP ${response.status})`);
  }

  let body: Record<string, unknown>;
  try {
    body = objectValue(await response.json()) ?? {};
  } catch {
    throw new Error("Codex token refresh returned invalid JSON");
  }

  const accessToken = stringValue(body.access_token);
  if (!accessToken) {
    throw new Error("Codex token refresh did not return an access token");
  }

  const newRefreshToken = stringValue(body.refresh_token) ?? refreshToken;
  const expiresIn = numberValue(body.expires_in);
  const now = runtime.now ? runtime.now() : Date.now();
  const expires = expiresIn !== null ? now + expiresIn * 1000 : (jwtExpiresAt(accessToken) ?? undefined);
  const accountId = jwtAccountId(accessToken);

  return {
    accessToken,
    refreshToken: newRefreshToken,
    accountId: accountId ?? undefined,
    expires,
  };
}

function persistOpenCodeToken(
  runtime: QuotaRuntime,
  refreshed: { accessToken: string; refreshToken?: string; expires?: number },
): void {
  if (typeof runtime.writeAuth !== "function" || typeof runtime.readAuth !== "function") return;
  try {
    const auth = runtime.readAuth();
    const existing = objectValue(auth.openai) ?? objectValue(auth.codex) ?? {};
    const key = auth.codex && !auth.openai ? "codex" : "openai";
    runtime.writeAuth({
      ...auth,
      [key]: {
        ...existing,
        type: "oauth",
        access: refreshed.accessToken,
        ...(refreshed.refreshToken ? { refresh: refreshed.refreshToken } : {}),
        ...(refreshed.expires ? { expires: refreshed.expires } : {}),
      },
    });
  } catch {
    // Best-effort write
  }
}

export interface CodexAccountSource {
  /** The account's private `CODEX_HOME`. */
  configDir: string;
  account(): UsageLimitAccount;
}

/** The default source reads the user's own login (native, env, OpenCode);
 *  with `source`, only that account's `CODEX_HOME/auth.json`, never another. */
export const createCodexProvider = (runtime: QuotaRuntime, source?: CodexAccountSource): DiscoverableProvider => {
  const providerId = source ? source.account().harnessId : CODEX_PROVIDER_ID;
  const load = source
    ? () => loadNativeCodexCredential({ ...runtime, paths: { ...runtime.paths, codexAuthFiles: [join(source.configDir, "auth.json")] } })
    : () => loadCodexCredential(runtime);
  return {
    id: providerId,
    ...(source ? { account: source.account } : {}),
    isConfigured: () => Boolean(load()),
    async fetch(signal: AbortSignal): Promise<QuotaSnapshot> {
      const cred = load();
      if (!cred) throw new Error(source ? "This Codex account is not signed in." : "Codex is not configured");

      let accessToken = cred.accessToken;
      let accountId = cred.accountId;

      const now = runtime.now ? runtime.now() : Date.now();
      const isExpired = !accessToken || (cred.expires !== null && cred.expires <= now);
      let didRefresh = false;

      if (isExpired && cred.refreshToken) {
        try {
          const refreshed = await refreshCodexToken(runtime, cred.refreshToken, signal);
          accessToken = refreshed.accessToken;
          if (refreshed.accountId) accountId = refreshed.accountId;
          didRefresh = true;
          if (cred.source === "opencode") {
            persistOpenCodeToken(runtime, refreshed);
          }
        } catch {
          // If refresh fails before request, fall through and let request/error path handle it
        }
      }

      if (!accessToken) {
        throw new Error(authErrorMessage(401));
      }

      const requestUsage = async (token: string, acctId: string | null | undefined) => {
        let response: Response;
        try {
          response = await runtime.fetchImpl(CODEX_USAGE_URL, {
            method: "GET",
            headers: {
              ...bearer(token),
              ...(acctId ? { "ChatGPT-Account-Id": acctId } : {}),
            },
            signal,
          });
        } catch {
          throw new Error("Codex usage request failed");
        }

        if (response.status === 401 || response.status === 403) {
          throw Object.assign(new Error(authErrorMessage(response.status)), { status: response.status });
        }
        if (!response.ok) {
          throw new Error(`Codex usage API returned HTTP ${response.status}`);
        }
        try {
          return objectValue(await response.json()) ?? {};
        } catch {
          throw new Error("Codex usage API returned invalid JSON");
        }
      };

      let payload: Record<string, unknown>;
      try {
        payload = await requestUsage(accessToken, accountId);
      } catch (err: unknown) {
        const status = (err as { status?: number })?.status;
        if (status === 401 && cred.refreshToken && !didRefresh) {
          try {
            const refreshed = await refreshCodexToken(runtime, cred.refreshToken, signal);
            accessToken = refreshed.accessToken;
            if (refreshed.accountId) accountId = refreshed.accountId;
            if (cred.source === "opencode") {
              persistOpenCodeToken(runtime, refreshed);
            }
            payload = await requestUsage(accessToken, accountId);
          } catch {
            throw err;
          }
        } else {
          throw err;
        }
      }

      const windows: Record<string, ProviderUsageWindow> = {};
      const rateLimit = objectValue(payload.rate_limit);
      for (const raw of [rateLimit?.primary_window, rateLimit?.secondary_window]) {
        const window = objectValue(raw);
        if (!window) continue;
        const seconds = numberValue(window.limit_window_seconds);
        const usedPercent = numberValue(window.used_percent);
        if (usedPercent === null && seconds === null) continue;
        const key = windowLabel(seconds);
        const is5h = seconds === 5 * 3600;
        const isWeekly = seconds === 7 * 86400;
        const label = is5h ? "5h limit" : isWeekly ? "Weekly limit" : undefined;
        windows[key] = usageWindow({
          ...(label ? { label } : {}),
          usedPercent,
          windowSeconds: seconds,
          resetAt: timestampValue(window.reset_at),
        });
      }
      const credits = objectValue(payload.credits);
      const balance = numberValue(credits?.balance);
      if (credits?.unlimited === true) {
        windows.credits_balance = usageWindow({ valueLabel: "Unlimited" });
      } else if (balance !== null) {
        windows.credits_balance = usageWindow({
          used: 0,
          limit: balance,
          unit: "currency",
          valueLabel: `$${balance.toFixed(2)} available`,
        });
      }
      const spendLimit = objectValue(objectValue(payload.spend_control)?.individual_limit);
      const spent = numberValue(spendLimit?.used);
      const limit = numberValue(spendLimit?.limit);
      if (spent !== null && limit !== null) {
        windows.credits = usageWindow({ used: spent, limit, unit: "currency" });
      }
      const plan = stringValue(payload.plan_type) ?? stringValue(payload.account_plan);
      const parsedWindows = mapProviderUsage({ windows });
      if (parsedWindows.length === 0) throw new Error("Codex usage data could not be parsed");
      return {
        providerId,
        accountLabel: plan ? `Codex (${plan})` : "Codex",
        windows: parsedWindows,
        fetchedAt: runtime.now ? runtime.now() : Date.now(),
        stale: false,
      };
    },
  };
};

export { createCodexProvider as createCodex };
