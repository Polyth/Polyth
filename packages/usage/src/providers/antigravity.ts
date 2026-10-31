import { createHash } from "node:crypto";
import { join } from "node:path";
import type { QuotaSnapshot } from "@polyth/contracts";
import type { UsageLimitAccount } from "../limits.ts";
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
import { antigravityClientHeaders, warnIfGeminiGroupMissing } from "./antigravityClient.ts";
import type { DiscoverableProvider } from "./adapters.ts";

export const ANTIGRAVITY_PROVIDER_ID = "antigravity";
export const ANTIGRAVITY_PROVIDER_NAME = "Antigravity";

const GOOGLE_PRIMARY = "https://cloudcode-pa.googleapis.com";
const DEFAULT_PROJECT = "rising-fact-p41fc";
const DEFAULT_COOLDOWN_MS = 5 * 60_000;
const MAX_COOLDOWN_MS = 60 * 60_000;

export interface AntigravityCredential {
  /** `agy` refreshes its own login; an OpenCode plugin login needs the
   *  plugin's installed OAuth client. */
  origin: "agy" | "opencode";
  accessToken: string | null;
  refreshToken: string | null;
  projectId: string | null;
  expires: number | null;
}

/** An `agy` login file (`antigravity-oauth-token`). */
const readTokenFile = (runtime: QuotaRuntime, path: string): AntigravityCredential | null => {
  const file = readJson(runtime, path);
  if (!file) return null;
  const tokenObj = objectValue(file.token) ?? file;
  const accessToken = stringValue(tokenObj.access_token) ?? stringValue(tokenObj.accessToken);
  const refreshToken = stringValue(tokenObj.refresh_token) ?? stringValue(tokenObj.refreshToken);
  const expires = timestampValue(tokenObj.expiry) ?? timestampValue(tokenObj.expires);
  const projectId = stringValue(file.projectId) ?? stringValue(tokenObj.projectId);
  return accessToken || refreshToken ? { origin: "agy", accessToken, refreshToken, projectId, expires } : null;
};

export function loadAntigravityCredential(runtime: QuotaRuntime): AntigravityCredential | null {
  for (const path of runtime.paths.antigravityTokenFiles ?? []) {
    const credential = readTokenFile(runtime, path);
    if (credential) return credential;
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
      origin: "opencode",
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
        origin: "opencode",
        accessToken,
        refreshToken,
        projectId: stringValue(parts[1]) ?? stringValue(parts[2]),
        expires: timestampValue(oauth.expires),
      };
    }
  }

  return null;
}

/** One account's own login. An account's `agy` runs with `HOME` set to the
 * account directory, so its sign-in lands in `<configDir>/.gemini/antigravity-cli`.
 * It never borrows the default login, `GEMINI_CLI_HOME`, the OpenCode plugin's
 * accounts file or the OpenCode auth file, so its limits can't be another account's. */
export const loadAntigravityAccountCredential = (runtime: QuotaRuntime, configDir: string): AntigravityCredential | null =>
  readTokenFile(runtime, join(configDir, ".gemini", "antigravity-cli", "antigravity-oauth-token"));

const bearer =(secret: string): Record<string, string> => ({
  Authorization: `Bearer ${secret}`,
  "Content-Type": "application/json",
});

