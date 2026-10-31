import type { QuotaSnapshot } from "@polyth/contracts";
import type { QuotaProvider } from "../index.ts";
import {
  getAuthEntry,
  numberValue,
  objectValue,
  providerLogins,
  readManagedCredential,
  removeLegacyOpenCodeGoCredential,
  stringValue,
  timestampValue,
  type QuotaRuntime
} from "../opencodeAuth.ts";
import { mapProviderUsage, usageWindow, type ProviderUsage, type ProviderUsageWindow } from "../ocWindows.ts";
import { createCodex } from "./codex.ts";
import { antigravityClientHeaders } from "./antigravityClient.ts";

export type DiscoverableProvider = QuotaProvider & { isConfigured(): boolean };

const clampPercent = (value: unknown): number | null => {
  const number = numberValue(value);
  return number === null ? null : Math.max(0, Math.min(100, number));
};

const formatNumber = (value: number): string =>
  String(Math.round((value + Number.EPSILON) * 100) / 100);

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

const percentOf = (used: number | null, limit: number | null): number | null =>
  used !== null && limit !== null && limit > 0 ? clampPercent(used / limit * 100) : null;

const authEntry = (runtime: QuotaRuntime, aliases: readonly string[]): Record<string, unknown> | null =>
  getAuthEntry(runtime.readAuth(), aliases);

const authSecret = (
  runtime: QuotaRuntime,
  aliases: readonly string[],
  fields: readonly string[] = ["key", "token"],
): string | null => {
  const entry = authEntry(runtime, aliases);
  for (const field of fields) {
    const value = stringValue(entry?.[field]);
    if (value) return value;
  }
  return null;
};

/** A provider API key from its documented environment variable, then its auth entry. */
const providerKey = (
  runtime: QuotaRuntime,
  aliases: readonly string[],
  envNames: readonly string[],
  fields: readonly string[] = ["key", "token"],
): string | null => {
  for (const name of envNames) {
    const value = stringValue(runtime.env[name]);
    if (value) return value;
  }
  return authSecret(runtime, aliases, fields);
};

const safeJson = async (
  runtime: QuotaRuntime,
  providerName: string,
  url: string,
  init: RequestInit,
  authMessage?: string | ((status: number) => string),
): Promise<Record<string, unknown>> => {
  let response: Response;
  try {
    response = await runtime.fetchImpl(url, init);
  } catch {
    throw new Error(`${providerName} usage request failed`);
  }
  if (response.status === 401 || response.status === 403) {
    const message = typeof authMessage === "function"
      ? authMessage(response.status)
      : authMessage ?? `${providerName} authentication failed`;
    throw new Error(message);
  }
  if (!response.ok) throw new Error(`${providerName} usage API returned HTTP ${response.status}`);
  try {
    return objectValue(await response.json()) ?? {};
  } catch {
    throw new Error(`${providerName} usage API returned invalid JSON`);
  }
};

const createProvider = (
  runtime: QuotaRuntime,
  id: string,
  name: string,
  isConfigured: () => boolean,
  fetchUsage: (signal: AbortSignal) => Promise<{ usage: ProviderUsage; accountLabel?: string }>,
): DiscoverableProvider => ({
  id,
  isConfigured,
  async fetch(signal): Promise<QuotaSnapshot> {
    if (!isConfigured()) throw new Error(`${name} is not configured`);
    const result = await fetchUsage(signal);
    const windows = mapProviderUsage(result.usage);
    if (windows.length === 0) throw new Error(`${name} usage data could not be parsed`);
    return {
      providerId: id,
      accountLabel: result.accountLabel ?? name,
      windows,
      fetchedAt: runtime.now(),
      stale: false,
    };
  },
});

const bearer = (secret: string): Record<string, string> => ({
  Authorization: `Bearer ${secret}`,
  "Content-Type": "application/json",
});

const createOpenRouter = (runtime: QuotaRuntime): DiscoverableProvider => {
  const key = () => authSecret(runtime, ["openrouter"]);
  return createProvider(runtime, "openrouter", "OpenRouter", () => Boolean(key()), async (signal) => {
    const payload = await safeJson(runtime, "OpenRouter", "https://openrouter.ai/api/v1/credits", {
      method: "GET", headers: bearer(key()!), signal,
    });
    const data = objectValue(payload.data);
    const limit = numberValue(data?.total_credits);
    const used = numberValue(data?.total_usage);
    const windows: Record<string, ProviderUsageWindow> = {};
    if (used !== null && limit !== null) {
      windows.credits = usageWindow({
        used,
        limit,
        unit: "currency",
        valueLabel: `$${Math.max(0, limit - used).toFixed(2)} left · $${used.toFixed(2)} spent`,
      });
    }
    return { usage: { windows } };
  });
};

