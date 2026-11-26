// Mistral Vibe limits: the monthly Vibe Code budget of the Mistral account the
// Vibe harness runs on. Vibe 3.x reads the same two public billing routes for
// its own account view (`vibe/app_server/_billing.py`): `GET /v1/billing/budget`
// (`vibe_budget.usage_percentage` on a 0–100 scale, `initial_budget`,
// `currency`, `reset_at`, `payg_enabled`) and `GET /v1/billing/subscription`
// (`plan_name`, `vibe_payg_enabled`). The budget's sibling `api_budget` meters
// La Plateforme API usage, which a Vibe turn does not spend, so it is left out:
// it must not make the Vibe source look exhausted.
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import type { QuotaSnapshot, QuotaWindow } from "@polyth/contracts";
import type { UsageLimitAccount } from "../limits.ts";
import type { QuotaRuntime } from "../opencodeAuth.ts";
import { numberValue, objectValue, stringValue, timestampValue } from "../opencodeAuth.ts";
import type { DiscoverableProvider } from "./adapters.ts";

export const VIBE_PROVIDER_ID = "vibe";
const MISTRAL_API_BASE = "https://api.mistral.ai/v1";
const MISTRAL_API_KEY_ENV = "MISTRAL_API_KEY";
// Vibe's browser (OIDC) sign-in stores this non-secret placeholder in place of
// a key and swaps in an ID token per request; it is not a credential.
const OIDC_MARKER = "vibe-cli-oidc";
const PLAN_TITLES: Readonly<Record<string, string>> = {
  FREE: "Free",
  INDIVIDUAL: "Pro",
  EDU: "Student",
  TEAM: "Team",
};

export interface VibeAccountSource {
  /** The account's private `VIBE_HOME`. */
  configDir: string;
  account(): UsageLimitAccount;
}

/** `VIBE_HOME`, else `~/.vibe` — Vibe's own resolution. */
const vibeHome = (runtime: QuotaRuntime): string => {
  const configured = stringValue(runtime.env.VIBE_HOME);
  return configured ? resolve(configured.replace(/^~(?=$|[\\/])/, runtime.home)) : join(runtime.home, ".vibe");
};

