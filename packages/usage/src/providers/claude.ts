import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { QuotaSnapshot } from "@polyth/contracts";
import type { QuotaProvider } from "../index.ts";
import {
  getAuthEntry,
  normalizeAuthEntry,
  numberValue,
  objectValue,
  readJson,
  stringValue,
  timestampValue,
  type QuotaRuntime,
} from "../opencodeAuth.ts";
import { mapProviderUsage, usageWindow, type ProviderUsage } from "../ocWindows.ts";

const PROVIDER_ID = "claude";
const PROVIDER_NAME = "Claude";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const DEFAULT_COOLDOWN_MS = 5 * 60_000;
const MAX_COOLDOWN_MS = 60 * 60_000;

interface ClaudeCredential {
  accessToken: string;
  refreshToken: string | null;
  planLabel: string | null;
}

const parseClaudeCodeBlob = (blob: unknown): ClaudeCredential | null => {
  const oauth = objectValue(objectValue(blob)?.claudeAiOauth);
  const accessToken = stringValue(oauth?.accessToken);
  if (!accessToken) return null;
  return {
    accessToken,
    refreshToken: stringValue(oauth?.refreshToken),
    planLabel: stringValue(oauth?.subscriptionType),
  };
};

const readKeychain = (runtime: QuotaRuntime): ClaudeCredential | null => {
  if (runtime.platform !== "darwin") return null;
  try {
    const raw = runtime.readKeychain
      ? runtime.readKeychain()
      : execFileSync(
          "security",
          ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
          { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] },
        );
    return raw ? parseClaudeCodeBlob(JSON.parse(raw.trim())) : null;
  } catch {
    return null;
  }
};

export const loadClaudeCredential = (runtime: QuotaRuntime): ClaudeCredential | null => {
  const keychain = readKeychain(runtime);
  if (keychain) return keychain;
  const credentialsFile = parseClaudeCodeBlob(readJson(runtime, runtime.paths.claudeCredentialsFile));
  if (credentialsFile) return credentialsFile;
  const entry = normalizeAuthEntry(getAuthEntry(runtime.readAuth(), ["anthropic", "claude"]));
  const accessToken = stringValue(entry?.access) ?? stringValue(entry?.token);
  if (accessToken) {
    return {
      accessToken,
      refreshToken: stringValue(entry?.refresh),
      planLabel: null,
    };
  }
  const envToken = stringValue(runtime.env.CLAUDE_CODE_OAUTH_TOKEN);
  return envToken ? { accessToken: envToken, refreshToken: null, planLabel: null } : null;
};

const amount = (value: unknown): number | null => {
  const money = objectValue(value);
  const minor = numberValue(money?.amount_minor);
  if (minor === null) return null;
  return minor / 10 ** (numberValue(money?.exponent) ?? 2);
};

const toClaudeUsage = (raw: unknown): ProviderUsage => {
  const payload = objectValue(raw) ?? {};
  const windows: NonNullable<ProviderUsage["windows"]> = {};
  const models: NonNullable<ProviderUsage["models"]> = {};
  const addPercent = (
    target: NonNullable<ProviderUsage["windows"]>,
    key: string,
    percent: unknown,
    resetAt: unknown,
    windowSeconds: number,
  ) => {
    const usedPercent = numberValue(percent);
    if (usedPercent === null) return;
    target[key] = usageWindow({ usedPercent, resetAt: timestampValue(resetAt), windowSeconds });
  };
  const limits = Array.isArray(payload.limits) ? payload.limits : [];
  if (limits.length > 0) {
    for (const rawLimit of limits) {
      const limit = objectValue(rawLimit);
      if (!limit) continue;
      if (limit.kind === "session") {
        addPercent(windows, "5h", limit.percent, limit.resets_at, 5 * 60 * 60);
      } else if (limit.kind === "weekly_all") {
        addPercent(windows, "7d", limit.percent, limit.resets_at, 7 * 24 * 60 * 60);
      } else if (limit.kind === "weekly_scoped") {
        const modelName = stringValue(objectValue(objectValue(limit.scope)?.model)?.display_name);
        if (!modelName) continue;
        const scoped: NonNullable<ProviderUsage["windows"]> = {};
        addPercent(scoped, "7d", limit.percent, limit.resets_at, 7 * 24 * 60 * 60);
        if (Object.keys(scoped).length > 0) models[modelName] = { windows: scoped };
      }
    }
  } else {
    const fiveHour = objectValue(payload.five_hour);
    const sevenDay = objectValue(payload.seven_day);
    if (fiveHour) addPercent(windows, "5h", fiveHour.utilization, fiveHour.resets_at, 5 * 60 * 60);
    if (sevenDay) addPercent(windows, "7d", sevenDay.utilization, sevenDay.resets_at, 7 * 24 * 60 * 60);
  }
  const spend = objectValue(payload.spend);
  if (spend?.enabled === true) {
    const used = amount(spend.used);
    const limit = amount(spend.limit);
    if (used !== null || numberValue(spend.percent) !== null) {
      windows.extra_usage = usageWindow({
        usedPercent: numberValue(spend.percent),
        ...(used !== null && limit !== null ? { used, limit, unit: "currency" } : {}),
      });
    }
  }
  return { windows, ...(Object.keys(models).length > 0 ? { models } : {}) };
};