const createCommandCode = (runtime: QuotaRuntime): DiscoverableProvider => {
  const key = () => authSecret(runtime, ["command-code"], ["key", "access", "token"])
    ?? stringValue(runtime.env.COMMAND_CODE_API_KEY);
  const request = (path: string, signal: AbortSignal) =>
    safeJson(runtime, "Command Code", `https://api.commandcode.ai${path}`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${key()!}` },
      signal,
    });
  return createProvider(runtime, "command-code", "Command Code", () => Boolean(key()), async (signal) => {
    const identity = await request("/alpha/whoami", signal);
    const orgId = stringValue(objectValue(identity.org)?.id);
    const payload = await request(
      orgId ? `/alpha/billing/credits?orgId=${encodeURIComponent(orgId)}` : "/alpha/billing/credits",
      signal,
    );
    const windows: Record<string, ProviderUsageWindow> = {};
    const credits = objectValue(payload.credits);
    for (const [label, field] of [
      ["monthly_credits", "monthlyCredits"],
      ["purchased_credits", "purchasedCredits"],
      ["free_credits", "freeCredits"],
    ] as const) {
      const available = numberValue(credits?.[field]);
      if (available !== null) windows[label] = usageWindow({ used: 0, limit: available, unit: "requests" });
    }
    const limits = objectValue(payload.windowLimits);
    for (const [label, field, seconds] of [
      ["5h", "fiveHour", 5 * 60 * 60],
      ["weekly", "weekly", 7 * 24 * 60 * 60],
    ] as const) {
      const value = objectValue(limits?.[field]);
      const used = numberValue(value?.used);
      const limit = numberValue(value?.cap);
      if (used === null || limit === null || limit <= 0) continue;
      windows[label] = usageWindow({
        usedPercent: percentOf(used, limit),
        windowSeconds: seconds,
        resetAt: timestampValue(value?.resetAt),
        valueLabel: `${formatNumber(used)} / ${formatNumber(limit)}`,
      });
    }
    return { usage: { windows } };
  });
};

const createCopilot = (runtime: QuotaRuntime): DiscoverableProvider => {
  const token = () => authSecret(runtime, ["github-copilot", "copilot"], ["access", "token"]);
  const id = "github-copilot";
  const name = "GitHub Copilot";
  return createProvider(runtime, id, name, () => Boolean(token()), async (signal) => {
    const payload = await safeJson(runtime, name, "https://api.github.com/copilot_internal/user", {
      method: "GET",
      headers: {
        Authorization: `token ${token()!}`,
        Accept: "application/json",
        "Editor-Version": "vscode/1.96.2",
        "X-Github-Api-Version": "2025-04-01",
      },
      signal,
    });
    const resetAt = timestampValue(payload.quota_reset_date);
    const snapshots = objectValue(payload.quota_snapshots);
    const windows: Record<string, ProviderUsageWindow> = {};
    for (const [label, field] of [
      ["chat", "chat"], ["completions", "completions"], ["premium", "premium_interactions"],
    ] as const) {
      const value = objectValue(snapshots?.[field]);
      const entitlement = numberValue(value?.entitlement);
      const remaining = numberValue(value?.remaining);
      if (entitlement === null || remaining === null) continue;
      windows[label] = usageWindow({
        usedPercent: percentOf(entitlement - remaining, entitlement),
        resetAt,
        valueLabel: `${remaining.toFixed(0)} / ${entitlement.toFixed(0)} left`,
      });
    }
    return { usage: { windows } };
  });
};

const createBalanceProvider = (
  runtime: QuotaRuntime,
  config: {
    id: string;
    name: string;
    aliases: string[];
    url: string;
    balance: (payload: Record<string, unknown>) => { amount: number; symbol: string } | null;
  },
): DiscoverableProvider => {
  const key = () => authSecret(runtime, config.aliases);
  return createProvider(runtime, config.id, config.name, () => Boolean(key()), async (signal) => {
    const payload = await safeJson(runtime, config.name, config.url, {
      method: "GET",
      headers: { Authorization: `Bearer ${key()!}`, "Accept-Encoding": "identity" },
      signal,
    });
    const balance = config.balance(payload);
    const windows: Record<string, ProviderUsageWindow> = {};
    if (balance) {
      windows.credits_balance = usageWindow({
        used: 0,
        limit: balance.amount,
        unit: "currency",
        valueLabel: `${balance.symbol}${balance.amount.toFixed(2)} available`,
      });
    }
    return {
      usage: { windows },
    };
  });
};

const createCrof = (runtime: QuotaRuntime): DiscoverableProvider =>
  createBalanceProvider(runtime, {
    id: "crof",
    name: "CrofAI",
    aliases: ["crof"],
    url: "https://crof.ai/usage_api/",
    balance: (payload) => {
      const amount = numberValue(payload.credits);
      return amount === null ? null : { amount, symbol: "$" };
    },
  });

const createDeepSeek = (runtime: QuotaRuntime): DiscoverableProvider =>
  createBalanceProvider(runtime, {
    id: "deepseek",
    name: "DeepSeek",
    aliases: ["deepseek"],
    url: "https://api.deepseek.com/user/balance",
    balance: (payload) => {
      const balances = Array.isArray(payload.balance_infos) ? payload.balance_infos : [];
      const selected = balances.map(objectValue).find((item) => item?.currency === "USD")
        ?? balances.map(objectValue).find((item) => item?.currency === "CNY");
      const amount = numberValue(selected?.total_balance);
      return amount === null ? null : { amount, symbol: selected?.currency === "CNY" ? "¥" : "$" };
    },
  });

const duration = (value: unknown, unit: unknown): number | null => {
  const amount = numberValue(value);
  if (!amount) return null;
  if (unit === "TIME_UNIT_MINUTE") return amount * 60;
  if (unit === "TIME_UNIT_HOUR") return amount * 3600;
  if (unit === "TIME_UNIT_DAY") return amount * 86400;
  return null;
};

interface KimiConfig {
  id: string;
  name: string;
  url: string;
  aliases: string[];
  envNames: string[];
}

const createKimi = (runtime: QuotaRuntime, config: KimiConfig): DiscoverableProvider => {
  const key = () => providerKey(runtime, config.aliases, config.envNames);
  return createProvider(runtime, config.id, config.name, () => Boolean(key()), async (signal) => {
    const payload = await safeJson(runtime, config.name, config.url, {
      method: "GET", headers: bearer(key()!), signal,
    });
    const windows: Record<string, ProviderUsageWindow> = {};
    const usage = objectValue(payload.usage);
    if (usage) {
      const limit = numberValue(usage.limit);
      const used = numberValue(usage.used);
      const remaining = numberValue(usage.remaining);
      windows.weekly = usageWindow({
        usedPercent: used !== null
          ? percentOf(used, limit)
          : remaining !== null && limit !== null ? percentOf(limit - remaining, limit) : null,
        resetAt: timestampValue(usage.resetTime),
      });
    }
    const limits = Array.isArray(payload.limits) ? payload.limits : [];
    for (const raw of limits) {
      const limit = objectValue(raw);
      const frame = objectValue(limit?.window);
      const detail = objectValue(limit?.detail);
      const seconds = duration(frame?.duration, frame?.timeUnit);
      const cap = numberValue(detail?.limit);
      const used = numberValue(detail?.used);
      const remaining = numberValue(detail?.remaining);
      const label = seconds === 5 * 60 * 60 ? "Rate Limit (5h)" : windowLabel(seconds);
      windows[label] = usageWindow({
        usedPercent: used !== null
          ? percentOf(used, cap)
          : remaining !== null && cap !== null ? percentOf(cap - remaining, cap) : null,
        windowSeconds: seconds,
        resetAt: timestampValue(detail?.resetTime),
      });
    }
    return { usage: { windows } };
  });
};

const createKimiCn = (runtime: QuotaRuntime): DiscoverableProvider =>
  createKimi(runtime, {
    id: "kimi-for-coding",
    name: "Kimi Code (CN)",
    url: "https://api.kimi.com/coding/v1/usages",
    aliases: ["kimi-for-coding", "kimi-code", "kimi"],
    envNames: ["KIMI_CN_API_KEY", "KIMI_API_KEY", "KIMI_CODE_API_KEY"],
  });

const createKimiGlobal = (runtime: QuotaRuntime): DiscoverableProvider =>
  createKimi(runtime, {
    id: "kimi-code-plan-global",
    name: "Kimi Code (Global)",
    url: "https://api.kimi.ai/coding/v1/usages",
    aliases: ["kimi-code-plan-global"],
    envNames: ["KIMI_GLOBAL_API_KEY"],
  });

const createNanoGpt = (runtime: QuotaRuntime): DiscoverableProvider => {
  const key = () => authSecret(runtime, ["nano-gpt", "nanogpt", "nano_gpt"]);
  return createProvider(runtime, "nano-gpt", "NanoGPT", () => Boolean(key()), async (signal) => {
    const payload = await safeJson(runtime, "NanoGPT", "https://nano-gpt.com/api/subscription/v1/usage", {
      method: "GET", headers: bearer(key()!), signal,
    });
    const windows: Record<string, ProviderUsageWindow> = {};
    const period = objectValue(payload.period);
    for (const [label, seconds] of [["daily", 86400], ["monthly", null]] as const) {
      const value = objectValue(payload[label]);
      if (!value) continue;
      const fraction = numberValue(value.percentUsed);
      const used = numberValue(value.used);
      const limit = numberValue(value.limit) ?? numberValue(objectValue(value.limits)?.[label]);
      windows[label] = usageWindow({
        usedPercent: fraction !== null ? clampPercent(fraction * 100) : percentOf(used, limit),
        windowSeconds: seconds,
        resetAt: timestampValue(value.resetAt ?? (label === "monthly" ? period?.currentPeriodEnd : null)),
        ...(payload.state && payload.state !== "active" ? { valueLabel: `(${String(payload.state)})` } : {}),
      });
    }
    return { usage: { windows } };
  });
};

const zaiWindowSeconds = (limit: Record<string, unknown>): number | null => {
  const amount = numberValue(limit.number);
  const unit = numberValue(limit.unit);
  if (!amount) return null;
  if (unit === 3) return amount * 3600;
  if (unit === 6) return amount * 7 * 86400;
  return null;
};

const createZai = (
  runtime: QuotaRuntime,
  china: boolean,
): DiscoverableProvider => {
  const id = china ? "zhipuai-coding-plan" : "zai-coding-plan";
  const name = china ? "Zhipu AI Coding Plan" : "z.ai";
  const aliases = china ? ["zhipuai-coding-plan", "zhipuai", "zhipu"] : ["zai-coding-plan", "zai", "z.ai"];
  const url = china
    ? "https://open.bigmodel.cn/api/monitor/usage/quota/limit"
    : "https://api.z.ai/api/monitor/usage/quota/limit";
  const key = () => authSecret(runtime, aliases);
  return createProvider(runtime, id, name, () => Boolean(key()), async (signal) => {
    const payload = await safeJson(runtime, name, url, {
      method: "GET", headers: bearer(key()!), signal,
    });
    const limits = Array.isArray(objectValue(payload.data)?.limits)
      ? objectValue(payload.data)!.limits as unknown[]
      : [];
    const windows: Record<string, ProviderUsageWindow> = {};
    for (const raw of limits) {
      const limit = objectValue(raw);
      if (!limit) continue;
      if (limit.type === "TOKENS_LIMIT") {
        const seconds = zaiWindowSeconds(limit);
        const label = china ? "Tokens" : windowLabel(seconds);
        windows[label] = usageWindow({
          usedPercent: numberValue(limit.percentage),
          windowSeconds: seconds,
          resetAt: timestampValue(limit.nextResetTime),
        });
      } else if (limit.type === "TIME_LIMIT") {
        windows["MCP Tools"] = usageWindow({
          usedPercent: numberValue(limit.percentage),
          windowSeconds: 30 * 86400,
          resetAt: timestampValue(limit.nextResetTime),
        });
      }
    }
    return { usage: { windows } };
  });
};

const miniMaxUsage = (
  model: Record<string, unknown>,
  tokenPlan: boolean,
): Record<string, ProviderUsageWindow> => {
  const windows: Record<string, ProviderUsageWindow> = {};
  const add = (weekly: boolean) => {
    const prefix = weekly ? "current_weekly" : "current_interval";
    const total = numberValue(model[`${prefix}_total_count`]);
    const raw = numberValue(model[`${prefix}_usage_count`]);
    const remainingPercent = clampPercent(model[`${prefix}_remaining_percent`]);
    const usedPercent = remainingPercent !== null
      ? 100 - remainingPercent
      : total !== null && total > 0 && raw !== null
        ? percentOf(tokenPlan ? total - raw : raw, total)
        : null;
    const startAt = timestampValue(model[weekly ? "weekly_start_time" : "start_time"]);
    const resetAt = timestampValue(model[weekly ? "weekly_end_time" : "end_time"]);
    const remainsMs = numberValue(model[weekly ? "weekly_remains_time" : "remains_time"]);
    const seconds = startAt !== null && resetAt !== null && resetAt > startAt
      ? Math.floor((resetAt - startAt) / 1000)
      : remainsMs !== null && remainsMs > 0 ? Math.floor(remainsMs / 1000) : null;
    if (usedPercent === null) return;
    windows[weekly ? "weekly" : "5h"] = usageWindow({ usedPercent, windowSeconds: seconds, resetAt });
  };
  add(false);
  const weeklyStatus = numberValue(model.current_weekly_status);
  if (weeklyStatus !== 3) add(true);
  return windows;
};

const createMiniMax = (
  runtime: QuotaRuntime,
  china: boolean,
): DiscoverableProvider => {
  const id = china ? "minimax-cn-coding-plan" : "minimax-coding-plan";
  const name = china ? "MiniMax Coding Plan (minimaxi.com)" : "MiniMax Coding Plan (minimax.io)";
  const base = china ? "https://api.minimaxi.com" : "https://api.minimax.io";
  const legacy = china
    ? "https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains"
    : "https://api.minimax.io/v1/api/openplatform/coding_plan/remains";
  const key = () => authSecret(runtime, [id]);
  const fetchEndpoint = async (url: string, signal: AbortSignal): Promise<Record<string, unknown> | null> => {
    try {
      const payload = await safeJson(runtime, name, url, {
        method: "GET", headers: bearer(key()!), signal,
      });
      const baseResp = objectValue(payload.base_resp);
      return baseResp && baseResp.status_code !== 0 ? null : payload;
    } catch {
      return null;
    }
  };
  return createProvider(runtime, id, name, () => Boolean(key()), async (signal) => {
    let payload = await fetchEndpoint(`${base}/v1/token_plan/remains`, signal);
    let tokenPlan = true;
    if (!payload) {
      payload = await fetchEndpoint(legacy, signal);
      tokenPlan = false;
    }
    const remains = Array.isArray(payload?.model_remains) ? payload.model_remains : [];
    const models = remains.map(objectValue).filter((value): value is Record<string, unknown> => Boolean(value));
    const selected = models.find((model) =>
      /^minimax-m/i.test(stringValue(model.model_name) ?? "") && (numberValue(model.current_interval_total_count) ?? 0) > 0)
      ?? models.find((model) => ["general", "chat", "text"].includes((stringValue(model.model_name) ?? "").toLowerCase()))
      ?? models.find((model) => numberValue(model.current_interval_remaining_percent) !== null)
      ?? models[0];
    return { usage: { windows: selected ? miniMaxUsage(selected, tokenPlan) : {} } };
  });
};

const createOllamaCloud = (runtime: QuotaRuntime): DiscoverableProvider => {
  const credential = () => {
    const value = readManagedCredential(runtime, "ollama-cloud");
    const cookie = stringValue(value?.cookie);
    return cookie ? { cookie } : null;
  };
  return createProvider(runtime, "ollama-cloud", "Ollama Cloud", () => Boolean(credential()), async (signal) => {
    let response: Response;
    try {
      response = await runtime.fetchImpl("https://ollama.com/settings", {
        method: "GET",
        headers: { Cookie: credential()!.cookie, "User-Agent": "Polyth quota provider" },
        redirect: "manual",
        signal,
      });
    } catch {
      throw new Error("Ollama Cloud usage request failed");
    }
    if (response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400)) {
      throw new Error("Ollama Cloud authentication failed");
    }
    if (!response.ok) throw new Error(`Ollama Cloud returned HTTP ${response.status}`);
    const html = await response.text();
    const windows: Record<string, ProviderUsageWindow> = {};
    const session = html.match(/Session\s+usage[^0-9]*([0-9.]+)%/i);
    const weekly = html.match(/Weekly\s+usage[^0-9]*([0-9.]+)%/i);
    const premium = html.match(/Premium[^0-9]*([0-9]+)\s*\/\s*([0-9]+)/i);
    if (session) windows.session = usageWindow({ usedPercent: numberValue(session[1]) });
    if (weekly) windows.weekly = usageWindow({ usedPercent: numberValue(weekly[1]) });
    if (premium) {
      const used = numberValue(premium[1]);
      const limit = numberValue(premium[2]);
      if (used !== null && limit !== null) windows.premium = usageWindow({ used, limit, unit: "requests" });
    }
    return { usage: { windows } };
  });
};

const createWafer = (runtime: QuotaRuntime): DiscoverableProvider => {
  const key = () => authSecret(runtime, ["wafer", "wafer-ai", "wafer_ai", "wafer.ai"]);
  return createProvider(runtime, "wafer", "Wafer.ai", () => Boolean(key()), async (signal) => {
    const payload = await safeJson(runtime, "Wafer.ai", "https://pass.wafer.ai/v1/inference/quota", {
      method: "GET",
      headers: { Authorization: `Bearer ${key()!}`, "Accept-Encoding": "identity" },
      signal,
    });
    const remaining = numberValue(payload.remaining_included_requests);
    const limit = numberValue(payload.included_request_limit);
    const overage = numberValue(payload.overage_request_count) ?? 0;
    const seconds = (() => {
      const start = timestampValue(payload.window_start);
      const end = timestampValue(payload.window_end);
      return start !== null && end !== null ? Math.round((end - start) / 1000) : 5 * 3600;
    })();
    const usedPercent = numberValue(payload.current_period_used_percent);
    const windows = usedPercent === null && remaining === null && limit === null ? {} : {
      [windowLabel(seconds)]: usageWindow({
        usedPercent: overage > 0 ? Math.max(0, usedPercent ?? 0) : clampPercent(usedPercent ?? 0),
        windowSeconds: seconds,
        resetAt: timestampValue(payload.window_end),
        ...(remaining !== null && limit !== null
          ? { valueLabel: `${remaining} / ${limit} left${overage > 0 ? ` · +${overage} overage` : ""}` }
          : {}),
      }),
    };
    return { usage: { windows } };
  });
};

const periodSeconds = (period: string | null): number | null => {
  if (period === "daily") return 86400;
  if (period === "weekly") return 7 * 86400;
  if (period === "monthly" || period === "month") return 30 * 86400;
  if (period === "yearly" || period === "year") return 365 * 86400;
  return null;
};

const createNeuralWatt = (runtime: QuotaRuntime): DiscoverableProvider => {
  const key = () => authSecret(runtime, ["neuralwatt"]);
  return createProvider(runtime, "neuralwatt", "NeuralWatt", () => Boolean(key()), async (signal) => {
    const payload = await safeJson(runtime, "NeuralWatt", "https://api.neuralwatt.com/v1/quota", {
      method: "GET",
      headers: { Authorization: `Bearer ${key()!}`, "Accept-Encoding": "identity" },
      signal,
    });
    const windows: Record<string, ProviderUsageWindow> = {};
    const subscription = objectValue(payload.subscription);
    if (subscription) {
      const included = numberValue(subscription.kwh_included);
      const used = numberValue(subscription.kwh_used);
      windows[stringValue(subscription.plan) ?? "plan_limit"] = usageWindow({
        usedPercent: subscription.in_overage ? 100 : percentOf(used, included),
        resetAt: timestampValue(subscription.kwh_reset_date) ?? timestampValue(subscription.current_period_end),
      });
    }
    const allowance = objectValue(objectValue(payload.key)?.allowance);
    const credits = numberValue(objectValue(payload.balance)?.credits_remaining_usd);
    if (allowance) {
      const spent = numberValue(allowance.spent_usd) ?? 0;
      const limit = numberValue(allowance.limit_usd);
      const effective = limit !== null && credits !== null ? Math.min(limit, credits + spent) : limit ?? credits;
      const period = stringValue(allowance.period);
      const keyName = period === "daily" || period === "weekly" || period === "monthly"
        ? period
        : period === "month" ? "monthly" : "billing_cycle";
      windows[keyName] = usageWindow({
        usedPercent: allowance.blocked ? 100 : percentOf(spent, effective),
        windowSeconds: periodSeconds(period),
        resetAt: timestampValue(allowance.reset_at),
        ...(stringValue(objectValue(payload.key)?.name) ? { valueLabel: stringValue(objectValue(payload.key)?.name)! } : {}),
      });
    } else if (credits !== null) {
      windows.credits_balance = usageWindow({
        used: 0, limit: credits, unit: "currency", valueLabel: `$${credits.toFixed(2)} available`,
      });
    }
    return { usage: { windows } };
  });
};

const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

/**
 * OpenCode Go metered windows. The Go subscription belongs to one account,
 * and that account can be signed in more than once on a host: OpenCode's own
 * `auth.json` and Pi's agent directory each keep a key. A stale key in one
 * store must not hide a working key in the other, so every discovered login
 * is a candidate and an authentication rejection moves to the next one.
 */
const createOpenCodeGo = (runtime: QuotaRuntime): DiscoverableProvider => {
  // The provider's own client store is the primary login; the same account may
  // also be signed in to Pi, whose agent directory keeps its own key.
  const logins = (): string[] => {
    const primary = authSecret(runtime, ["opencode-go"]);
    const values = [
      ...(primary ? [primary] : []),
      ...providerLogins(runtime, "opencode-go"),
    ];
    return values.filter((value, index) => values.indexOf(value) === index);
  };
  const key = () => logins()[0] ?? null;
  return createProvider(runtime, "opencode-go", "OpenCode Go", () => Boolean(key()), async (signal) => {
    removeLegacyOpenCodeGoCredential(runtime);
    const candidates = logins();
    if (candidates.length === 0) throw new Error("OpenCode Go is not configured");
    let payload: Record<string, unknown> | null = null;
    let rejected = 0;
    for (const candidate of candidates) {
      let response: Response;
      try {
        response = await runtime.fetchImpl(OPENCODE_GO_USAGE_URL, {
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${candidate}`,
            "User-Agent": "Polyth quota provider",
          },
          signal,
        });
      } catch {
        throw new Error("OpenCode Go usage request failed");
      }
      // 401/403 means this particular key is expired or revoked. Another
      // stored login may still be valid, so try it before reporting.
      if (response.status === 401 || response.status === 403) {
        rejected += 1;
        continue;
      }
      if (!response.ok) throw new Error(`OpenCode Go usage API returned HTTP ${response.status}`);
      try {
        payload = objectValue(await response.json()) ?? {};
      } catch {
        throw new Error("OpenCode Go usage API returned invalid JSON");
      }
      break;
    }
    if (!payload) {
      const stores = rejected === 1 ? "the stored login" : `all ${rejected} stored logins`;
      throw new Error(`OpenCode Go rejected ${stores} (expired or revoked). Create a new key in OpenCode Console.`);
    }
    const usage = objectValue(payload.usage);
    const windows: Record<string, ProviderUsageWindow> = {};
    for (const [label, field, seconds, title] of [
      ["5h", "rolling", 5 * 3600, "5h limit"],
      ["weekly", "weekly", 7 * 86400, "Weekly limit"],
      ["monthly", "monthly", 30 * 86400, "Monthly limit"],
    ] as const) {
      const value = objectValue(usage?.[field]);
      const percent = clampPercent(value?.percent);
      const resetAt = timestampValue(value?.resetsAt);
      if (percent !== null && resetAt !== null) {
        windows[label] = usageWindow({
          label: title,
          usedPercent: percent,
          windowSeconds: seconds,
          resetAt,
        });
      }
    }
    return { usage: { windows } };
  });
};

