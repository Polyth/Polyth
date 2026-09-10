import type {
  MarketCandleSeries,
  MarketEarningsSurprise,
  MarketFiling,
  MarketFundamentals,
  MarketNewsItem,
  MarketProviderCapability,
  MarketQuote,
  MarketRange,
  MarketSearchResult,
} from "./types.ts";

export interface MarketProvider {
  id: string;
  quote?(symbol: string, signal: AbortSignal): Promise<MarketQuote>;
  candles?(symbol: string, range: MarketRange, signal: AbortSignal): Promise<MarketCandleSeries>;
  search?(query: string, signal: AbortSignal): Promise<MarketSearchResult[]>;
  fundamentals?(symbol: string, signal: AbortSignal): Promise<MarketFundamentals>;
  news?(symbol: string, signal: AbortSignal): Promise<MarketNewsItem[]>;
  filings?(symbol: string, signal: AbortSignal): Promise<MarketFiling[]>;
  earnings?(symbol: string, signal: AbortSignal): Promise<MarketEarningsSurprise[]>;
}

export interface ProviderHealth {
  providerId: string;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  lastLatencyMs?: number;
  averageLatencyMs?: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  circuitOpenUntil?: number;
  lastError?: string;
}

export interface ProviderRegistryOptions {
  failureThreshold?: number;
  circuitMs?: number;
  now?: () => number;
}

const supports = (provider: MarketProvider, capability: MarketProviderCapability): boolean =>
  typeof provider[capability] === "function";

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export class ProviderRegistry {
  private readonly providers: MarketProvider[] = [];
  private readonly health = new Map<string, ProviderHealth>();
  private readonly failureThreshold: number;
  private readonly circuitMs: number;
  private readonly now: () => number;

  constructor(options: ProviderRegistryOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 3;
    this.circuitMs = options.circuitMs ?? 30_000;
    this.now = options.now ?? Date.now;
    if (this.failureThreshold < 1) throw new Error("failureThreshold must be at least 1");
    if (this.circuitMs < 0) throw new Error("circuitMs must be non-negative");
  }

  register(provider: MarketProvider): void {
    if (!provider.id.trim()) throw new Error("provider id is required");
    if (this.providers.some((item) => item.id === provider.id)) {
      throw new Error(`market provider already registered: ${provider.id}`);
    }
    this.providers.push(provider);
    this.health.set(provider.id, {
      providerId: provider.id,
      successes: 0,
      failures: 0,
      consecutiveFailures: 0,
    });
  }

  providerIds(capability?: MarketProviderCapability): string[] {
    return this.providers
      .filter((provider) => !capability || supports(provider, capability))
      .map((provider) => provider.id);
  }

  healthSnapshot(): ProviderHealth[] {
    return this.providers.map((provider) => ({ ...this.requireHealth(provider.id) }));
  }

  async run<T>(
    capability: MarketProviderCapability,
    invoke: (provider: MarketProvider) => Promise<T>,
  ): Promise<{ value: T; providerId: string }> {
    const candidates = this.providers.filter((provider) => supports(provider, capability));
    if (candidates.length === 0) {
      throw Object.assign(new Error(`no market provider supports ${capability}`), { code: "not-found" });
    }

    const errors: string[] = [];
    let attempted = 0;
    for (const provider of candidates) {
      const health = this.requireHealth(provider.id);
      const now = this.now();
      if ((health.circuitOpenUntil ?? 0) > now) continue;

      attempted += 1;
      const started = now;
      try {
        const value = await invoke(provider);
        this.recordSuccess(health, Math.max(0, this.now() - started));
        return { value, providerId: provider.id };
      } catch (cause) {
        const message = errorMessage(cause);
        errors.push(`${provider.id}: ${message}`);
        this.recordFailure(health, Math.max(0, this.now() - started), message);
      }
    }

    if (attempted === 0) {
      throw Object.assign(new Error(`all ${capability} providers are temporarily unavailable`), {
        code: "unavailable",
      });
    }
    throw Object.assign(new Error(`all ${capability} providers failed: ${errors.join("; ")}`), {
      code: "unavailable",
    });
  }

  async runAll<T>(
    capability: MarketProviderCapability,
    invoke: (provider: MarketProvider) => Promise<T>,
  ): Promise<Array<{ value: T; providerId: string }>> {
    const now = this.now();
    const candidates = this.providers.filter((provider) => {
      if (!supports(provider, capability)) return false;
      return (this.requireHealth(provider.id).circuitOpenUntil ?? 0) <= now;
    });
    if (candidates.length === 0) {
      const hasCapability = this.providers.some((provider) => supports(provider, capability));
      throw Object.assign(new Error(hasCapability
        ? `all ${capability} providers are temporarily unavailable`
        : `no market provider supports ${capability}`), { code: hasCapability ? "unavailable" : "not-found" });
    }

    const settled = await Promise.all(candidates.map(async (provider) => {
      const health = this.requireHealth(provider.id);
      const started = this.now();
      try {
        const value = await invoke(provider);
        this.recordSuccess(health, Math.max(0, this.now() - started));
        return { ok: true as const, value, providerId: provider.id };
      } catch (cause) {
        const message = errorMessage(cause);
        this.recordFailure(health, Math.max(0, this.now() - started), message);
        return { ok: false as const, providerId: provider.id, message };
      }
    }));
    const successes = settled.filter((item) => item.ok).map((item) => ({ value: item.value, providerId: item.providerId }));
    if (successes.length > 0) return successes;
    const errors = settled.filter((item) => !item.ok).map((item) => `${item.providerId}: ${item.message}`);
    throw Object.assign(new Error(`all ${capability} providers failed: ${errors.join("; ")}`), { code: "unavailable" });
  }

  private requireHealth(providerId: string): ProviderHealth {
    const health = this.health.get(providerId);
    if (!health) throw new Error(`unknown market provider: ${providerId}`);
    return health;
  }

  private recordSuccess(health: ProviderHealth, latencyMs: number): void {
    health.successes += 1;
    health.consecutiveFailures = 0;
    health.lastLatencyMs = latencyMs;
    health.averageLatencyMs = health.averageLatencyMs === undefined
      ? latencyMs
      : Math.round((health.averageLatencyMs * 0.8) + (latencyMs * 0.2));
    health.lastSuccessAt = this.now();
    health.circuitOpenUntil = undefined;
    health.lastError = undefined;
  }

  private recordFailure(health: ProviderHealth, latencyMs: number, message: string): void {
    health.failures += 1;
    health.consecutiveFailures += 1;
    health.lastLatencyMs = latencyMs;
    health.lastFailureAt = this.now();
    health.lastError = message;
    if (health.consecutiveFailures >= this.failureThreshold) {
      health.circuitOpenUntil = this.now() + this.circuitMs;
    }
  }
}
