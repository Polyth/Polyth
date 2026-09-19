import { createHash } from "node:crypto";
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
import { mapProviderUsage, usageWindow, type ProviderUsage } from "../ocWindows.ts";
import type { DiscoverableProvider } from "./adapters.ts";

export const ANTIGRAVITY_PROVIDER_ID = "antigravity";
export const ANTIGRAVITY_PROVIDER_NAME = "Antigravity";

export const ANTIGRAVITY_CLIENT = {
  id: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
  secret: "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",
} as const;

const GOOGLE_PRIMARY = "https://cloudcode-pa.googleapis.com";
const DEFAULT_PROJECT = "rising-fact-p41fc";
const DEFAULT_COOLDOWN_MS = 5 * 60_000;
const MAX_COOLDOWN_MS = 60 * 60_000;

export interface AntigravityCredential {
  accessToken: string | null;
  refreshToken: string | null;
  projectId: string | null;
  expires: number | null;
}

export function loadAntigravityCredential(runtime: QuotaRuntime): AntigravityCredential | null {
  for (const path of runtime.paths.antigravityTokenFiles ?? []) {
    const file = readJson(runtime, path);
    if (!file) continue;
    const tokenObj = objectValue(file.token) ?? file;
    const accessToken = stringValue(tokenObj.access_token) ?? stringValue(tokenObj.accessToken);
    const refreshToken = stringValue(tokenObj.refresh_token) ?? stringValue(tokenObj.refreshToken);
    const expires = timestampValue(tokenObj.expiry) ?? timestampValue(tokenObj.expires);
    const projectId = stringValue(file.projectId) ?? stringValue(tokenObj.projectId);
    if (accessToken || refreshToken) {
      return { accessToken, refreshToken, projectId, expires };
    }
  }

  for (const path of runtime.paths.antigravityAccountsFiles ?? []) {
    const file = readJson(runtime, path);
    const accounts = Array.isArray(file?.accounts) ? file.accounts : [];
    const index = numberValue(file?.activeIndex) ?? 0;
    const account = objectValue(accounts[index] ?? accounts[0]);
    const refresh = stringValue(account?.refreshToken);
    if (!refresh) continue;
    const parts = refresh.split("|");
    return {
      accessToken: null,
      refreshToken: stringValue(parts[0]),
      projectId: stringValue(account?.projectId)
        ?? stringValue(account?.managedProjectId)
        ?? stringValue(parts[1])
        ?? stringValue(parts[2]),
      expires: null,
    };
  }

  const entry = getAuthEntry(runtime.readAuth(), ["antigravity"]);
  const oauth = objectValue(entry?.oauth) ?? entry;
  if (oauth) {
    const parts = (stringValue(oauth.refresh) ?? "").split("|");
    const accessToken = stringValue(oauth.access) ?? stringValue(oauth.token);
    const refreshToken = stringValue(parts[0]) || stringValue(oauth.refresh);
    if (accessToken || refreshToken) {
      return {
        accessToken,
        refreshToken,
        projectId: stringValue(parts[1]) ?? stringValue(parts[2]),
        expires: timestampValue(oauth.expires),
      };
    }
  }

  return null;
}

const bearer = (secret: string): Record<string, string> => ({
  Authorization: `Bearer ${secret}`,
  "Content-Type": "application/json",
});

const antigravityHeaders = (accessToken: string): Record<string, string> => ({
  ...bearer(accessToken),
  "User-Agent": "antigravity/1.11.5 windows/amd64",
  "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
  "Client-Metadata": "{\"ideType\":\"IDE_UNSPECIFIED\",\"platform\":\"PLATFORM_UNSPECIFIED\",\"pluginType\":\"GEMINI\"}",
});

const safeJson = async (
  runtime: QuotaRuntime,
  url: string,
  init: RequestInit,
  authMessage?: string,
): Promise<Record<string, unknown>> => {
  let response: Response;
  try {
    response = await runtime.fetchImpl(url, init);
  } catch {
    throw new Error("Antigravity usage request failed");
  }
  if (response.status === 401 || response.status === 403) {
    throw Object.assign(new Error(authMessage ?? "Antigravity authentication failed"), { status: response.status });
  }
  if (response.status === 429) {
    const error = Object.assign(new Error("Rate limited by Google Cloud. Retrying shortly."), {
      status: 429,
      retryAfter: response.headers?.get?.("retry-after") ?? undefined,
    });
    throw error;
  }
  if (!response.ok) throw new Error(`Antigravity usage API returned HTTP ${response.status}`);
  try {
    return objectValue(await response.json()) ?? {};
  } catch {
    throw new Error("Antigravity usage API returned invalid JSON");
  }
};

