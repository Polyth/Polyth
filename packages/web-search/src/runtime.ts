import type {
  SecureSafeService,
  SpaceContext,
  ToolExecutionContext,
} from "@polyth/contracts";
import type {
  WebSearchCredentialHandleOption,
  WebSearchProviderStatus,
  WebSearchSettingsSnapshot,
} from "./client.ts";
import {
  isAutomaticFallbackError,
  webSearchError,
  webSearchErrorCode,
} from "./errors.ts";
import { normalizeSearchResults } from "./results.ts";
import { createSearchScheduler, type SearchScheduler } from "./scheduler.ts";
import {
  normalizeWebSearchQuery,
  parseWebSearchCount,
  parseWebSearchFreshness,
  parseWebSearchSettings,
  WEB_SEARCH_KEYLESS_CHAIN,
  WEB_SEARCH_SETTINGS_VERSION,
  type WebSearchProviderId,
  type WebSearchSettings,
} from "./settings.ts";
import type { WebSearchSettingsStore } from "./settingsStore.ts";
import type {
  ProviderSearchRequest,
  RawSearchResult,
  SearchProvider,
  WebSearchRequest,
  WebSearchResponse,
} from "./types.ts";

interface ProviderOutcome {
  provider: WebSearchProviderId;
  results: RawSearchResult[];
  /** The first service that was tried and failed before `provider` answered. */
  fallbackFrom?: WebSearchProviderId;
}

export interface WebSearchRuntimeDependencies {
  spaceForId(spaceId: string): SpaceContext;
  secureSafeForSpace(space: SpaceContext): SecureSafeService | undefined;
  projectExists(space: SpaceContext, projectId: string): Promise<boolean>;
  settings: WebSearchSettingsStore;
  providers: SearchProvider[];
}

const hasGlobalHandle = (vault: SecureSafeService | undefined, handle: string | undefined): boolean => {
  if (!vault || !handle) return false;
  try {
    const expected = handle.toLocaleLowerCase();
    return vault.list().some((entry) =>
      entry.handle.toLocaleLowerCase() === expected && entry.scope === "global" && (entry.kind === "env" || entry.kind === "token"));
  } catch {
    return false;
  }
};

const providerStatus = (
  provider: SearchProvider,
  settings: WebSearchSettings,
  vault: SecureSafeService | undefined,
): WebSearchProviderStatus => {
  const hasKey = hasGlobalHandle(vault, settings.tavilyCredentialHandle);
  const configured = !provider.requiresCredential || hasKey;
  return {
    id: provider.id,
    name: provider.name,
    available: configured,
    requiresCredential: provider.requiresCredential,
    configured,
    keyed: hasKey && (provider.requiresCredential || provider.acceptsCredential === true),
  };
};

const globalHandles = (vault: SecureSafeService | undefined): { available: boolean; handles: WebSearchCredentialHandleOption[] } => {
  if (!vault) return { available: false, handles: [] };
  try {
    return {
      available: true,
      handles: vault.list()
        .filter((entry) => entry.scope === "global" && (entry.kind === "env" || entry.kind === "token"))
        .map((entry) => ({
          handle: entry.handle,
          label: entry.label,
          kind: entry.kind as "env" | "token",
          ...(entry.purpose ? { purpose: entry.purpose } : {}),
        })),
    };
  } catch {
    return { available: false, handles: [] };
  }
};

const safeVault = (resolve: () => SecureSafeService | undefined): SecureSafeService | undefined => {
  try {
    return resolve();
  } catch {
    return undefined;
  }
};

export class WebSearchRuntime {
  readonly #dependencies: WebSearchRuntimeDependencies;
  readonly #providers: Map<string, SearchProvider>;
  #lifecycle: AbortController | undefined;
  #scheduler: SearchScheduler | undefined;

  constructor(dependencies: WebSearchRuntimeDependencies) {
    this.#dependencies = dependencies;
    this.#providers = new Map(dependencies.providers.map((provider) => [provider.id, provider]));
  }