const cooldownMs = (response: Response, now: number): number => {
  const raw = response.headers.get("retry-after");
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, MAX_COOLDOWN_MS);
  const retryAt = raw ? Date.parse(raw) : Number.NaN;
  if (Number.isFinite(retryAt) && retryAt > now) return Math.min(retryAt - now, MAX_COOLDOWN_MS);
  return DEFAULT_COOLDOWN_MS;
};

export const createClaudeProvider = (runtime: QuotaRuntime): QuotaProvider & { isConfigured(): boolean } => {
  let cached: { fingerprint: string; usage: ProviderUsage; planLabel: string | null } | null = null;
  let cooldownUntil = 0;
  const snapshot = (usage: ProviderUsage, planLabel: string | null): QuotaSnapshot => ({
    providerId: PROVIDER_ID,
    accountLabel: planLabel ?? PROVIDER_NAME,
    windows: mapProviderUsage(usage),
    fetchedAt: runtime.now(),
    stale: false,
  });
  return {
    id: PROVIDER_ID,
    isConfigured: () => Boolean(loadClaudeCredential(runtime)),
    async fetch(signal) {
      const credential = loadClaudeCredential(runtime);
      if (!credential) throw new Error("Claude is not configured");
      const fingerprint = createHash("sha256")
        .update(`${credential.accessToken}\0${credential.refreshToken ?? ""}`)
        .digest("hex");
      if (cached && cached.fingerprint !== fingerprint) {
        cached = null;
        cooldownUntil = 0;
      }
      if (runtime.now() < cooldownUntil) {
        if (cached) return snapshot(cached.usage, credential.planLabel ?? cached.planLabel);
        throw new Error("Rate limited by Anthropic. Retrying shortly.");
      }
      let response: Response;
      try {
        response = await runtime.fetchImpl(USAGE_URL, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${credential.accessToken}`,
            "anthropic-beta": "oauth-2025-04-20",
          },
          signal,
        });
      } catch {
        throw new Error("Claude usage request failed");
      }
      if (response.status === 429) {
        cooldownUntil = runtime.now() + cooldownMs(response, runtime.now());
        if (cached) return snapshot(cached.usage, credential.planLabel ?? cached.planLabel);
        throw new Error("Rate limited by Anthropic. Retrying shortly.");
      }
      if (response.status === 401 || response.status === 403) {
        throw new Error("Claude session expired. Open Claude Code to sign in again.");
      }
      if (!response.ok) throw new Error(`Claude usage API returned HTTP ${response.status}`);
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new Error("Unexpected response from Anthropic");
      }
      const usage = toClaudeUsage(payload);
      if (mapProviderUsage(usage).length === 0) throw new Error("Claude usage data could not be parsed");
      cached = { fingerprint, usage, planLabel: credential.planLabel };
      return snapshot(usage, credential.planLabel);
    },
  };
};