/** One variable of a dotenv file (`KEY=value`, optional `export`, quotes, `#` comments). */
export const readDotenvValue = (text: string, name: string): string | null => {
  for (const raw of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw);
    if (!match || match[1] !== name) continue;
    let value = match[2]!.trim();
    const quote = value[0];
    if ((quote === "\"" || quote === "'") && value.length >= 2) {
      const end = value.indexOf(quote, 1);
      value = end > 0 ? value.slice(1, end) : value.slice(1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    return stringValue(value);
  }
  return null;
};

const readHomeKey = (runtime: QuotaRuntime, home: string): string | null => {
  try {
    return readDotenvValue(runtime.readFile(join(home, ".env")), MISTRAL_API_KEY_ENV);
  } catch {
    return null;
  }
};

const usable = (key: string | null): string | null => key && key !== OIDC_MARKER ? key : null;

/**
 * The key a Vibe login runs on. The default login follows Vibe's precedence:
 * a non-empty launch-environment `MISTRAL_API_KEY` wins over `$VIBE_HOME/.env`.
 * An added account reads only its own `<configDir>/.env`: the harness strips
 * the server's `MISTRAL_API_KEY` from an account's child environment, so the
 * account never runs, or is metered, on the default key. The system keyring
 * and a browser (OIDC) sign-in are not read.
 */
export const loadVibeCredential = (runtime: QuotaRuntime, source?: Pick<VibeAccountSource, "configDir">): string | null => {
  if (source) return usable(readHomeKey(runtime, source.configDir));
  const env = stringValue(runtime.env[MISTRAL_API_KEY_ENV]);
  if (env) return usable(env);
  return usable(readHomeKey(runtime, vibeHome(runtime)));
};

interface BillingAnswer {
  status: number;
  body: Record<string, unknown> | null;
}

const billingRead = async (
  runtime: QuotaRuntime,
  path: string,
  key: string,
  signal: AbortSignal,
): Promise<BillingAnswer> => {
  let response: Response;
  try {
    response = await runtime.fetchImpl(`${MISTRAL_API_BASE}/${path}`, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${key}` },
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error("Mistral billing request failed");
  }
  if (!response.ok) return { status: response.status, body: null };
  try {
    return { status: response.status, body: objectValue(await response.json()) };
  } catch {
    throw new Error("Mistral billing API returned invalid JSON");
  }
};

const MONEY_SYMBOLS: Readonly<Record<string, string>> = { USD: "$", EUR: "€", GBP: "£" };
const formatMoney = (value: number, currency: string): string => {
  const symbol = MONEY_SYMBOLS[currency];
  const amount = value.toFixed(2);
  return symbol ? `${symbol}${amount}` : `${amount} ${currency}`;
};

/** The calendar month that ends at `resetAt` (the budget resets on the 1st). */
const monthBefore = (resetAt: number): number => {
  const end = new Date(resetAt);
  const start = new Date(end);
  start.setUTCMonth(end.getUTCMonth() - 1);
  // A reset on the 31st of a month after a shorter one rolls over; clamp it.
  if (start.getUTCDate() !== end.getUTCDate()) start.setUTCDate(0);
  return resetAt - start.getTime();
};

/** The Vibe Code budget as a Limits window, or null when the account has none. */
export const vibeBudgetWindow = (
  budget: Record<string, unknown> | null,
  subscription: Record<string, unknown> | null,
): QuotaWindow | null => {
  const detail = objectValue(budget?.vibe_budget);
  const initial = numberValue(detail?.initial_budget);
  const percentage = numberValue(detail?.usage_percentage);
  if (initial === null || initial <= 0 || percentage === null) return null;
  const usedPercent = Math.max(0, percentage);
  const currency = (stringValue(detail?.currency) ?? "USD").toUpperCase();
  const spent = (usedPercent / 100) * initial;
  const resetsAt = timestampValue(detail?.reset_at);
  const payg = typeof detail?.payg_enabled === "boolean"
    ? detail.payg_enabled
    : subscription?.vibe_payg_enabled === true;
  const amounts = `${formatMoney(Math.max(0, initial - spent), currency)} left · ${formatMoney(spent, currency)} spent`;
  // Past 100% a pay-as-you-go account is billed instead of paused.
  const label = `Monthly budget · ${amounts}${payg ? " · pay-as-you-go on" : ""}`;
  const timing = resetsAt !== null ? { resetsAt, periodMs: monthBefore(resetsAt) } : {};
  // Mistral meters the Vibe budget as a share (`usage_percentage`) and Vibe
  // shows it that way; the amounts are derived from it, so they stay in the
  // label and the window keeps the provider's own percentage.
  return { id: "monthly", label, used: usedPercent, limit: 100, unit: "percent", ...timing };
};

const planTitle = (subscription: Record<string, unknown> | null): string | null => {
  const plan = stringValue(subscription?.plan_name)?.toUpperCase();
  return plan ? PLAN_TITLES[plan] ?? null : null;
};

/** The default source reads the user's own Vibe login; with `source`, only
 *  that account's `VIBE_HOME/.env`. Each key is sent only to api.mistral.ai. */
export const createVibeProvider = (runtime: QuotaRuntime, source?: VibeAccountSource): DiscoverableProvider => {
  const providerId = source ? source.account().harnessId : VIBE_PROVIDER_ID;
  const load = () => loadVibeCredential(runtime, source);
  return {
    id: providerId,
    ...(source ? { account: source.account } : {}),
    isConfigured: () => Boolean(load()),
    // A key saved again with `vibe --setup` after a rejection is read at once.
    credentialFingerprint() {
      const key = load();
      return key ? createHash("sha256").update(key).digest("hex") : null;
    },
    async fetch(signal): Promise<QuotaSnapshot> {
      const key = load();
      if (!key) throw new Error(source ? "This Mistral Vibe account has no API key." : "Mistral Vibe has no API key");
      const [subscription, budget] = await Promise.all([
        billingRead(runtime, "billing/subscription", key, signal),
        billingRead(runtime, "billing/budget", key, signal),
      ]);
      if (subscription.status === 401 || budget.status === 401) {
        throw Object.assign(
          new Error("Mistral API key rejected — save a new key with vibe --setup"),
          { code: "unauthorized" },
        );
      }
      if (budget.status === 403) {
        // A member without the organization's usage permission may run Vibe
        // but not read its budget; that is not a signed-out account.
        throw new Error("This Mistral key may not read the organization's Vibe budget (HTTP 403); an admin can grant usage access");
      }
      if (!budget.body) throw new Error(`Mistral billing API returned HTTP ${budget.status}`);
      const window = vibeBudgetWindow(budget.body, subscription.body);
      if (!window) throw new Error("This Mistral account reports no Vibe Code budget");
      const plan = planTitle(subscription.body);
      return {
        providerId,
        accountLabel: plan ? `Mistral ${plan}` : "Mistral",
        windows: [window],
        fetchedAt: runtime.now(),
        stale: false,
      };
    },
  };
};
