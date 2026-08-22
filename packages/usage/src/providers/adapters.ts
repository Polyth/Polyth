import type { QuotaSnapshot } from "@polyth/contracts";
import type { QuotaProvider } from "../index.ts";
import {
  getAuthEntry,
  numberValue,
  objectValue,
  readJson,
  readManagedCredential,
  removeLegacyOpenCodeGoCredential,
  stringValue,
  timestampValue,
  type QuotaRuntime,
} from "../opencodeAuth.ts";
import { mappolythUsage, ocWindow, type polythUsage, type polythWindow } from "../ocWindows.ts";

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
    return days === 7 ? "weekly" : `${days}d`;
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

const safeJson = async (
  runtime: QuotaRuntime,
  providerName: string,
  url: string,
  init: RequestInit,
  authMessage?: string,
): Promise<Record<string, unknown>> => {
  let response: Response;
  try {
    response = await runtime.fetchImpl(url, init);
  } catch {
    throw new Error(`${providerName} usage request failed`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(authMessage ?? `${providerName} authentication failed`);
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
  fetchUsage: (signal: AbortSignal) => Promise<{ usage: polythUsage; accountLabel?: string }>,
): DiscoverableProvider => ({
  id,
  isConfigured,
  async fetch(signal): Promise<QuotaSnapshot> {
    if (!isConfigured()) throw new Error(`${name} is not configured`);
    const result = await fetchUsage(signal);
    const windows = mappolythUsage(result.usage);
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

const createCodex = (runtime: QuotaRuntime): DiscoverableProvider => {
  const aliases = ["openai", "codex", "chatgpt"];
  const token = () => authSecret(runtime, aliases, ["access", "token"]);
  return createProvider(runtime, "codex", "Codex", () => Boolean(token()), async (signal) => {
    const entry = authEntry(runtime, aliases);
    const accessToken = stringValue(entry?.access) ?? stringValue(entry?.token)!;
    const accountId = stringValue(entry?.accountId);
    const payload = await safeJson(runtime, "Codex", "https://chatgpt.com/backend-api/wham/usage", {
      method: "GET",
      headers: {
        ...bearer(accessToken),
        ...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
      },
      signal,
    }, "Codex session expired — please re-authenticate with OpenAI");
    const windows: Record<string, polythWindow> = {};
    const rateLimit = objectValue(payload.rate_limit);
    for (const raw of [rateLimit?.primary_window, rateLimit?.secondary_window]) {
      const window = objectValue(raw);
      if (!window) continue;
      const seconds = numberValue(window.limit_window_seconds);
      windows[windowLabel(seconds)] = ocWindow({
        usedPercent: numberValue(window.used_percent),
        windowSeconds: seconds,
        resetAt: timestampValue(window.reset_at),
      });
    }
    const credits = objectValue(payload.credits);
    const balance = numberValue(credits?.balance);
    if (credits?.unlimited === true) {
      windows.credits_balance = ocWindow({ valueLabel: "Unlimited" });
    } else if (balance !== null) {
      windows.credits_balance = ocWindow({
        used: 0, limit: balance, unit: "currency", valueLabel: `$${balance.toFixed(2)} available`,
      });
    }
    const spendLimit = objectValue(objectValue(payload.spend_control)?.individual_limit);
    const spent = numberValue(spendLimit?.used);
    const limit = numberValue(spendLimit?.limit);
    if (spent !== null && limit !== null) {
      windows.credits = ocWindow({ used: spent, limit, unit: "currency" });
    }
    return { usage: { windows } };
  });
};

const createOpenRouter = (runtime: QuotaRuntime): DiscoverableProvider => {
  const key = () => authSecret(runtime, ["openrouter"]);
  return createProvider(runtime, "openrouter", "OpenRouter", () => Boolean(key()), async (signal) => {
    const payload = await safeJson(runtime, "OpenRouter", "https://openrouter.ai/api/v1/credits", {
      method: "GET", headers: bearer(key()!), signal,
    });
    const data = objectValue(payload.data);
    const limit = numberValue(data?.total_credits);
    const used = numberValue(data?.total_usage);
    const windows: Record<string, polythWindow> = {};
    if (used !== null && limit !== null) {
      windows.credits = ocWindow({
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
    const windows: Record<string, polythWindow> = {};
    const credits = objectValue(payload.credits);
    for (const [label, field] of [
      ["monthly_credits", "monthlyCredits"],
      ["purchased_credits", "purchasedCredits"],
      ["free_credits", "freeCredits"],
    ] as const) {
      const available = numberValue(credits?.[field]);
      if (available !== null) windows[label] = ocWindow({ used: 0, limit: available, unit: "requests" });
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
      windows[label] = ocWindow({
        usedPercent: percentOf(used, limit),
        windowSeconds: seconds,
        resetAt: timestampValue(value?.resetAt),
        valueLabel: `${formatNumber(used)} / ${formatNumber(limit)}`,
      });
    }
    return { usage: { windows } };
  });
};

const createCopilot = (
  runtime: QuotaRuntime,
  addon: boolean,
): DiscoverableProvider => {
  const token = () => authSecret(runtime, ["github-copilot", "copilot"], ["access", "token"]);
  const id = addon ? "github-copilot-addon" : "github-copilot";
  const name = addon ? "GitHub Copilot Add-on" : "GitHub Copilot";
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
    const windows: Record<string, polythWindow> = {};
    for (const [label, field] of [
      ["chat", "chat"], ["completions", "completions"], ["premium", "premium_interactions"],
    ] as const) {
      if (addon && label !== "premium") continue;
      const value = objectValue(snapshots?.[field]);
      const entitlement = numberValue(value?.entitlement);
      const remaining = numberValue(value?.remaining);
      if (entitlement === null || remaining === null) continue;
      windows[label] = ocWindow({
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
    const windows: Record<string, polythWindow> = {};
    if (balance) {
      windows.credits_balance = ocWindow({
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

const createKimi = (runtime: QuotaRuntime): DiscoverableProvider => {
  const key = () => authSecret(runtime, ["kimi-for-coding", "kimi"]);
  return createProvider(runtime, "kimi-for-coding", "Kimi for Coding", () => Boolean(key()), async (signal) => {
    const payload = await safeJson(runtime, "Kimi for Coding", "https://api.kimi.com/coding/v1/usages", {
      method: "GET", headers: bearer(key()!), signal,
    });
    const windows: Record<string, polythWindow> = {};
    const usage = objectValue(payload.usage);
    if (usage) {
      const limit = numberValue(usage.limit);
      const used = numberValue(usage.used);
      const remaining = numberValue(usage.remaining);
      windows.weekly = ocWindow({
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
      windows[label] = ocWindow({
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

const createNanoGpt = (runtime: QuotaRuntime): DiscoverableProvider => {
  const key = () => authSecret(runtime, ["nano-gpt", "nanogpt", "nano_gpt"]);
  return createProvider(runtime, "nano-gpt", "NanoGPT", () => Boolean(key()), async (signal) => {
    const payload = await safeJson(runtime, "NanoGPT", "https://nano-gpt.com/api/subscription/v1/usage", {
      method: "GET", headers: bearer(key()!), signal,
    });
    const windows: Record<string, polythWindow> = {};
    const period = objectValue(payload.period);
    for (const [label, seconds] of [["daily", 86400], ["monthly", null]] as const) {
      const value = objectValue(payload[label]);
      if (!value) continue;
      const fraction = numberValue(value.percentUsed);
      const used = numberValue(value.used);
      const limit = numberValue(value.limit) ?? numberValue(objectValue(value.limits)?.[label]);
      windows[label] = ocWindow({
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
    const windows: Record<string, polythWindow> = {};
    for (const raw of limits) {
      const limit = objectValue(raw);
      if (!limit) continue;
      if (limit.type === "TOKENS_LIMIT") {
        const seconds = zaiWindowSeconds(limit);
        const label = china ? "Tokens" : windowLabel(seconds);
        windows[label] = ocWindow({
          usedPercent: numberValue(limit.percentage),
          windowSeconds: seconds,
          resetAt: timestampValue(limit.nextResetTime),
        });
      } else if (limit.type === "TIME_LIMIT") {
        windows["MCP Tools"] = ocWindow({
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
): Record<string, polythWindow> => {
  const windows: Record<string, polythWindow> = {};
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
    windows[weekly ? "weekly" : "5h"] = ocWindow({ usedPercent, windowSeconds: seconds, resetAt });
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
        headers: { Cookie: credential()!.cookie, "User-Agent": "polyth quota provider" },
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
    const windows: Record<string, polythWindow> = {};
    const session = html.match(/Session\s+usage[^0-9]*([0-9.]+)%/i);
    const weekly = html.match(/Weekly\s+usage[^0-9]*([0-9.]+)%/i);
    const premium = html.match(/Premium[^0-9]*([0-9]+)\s*\/\s*([0-9]+)/i);
    if (session) windows.session = ocWindow({ usedPercent: numberValue(session[1]) });
    if (weekly) windows.weekly = ocWindow({ usedPercent: numberValue(weekly[1]) });
    if (premium) {
      const used = numberValue(premium[1]);
      const limit = numberValue(premium[2]);
      if (used !== null && limit !== null) windows.premium = ocWindow({ used, limit, unit: "requests" });
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
      [windowLabel(seconds)]: ocWindow({
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
    const windows: Record<string, polythWindow> = {};
    const subscription = objectValue(payload.subscription);
    if (subscription) {
      const included = numberValue(subscription.kwh_included);
      const used = numberValue(subscription.kwh_used);
      windows[stringValue(subscription.plan) ?? "plan_limit"] = ocWindow({
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
      windows[keyName] = ocWindow({
        usedPercent: allowance.blocked ? 100 : percentOf(spent, effective),
        windowSeconds: periodSeconds(period),
        resetAt: timestampValue(allowance.reset_at),
        ...(stringValue(objectValue(payload.key)?.name) ? { valueLabel: stringValue(objectValue(payload.key)?.name)! } : {}),
      });
    } else if (credits !== null) {
      windows.credits_balance = ocWindow({
        used: 0, limit: credits, unit: "currency", valueLabel: `$${credits.toFixed(2)} available`,
      });
    }
    return { usage: { windows } };
  });
};

const createOpenCodeGo = (runtime: QuotaRuntime): DiscoverableProvider => {
  const key = () => authSecret(runtime, ["opencode-go"]);
  return createProvider(runtime, "opencode-go", "OpenCode Go", () => Boolean(key()), async (signal) => {
    removeLegacyOpenCodeGoCredential(runtime);
    const payload = await safeJson(runtime, "OpenCode Go", "https://opencode.ai/zen/go/v1/usage", {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${key()!}`,
        "User-Agent": "polyth quota provider",
      },
      signal,
    });
    const usage = objectValue(payload.usage);
    const windows: Record<string, polythWindow> = {};
    for (const [label, field] of [["5h", "rolling"], ["weekly", "weekly"], ["monthly", "monthly"]] as const) {
      const value = objectValue(usage?.[field]);
      const percent = clampPercent(value?.percent);
      const resetAt = timestampValue(value?.resetsAt);
      if (percent !== null && resetAt !== null) windows[label] = ocWindow({ usedPercent: percent, resetAt });
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
    const windows: Record<string, polythWindow> = {};
    const totalSpend = numberValue(planUsage.totalSpend);
    const planLimit = numberValue(planUsage.limit);
    const remaining = numberValue(planUsage.remaining);
    const explicitPercent = numberValue(planUsage.totalPercentUsed);
    if (totalSpend !== null && planLimit !== null) {
      windows.billing_cycle = ocWindow({
        used: totalSpend / 100,
        limit: planLimit / 100,
        unit: "currency",
        windowSeconds: seconds,
        resetAt,
      });
    } else if (explicitPercent !== null) {
      windows.billing_cycle = ocWindow({ usedPercent: explicitPercent, windowSeconds: seconds, resetAt });
    }
    for (const [label, field] of [["auto", "autoPercentUsed"], ["api", "apiPercentUsed"]] as const) {
      const percent = numberValue(planUsage[field]);
      if (percent !== null) windows[label] = ocWindow({ usedPercent: percent, windowSeconds: seconds, resetAt });
    }
    if (planLimit !== null && remaining !== null) {
      windows.plan_limit = ocWindow({
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
      windows.on_demand = ocWindow({
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
      windows.credits = ocWindow({ used: 0, limit: creditBalance / 100, unit: "currency" });
    }
    const planName = stringValue(objectValue(plan.planInfo)?.planName);
    return { usage: { windows }, ...(planName ? { accountLabel: `Cursor ${planName}` } : {}) };
  });
};

const GOOGLE_PRIMARY = "https://cloudcode-pa.googleapis.com";
const GOOGLE_CLIENTS = {
  gemini: {
    id: "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com",
    secret: "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",
  },
  antigravity: {
    id: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
    secret: "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",
  },
} as const;

interface GoogleSource {
  sourceId: "gemini" | "antigravity";
  accessToken: string | null;
  refreshToken: string | null;
  projectId: string | null;
  expires: number | null;
}

const googleSources = (runtime: QuotaRuntime): GoogleSource[] => {
  const sources: GoogleSource[] = [];
  const entry = authEntry(runtime, ["google", "google.oauth"]);
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
        projectId: stringValue(parts[1]) ?? stringValue(parts[2]),
        expires: timestampValue(oauth.expires),
      });
    }
  }
  for (const path of runtime.paths.antigravityAccountsFiles) {
    const file = readJson(runtime, path);
    const accounts = Array.isArray(file?.accounts) ? file.accounts : [];
    const index = numberValue(file?.activeIndex) ?? 0;
    const account = objectValue(accounts[index] ?? accounts[0]);
    const refresh = stringValue(account?.refreshToken);
    if (!refresh) continue;
    const parts = refresh.split("|");
    sources.push({
      sourceId: "antigravity",
      accessToken: null,
      refreshToken: stringValue(parts[0]),
      projectId: stringValue(account?.projectId)
        ?? stringValue(account?.managedProjectId)
        ?? stringValue(parts[1])
        ?? stringValue(parts[2]),
      expires: null,
    });
    break;
  }
  return sources;
};

const createGoogle = (runtime: QuotaRuntime): DiscoverableProvider =>
  createProvider(runtime, "google", "Google", () => googleSources(runtime).length > 0, async (signal) => {
    const models: NonNullable<polythUsage["models"]> = {};
    for (const source of googleSources(runtime)) {
      let accessToken = source.accessToken;
      if (!accessToken || (source.expires !== null && source.expires <= runtime.now())) {
        if (!source.refreshToken) continue;
        const client = GOOGLE_CLIENTS[source.sourceId];
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
                daily: ocWindow({
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
              "User-Agent": "antigravity/1.11.5 windows/amd64",
              "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
              "Client-Metadata": "{\"ideType\":\"IDE_UNSPECIFIED\",\"platform\":\"PLATFORM_UNSPECIFIED\",\"pluginType\":\"GEMINI\"}",
            },
            body,
            signal,
          });
          break;
        } catch { /* try the next polyth endpoint */ }
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
            [seconds === 5 * 3600 ? "5h" : "daily"]: ocWindow({
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

export const createStandardProviders = (runtime: QuotaRuntime): DiscoverableProvider[] => [
  createCodex(runtime),
  createCommandCode(runtime),
  createCursor(runtime),
  createCrof(runtime),
  createDeepSeek(runtime),
  createGoogle(runtime),
  createCopilot(runtime, false),
  createCopilot(runtime, true),
  createKimi(runtime),
  createNanoGpt(runtime),
  createOpenRouter(runtime),
  createZai(runtime, false),
  createZai(runtime, true),
  createMiniMax(runtime, false),
  createMiniMax(runtime, true),
  createOllamaCloud(runtime),
  createWafer(runtime),
  createOpenCodeGo(runtime),
  createNeuralWatt(runtime),
];
