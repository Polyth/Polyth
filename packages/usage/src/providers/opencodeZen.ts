import type { QuotaSnapshot } from "@polyth/contracts";
import type { QuotaProvider } from "../index.ts";
import {
  getAuthEntry,
  numberValue,
  objectValue,
  stringValue,
  type QuotaRuntime,
} from "../opencodeAuth.ts";
import { mapProviderUsage, usageWindow, type ProviderUsage, type ProviderUsageWindow } from "../ocWindows.ts";

/**
 * OpenCode Zen uses the OpenCode Console sign-in stored under the `opencode`
 * auth entry (device flow, not the provider API key). The Console is an
 * unofficial surface, so every route below is defensive: balance is required,
 * everything else is optional and only hides the rows that depend on it.
 *
 * Amounts are micro-cents: one US dollar is 100,000,000 billing units.
 */
const DEFAULT_CONSOLE_URL = "https://opencode.ai/console";
const CONSOLE_CLIENT_ID = "opencode-cli";
const BILLING_UNITS_PER_DOLLAR = 100_000_000;
const CONSOLE_TIMEOUT_MS = 10_000;
const SESSION_ERROR =
  "OpenCode Console sign-in expired or invalid. Sign in again with `opencode auth login opencode`.";

type ProviderUsageWindowWithValue = ProviderUsageWindow;

interface ConsoleCredential {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  accountId: string | null;
  orgId: string | null;
  orgName: string | null;
  email: string | null;
  server: string;
}

type RouteResult<T> = { ok: true; value: T } | { ok: false; error: string };

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const consoleUrl = (raw: string | null): string => {
  const url = (raw ?? DEFAULT_CONSOLE_URL).trim().replace(/\/+$/, "");
  return url.replace(/^https:\/\/console\.opencode\.ai(?=\/|$)/, DEFAULT_CONSOLE_URL);
};

const readCredential = (runtime: QuotaRuntime): ConsoleCredential | null => {
  const entry = getAuthEntry(runtime.readAuth(), ["opencode"]);
  if (!entry || entry.type !== "oauth") return null;
  const accessToken = stringValue(entry.access) ?? stringValue(entry.token);
  if (!accessToken) return null;
  const metadata = objectValue(entry.metadata) ?? {};
  return {
    accessToken,
    refreshToken: stringValue(entry.refresh),
    expiresAt: numberValue(entry.expires),
    accountId: stringValue(metadata.accountID) ?? stringValue(entry.accountId),
    orgId: stringValue(metadata.orgID) ?? stringValue(entry.orgId),
    orgName: stringValue(metadata.orgName),
    email: stringValue(metadata.email),
    server: consoleUrl(stringValue(metadata.server)),
  };
};

/** Persist a refreshed Console token in the same store it was read from. */
const writeCredential = (runtime: QuotaRuntime, credential: ConsoleCredential): void => {
  try {
    const auth = runtime.readAuth();
    const raw = auth.opencode;
    if (!objectValue(raw)) return;
    const entry = { ...raw as Record<string, unknown> };
    entry.access = credential.accessToken;
    if (credential.refreshToken) entry.refresh = credential.refreshToken;
    if (credential.expiresAt !== null) entry.expires = credential.expiresAt;
    const metadata = { ...(objectValue(entry.metadata) ?? {}) };
    if (credential.accountId) metadata.accountID = credential.accountId;
    if (credential.orgId) metadata.orgID = credential.orgId;
    if (credential.orgName) metadata.orgName = credential.orgName;
    if (credential.email) metadata.email = credential.email;
    metadata.server = credential.server;
    entry.metadata = metadata;
    runtime.writeAuth({ ...auth, opencode: entry });
  } catch {
    // A read-only auth store must not turn a usable quota read into a failure.
  }
};

