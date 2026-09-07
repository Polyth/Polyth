// Provider manager: visibility + custom-provider config + discovery.
// OpenCode JSON is written only through ProviderConfigPort.

import type {
  AgentRuntime,
  CustomProviderApply,
  CustomProviderAuthMode,
  ModelDescriptor,
  ProviderConfigPort,
  ProviderInspect,
  ProviderOrigin,
} from "@polyth/contracts";
import {
  redactProviderError,
  validateCustomProviderInput,
  validateModelId,
  validateModelLimit,
  type CustomProviderInput,
} from "./customProvider.ts";
import {
  discoverOpenAiModels,
  type DiscoverModelsInput,
  type DiscoverModelsResult,
} from "./discoverModels.ts";

export interface VisibilityPort {
  state(): {
    disabledProviders: string[];
    disabledModels: string[];
    addedProviders: Array<{
      id: string;
      name?: string;
      origin?: ProviderOrigin;
      protocol?: CustomProviderApply["protocol"];
      authMode?: CustomProviderAuthMode;
      hasStoredCredential?: boolean;
    }>;
  };
  catalog(models: ModelDescriptor[]): unknown;
  addProvider(
    id: string,
    name?: string,
    origin?: ProviderOrigin,
    meta?: {
      protocol?: CustomProviderApply["protocol"];
      authMode?: CustomProviderAuthMode;
      hasStoredCredential?: boolean;
    },
  ): Promise<unknown>;
  removeProvider(id: string): Promise<unknown>;
  setModelEnabled?(key: string, enabled: boolean): Promise<unknown>;
}

export interface ProviderManager {
  takenIds(models: ModelDescriptor[], reservedIds?: Iterable<string>): Set<string>;
  createCustom(
    input: CustomProviderInput,
    models: ModelDescriptor[],
    reservedIds?: Iterable<string>,
  ): Promise<{ id: string; discovered?: number }>;
  updateCustom(id: string, input: CustomProviderInput): Promise<void>;
  removeManaged(id: string, opts: { deleteCredentials: boolean }): Promise<void>;
  discover(id: string, opts?: { apiKey?: string; signal?: AbortSignal }): Promise<{
    models: Array<{ id: string; name?: string }>;
    unsupported?: boolean;
    message?: string;
  }>;
  addManualModel(id: string, model: { id: string; name?: string; context?: number; output?: number }): Promise<void>;
  removeConfiguredModel(id: string, modelId: string): Promise<void>;
}

const secretsOf = (apiKey: string | undefined, headers: Record<string, string> | undefined): string[] => [
  ...(apiKey ? [apiKey] : []),
  ...Object.values(headers ?? {}),
];

const REDISCOVER_NEEDS_KEY =
  "Re-enter the API key to rediscover models. Stored keys cannot be read back.";

const rollbackApplyOf = (
  inspect: ProviderInspect,
  previousAuth: CustomProviderAuthMode,
  fallback: CustomProviderApply,
): CustomProviderApply => ({
  id: inspect.id,
  name: inspect.name,
  protocol: inspect.protocol ?? fallback.protocol,
  baseURL: inspect.baseURL ?? fallback.baseURL,
  authMode: inspect.authMode ?? previousAuth,
  headerPatch: inspect.headers && Object.keys(inspect.headers).length
    ? { clear: true, set: inspect.headers }
    : { clear: true },
});