const readCursorAuth = (runtime: QuotaRuntime): {
  accessToken: string | null;
  refreshToken: string | null;
  source: "env" | "file" | "managed";
} => {
  const envAccess = stringValue(runtime.env.CURSOR_TOKEN) ?? stringValue(runtime.env.CURSOR_ACCESS_TOKEN);
  const envRefresh = stringValue(runtime.env.CURSOR_REFRESH_TOKEN);
  if (envAccess || envRefresh) return { accessToken: envAccess, refreshToken: envRefresh, source: "env" };
  const readTokenFile = (path: string | undefined) => {
    if (!path) return null;
    try { return stringValue(runtime.readFile(path)); } catch { return null; }
  };
  const fileAccess = readTokenFile(runtime.env.CURSOR_TOKEN_FILE);
  const fileRefresh = readTokenFile(runtime.env.CURSOR_REFRESH_TOKEN_FILE);
  if (fileAccess || fileRefresh) return { accessToken: fileAccess, refreshToken: fileRefresh, source: "file" };
  const managed = readManagedCredential(runtime, "cursor");
  return {
    accessToken: stringValue(managed?.accessToken),
    refreshToken: stringValue(managed?.refreshToken),
    source: "managed",
  };
};

const jwtExpiry = (token: string): number | null => {
  try {
    const payload = token.split(".")[1];
    return payload ? numberValue(objectValue(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")))?.exp) : null;
  } catch {
    return null;
  }
};

const createCursor = (runtime: QuotaRuntime): DiscoverableProvider => {
  const configured = () => {
    const auth = readCursorAuth(runtime);
    return Boolean(auth.accessToken || auth.refreshToken);
  };
  const access = async (signal: AbortSignal): Promise<string> => {
    const auth = readCursorAuth(runtime);
    const expiry = auth.accessToken ? jwtExpiry(auth.accessToken) : null;
    if (
      auth.accessToken
      && (
        (expiry !== null && expiry * 1000 - runtime.now() > 5 * 60_000)
        || (expiry === null && !auth.refreshToken)
      )
    ) return auth.accessToken;
    if (!auth.refreshToken) {
      if (auth.accessToken) return auth.accessToken;
      throw new Error("Cursor is not configured");
    }
    const payload = await safeJson(runtime, "Cursor", "https://api2.cursor.sh/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB",
        refresh_token: auth.refreshToken,
      }),
      signal,
    }, "Cursor session expired");
    if (payload.shouldLogout === true) throw new Error("Session expired - please sign in to Cursor again");
    const token = stringValue(payload.access_token);
    if (!token) throw new Error("Cursor refresh response did not include an access token");
    if (auth.source === "managed") {
      runtime.writeManagedCredential("cursor", { accessToken: token, refreshToken: auth.refreshToken });
    }
    return token;
  };
  const connect = (
    url: string,
    token: string,
    signal: AbortSignal,
  ) => safeJson(runtime, "Cursor", url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
    },
    body: "{}",
    signal,
  }, "Cursor session expired");
  return createProvider(runtime, "cursor", "Cursor", configured, async (signal) => {
    const token = await access(signal);
    const usageUrl = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
    const planUrl = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo";
    const creditsUrl = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCreditGrantsBalance";
    const usage = await connect(usageUrl, token, signal);
    const [plan, credits]: [Record<string, unknown>, Record<string, unknown>] = await Promise.all([
      connect(planUrl, token, signal).catch((): Record<string, unknown> => ({})),
      connect(creditsUrl, token, signal).catch((): Record<string, unknown> => ({})),
    ]);
    if (usage.enabled === false || !objectValue(usage.planUsage)) throw new Error("No active Cursor subscription");
    const planUsage = objectValue(usage.planUsage) ?? {};
    const spendLimit = objectValue(usage.spendLimitUsage) ?? {};
    const resetAt = timestampValue(usage.billingCycleEnd)
      ?? timestampValue(objectValue(plan.planInfo)?.billingCycleEnd);
    const seconds = resetAt === null ? null : Math.max(0, Math.floor((resetAt - runtime.now()) / 1000));
    const windows: Record<string, ProviderUsageWindow> = {};
    const totalSpend = numberValue(planUsage.totalSpend);
    const planLimit = numberValue(planUsage.limit);
    const remaining = numberValue(planUsage.remaining);
    const explicitPercent = numberValue(planUsage.totalPercentUsed);
    if (totalSpend !== null && planLimit !== null) {
      windows.billing_cycle = usageWindow({
        used: totalSpend / 100,
        limit: planLimit / 100,
        unit: "currency",
        windowSeconds: seconds,
        resetAt,
      });
    } else if (explicitPercent !== null) {
      windows.billing_cycle = usageWindow({ usedPercent: explicitPercent, windowSeconds: seconds, resetAt });
    }
    for (const [label, field] of [["auto", "autoPercentUsed"], ["api", "apiPercentUsed"]] as const) {
      const percent = numberValue(planUsage[field]);
      if (percent !== null) windows[label] = usageWindow({ usedPercent: percent, windowSeconds: seconds, resetAt });
    }
    if (planLimit !== null && remaining !== null) {
      windows.plan_limit = usageWindow({
        used: Math.max(0, planLimit - remaining) / 100,
        limit: planLimit / 100,
        unit: "currency",
        windowSeconds: seconds,
        resetAt,
      });
    }
    const onDemandLimit = numberValue(spendLimit.individualLimit) ?? numberValue(spendLimit.pooledLimit);
    const onDemandRemaining = numberValue(spendLimit.individualRemaining) ?? numberValue(spendLimit.pooledRemaining);
    if (onDemandLimit !== null && onDemandLimit > 0) {
      windows.on_demand = usageWindow({
        used: Math.max(0, onDemandLimit - (onDemandRemaining ?? 0)) / 100,
        limit: onDemandLimit / 100,
        unit: "currency",
        windowSeconds: seconds,
        resetAt,
      });
    }
    const creditBalance = numberValue(credits.balanceCents)
      ?? numberValue(credits.totalBalanceCents)
      ?? numberValue(credits.amountCents);
    if (creditBalance !== null) {
      windows.credits = usageWindow({ used: 0, limit: creditBalance / 100, unit: "currency" });
    }
    const planName = stringValue(objectValue(plan.planInfo)?.planName);
    return { usage: { windows }, ...(planName ? { accountLabel: `Cursor ${planName}` } : {}) };
  });
};