/** Refresh an expired Console access token with the documented device token endpoint. */
const refreshCredential = async (
  runtime: QuotaRuntime,
  credential: ConsoleCredential,
  signal: AbortSignal,
): Promise<ConsoleCredential> => {
  if (!credential.refreshToken) throw new Error(SESSION_ERROR);
  let response: Response;
  try {
    response = await runtime.fetchImpl(`${credential.server}/auth/device/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: credential.refreshToken,
        client_id: CONSOLE_CLIENT_ID,
      }),
      signal,
    });
  } catch {
    throw new Error("OpenCode Console token refresh failed");
  }
  if (response.status === 400 || response.status === 401 || response.status === 403) {
    throw new Error(SESSION_ERROR);
  }
  if (!response.ok) throw new Error(`OpenCode Console token refresh returned HTTP ${response.status}`);
  let payload: Record<string, unknown> | null = null;
  try {
    payload = objectValue(await response.json());
  } catch {
    payload = null;
  }
  const accessToken = stringValue(payload?.access_token);
  if (!payload || !accessToken) throw new Error("OpenCode Console token refresh returned no access token");
  const refreshToken = stringValue(payload.refresh_token) ?? credential.refreshToken;
  const expiresIn = numberValue(payload.expires_in);
  const orgId = stringValue(payload.org_id) ?? credential.orgId;
  const next: ConsoleCredential = {
    ...credential,
    accessToken,
    refreshToken,
    expiresAt: expiresIn !== null ? runtime.now() + expiresIn * 1000 : credential.expiresAt,
    orgId,
  };
  writeCredential(runtime, next);
  return next;
};

const resolveCredential = async (
  runtime: QuotaRuntime,
  signal: AbortSignal,
): Promise<ConsoleCredential> => {
  const credential = readCredential(runtime);
  if (!credential) {
    throw new Error("No OpenCode Console sign-in found. Sign in with `opencode auth login opencode`.");
  }
  if (credential.expiresAt === null || credential.expiresAt > runtime.now() + 60_000) {
    return credential;
  }
  return refreshCredential(runtime, credential, signal);
};

const headersFor = (credential: ConsoleCredential): Record<string, string> => ({
  Authorization: `Bearer ${credential.accessToken}`,
  Accept: "application/json",
  ...(credential.orgId ? { "x-org-id": credential.orgId } : {}),
});

const consoleGet = async <T>(
  runtime: QuotaRuntime,
  credential: ConsoleCredential,
  route: string,
  parse: (json: unknown) => T,
  signal: AbortSignal,
): Promise<RouteResult<T>> => {
  let response: Response;
  try {
    response = await runtime.fetchImpl(`${credential.server}/api/${route}`, {
      method: "GET",
      headers: headersFor(credential),
      redirect: "manual",
      signal: AbortSignal.any([signal, AbortSignal.timeout(CONSOLE_TIMEOUT_MS)]),
    });
  } catch {
    return { ok: false, error: `OpenCode Console ${route} request failed` };
  }
  // A redirect or 401 means the whole Console session is gone; a 403 is
  // route-specific, so optional routes can still fall back.
  if ((response.status >= 300 && response.status < 400) || response.status === 401) {
    return { ok: false, error: SESSION_ERROR };
  }
  if (!response.ok) return { ok: false, error: `OpenCode Console ${route} error ${response.status}` };
  if (response.headers.get("content-type")?.includes("text/html")) {
    return { ok: false, error: SESSION_ERROR };
  }
  try {
    const text = await response.text();
    return { ok: true, value: parse(text.trim() ? JSON.parse(text) : null) };
  } catch {
    return { ok: false, error: `Could not parse OpenCode Console ${route} response` };
  }
};

const invalidConsoleResponse = (): never => {
  throw new Error("Unexpected OpenCode Console response");
};

const parseMicroCents = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const parseDollars = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return invalidConsoleResponse();
};

const parseBalance = (json: unknown): number => {
  const balance = parseMicroCents(asRecord(json)?.balanceMicroCents);
  if (balance === null) return invalidConsoleResponse();
  return Math.max(0, balance);
};

const parseCreditLimit = (json: unknown): number | null => {
  const value = asRecord(json)?.creditLimitMicroCents;
  if (value === null || value === undefined) return null;
  const limit = parseMicroCents(value);
  if (limit === null) return invalidConsoleResponse();
  return limit / BILLING_UNITS_PER_DOLLAR;
};

const parseMonthlyUsage = (json: unknown, now: number): number => {
  if (!Array.isArray(json)) return invalidConsoleResponse();
  const date = new Date(now);
  const month = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  let total = 0;
  for (const item of json) {
    const day = asRecord(item);
    const cost = parseMicroCents(day?.totalCostMicroCents);
    if (typeof day?.date !== "string" || cost === null) return invalidConsoleResponse();
    if (day.date.slice(0, 7) === month) total += cost;
  }
  return total;
};

const nextUtcMonthStart = (now: number): number => {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
};

const MAX_BUDGET_DOLLARS = 90_000_000;

const parseBudgetDollars = (value: unknown): number | null => {
  if (value === undefined || value === null) return null;
  const dollars = parseDollars(value);
  if (dollars === null) return null;
  if (dollars < 0 || dollars > MAX_BUDGET_DOLLARS) return invalidConsoleResponse();
  return dollars;
};

/**
 * A budget rule selects only when its policy and rule agree on a monthly
 * budget, the selector does not narrow models, and both amounts are usable.
 * One unevaluable candidate makes the whole selection untrustworthy, because
 * it could be the binding cap, so no member budget is returned then.
 */
const ruleSelectorUnfiltered = (selector: unknown): boolean => {
  if (selector === undefined) return true;
  const spec = asRecord(selector);
  if (!spec) return false;
  const known = new Set(["models", "vendors", "inputPriceAtLeast", "includeUnknownPrice"]);
  if (Object.keys(spec).some((key) => !known.has(key))) return false;
  for (const key of ["models", "vendors"] as const) {
    const filter = spec[key];
    if (filter === undefined) continue;
    if (!Array.isArray(filter) || filter.some((entry) => typeof entry !== "string")) return false;
    if (filter.length > 0) return false;
  }
  if (spec.inputPriceAtLeast !== undefined) return false;
  if (spec.includeUnknownPrice !== undefined && typeof spec.includeUnknownPrice !== "boolean") {
    return false;
  }
  return true;
};

const parseMemberBudgets = (
  json: unknown,
  accountId: string,
): { limitMicroCents: number | null; spentMicroCents: number | null; budgetCount: number } => {
  const member = asRecord(json);
  if (!member || member.userID !== accountId) return invalidConsoleResponse();
  if (!Array.isArray(member.budgets) || !Array.isArray(member.policies)) {
    return invalidConsoleResponse();
  }
  let selected: { limit: number; spent: number } | null = null;
  let skipped = false;
  let budgetCount = 0;
  for (const item of member.budgets) {
    const budget = asRecord(item);
    if (!budget) return invalidConsoleResponse();
    const policyId = budget.policyID;
    const ruleId = budget.ruleID;
    if (typeof policyId !== "string" || typeof ruleId !== "string") return invalidConsoleResponse();
    if (budget.scope !== "each" && budget.scope !== "combined") return invalidConsoleResponse();
    const per = budget.per ?? "set";
    if (per !== "set" && per !== "model") return invalidConsoleResponse();
    budgetCount += 1;

    const limitDollars = parseBudgetDollars(budget.limitDollars);
    const spentDollars = parseBudgetDollars(budget.spentDollars);
    if (limitDollars === null || spentDollars === null) {
      skipped = true;
      continue;
    }
    const policy = member.policies.map(asRecord).find((value) => value?.id === policyId);
    const rule = policy && Array.isArray(policy.rules)
      ? policy.rules.map(asRecord).find((value) => value?.id === ruleId)
      : undefined;
    if (
      !rule
      || rule.kind !== "budget"
      || rule.period !== "month"
      || rule.scope !== budget.scope
      || (rule.per ?? "set") !== per
      || !ruleSelectorUnfiltered(rule.selector)
      || (per === "model" && limitDollars !== 0)
    ) {
      skipped = true;
      continue;
    }
    const candidate = { limit: limitDollars, spent: spentDollars };
    if (selected === null || candidate.limit - candidate.spent < selected.limit - selected.spent) {
      selected = candidate;
    }
  }
  if (skipped) selected = null;
  return {
    limitMicroCents: selected === null ? null : Math.round(selected.limit * BILLING_UNITS_PER_DOLLAR),
    spentMicroCents: selected === null ? null : Math.round(selected.spent * BILLING_UNITS_PER_DOLLAR),
    budgetCount,
  };
};

const memberBudgetRoute = (
  runtime: QuotaRuntime,
  credential: ConsoleCredential,
  signal: AbortSignal,
): Promise<RouteResult<{ limitMicroCents: number | null; spentMicroCents: number | null; budgetCount: number }>> => {
  if (!credential.accountId) {
    return Promise.resolve({
      ok: false,
      error: "OpenCode Console member budgets unavailable: the sign-in has no account id",
    });
  }
  return consoleGet(
    runtime,
    credential,
    `policies/members/${encodeURIComponent(credential.accountId)}`,
    (json) => parseMemberBudgets(json, credential.accountId!),
    signal,
  );
};

const formatUsd = (value: number): string => `$${value.toFixed(2)}`;

interface ZenBilling {
  balance: number;
  monthlyLimit: number | null;
  monthlyUsage: number | null;
  budgetResetAt: number | null;
  errors: string[];
}

const fetchBilling = async (
  runtime: QuotaRuntime,
  credential: ConsoleCredential,
  signal: AbortSignal,
): Promise<ZenBilling> => {
  const [balance, creditLimit, member, monthlyUsage] = await Promise.all([
    consoleGet(runtime, credential, "billing/status", parseBalance, signal),
    consoleGet(runtime, credential, "billing/account", parseCreditLimit, signal),
    memberBudgetRoute(runtime, credential, signal),
    consoleGet(runtime, credential, "usage/cost-by-day", (json) => parseMonthlyUsage(json, runtime.now()), signal),
  ]);

  const optional = [creditLimit, member, monthlyUsage];
  if ([balance, ...optional].some((result) => !result.ok && result.error === SESSION_ERROR)) {
    throw new Error(SESSION_ERROR);
  }
  if (!balance.ok) throw new Error(balance.error);

  let monthlyLimit = creditLimit.ok ? creditLimit.value : null;
  let usage = monthlyUsage.ok ? monthlyUsage.value : null;
  let budgetResetAt: number | null = null;
  if (member.ok && member.value.limitMicroCents !== null && member.value.spentMicroCents !== null) {
    monthlyLimit = member.value.limitMicroCents / BILLING_UNITS_PER_DOLLAR;
    usage = member.value.spentMicroCents;
    budgetResetAt = nextUtcMonthStart(runtime.now());
  }

  return {
    balance: balance.value / BILLING_UNITS_PER_DOLLAR,
    monthlyLimit,
    monthlyUsage: usage,
    budgetResetAt,
    errors: optional.flatMap((result) => (result.ok ? [] : [result.error])),
  };
};

/** Map Zen billing into the shared window shape. */
export const createOpenCodeZenProvider = (runtime: QuotaRuntime): QuotaProvider & { isConfigured(): boolean } => {
  const isConfigured = () => readCredential(runtime) !== null;
  return {
    id: "opencode-zen",
    isConfigured,
    async fetch(signal): Promise<QuotaSnapshot> {
      if (!isConfigured()) throw new Error("OpenCode Zen is not configured");
      const credential = await resolveCredential(runtime, signal);
      const billing = await fetchBilling(runtime, credential, signal);
      const windows: Record<string, ProviderUsageWindowWithValue> = {};
      const usage = billing.monthlyUsage === null
        ? null
        : billing.monthlyUsage / BILLING_UNITS_PER_DOLLAR;

      if (billing.monthlyLimit !== null && usage !== null) {
        const remaining = Math.max(0, billing.monthlyLimit - usage);
        windows.monthly_budget = usageWindow({
          used: usage,
          limit: billing.monthlyLimit,
          unit: "currency",
          windowSeconds: 30 * 86400,
          resetAt: billing.budgetResetAt,
          valueLabel: `${formatUsd(remaining)} left · ${formatUsd(usage)} spent`,
        });
      }

      windows.balance = usageWindow({
        used: 0,
        limit: billing.balance,
        unit: "currency",
        valueLabel: `${formatUsd(billing.balance)} available`,
      });

      const mapped = mapProviderUsage({ windows } satisfies ProviderUsage);
      if (mapped.length === 0) throw new Error("OpenCode Zen usage data could not be parsed");
      return {
        providerId: "opencode-zen",
        accountLabel: credential.orgName ?? credential.email ?? "OpenCode Zen",
        windows: mapped,
        fetchedAt: runtime.now(),
        stale: false,
      };
    },
  };
};