export function createProviderManager(deps: {
  visibility: VisibilityPort;
  config: ProviderConfigPort;
  runtime: () => Promise<AgentRuntime>;
  invalidateCatalog: () => void;
  discoverModels?: (input: DiscoverModelsInput) => Promise<DiscoverModelsResult>;
}): ProviderManager {
  const addedOf = (id: string) => deps.visibility.state().addedProviders.find((p) => p.id === id);
  const probeModels = deps.discoverModels ?? discoverOpenAiModels;

  const isOwned = (id: string, inspectOwned?: boolean): boolean => {
    const origin = addedOf(id)?.origin;
    if (origin === "custom") return true;
    if (origin === "externally-configured" || origin === "builtin") return false;
    return inspectOwned === true;
  };

  const redactThrow = (e: unknown, secrets: readonly string[]): never => {
    const err = e as Error & { code?: string };
    throw Object.assign(
      new Error(redactProviderError(err.message, secrets)),
      { code: err.code ?? "unavailable" },
    );
  };

  const tryDiscoverAndMerge = async (input: {
    id: string;
    baseURL: string;
    apiKey?: string;
    headers?: Record<string, string>;
  }): Promise<number | undefined> => {
    try {
      const result = await probeModels({
        baseURL: input.baseURL,
        ...(input.apiKey ? { apiKey: input.apiKey } : {}),
        ...(input.headers ? { headers: input.headers } : {}),
      });
      if (!result.ok || result.models.length === 0) return undefined;
      await deps.config.mergeDiscoveredModels(input.id, result.models);
      return result.models.length;
    } catch {
      return undefined;
    }
  };

  const requireAuthOk = (ok: boolean | undefined, action: string): void => {
    if (ok === false) {
      throw Object.assign(new Error(`${action} failed`), { code: "unavailable" });
    }
  };

  return {
    takenIds(models, reservedIds) {
      const ids = new Set<string>();
      for (const id of reservedIds ?? []) if (id) ids.add(id);
      for (const p of deps.visibility.state().addedProviders) ids.add(p.id);
      for (const m of models) ids.add(m.providerID);
      return ids;
    },

    async createCustom(input, models, reservedIds) {
      const taken = this.takenIds(models, reservedIds);
      const cfg = await deps.config.readConfig();
      const providers = cfg.provider && typeof cfg.provider === "object" && !Array.isArray(cfg.provider)
        ? cfg.provider as Record<string, unknown>
        : {};
      for (const id of Object.keys(providers)) taken.add(id);
      const validated = validateCustomProviderInput(input, taken);
      const secrets = secretsOf(validated.apiKey, validated.headerPatch?.set);
      const applyInput: CustomProviderApply = {
        id: validated.id,
        name: validated.name,
        protocol: validated.protocol,
        baseURL: validated.baseURL,
        authMode: validated.authMode,
        ...(validated.headerPatch ? { headerPatch: validated.headerPatch } : {}),
      };

      let wroteCredential = false;
      try {
        if (validated.authMode === "api-key") {
          const rt = await deps.runtime();
          if (!rt.setProviderApiKey) {
            throw Object.assign(new Error("provider auth unavailable on this runtime"), { code: "unsupported" });
          }
          requireAuthOk(await rt.setProviderApiKey(validated.id, validated.apiKey!), "provider API key write");
          wroteCredential = true;
        }
        await deps.config.applyCustomProvider(applyInput);
      } catch (e) {
        if (wroteCredential) {
          try {
            const rt = await deps.runtime();
            await rt.removeProviderAuth?.(validated.id);
          } catch { /* compensating cleanup best-effort */ }
        }
        redactThrow(e, secrets);
      }
      try {
        await deps.visibility.addProvider(validated.id, validated.name, "custom", {
          protocol: validated.protocol,
          authMode: validated.authMode,
          hasStoredCredential: validated.authMode === "api-key",
        });
      } catch (e) {
        try { await deps.config.removeCustomProvider(validated.id); } catch { /* best-effort */ }
        if (wroteCredential) {
          try {
            const rt = await deps.runtime();
            await rt.removeProviderAuth?.(validated.id);
          } catch { /* best-effort */ }
        }
        redactThrow(e, secrets);
      }
      const discovered = await tryDiscoverAndMerge({
        id: validated.id,
        baseURL: validated.baseURL,
        ...(validated.apiKey ? { apiKey: validated.apiKey } : {}),
        ...(validated.headerPatch?.set ? { headers: validated.headerPatch.set } : {}),
      });
      deps.invalidateCatalog();
      return { id: validated.id, ...(discovered !== undefined ? { discovered } : {}) };
    },

    async updateCustom(id, input) {
      const current = await deps.config.inspectProvider(id);
      if (!current) throw Object.assign(new Error("not-found"), { code: "not-found" });
      if (!isOwned(id, current.owned)) {
        throw Object.assign(new Error("This provider is managed outside Polyth and cannot be edited here."), { code: "conflict" });
      }
      const validated = validateCustomProviderInput(input, new Set(), { existingId: id });
      const previous = addedOf(id);
      const previousAuth = previous?.authMode ?? current.authMode ?? "api-key";
      const secrets = secretsOf(validated.apiKey, validated.headerPatch?.set);
      if (validated.authMode === "api-key" && previousAuth === "none" && !validated.apiKey) {
        throw Object.assign(new Error("API key is required"), { code: "invalid-input" });
      }

      const applyInput: CustomProviderApply = {
        id,
        name: validated.name,
        protocol: validated.protocol,
        baseURL: validated.baseURL,
        authMode: validated.authMode,
        ...(validated.headerPatch ? { headerPatch: validated.headerPatch } : {}),
      };
      const previousApply = rollbackApplyOf(current, previousAuth, applyInput);
      const previousMeta = {
        name: previous?.name ?? current.name,
        protocol: previous?.protocol ?? current.protocol ?? applyInput.protocol,
        authMode: previousAuth,
        hasStoredCredential: previous?.hasStoredCredential === true,
      };

      const rollbackConfigAndMeta = async () => {
        try { await deps.config.applyCustomProvider(previousApply); } catch { /* best-effort */ }
        try {
          await deps.visibility.addProvider(id, previousMeta.name, "custom", {
            protocol: previousMeta.protocol,
            authMode: previousMeta.authMode,
            hasStoredCredential: previousMeta.hasStoredCredential,
          });
        } catch { /* best-effort */ }
      };

      try {
        await deps.config.applyCustomProvider(applyInput);
      } catch (e) {
        redactThrow(e, secrets);
      }

      const hasStoredCredential = validated.authMode === "none"
        ? false
        : (validated.apiKey ? true : previous?.hasStoredCredential === true);
      try {
        await deps.visibility.addProvider(id, validated.name, "custom", {
          protocol: validated.protocol,
          authMode: validated.authMode,
          hasStoredCredential,
        });
      } catch (e) {
        try { await deps.config.applyCustomProvider(previousApply); } catch { /* best-effort */ }
        redactThrow(e, secrets);
      }

      try {
        const rt = await deps.runtime();
        if (validated.authMode === "api-key" && validated.apiKey) {
          if (!rt.setProviderApiKey) {
            throw Object.assign(new Error("provider auth unavailable on this runtime"), { code: "unsupported" });
          }
          requireAuthOk(await rt.setProviderApiKey(id, validated.apiKey), "provider API key write");
        } else if (validated.authMode === "none" && previousAuth === "api-key") {
          requireAuthOk(await rt.removeProviderAuth?.(id), "provider auth delete");
        }
      } catch (e) {
        await rollbackConfigAndMeta();
        redactThrow(e, secrets);
      }
      deps.invalidateCatalog();
    },

    async removeManaged(id, opts) {
      const current = await deps.config.inspectProvider(id);
      const owned = isOwned(id, current?.owned);
      if (!owned) {
        await deps.visibility.removeProvider(id);
        deps.invalidateCatalog();
        return;
      }
      const previous = addedOf(id);
      const previousAuth = previous?.authMode ?? current?.authMode ?? "api-key";
      const previousApply = current
        ? rollbackApplyOf(current, previousAuth, {
            id,
            name: current.name,
            protocol: current.protocol ?? "openai-compatible",
            baseURL: current.baseURL ?? "",
            authMode: previousAuth,
          })
        : undefined;
      const previousMeta = {
        name: previous?.name ?? current?.name,
        protocol: previous?.protocol ?? current?.protocol,
        authMode: previousAuth,
        hasStoredCredential: previous?.hasStoredCredential === true,
      };
      const restore = async () => {
        if (previousApply) {
          try { await deps.config.applyCustomProvider(previousApply); } catch { /* best-effort */ }
        }
        try {
          await deps.visibility.addProvider(id, previousMeta.name, "custom", {
            ...(previousMeta.protocol ? { protocol: previousMeta.protocol } : {}),
            authMode: previousMeta.authMode,
            hasStoredCredential: previousMeta.hasStoredCredential,
          });
        } catch { /* best-effort */ }
      };

      try {
        await deps.config.removeCustomProvider(id);
      } catch (e) {
        redactThrow(e, []);
      }
      try {
        await deps.visibility.removeProvider(id);
      } catch (e) {
        if (previousApply) {
          try { await deps.config.applyCustomProvider(previousApply); } catch { /* best-effort */ }
        }
        redactThrow(e, []);
      }
      if (opts.deleteCredentials !== false) {
        try {
          const rt = await deps.runtime();
          requireAuthOk(await rt.removeProviderAuth?.(id), "provider auth delete");
        } catch (e) {
          await restore();
          redactThrow(e, []);
        }
      }
      deps.invalidateCatalog();
    },

    async discover(id, opts = {}) {
      const current = await deps.config.inspectProvider(id);
      if (!current) throw Object.assign(new Error("not-found"), { code: "not-found" });
      if (!current.baseURL) throw Object.assign(new Error("This provider has no Base URL to probe."), { code: "invalid-input" });
      const authMode = addedOf(id)?.authMode ?? current.authMode;
      if (authMode === "api-key" && !opts.apiKey) {
        throw Object.assign(new Error(REDISCOVER_NEEDS_KEY), { code: "invalid-input" });
      }
      const secrets = secretsOf(opts.apiKey, current.headers);
      const result = await probeModels({
        baseURL: current.baseURL,
        ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
        ...(current.headers ? { headers: current.headers } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      if (!result.ok) {
        if (result.code === "unsupported") {
          return { models: [], unsupported: true, message: result.message };
        }
        throw Object.assign(new Error(redactProviderError(result.message, secrets)), { code: result.code });
      }
      await deps.config.mergeDiscoveredModels(id, result.models);
      deps.invalidateCatalog();
      return { models: result.models };
    },

    async addManualModel(id, model) {
      const modelId = validateModelId(model.id);
      const current = await deps.config.inspectProvider(id);
      if (!current) throw Object.assign(new Error("not-found"), { code: "not-found" });
      if (!isOwned(id, current.owned)) {
        throw Object.assign(new Error("This provider is managed outside Polyth and cannot be edited here."), { code: "conflict" });
      }
      const name = model.name?.trim();
      if (name && name.length > 256) {
        throw Object.assign(new Error("model display name is too long"), { code: "invalid-input" });
      }
      await deps.config.addManualModel(id, {
        id: modelId,
        ...(name ? { name } : {}),
        ...(validateModelLimit(model.context, "context") !== undefined
          ? { context: validateModelLimit(model.context, "context") }
          : {}),
        ...(validateModelLimit(model.output, "output") !== undefined
          ? { output: validateModelLimit(model.output, "output") }
          : {}),
      });
      deps.invalidateCatalog();
    },

    async removeConfiguredModel(id, modelId) {
      const trimmed = validateModelId(modelId);
      const current = await deps.config.inspectProvider(id);
      if (!current) throw Object.assign(new Error("not-found"), { code: "not-found" });
      if (!isOwned(id, current.owned)) {
        throw Object.assign(new Error("This provider is managed outside Polyth and cannot be edited here."), { code: "conflict" });
      }
      if (!current.modelIDs.includes(trimmed)) {
        throw Object.assign(new Error("not-found"), { code: "not-found" });
      }
      await deps.config.removeConfiguredModel(id, trimmed);
      try {
        await deps.visibility.setModelEnabled?.(`${id}/${trimmed}`, true);
      } catch { /* disable-entry cleanup is best-effort */ }
      deps.invalidateCatalog();
    },
  };
}
