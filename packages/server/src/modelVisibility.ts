// Server-owned provider/model visibility (WP: Providers & Models settings).
// The canonical toggle state lives in data/model-visibility.json; every change
// is mirrored into the backend config (opencode.json disabled_providers +
// provider.<id>.blacklist) through the adapter's applier so OpenCode stays the
// source of truth. On first boot the store seeds FROM that config, so
// visibility already curated in OpenCode shows up in Polyth immediately.
// Seeding is READ-ONLY (invariant 11): it only calls readConfig and writes the
// Polyth-side store, never the backend config. Writes go through the applier's
// applyProviderVisibility, which owns only disabled_providers and each
// provider's blacklist — unknown provider/model metadata (reasoning,
// modalities, limits, variants, future fields) is preserved by the applier.
import { mkdirSync, readFileSync } from "node:fs";
import { atomicWriteSync } from "./atomicWrite.ts";
import { dirname } from "node:path";
import type { ModelDescriptor } from "@polyth/contracts";

export interface VisibilityState {
  /** Provider ids hidden entirely. */
  disabledProviders: string[];
  /** "providerID/modelID" keys disabled inside an otherwise-enabled provider. */
  disabledModels: string[];
}

export interface ProviderCatalogModel {
  providerID: string;
  modelID: string;
  /** "providerID/modelID" toggle key. */
  key: string;
  name: string;
  providerName?: string;
  context?: number;
  cost?: { input: number; output: number };
  capabilities?: string[];
  variants?: string[];
  connected: boolean;
  enabled: boolean;
}

export interface ProviderCatalogEntry {
  id: string;
  name: string;
  connected: boolean;
  enabled: boolean;
  models: ProviderCatalogModel[];
}

export interface VisibilityApplier {
  readConfig(): Promise<Record<string, unknown>>;
  applyProviderVisibility(v: { disabledProviders: string[]; blacklists: Record<string, string[]> }): Promise<void>;
}

export interface ModelVisibilityService {
  state(): VisibilityState;
  providerEnabled(providerID: string): boolean;
  modelEnabled(m: { providerID: string; modelID: string }): boolean;
  /** Models the pickers may show: enabled and (by default) connected. */
  filter(models: ModelDescriptor[], opts?: { includeDisconnected?: boolean }): ModelDescriptor[];
  catalog(models: ModelDescriptor[]): ProviderCatalogEntry[];
  setProviderEnabled(providerID: string, enabled: boolean): Promise<VisibilityState>;
  setModelEnabled(key: string, enabled: boolean): Promise<VisibilityState>;
  /** Seed from the backend config when no local store exists yet. */
  seed(): Promise<void>;
}

const err = (code: string, message: string) => Object.assign(new Error(message), { code });

export const modelVisibilityKey = (m: { providerID: string; modelID: string }): string =>
  `${m.providerID}/${m.modelID}`;

export function parseVisibility(raw: unknown): VisibilityState {
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && x.length > 0))].sort() : [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { disabledProviders: [], disabledModels: [] };
  const o = raw as Record<string, unknown>;
  return { disabledProviders: strings(o.disabledProviders), disabledModels: strings(o.disabledModels) };
}