const GOOGLE_PRIMARY = "https://cloudcode-pa.googleapis.com";
interface GoogleSource {
  sourceId: "gemini";
  accessToken: string | null;
  refreshToken: string | null;
  projectId: string | null;
  expires: number | null;
}

const googleSources = (runtime: QuotaRuntime): GoogleSource[] => {
  const sources: GoogleSource[] = [];
  // OpenCode's Gemini CLI companion stores the same device-flow OAuth entry
  // under one of these ids; only OAuth entries carry quota credentials.
  const entry = authEntry(runtime, [
    "google",
    "google.oauth",
    "google-gemini-cli",
    "gemini-cli",
    "opencode-gemini-auth",
    "gemini",
  ]);
  const oauth = objectValue(entry?.oauth) ?? entry;
  if (oauth) {
    const parts = (stringValue(oauth.refresh) ?? "").split("|");
    const accessToken = stringValue(oauth.access) ?? stringValue(oauth.token);
    const refreshToken = stringValue(parts[0]);
    if (accessToken || refreshToken) {
      sources.push({
        sourceId: "gemini",
        accessToken,
        refreshToken,
        projectId: stringValue(oauth.managedProjectId)
          ?? stringValue(oauth.quotaProjectId)
          ?? stringValue(parts[2])
          ?? stringValue(oauth.projectId)
          ?? stringValue(oauth.projectID)
          ?? stringValue(parts[1]),
        expires: timestampValue(oauth.expires),
      });
    }
  }
  return sources;
};

