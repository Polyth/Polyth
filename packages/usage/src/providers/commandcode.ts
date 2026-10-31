import { join } from "node:path";
import type { QuotaSnapshot } from "@polyth/contracts";
import type { QuotaRuntime } from "../opencodeAuth.ts";
import {
  getAuthEntry,
  numberValue,
  objectValue,
  stringValue,
  timestampValue,
} from "../opencodeAuth.ts";
import type { DiscoverableProvider } from "./adapters.ts";

const safeJson = async (
  runtime: QuotaRuntime,
  url: string,
  key: string,
  signal: AbortSignal,
): Promise<Record<string, unknown>> => {
  let response: Response;
  try {
    response = await runtime.fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${key}` },
      signal,
    });
  } catch {
    throw new Error("Command Code usage request failed");
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error("Command Code session expired — sign in again with Command Code");
  }
  if (!response.ok) throw new Error(`Command Code usage API returned HTTP ${response.status}`);
  try {
    return objectValue(await response.json()) ?? {};
  } catch {
    throw new Error("Command Code usage API returned invalid JSON");
  }
};

const readNativeAuth = (runtime: QuotaRuntime): Record<string, unknown> | null => {
  try {
    const text = runtime.readFile(join(runtime.home, ".commandcode", "auth.json")).trim();
    return text ? objectValue(JSON.parse(text)) : null;
  } catch {
    return null;
  }
};

export const loadCommandCodeCredential = (runtime: QuotaRuntime): string | null => {
  const env = stringValue(runtime.env.COMMAND_CODE_API_KEY);
  if (env) return env;
  const native = readNativeAuth(runtime);
  const nativeKey = stringValue(native?.apiKey) ?? stringValue(native?.token) ?? stringValue(native?.key);
  if (nativeKey) return nativeKey;
  const legacy = getAuthEntry(runtime.readAuth(), ["command-code", "commandcode"]);
  return stringValue(legacy?.key) ?? stringValue(legacy?.access) ?? stringValue(legacy?.token);
};

const percent = (used: number, limit: number): number =>
  Math.max(0, Math.min(100, limit > 0 ? (used / limit) * 100 : 0));

const formatNumber = (value: number): string =>
  String(Math.round((value + Number.EPSILON) * 100) / 100);

const accountName = (identity: Record<string, unknown>): string => {
  const user = objectValue(identity.user);
  const org = objectValue(identity.org);
  return (
    stringValue(user?.email) ??
    stringValue(user?.name) ??
    stringValue(identity.email) ??
    stringValue(identity.name) ??
    stringValue(org?.name) ??
    "Command Code"
  );
};

export const createCommandCodeProvider = (runtime: QuotaRuntime): DiscoverableProvider => ({
  id: "command-code",
  isConfigured: () => Boolean(loadCommandCodeCredential(runtime)),
  async fetch(signal): Promise<QuotaSnapshot> {
    const key = loadCommandCodeCredential(runtime);
    if (!key) throw new Error("Command Code is not signed in");

    const identity = await safeJson(runtime, "https://api.commandcode.ai/alpha/whoami", key, signal);
    const orgId = stringValue(objectValue(identity.org)?.id);
    const creditsUrl = orgId
      ? `https://api.commandcode.ai/alpha/billing/credits?orgId=${encodeURIComponent(orgId)}`
      : "https://api.commandcode.ai/alpha/billing/credits";
    const payload = await safeJson(runtime, creditsUrl, key, signal);
    const windows: QuotaSnapshot["windows"] = [];

    const limits = objectValue(payload.windowLimits);
    for (const [id, field, seconds, label] of [
      ["5h", "fiveHour", 5 * 60 * 60, "5h credits"],
      ["weekly", "weekly", 7 * 24 * 60 * 60, "Weekly credits"],
    ] as const) {
      const window = objectValue(limits?.[field]);
      const used = numberValue(window?.used);
      const cap = numberValue(window?.cap);
      if (used === null || cap === null || cap <= 0) continue;
      const resetAt = timestampValue(window?.resetAt);
      windows.push({
        id,
        label: `${label} · ${formatNumber(used)} / ${formatNumber(cap)}`,
        used: percent(used, cap),
        limit: 100,
        unit: "percent",
        periodMs: seconds * 1000,
        ...(resetAt !== null ? { resetsAt: resetAt } : {}),
      });
    }

    const credits = objectValue(payload.credits);
    for (const [id, field, label] of [
      ["monthly_credits", "monthlyCredits", "Monthly credits available"],
      ["purchased_credits", "purchasedCredits", "Purchased credits available"],
      ["free_credits", "freeCredits", "Free credits available"],
    ] as const) {
      const available = numberValue(credits?.[field]);
      if (available === null) continue;
      windows.push({ id, label: `${label} · ${available}`, used: 0, limit: available, unit: "requests" });
    }

    if (!windows.length) throw new Error("Command Code usage data could not be parsed");
    return {
      providerId: "command-code",
      accountLabel: accountName(identity),
      windows,
      fetchedAt: runtime.now(),
      stale: false,
    };
  },
});