/** Extract visibility from a parsed opencode.json (seeding path). */
export function visibilityFromBackendConfig(cfg: Record<string, unknown>): VisibilityState {
  const disabledProviders = Array.isArray(cfg.disabled_providers)
    ? cfg.disabled_providers.filter((x): x is string => typeof x === "string")
    : [];
  const disabledModels: string[] = [];
  const provider = cfg.provider;
  if (provider && typeof provider === "object" && !Array.isArray(provider)) {
    for (const [id, entry] of Object.entries(provider as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const blacklist = (entry as Record<string, unknown>).blacklist;
      if (!Array.isArray(blacklist)) continue;
      for (const modelID of blacklist) {
        if (typeof modelID === "string" && modelID) disabledModels.push(`${id}/${modelID}`);
      }
    }
  }
  return parseVisibility({ disabledProviders, disabledModels });
}

export function isModelVisible(m: ModelDescriptor, state: VisibilityState): boolean {
  if (state.disabledProviders.includes(m.providerID)) return false;
  return !state.disabledModels.includes(modelVisibilityKey(m));
}

/** Enabled models; disconnected providers are hidden unless requested.
 *  Fail-open: if filtering leaves nothing while some models exist, the
 *  connected-only cut is dropped so the picker never goes empty because a
 *  backend forgot to report credentials. */
export function filterVisibleModels(
  models: ModelDescriptor[],
  state: VisibilityState,
  opts: { includeDisconnected?: boolean } = {},
): ModelDescriptor[] {
  const enabled = models.filter((m) => isModelVisible(m, state));
  if (opts.includeDisconnected) return enabled;
  const connected = enabled.filter((m) => m.connected !== false);
  return connected.length > 0 ? connected : enabled;
}

export function buildProviderCatalog(models: ModelDescriptor[], state: VisibilityState): ProviderCatalogEntry[] {
  const byProvider = new Map<string, ProviderCatalogEntry>();
  for (const m of models) {
    let entry = byProvider.get(m.providerID);
    if (!entry) {
      entry = {
        id: m.providerID,
        name: m.providerName ?? m.providerID,
        connected: m.connected !== false,
        enabled: !state.disabledProviders.includes(m.providerID),
        models: [],
      };
      byProvider.set(m.providerID, entry);
    }
    if (m.connected !== false) entry.connected = true;
    if (m.providerName && entry.name === entry.id) entry.name = m.providerName;
    const key = modelVisibilityKey(m);
    entry.models.push({
      providerID: m.providerID,
      modelID: m.modelID,
      key,
      name: m.name || m.modelID,
      ...(m.providerName ? { providerName: m.providerName } : {}),
      ...(m.context !== undefined ? { context: m.context } : {}),
      ...(m.cost ? { cost: m.cost } : {}),
      ...(m.capabilities ? { capabilities: m.capabilities } : {}),
      ...(m.variants ? { variants: m.variants } : {}),
      connected: m.connected !== false,
      enabled: entry.enabled && !state.disabledModels.includes(key),
    });
  }
  const out = [...byProvider.values()];
  for (const p of out) p.models.sort((a, b) => a.name.localeCompare(b.name));
  out.sort((a, b) => {
    if (a.connected !== b.connected) return a.connected ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return out;
}

/** disabledModels keys → per-provider blacklists for the backend config. */
export function blacklistsOf(state: VisibilityState): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const key of state.disabledModels) {
    const i = key.indexOf("/");
    if (i <= 0 || i === key.length - 1) continue;
    const provider = key.slice(0, i);
    (out[provider] ??= []).push(key.slice(i + 1));
  }
  return out;
}

export function createModelVisibilityService(opts: { file: string; applier?: VisibilityApplier }): ModelVisibilityService {
  mkdirSync(dirname(opts.file), { recursive: true });

  let loaded = false;
  let state: VisibilityState = { disabledProviders: [], disabledModels: [] };
  try {
    state = parseVisibility(JSON.parse(readFileSync(opts.file, "utf8")));
    loaded = true;
  } catch { /* no store yet — seed() may fill it from the backend config */ }

  const persist = () => atomicWriteSync(opts.file, `${JSON.stringify(state, null, 2)}\n`);

  /** Mirror to opencode.json; a failed apply rolls the store back so Polyth
   *  and OpenCode never disagree about what is visible. */
  const commit = async (next: VisibilityState): Promise<VisibilityState> => {
    const before = state;
    state = parseVisibility(next);
    try {
      await opts.applier?.applyProviderVisibility({
        disabledProviders: state.disabledProviders,
        blacklists: blacklistsOf(state),
      });
    } catch (e) {
      state = before;
      throw err("conflict", `backend apply failed, change rolled back: ${(e as Error).message}`);
    }
    persist();
    return state;
  };

  return {
    state: () => state,
    providerEnabled: (providerID) => !state.disabledProviders.includes(providerID),
    modelEnabled: (m) => isModelVisible({ ...m, name: m.modelID }, state),
    filter: (models, o) => filterVisibleModels(models, state, o ?? {}),
    catalog: (models) => buildProviderCatalog(models, state),

    async seed(): Promise<void> {
      if (loaded || !opts.applier) return;
      try {
        state = visibilityFromBackendConfig(await opts.applier.readConfig());
        persist();
        loaded = true;
      } catch (e) {
        // A corrupt backend config must not brick boot; start empty in memory.
        console.warn("[polyth] model visibility seed skipped:", (e as Error).message);
      }
    },

    setProviderEnabled(providerID, enabled) {
      if (!providerID) throw err("invalid-input", "provider id required");
      const set = new Set(state.disabledProviders);
      if (enabled) set.delete(providerID);
      else set.add(providerID);
      return commit({ ...state, disabledProviders: [...set] });
    },

    setModelEnabled(key, enabled) {
      const i = key.indexOf("/");
      if (i <= 0 || i === key.length - 1) throw err("invalid-input", `model key must be "providerID/modelID", got "${key}"`);
      const set = new Set(state.disabledModels);
      if (enabled) set.delete(key);
      else set.add(key);
      return commit({ ...state, disabledModels: [...set] });
    },
  };
}