const createGoogle = (runtime: QuotaRuntime): DiscoverableProvider =>
  createProvider(runtime, "google", "Google", () => googleSources(runtime).length > 0, async (signal) => {
    const models: NonNullable<ProviderUsage["models"]> = {};
    for (const source of googleSources(runtime)) {
      let accessToken = source.accessToken;
      if (!accessToken || (source.expires !== null && source.expires <= runtime.now())) {
        if (!source.refreshToken) continue;
        // The token belongs to Gemini CLI's OAuth client; read it from the install.
        const client = runtime.findGoogleClient(source.sourceId);
        if (!client) throw new Error("Google login expired — install Gemini CLI or open OpenCode to refresh it");
        const form = new URLSearchParams({
          client_id: client.id,
          client_secret: client.secret,
          refresh_token: source.refreshToken,
          grant_type: "refresh_token",
        });
        const refreshed = await safeJson(runtime, "Google", "https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form,
          signal,
        });
        accessToken = stringValue(refreshed.access_token);
      }
      if (!accessToken) continue;
      const project = source.projectId ?? "rising-fact-p41fc";
      const body = JSON.stringify({ project });
      if (source.sourceId === "gemini") {
        try {
          const quotas = await safeJson(runtime, "Google", `${GOOGLE_PRIMARY}/v1internal:retrieveUserQuota`, {
            method: "POST", headers: bearer(accessToken), body, signal,
          });
          const buckets = Array.isArray(quotas.buckets) ? quotas.buckets : [];
          for (const raw of buckets) {
            const bucket = objectValue(raw);
            const model = stringValue(bucket?.modelId);
            if (!model) continue;
            const fraction = numberValue(bucket?.remainingFraction);
            models[model.startsWith("gemini/") ? model : `gemini/${model}`] = {
              windows: {
                daily: usageWindow({
                  usedPercent: fraction === null ? null : 100 - Math.round(fraction * 100),
                  windowSeconds: 86400,
                  resetAt: timestampValue(bucket?.resetTime),
                }),
              },
            };
          }
        } catch { /* fetchAvailableModels remains useful */ }
      }
      const endpoints = [
        "https://daily-cloudcode-pa.sandbox.googleapis.com",
        "https://autopush-cloudcode-pa.sandbox.googleapis.com",
        GOOGLE_PRIMARY,
      ];
      let available: Record<string, unknown> | null = null;
      for (const endpoint of endpoints) {
        try {
          available = await safeJson(runtime, "Google", `${endpoint}/v1internal:fetchAvailableModels`, {
            method: "POST",
            headers: {
              ...bearer(accessToken),
              ...antigravityClientHeaders(runtime),
            },
            body,
            signal,
          });
          break;
        } catch { /* try the next provider endpoint */ }
      }
      const availableModels = objectValue(available?.models) ?? {};
      for (const [name, raw] of Object.entries(availableModels)) {
        const model = objectValue(raw);
        const quota = objectValue(model?.quotaInfo);
        const remaining = numberValue(quota?.remainingFraction);
        const resetAt = timestampValue(quota?.resetTime);
        const seconds = source.sourceId === "gemini"
          ? 86400
          : resetAt !== null && (resetAt - runtime.now()) / 1000 <= 10 * 3600 ? 5 * 3600 : 86400;
        models[name.startsWith(`${source.sourceId}/`) ? name : `${source.sourceId}/${name}`] = {
          windows: {
            [seconds === 5 * 3600 ? "5h" : "daily"]: usageWindow({
              usedPercent: remaining === null ? null : 100 - Math.round(remaining * 100),
              windowSeconds: seconds,
              resetAt,
            }),
          },
        };
      }
    }
    return { usage: { windows: {}, models } };
  });