async function refreshAccessToken(
  runtime: QuotaRuntime,
  refreshToken: string,
  signal: AbortSignal,
): Promise<string> {
  const form = new URLSearchParams({
    client_id: ANTIGRAVITY_CLIENT.id,
    client_secret: ANTIGRAVITY_CLIENT.secret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const refreshed = await safeJson(
    runtime,
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
      signal,
    },
    "Antigravity session expired — please sign in again with agy",
  );
  const token = stringValue(refreshed.access_token);
  if (!token) throw new Error("Antigravity OAuth token refresh did not return an access token");
  return token;
}

interface ModelQuotaRow {
  remainingFraction: number | null;
  resetTime: string | null;
}

async function fetchAntigravityUsage(
  runtime: QuotaRuntime,
  accessToken: string,
  projectId: string | null,
  signal: AbortSignal,
): Promise<ProviderUsage> {
  const project = projectId ?? DEFAULT_PROJECT;
  const body = JSON.stringify({ project });
  const headers = antigravityHeaders(accessToken);
  const authMessage = "Antigravity session expired — please sign in again with agy";
  const rawModels = new Map<string, ModelQuotaRow>();

  // 1. retrieveUserQuota: model-level quota buckets with reset times and remaining fractions
  try {
    const quotas = await safeJson(
      runtime,
      `${GOOGLE_PRIMARY}/v1internal:retrieveUserQuota`,
      {
        method: "POST",
        headers,
        body,
        signal,
      },
      authMessage,
    );
    const buckets = Array.isArray(quotas.buckets) ? quotas.buckets : [];
    for (const raw of buckets) {
      const bucket = objectValue(raw);
      const model = stringValue(bucket?.modelId);
      if (!model || model.startsWith("chat_") || model.startsWith("tab_")) continue;
      rawModels.set(model, {
        remainingFraction: numberValue(bucket?.remainingFraction),
        resetTime: stringValue(bucket?.resetTime),
      });
    }
  } catch (err: unknown) {
    const status = (err as { status?: number })?.status;
    if (status === 401 || status === 403 || status === 429) throw err;
    /* fetchAvailableModels remains useful */
  }

  // 2. fetchAvailableModels fallback / augmentation
  const endpoints = [
    "https://daily-cloudcode-pa.sandbox.googleapis.com",
    "https://autopush-cloudcode-pa.sandbox.googleapis.com",
    GOOGLE_PRIMARY,
  ];
  let available: Record<string, unknown> | null = null;
  for (const endpoint of endpoints) {
    try {
      available = await safeJson(
        runtime,
        `${endpoint}/v1internal:fetchAvailableModels`,
        {
          method: "POST",
          headers,
          body,
          signal,
        },
        authMessage,
      );
      break;
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status;
      if (status === 401 || status === 403 || status === 429) throw err;
      /* try the next endpoint */
    }
  }

  const availableModels = objectValue(available?.models) ?? {};
  for (const [name, raw] of Object.entries(availableModels)) {
    if (name.startsWith("chat_") || name.startsWith("tab_")) continue;
    const model = objectValue(raw);
    const quota = objectValue(model?.quotaInfo);
    if (!quota && rawModels.has(name)) continue;
    rawModels.set(name, {
      remainingFraction: numberValue(quota?.remainingFraction),
      resetTime: stringValue(quota?.resetTime),
    });
  }

  const models: NonNullable<ProviderUsage["models"]> = {};
  for (const [name, row] of rawModels) {
    const remaining = row.remainingFraction;
    const resetAt = timestampValue(row.resetTime);
    const seconds = resetAt !== null && (resetAt - runtime.now()) / 1000 <= 10 * 3600 ? 5 * 3600 : 86400;
    models[name] = {
      windows: {
        [seconds === 5 * 3600 ? "5h" : "daily"]: usageWindow({
          usedPercent: remaining === null ? null : Math.max(0, 100 - Math.round(remaining * 100)),
          windowSeconds: seconds,
          resetAt,
        }),
      },
    };
  }

  return { models };
}

const cooldownMs = (retryAfter: string | undefined, now: number): number => {
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, MAX_COOLDOWN_MS);
  const retryAt = retryAfter ? Date.parse(retryAfter) : Number.NaN;
  if (Number.isFinite(retryAt) && retryAt > now) return Math.min(retryAt - now, MAX_COOLDOWN_MS);
  return DEFAULT_COOLDOWN_MS;
};

export const createAntigravityProvider = (runtime: QuotaRuntime): DiscoverableProvider => {
  let cached: { fingerprint: string; usage: ProviderUsage } | null = null;
  let cooldownUntil = 0;

  const snapshot = (usage: ProviderUsage): QuotaSnapshot => {
    const windows = mapProviderUsage(usage);
    if (windows.length === 0) throw new Error("Antigravity usage data could not be parsed");
    return {
      providerId: ANTIGRAVITY_PROVIDER_ID,
      accountLabel: ANTIGRAVITY_PROVIDER_NAME,
      windows,
      fetchedAt: runtime.now(),
      stale: false,
    };
  };

  return {
    id: ANTIGRAVITY_PROVIDER_ID,
    isConfigured: () => Boolean(loadAntigravityCredential(runtime)),
    async fetch(signal) {
      const cred = loadAntigravityCredential(runtime);
      if (!cred) throw new Error("Antigravity is not configured");

      const fingerprint = createHash("sha256")
        .update(`${cred.accessToken ?? ""}\0${cred.refreshToken ?? ""}\0${cred.projectId ?? ""}`)
        .digest("hex");

      if (cached && cached.fingerprint !== fingerprint) {
        cached = null;
        cooldownUntil = 0;
      }

      if (runtime.now() < cooldownUntil) {
        if (cached) return snapshot(cached.usage);
        throw new Error("Rate limited by Google Cloud. Retrying shortly.");
      }

      let token = cred.accessToken;
      if (!token || (cred.expires !== null && cred.expires <= runtime.now())) {
        if (!cred.refreshToken) {
          throw new Error("Antigravity session expired — please sign in again with agy");
        }
        token = await refreshAccessToken(runtime, cred.refreshToken, signal);
      }

      try {
        const usage = await fetchAntigravityUsage(runtime, token, cred.projectId, signal);
        const snap = snapshot(usage);
        cached = { fingerprint, usage };
        return snap;
      } catch (err: unknown) {
        if (err && typeof err === "object" && (err as { status?: number }).status === 429) {
          cooldownUntil = runtime.now() + cooldownMs((err as { retryAfter?: string }).retryAfter, runtime.now());
          if (cached) return snapshot(cached.usage);
        }
        throw err;
      }
    },
  };
};
