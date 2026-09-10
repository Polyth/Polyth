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

export interface ProviderCapabilityHealth {
  capability: MarketProviderCapability;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  circuitOpenUntil?: number;
  lastError?: string;
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
  capabilities: ProviderCapabilityHealth[];
}

export interface ProviderRegistryOptions {
  failureThreshold?: number;
  circuitMs?: number;
  now?: () => number;
}

const CAPABILITIES: readonly MarketProviderCapability[] = [
  "quote",
  "candles",
  "search",
  "fundamentals",
  "news",
  "filings",
  "earnings",
];

const supports = (provider: MarketProvider, capability: MarketProviderCapability): boolean =>
  typeof provider[capability] === "function";

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const errorCode = (cause: unknown): string | undefined =>
  cause && typeof cause === "object" && "code" in cause && typeof (cause as { code?: unknown }).code === "string"
    ? (cause as { code: string }).code
    : undefined;

export class ProviderRegistry {
  private readonly providers: MarketProvider[] = [];
  private readonly health = new Map<string, ProviderHealth>();
  private readonly capabilityHealth = new Map<string, Map<MarketProviderCapability, ProviderCapabilityHealth>>();
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
    const byCapability = new Map<MarketProviderCapability, ProviderCapabilityHealth>();
    for (const capability of CAPABILITIES) {
      if (!supports(provider, capability)) continue;
      byCapability.set(capability, {
        capability,
        successes: 0,
        failures: 0,
        consecutiveFailures: 0,
      });
    }
    this.capabilityHealth.set(provider.id, byCapability);
    this.health.set(provider.id, {
      providerId: provider.id,
      successes: 0,
      failures: 0,
      consecutiveFailures: 0,
      capabilities: [],
    });
  }

  providerIds(capability?: MarketProviderCapability): string[] {
    return this.providers
      .filter((provider) => !capability || supports(provider, capability))
      .map((provider) => provider.id);
  }

  healthSnapshot(): ProviderHealth[] {
    return this.providers.map((provider) => {
      const health = this.requireHealth(provider.id);
      const capabilities = [...this.requireCapabilityMap(provider.id).values()].map((item) => ({ ...item }));
      return { ...health, capabilities };
    });
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
    let misses = 0;
    let failures = 0;
    let circuitSkipped = 0;
    for (const provider of candidates) {
      const health = this.requireHealth(provider.id);
      const capabilityState = this.requireCapabilityHealth(provider.id, capability);
      const now = this.now();
      if ((capabilityState.circuitOpenUntil ?? 0) > now) {
        circuitSkipped += 1;
        continue;
      }

      attempted += 1;
      const started = now;
      try {
        const value = await invoke(provider);
        this.recordSuccess(health, capabilityState, Math.max(0, this.now() - started));
        return { value, providerId: provider.id };
      } catch (cause) {
        const message = errorMessage(cause);
        errors.push(`${provider.id}: ${message}`);
        if (errorCode(cause) === "not-found") {
          misses += 1;
          continue;
        }
        failures += 1;
        this.recordFailure(health, capabilityState, Math.max(0, this.now() - started), message);
      }
    }

    if (attempted > 0 && misses === attempted && failures === 0 && circuitSkipped === 0) {
      throw Object.assign(new Error(`no ${capability} provider has data for this request: ${errors.join("; ")}`), {
        code: "not-found",
      });
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
      return (this.requireCapabilityHealth(provider.id, capability).circuitOpenUntil ?? 0) <= now;
    });
    if (candidates.length === 0) {
      const hasCapability = this.providers.some((provider) => supports(provider, capability));
      throw Object.assign(new Error(hasCapability
        ? `all ${capability} providers are temporarily unavailable`
        : `no market provider supports ${capability}`), { code: hasCapability ? "unavailable" : "not-found" });
    }

    const settled = await Promise.all(candidates.map(async (provider) => {
      const health = this.requireHealth(provider.id);
      const capabilityState = this.requireCapabilityHealth(provider.id, capability);
      const started = this.now();
      try {
        const value = await invoke(provider);
        this.recordSuccess(health, capabilityState, Math.max(0, this.now() - started));
        return { ok: true as const, value, providerId: provider.id };
      } catch (cause) {
        const message = errorMessage(cause);
        if (errorCode(cause) === "not-found") {
          return { ok: false as const, providerId: provider.id, message, miss: true as const };
        }
        this.recordFailure(health, capabilityState, Math.max(0, this.now() - started), message);
        return { ok: false as const, providerId: provider.id, message, miss: false as const };
      }
    }));
    const successes = settled.filter((item) => item.ok).map((item) => ({ value: item.value, providerId: item.providerId }));
    if (successes.length > 0) return successes;
    const errors = settled.filter((item) => !item.ok).map((item) => `${item.providerId}: ${item.message}`);
    const missesOnly = settled.every((item) => !item.ok && item.miss);
    throw Object.assign(new Error(`${missesOnly ? `no ${capability} provider has data` : `all ${capability} providers failed`}: ${errors.join("; ")}`), {
      code: missesOnly ? "not-found" : "unavailable",
    });
  }

  private requireHealth(providerId: string): ProviderHealth {
    const health = this.health.get(providerId);
    if (!health) throw new Error(`unknown market provider: ${providerId}`);
    return health;
  }

  private requireCapabilityMap(providerId: string): Map<MarketProviderCapability, ProviderCapabilityHealth> {
    const health = this.capabilityHealth.get(providerId);
    if (!health) throw new Error(`unknown market provider: ${providerId}`);
    return health;
  }

  private requireCapabilityHealth(providerId: string, capability: MarketProviderCapability): ProviderCapabilityHealth {
    const health = this.requireCapabilityMap(providerId).get(capability);
    if (!health) throw new Error(`market provider ${providerId} does not support ${capability}`);
    return health;
  }

  private syncAggregateCircuit(health: ProviderHealth): void {
    const now = this.now();
    const open = [...this.requireCapabilityMap(health.providerId).values()]
      .map((item) => item.circuitOpenUntil ?? 0)
      .filter((until) => until > now);
    health.circuitOpenUntil = open.length ? Math.max(...open) : undefined;
  }

  private recordSuccess(health: ProviderHealth, capability: ProviderCapabilityHealth, latencyMs: number): void {
    const now = this.now();
    health.successes += 1;
    health.consecutiveFailures = 0;
    health.lastLatencyMs = latencyMs;
    health.averageLatencyMs = health.averageLatencyMs === undefined
      ? latencyMs
      : Math.round((health.averageLatencyMs * 0.8) + (latencyMs * 0.2));
    health.lastSuccessAt = now;
    health.lastError = undefined;

    capability.successes += 1;
    capability.consecutiveFailures = 0;
    capability.lastSuccessAt = now;
    capability.circuitOpenUntil = undefined;
    capability.lastError = undefined;
    this.syncAggregateCircuit(health);
  }

  private recordFailure(health: ProviderHealth, capability: ProviderCapabilityHealth, latencyMs: number, message: string): void {
    const now = this.now();
    health.failures += 1;
    health.consecutiveFailures += 1;
    health.lastLatencyMs = latencyMs;
    health.lastFailureAt = now;
    health.lastError = message;

    capability.failures += 1;
    capability.consecutiveFailures += 1;
    capability.lastFailureAt = now;
    capability.lastError = message;
    if (capability.consecutiveFailures >= this.failureThreshold) {
      capability.circuitOpenUntil = now + this.circuitMs;
    }
    this.syncAggregateCircuit(health);
  }
}