const safeAnyJson = async (
  runtime: QuotaRuntime,
  providerName: string,
  url: string,
  init: RequestInit,
): Promise<unknown> => {
  let response: Response;
  try {
    response = await runtime.fetchImpl(url, init);
  } catch {
    throw new Error(`${providerName} usage request failed`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(`${providerName} authentication failed`);
  }
  if (!response.ok) throw new Error(`${providerName} usage API returned HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error(`${providerName} usage API returned invalid JSON`);
  }
};

const nextUtcMidnight = (now: number): number => {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
};

const createChutes = (runtime: QuotaRuntime): DiscoverableProvider => {
  const key = () => providerKey(runtime, ["chutes"], ["CHUTES_API_KEY"]);
  return createProvider(runtime, "chutes", "Chutes AI", () => Boolean(key()), async (signal) => {
    const payload = await safeJson(runtime, "Chutes AI", "https://api.chutes.ai/users/me/quota_usage/me", {
      method: "GET",
      headers: { Authorization: `Bearer ${key()!}`, "User-Agent": "Polyth quota provider" },
      signal,
    });
    const limit = numberValue(payload.quota);
    const used = numberValue(payload.used);
    const windows: Record<string, ProviderUsageWindow> = {};
    if (limit !== null && limit > 0 && used !== null) {
      windows.quota = usageWindow({
        used,
        limit,
        unit: "requests",
        windowSeconds: 86400,
        resetAt: nextUtcMidnight(runtime.now()),
        valueLabel: `${formatNumber(Math.max(0, limit - used))} / ${formatNumber(limit)} left`,
      });
    }
    return { usage: { windows } };
  });
};

const syntheticAmount = (value: unknown): number | null => {
  if (typeof value !== "string") return null;
  const match = /^\$(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(2, "0") || "0");
  return Number.isFinite(whole) && Number.isFinite(fraction) ? whole + fraction / 100 : null;
};

const createSynthetic = (runtime: QuotaRuntime): DiscoverableProvider => {
  const key = () => providerKey(runtime, ["synthetic"], ["SYNTHETIC_API_KEY"]);
  return createProvider(runtime, "synthetic", "Synthetic", () => Boolean(key()), async (signal) => {
    const payload = await safeJson(runtime, "Synthetic", "https://api.synthetic.new/v2/quotas", {
      method: "GET",
      headers: { Authorization: `Bearer ${key()!}`, "User-Agent": "Polyth quota provider" },
      signal,
    });
    const windows: Record<string, ProviderUsageWindow> = {};
    const rolling = objectValue(payload.rollingFiveHourLimit);
    const max = numberValue(rolling?.max);
    const remaining = numberValue(rolling?.remaining);
    if (max !== null && max > 0 && remaining !== null && remaining >= 0) {
      windows["5h"] = usageWindow({
        used: Math.max(0, max - remaining),
        limit: max,
        unit: "requests",
        windowSeconds: 5 * 3600,
        resetAt: timestampValue(rolling?.nextTickAt),
        valueLabel: `${formatNumber(Math.max(0, remaining))} / ${formatNumber(max)} left`,
      });
    }
    const weekly = objectValue(payload.weeklyTokenLimit);
    const weeklyLimit = syntheticAmount(weekly?.maxCredits);
    const weeklyRemaining = syntheticAmount(weekly?.remainingCredits);
    if (weeklyLimit !== null && weeklyLimit > 0 && weeklyRemaining !== null && weeklyRemaining >= 0) {
      const percent = numberValue(weekly?.percentRemaining);
      windows.weekly = usageWindow({
        used: Math.max(0, weeklyLimit - weeklyRemaining),
        limit: weeklyLimit,
        unit: "currency",
        windowSeconds: 7 * 86400,
        resetAt: timestampValue(weekly?.nextRegenAt),
        ...(percent !== null ? { usedPercent: percent } : {}),
        valueLabel: `$${Math.max(0, weeklyRemaining).toFixed(2)} left`,
      });
    }
    return { usage: { windows } };
  });
};

interface KiloPassState {
  baseCreditsUsd: number;
  bonusCreditsUsd: number;
  usageUsd: number;
  remainingUsd: number;
  resetAt: number | null;
}

/** Parse the tRPC envelope (an array or a bare object) around the pass state. */
const parseKiloPass = (payload: unknown): KiloPassState | null => {
  const item = Array.isArray(payload) ? payload[0] : payload;
  const record = objectValue(item);
  const data = objectValue(objectValue(record?.result)?.data);
  if (!data) return null;
  if ("json" in data && !objectValue(data.json)) return null;
  const root = objectValue(data.json) ?? data;
  if (!root || !("subscription" in root) || root.subscription === null) return null;
  const subscription = objectValue(root.subscription);
  if (!subscription) return null;
  const base = numberValue(subscription.currentPeriodBaseCreditsUsd);
  const usage = numberValue(subscription.currentPeriodUsageUsd);
  const bonus = numberValue(subscription.currentPeriodBonusCreditsUsd) ?? 0;
  if (base === null || base < 0 || usage === null || usage < 0 || bonus < 0) return null;
  const total = base + bonus;
  return {
    baseCreditsUsd: base,
    bonusCreditsUsd: bonus,
    usageUsd: usage,
    remainingUsd: Math.round(Math.max(0, total - usage) * 100) / 100,
    resetAt: timestampValue(subscription.nextBillingAt) ?? timestampValue(subscription.nextRenewalAt),
  };
};

const createKilo = (runtime: QuotaRuntime): DiscoverableProvider => {
  const key = () => providerKey(runtime, ["kilo"], ["KILO_API_KEY"]);
  return createProvider(runtime, "kilo", "Kilo Gateway", () => Boolean(key()), async (signal) => {
    const headers = { Authorization: `Bearer ${key()!}`, Accept: "application/json" };
    const query = new URLSearchParams({ batch: "1", input: JSON.stringify({ "0": null }) });
    const statePayload = await safeAnyJson(
      runtime,
      "Kilo Gateway",
      `https://app.kilo.ai/api/trpc/kiloPass.getState?${query.toString()}`,
      { method: "GET", headers, redirect: "manual", signal },
    );
    const pass = parseKiloPass(statePayload);
    if (pass) {
      const total = pass.baseCreditsUsd + pass.bonusCreditsUsd;
      if (total > 0) {
        return {
          usage: {
            windows: {
              credits: usageWindow({
                used: pass.usageUsd,
                limit: total,
                unit: "currency",
                resetAt: pass.resetAt,
                valueLabel: `$${pass.remainingUsd.toFixed(2)} left`,
              }),
            },
          },
        };
      }
      return {
        usage: {
          windows: {
            remaining_credits: usageWindow({
              used: 0,
              limit: pass.remainingUsd,
              unit: "currency",
              resetAt: pass.resetAt,
              valueLabel: `$${pass.remainingUsd.toFixed(2)} remaining`,
            }),
          },
        },
      };
    }
    // No active Kilo Pass: only the gateway balance is real, never an invented quota.
    const balancePayload = await safeJson(runtime, "Kilo Gateway", "https://api.kilo.ai/api/profile/balance", {
      method: "GET", headers, signal,
    });
    const balance = numberValue(balancePayload.balance);
    const windows: Record<string, ProviderUsageWindow> = {};
    if (balance !== null && balance >= 0) {
      windows.balance = usageWindow({
        used: 0,
        limit: balance,
        unit: "currency",
        valueLabel: `$${balance.toFixed(2)} available`,
      });
    }
    return { usage: { windows } };
  });
};