  start(): void {
    if (this.#lifecycle && !this.#lifecycle.signal.aborted) return;
    this.#lifecycle = new AbortController();
    this.#scheduler = createSearchScheduler();
  }

  stop(): void {
    this.#lifecycle?.abort();
    this.#scheduler?.close();
    this.#lifecycle = undefined;
    this.#scheduler = undefined;
  }

  settingsSnapshot(space: SpaceContext): WebSearchSettingsSnapshot {
    const state = this.#dependencies.settings.read(space);
    const vault = safeVault(() => this.#dependencies.secureSafeForSpace(space));
    const handles = globalHandles(vault);
    return {
      version: WEB_SEARCH_SETTINGS_VERSION,
      revision: state.revision,
      settings: state.settings,
      providers: this.#dependencies.providers.map((provider) => providerStatus(provider, state.settings, vault)),
      credentialHandles: handles.handles,
      vaultAvailable: handles.available,
    };
  }

  saveSettings(space: SpaceContext, value: unknown, expectedRevision: unknown): WebSearchSettingsSnapshot {
    const settings = parseWebSearchSettings(value);
    if (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 0) {
      throw webSearchError("invalid-input", "expectedRevision must be a non-negative integer");
    }
    const vault = safeVault(() => this.#dependencies.secureSafeForSpace(space));
    if (settings.tavilyCredentialHandle && !hasGlobalHandle(vault, settings.tavilyCredentialHandle)) {
      throw webSearchError("invalid-input", "Tavily requires an available global Credential Vault handle");
    }
    if (settings.provider === "tavily" && !settings.tavilyCredentialHandle) {
      throw webSearchError("invalid-input", "select a Credential Vault handle before selecting Tavily");
    }
    this.#dependencies.settings.save(space, settings, Number(expectedRevision));
    return this.settingsSnapshot(space);
  }

  async search(context: ToolExecutionContext, value: WebSearchRequest): Promise<WebSearchResponse> {
    const lifecycle = this.#lifecycle;
    const scheduler = this.#scheduler;
    if (!lifecycle || !scheduler) throw webSearchError("unavailable", "web search is not enabled");
    if (!context.spaceId?.trim()) throw webSearchError("forbidden", "web search requires an active Polyth Space");
    if (!context.projectId?.trim()) throw webSearchError("forbidden", "web search requires an active project");

    const state = this.#dependencies.settings.read(this.#dependencies.spaceForId(context.spaceId));
    if (!state.settings.enabled) throw webSearchError("forbidden", "web search is disabled in Settings");
    const query = normalizeWebSearchQuery(value.query);
    const count = parseWebSearchCount(value.count, state.settings.maxResults);
    const freshness = parseWebSearchFreshness(value.freshness);
    const space = this.#dependencies.spaceForId(context.spaceId);
    const signal = context.signal
      ? AbortSignal.any([lifecycle.signal, context.signal])
      : lifecycle.signal;
    if (signal.aborted) throw webSearchError("aborted", "web search was cancelled");

    return scheduler.run(space.spaceId, async () => {
      if (signal.aborted) throw webSearchError("aborted", "web search was cancelled");
      if (!await this.#dependencies.projectExists(space, context.projectId)) {
        throw webSearchError("forbidden", "the active project is no longer available in this Space");
      }
      const request: ProviderSearchRequest = {
        query,
        count,
        region: state.settings.region,
        safeSearch: state.settings.safeSearch,
        ...(freshness ? { freshness } : {}),
        signal,
      };
      const outcome = await this.#runProvider(space, context.projectId, state.settings, request);
      const normalized = normalizeSearchResults(outcome.results);
      return {
        query,
        provider: outcome.provider,
        results: normalized.slice(0, count),
        truncated: normalized.length > count,
        ...(outcome.fallbackFrom ? { fallbackFrom: outcome.fallbackFrom } : {}),
      };
    }, context.signal);
  }

  async #runProvider(
    space: SpaceContext,
    projectId: string,
    settings: WebSearchSettings,
    request: ProviderSearchRequest,
  ): Promise<ProviderOutcome> {
    const tavily = this.#providers.get("tavily");
    if (settings.provider === "tavily") {
      if (!tavily) throw webSearchError("provider-unavailable", "Tavily search is unavailable");
      return { provider: "tavily", results: await this.#searchTavily(space, projectId, settings, request, tavily) };
    }
    if (settings.provider === "auto" && tavily && settings.tavilyCredentialHandle) {
      try {
        const results = await this.#searchTavily(space, projectId, settings, request, tavily);
        return { provider: "tavily", results };
      } catch (cause) {
        if (!isAutomaticFallbackError(cause)) throw cause;
        return this.#searchKeyless(request, "tavily");
      }
    }
    return this.#searchKeyless(request);
  }

  /** Tries each free service in order; a provider that fails for its own reasons hands over to the next. */
  async #searchKeyless(request: ProviderSearchRequest, failedBefore?: WebSearchProviderId): Promise<ProviderOutcome> {
    let fallbackFrom = failedBefore;
    const failures: unknown[] = [];
    for (const id of WEB_SEARCH_KEYLESS_CHAIN) {
      const provider = this.#providers.get(id);
      // A service whose keyed call just failed is not asked again without the key.
      if (!provider || id === failedBefore) continue;
      try {
        const results = await provider.search(request);
        return { provider: id, results, ...(fallbackFrom ? { fallbackFrom } : {}) };
      } catch (cause) {
        if (!isAutomaticFallbackError(cause)) throw cause;
        failures.push(cause);
        fallbackFrom ??= id;
      }
    }
    if (failures.length === 0) throw webSearchError("provider-unavailable", "no free search service is available");
    const reasons = failures.map((cause) => (cause as Error).message).join("; ");
    throw webSearchError(
      failures.every((cause) => webSearchErrorCode(cause) === "rate-limited") ? "rate-limited" : "provider-unavailable",
      `no free search service answered (${reasons})`,
    );
  }

  async #searchTavily(
    space: SpaceContext,
    projectId: string,
    settings: WebSearchSettings,
    request: ProviderSearchRequest,
    provider: SearchProvider,
  ): Promise<RawSearchResult[]> {
    const handle = settings.tavilyCredentialHandle;
    if (!handle) throw webSearchError("auth-required", "Tavily is not configured for this Space");
    const vault = safeVault(() => this.#dependencies.secureSafeForSpace(space));
    if (!vault?.useCredential || !hasGlobalHandle(vault, handle)) {
      throw webSearchError("auth-required", "the Tavily Credential Vault handle is unavailable");
    }
    if (!await this.#dependencies.projectExists(space, projectId)) {
      throw webSearchError("forbidden", "the active project is no longer available in this Space");
    }

    let entered = false;
    let results: RawSearchResult[] | undefined;
    try {
      await vault.useCredential({ projectId, handle }, async (credential) => {
        entered = true;
        results = await provider.search(request, credential);
      });
    } catch (cause) {
      if (entered && webSearchErrorCode(cause)) throw cause;
      throw webSearchError("auth-required", "the Tavily Credential Vault handle could not be resolved");
    }
    return results ?? [];
  }
}