const antigravityHeaders = (
  accessToken: string,
  runtime: { platform: string; arch: string },
): Record<string, string> => ({
  ...bearer(accessToken),
  ...antigravityClientHeaders(runtime),
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

const SIGN_IN_AGAIN = "Antigravity session expired — please sign in again with agy";

/** An OpenCode plugin login, refreshed with the plugin's own installed client. */
async function refreshPluginToken(
  runtime: QuotaRuntime,
  refreshToken: string,
  signal: AbortSignal,
): Promise<string> {
  const client = runtime.findGoogleClient("antigravity");
  if (!client) throw new Error("Antigravity session expired — open OpenCode to refresh its Antigravity login");
  const form = new URLSearchParams({
    client_id: client.id,
    client_secret: client.secret,
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
    SIGN_IN_AGAIN,
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
  const headers = antigravityHeaders(accessToken, runtime);
  const authMessage = SIGN_IN_AGAIN;
  const rawModels = new Map<string, ModelQuotaRow>();

  const isGoogleModel = (modelId: string): boolean => {
    const lower = modelId.toLowerCase();
    return lower.startsWith("gemini") || lower.startsWith("gemma") || lower.includes("google");
  };

  // 0. retrieveUserQuotaSummary: provides official 5-hour and weekly limits for Google and third-party groups
  try {
    const summary = await safeJson(
      runtime,
      `${GOOGLE_PRIMARY}/v1internal:retrieveUserQuotaSummary`,
      {
        method: "POST",
        headers,
        body,
        signal,
      },
      authMessage,
    );
    const groups = Array.isArray(summary.groups) ? summary.groups : [];
    if (groups.length > 0) {
      const windows: NonNullable<ProviderUsage["windows"]> = {};
      let sawGoogleGroup = false;
      for (const rawGroup of groups) {
        const group = objectValue(rawGroup);
        if (!group) continue;
        const groupName = stringValue(group.displayName) ?? "";
        const isGoogle = isGoogleModel(groupName) || /gemini|google/i.test(groupName);
        if (isGoogle) sawGoogleGroup = true;
        const prefix = isGoogle ? "google" : "third-party";
        const groupLabel = isGoogle ? "Google models" : "Third-party models";
        const buckets = Array.isArray(group.buckets) ? group.buckets : [];
        for (const rawBucket of buckets) {
          const bucket = objectValue(rawBucket);
          if (!bucket) continue;
          const bucketWindow = stringValue(bucket.window)?.toLowerCase();
          const bucketId = stringValue(bucket.bucketId)?.toLowerCase() ?? "";
          const is5h = bucketWindow === "5h" || bucketId.includes("5h");
          const isWeekly = bucketWindow === "weekly" || bucketId.includes("weekly");
          const windowKey = is5h ? `${prefix}-5h` : isWeekly ? `${prefix}-weekly` : `${prefix}-${bucketId || "limit"}`;
          const windowDuration = is5h ? 5 * 3600 : isWeekly ? 7 * 86400 : undefined;
          const label = `${groupLabel} (${is5h ? "5h" : isWeekly ? "weekly" : bucketId})`;
          const fraction = numberValue(bucket.remainingFraction);
          const usedPercent = fraction === null ? null : Math.max(0, 100 - Math.round(fraction * 100));
          const resetAt = timestampValue(bucket.resetTime);
          windows[windowKey] = usageWindow({
            label,
            usedPercent,
            ...(windowDuration ? { windowSeconds: windowDuration } : {}),
            resetAt,
          });
        }
      }
      warnIfGeminiGroupMissing(groups, sawGoogleGroup);
      if (Object.keys(windows).length > 0) {
        return { windows };
      }
    }
    const summaryBuckets = Array.isArray(summary.buckets) ? summary.buckets : [];
    for (const raw of summaryBuckets) {
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
    /* fallback to retrieveUserQuota */
  }

  // 1. retrieveUserQuota: model-level quota buckets with reset times and remaining fractions
  if (rawModels.size === 0) {
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

  const aggregateTier = (rows: ModelQuotaRow[]): { remainingFraction: number | null; resetTime: string | null } => {
    let minFraction: number | null = null;
    let resetTime: string | null = null;
    for (const row of rows) {
      if (row.remainingFraction !== null && Number.isFinite(row.remainingFraction)) {
        if (minFraction === null || row.remainingFraction < minFraction) {
          minFraction = row.remainingFraction;
          resetTime = row.resetTime ?? resetTime;
        }
      } else if (resetTime === null && row.resetTime) {
        resetTime = row.resetTime;
      }
    }
    return { remainingFraction: minFraction, resetTime };
  };

  const googleRows: ModelQuotaRow[] = [];
  const thirdPartyRows: ModelQuotaRow[] = [];
  for (const [name, row] of rawModels) {
    if (isGoogleModel(name)) {
      googleRows.push(row);
    } else {
      thirdPartyRows.push(row);
    }
  }

  const windows: NonNullable<ProviderUsage["windows"]> = {};

  if (googleRows.length > 0) {
    const { remainingFraction, resetTime } = aggregateTier(googleRows);
    const resetAt = timestampValue(resetTime);
    const seconds = resetAt !== null && (resetAt - runtime.now()) / 1000 <= 10 * 3600 ? 5 * 3600 : 86400;
    windows["google-models"] = usageWindow({
      label: "Google models",
      usedPercent: remainingFraction === null ? null : Math.max(0, 100 - Math.round(remainingFraction * 100)),
      windowSeconds: seconds,
      resetAt,
    });
  }

  if (thirdPartyRows.length > 0) {
    const { remainingFraction, resetTime } = aggregateTier(thirdPartyRows);
    const resetAt = timestampValue(resetTime);
    const seconds = resetAt !== null && (resetAt - runtime.now()) / 1000 <= 10 * 3600 ? 5 * 3600 : 86400;
    windows["third-party-models"] = usageWindow({
      label: "Third-party models",
      usedPercent: remainingFraction === null ? null : Math.max(0, 100 - Math.round(remainingFraction * 100)),
      windowSeconds: seconds,
      resetAt,
    });
  }

  return { windows };
}

const cooldownMs = (retryAfter: string | undefined, now: number): number => {
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, MAX_COOLDOWN_MS);
  const retryAt = retryAfter ? Date.parse(retryAfter) : Number.NaN;
  if (Number.isFinite(retryAt) && retryAt > now) return Math.min(retryAt - now, MAX_COOLDOWN_MS);
  return DEFAULT_COOLDOWN_MS;
};

export interface AntigravityAccountSource {
  /** The account's private `HOME`, which holds its own `.gemini`. */
  configDir: string;
  account(): UsageLimitAccount;
}

/** The default source reads the user's own login; with `source`, one account's. */
export const createAntigravityProvider = (
  runtime: QuotaRuntime,
  source?: AntigravityAccountSource,
): DiscoverableProvider => {
  const providerId = source ? source.account().harnessId : ANTIGRAVITY_PROVIDER_ID;
  const load = source
    ? () => loadAntigravityAccountCredential(runtime, source.configDir)
    : () => loadAntigravityCredential(runtime);
  const loginHome = source?.configDir ?? runtime.home;
  const expired = (cred: AntigravityCredential): boolean =>
    !cred.accessToken || (cred.expires !== null && cred.expires <= runtime.now());
  /** A live access token. `agy` rewrites its token file when it refreshes, so
   *  the login is read again afterwards. */
  const accessToken = async (cred: AntigravityCredential, signal: AbortSignal): Promise<string> => {
    if (!expired(cred)) return cred.accessToken as string;
    if (!cred.refreshToken) throw new Error(SIGN_IN_AGAIN);
    if (cred.origin === "opencode") return refreshPluginToken(runtime, cred.refreshToken, signal);
    await runtime.refreshAntigravityLogin(loginHome);
    const reread = load();
    if (!reread || reread.origin !== "agy" || expired(reread)) throw new Error(SIGN_IN_AGAIN);
    return reread.accessToken as string;
  };
  let cached: { fingerprint: string; usage: ProviderUsage } | null = null;
  let cooldownUntil = 0;

  const snapshot = (usage: ProviderUsage): QuotaSnapshot => {
    const windows = mapProviderUsage(usage);
    if (windows.length === 0) throw new Error("Antigravity usage data could not be parsed");
    return {
      providerId,
      accountLabel: ANTIGRAVITY_PROVIDER_NAME,
      windows,
      fetchedAt: runtime.now(),
      stale: false,
    };
  };
  const fingerprintOf = (cred: AntigravityCredential): string => createHash("sha256")
    .update(`${cred.accessToken ?? ""}\0${cred.refreshToken ?? ""}\0${cred.projectId ?? ""}`)
    .digest("hex");

  return {
    id: providerId,
    ...(source ? { account: source.account } : {}),
    isConfigured: () => Boolean(load()),
    credentialFingerprint() {
      const cred = load();
      return cred ? fingerprintOf(cred) : null;
    },
    async fetch(signal) {
      const cred = load();
      if (!cred) {
        throw new Error(source ? "This Antigravity account is not signed in." : "Antigravity is not configured");
      }

      const fingerprint = fingerprintOf(cred);

      if (cached && cached.fingerprint !== fingerprint) {
        cached = null;
        cooldownUntil = 0;
      }

      if (runtime.now() < cooldownUntil) {
        if (cached) return snapshot(cached.usage);
        throw new Error("Rate limited by Google Cloud. Retrying shortly.");
      }

      const token = await accessToken(cred, signal);

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