const mimoTimeZone = (): string => {
  const offset = -new Date().getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const minutes = Math.abs(offset);
  return `UTC${sign}${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
};

const createMimo = (runtime: QuotaRuntime): DiscoverableProvider => {
  let rejected = false;
  const cookie = () => {
    const raw = stringValue(runtime.env.MIMO_USAGE_COOKIE)
      ?? stringValue(readManagedCredential(runtime, "mimo")?.cookie);
    return raw ? raw.replace(/^cookie:\s*/i, "") : null;
  };
  const request = async (path: string, signal: AbortSignal): Promise<Record<string, unknown> | null> => {
    const value = cookie();
    if (!value) return null;
    try {
      const payload = await safeAnyJson(
        runtime,
        "Xiaomi MiMo",
        `https://platform.xiaomimimo.com${path}`,
        {
          method: "GET",
          redirect: "manual",
          headers: {
            Accept: "application/json, text/plain, */*",
            Cookie: value,
            Origin: "https://platform.xiaomimimo.com",
            Referer: "https://platform.xiaomimimo.com/#/console/balance",
            "User-Agent": "Mozilla/5.0 (Polyth quota provider)",
            "x-timeZone": mimoTimeZone(),
          },
          signal,
        },
      );
      const envelope = objectValue(payload);
      if (!envelope || envelope.code !== 0) return null;
      return objectValue(envelope.data);
    } catch (error) {
      if (error instanceof Error && /authentication failed/.test(error.message)) rejected = true;
      return null;
    }
  };
  return createProvider(runtime, "xiaomi", "Xiaomi MiMo", () => Boolean(cookie()), async (signal) => {
    rejected = false;
    const [usage, detail, balance] = await Promise.all([
      request("/api/v1/tokenPlan/usage", signal),
      request("/api/v1/tokenPlan/detail", signal),
      request("/api/v1/balance", signal),
    ]);
    const windows: Record<string, ProviderUsageWindow> = {};
    const expired = detail?.expired === true;
    const monthUsage = objectValue(usage?.monthUsage);
    const items = Array.isArray(monthUsage?.items) ? monthUsage.items : [];
    const monthly = items
      .map(objectValue)
      .find((item) => item?.name === "month_total_token");
    const used = numberValue(monthly?.used);
    const limit = numberValue(monthly?.limit);
    if (!expired && used !== null && limit !== null && limit > 0) {
      windows.monthly = usageWindow({
        used,
        limit,
        unit: "tokens",
        windowSeconds: 30 * 86400,
        valueLabel: `${formatNumber(Math.max(0, limit - used))} tokens left`,
      });
    }
    const amount = numberValue(balance?.balance);
    if (amount !== null && amount >= 0) {
      const currency = stringValue(balance?.currency);
      windows.balance = usageWindow({
        used: 0,
        limit: amount,
        unit: currency ? "currency" : "requests",
        valueLabel: currency ? `${currency} ${amount.toFixed(2)} available` : `${formatNumber(amount)} credits available`,
      });
    }
    const planName = stringValue(detail?.planName);
    if (Object.keys(windows).length === 0 && rejected) {
      throw new Error("Xiaomi MiMo authentication failed");
    }
    return {
      usage: { windows },
      ...(planName ? { accountLabel: `Xiaomi MiMo · ${planName}` } : {}),
    };
  });
};

export const createStandardProviders = (runtime: QuotaRuntime): DiscoverableProvider[] => [
  createCodex(runtime),
  createCommandCode(runtime),
  createCursor(runtime),
  createCrof(runtime),
  createChutes(runtime),
  createDeepSeek(runtime),
  createGoogle(runtime),
  createCopilot(runtime),
  createKilo(runtime),
  createKimiCn(runtime),
  createKimiGlobal(runtime),
  createMimo(runtime),
  createNanoGpt(runtime),
  createOpenRouter(runtime),
  createSynthetic(runtime),
  createZai(runtime, false),
  createZai(runtime, true),
  createMiniMax(runtime, false),
  createMiniMax(runtime, true),
  createOllamaCloud(runtime),
  createWafer(runtime),
  createOpenCodeGo(runtime),
  createNeuralWatt(runtime),
];
