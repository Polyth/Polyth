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
import { atomicWriteSync } from "@polyth/plugins";
import { dirname } from "node:path";
import type { AvailableProviderDescriptor, ModelDescriptor } from "@polyth/contracts";

export type AvailableProvider = AvailableProviderDescriptor;

/** A provider the user explicitly added via the "add a provider" picker.
 *  `name` is a display-name hint captured at add time (the row has no live
 *  model yet to source one from). */
export interface AddedProvider {
  id: string;
  name?: string;
}

export interface VisibilityState {
  /** Provider ids hidden entirely. */
  disabledProviders: string[];
  /** "providerID/modelID" keys disabled inside an otherwise-enabled provider. */
  disabledModels: string[];
  /** Providers explicitly added via the picker — shown even with zero models. */
  addedProviders: AddedProvider[];
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

export interface ConfiguredProvider {
  id: string;
  name?: string;
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
  /** Candidates for the "add a provider" picker: `live` + `authMethodIds`
   *  (from the backend) minus everything catalog() already shows. */
  available(
    models: ModelDescriptor[],
    live: readonly AvailableProvider[],
    authMethodIds: readonly string[],
  ): AvailableProvider[];
  setProviderEnabled(providerID: string, enabled: boolean): Promise<VisibilityState>;
  setModelEnabled(key: string, enabled: boolean): Promise<VisibilityState>;
  /** Explicitly add a zero-model provider so it appears in catalog(); resets
   *  any stale disabled flag so a freshly-added row starts enabled. */
  addProvider(providerID: string, name?: string): Promise<VisibilityState>;
  /** Undo addProvider — hides the row again. Credentials, if any were set,
   *  are left alone; re-adding may reconnect for free. */
  removeProvider(providerID: string): Promise<VisibilityState>;
  /** Seed from the backend config when no local store exists yet. */
  seed(): Promise<void>;
}

const err = (code: string, message: string) => Object.assign(new Error(message), { code });

const modelVisibilityKey = (m: { providerID: string; modelID: string }): string =>
  `${m.providerID}/${m.modelID}`;

/** Accepts plain id strings too (forward-compatible with a simpler shape),
 *  always normalizing to `{id, name?}`, deduped by id. */
function parseAddedProviders(v: unknown): AddedProvider[] {
  if (!Array.isArray(v)) return [];
  const byId = new Map<string, AddedProvider>();
  for (const entry of v) {
    if (typeof entry === "string" && entry) {
      if (!byId.has(entry)) byId.set(entry, { id: entry });
      continue;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const id = (entry as Record<string, unknown>).id;
    const name = (entry as Record<string, unknown>).name;
    if (typeof id === "string" && id) {
      byId.set(id, { id, ...(typeof name === "string" && name ? { name } : {}) });
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function parseVisibility(raw: unknown): VisibilityState {
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && x.length > 0))].sort() : [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { disabledProviders: [], disabledModels: [], addedProviders: [] };
  }
  const o = raw as Record<string, unknown>;
  return {
    disabledProviders: strings(o.disabledProviders),
    disabledModels: strings(o.disabledModels),
    addedProviders: parseAddedProviders(o.addedProviders),
  };
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

function isModelVisible(m: ModelDescriptor, state: VisibilityState): boolean {
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

export function buildProviderCatalog(
  models: ModelDescriptor[],
  state: VisibilityState,
  configuredProviders: readonly ConfiguredProvider[] = [],
): ProviderCatalogEntry[] {
  const byProvider = new Map<string, ProviderCatalogEntry>();
  for (const provider of configuredProviders) {
    if (!provider.id) continue;
    byProvider.set(provider.id, {
      id: provider.id,
      name: provider.name || provider.id,
      connected: false,
      enabled: !state.disabledProviders.includes(provider.id),
      models: [],
    });
  }
  for (const added of state.addedProviders) {
    if (byProvider.has(added.id)) continue;
    byProvider.set(added.id, {
      id: added.id,
      name: added.name || added.id,
      connected: false,
      enabled: !state.disabledProviders.includes(added.id),
      models: [],
    });
  }
  for (const m of models) {
    // OpenCode's full model catalog also contains providers without live
    // credentials. Keep those out of the settings list; they belong in the
    // add-provider picker. Configured/explicitly-added providers still get a
    // zero-model row above so they can be connected here.
    if (m.connected === false) continue;
    let entry = byProvider.get(m.providerID);
    if (!entry) {
      entry = {
        id: m.providerID,
        name: m.providerName ?? m.providerID,
        connected: true,
        enabled: !state.disabledProviders.includes(m.providerID),
        models: [],
      };
      byProvider.set(m.providerID, entry);
    }
    entry.connected = true;
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
      connected: true,
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

/** Ids already shown by catalog() — mirrors its inclusion rule so
 *  buildAvailableProviders never doubles up an already-visible provider. */
export function shownProviderIds(
  models: readonly Pick<ModelDescriptor, "providerID" | "connected">[],
  state: VisibilityState,
  configuredProviders: readonly ConfiguredProvider[] = [],
): Set<string> {
  const ids = new Set<string>();
  for (const p of configuredProviders) if (p.id) ids.add(p.id);
  for (const p of state.addedProviders) ids.add(p.id);
  for (const m of models) if (m.connected !== false) ids.add(m.providerID);
  return ids;
}

/** Best-effort display name for a provider OpenCode currently hides (e.g.
 *  disabled) and that has no login-flow label to borrow a name from. */
export function humanizeProviderId(id: string): string {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** Candidates for the "add a provider" picker. `live` is OpenCode's own
 *  provider list (already-disabled providers are absent from it);
 *  `authMethodIds` are ids with a registered login flow, which OpenCode keeps
 *  visible even while disabled — the only way a previously-disabled provider
 *  (e.g. Cursor) can still be found and re-added. */
export function buildAvailableProviders(
  live: readonly AvailableProvider[],
  authMethodIds: readonly string[],
  shown: ReadonlySet<string>,
): AvailableProvider[] {
  const byId = new Map<string, string>();
  for (const p of live) if (p.id && p.name) byId.set(p.id, p.name);
  for (const id of authMethodIds) if (!byId.has(id)) byId.set(id, humanizeProviderId(id));
  return [...byId.entries()]
    .filter(([id]) => !shown.has(id))
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
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
  let state: VisibilityState = { disabledProviders: [], disabledModels: [], addedProviders: [] };
  let configuredProviders: ConfiguredProvider[] = [];
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
    catalog: (models) => buildProviderCatalog(models, state, configuredProviders),
    available: (models, live, authMethodIds) =>
      buildAvailableProviders(live, authMethodIds, shownProviderIds(models, state, configuredProviders)),

    async seed(): Promise<void> {
      if (!opts.applier) return;
      try {
        const config = await opts.applier.readConfig();
        const provider = config.provider;
        if (provider && typeof provider === "object" && !Array.isArray(provider)) {
          configuredProviders = Object.entries(provider as Record<string, unknown>).map(([id, entry]) => ({
            id,
            ...(entry && typeof entry === "object" && !Array.isArray(entry)
              && typeof (entry as Record<string, unknown>).name === "string"
              ? { name: (entry as Record<string, unknown>).name as string }
              : {}),
          }));
        }
        if (!loaded) {
          state = visibilityFromBackendConfig(config);
          persist();
          loaded = true;
        }
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

    addProvider(providerID, name) {
      if (!providerID) throw err("invalid-input", "provider id required");
      const nextAdded = [
        ...state.addedProviders.filter((p) => p.id !== providerID),
        { id: providerID, ...(name ? { name } : {}) },
      ].sort((a, b) => a.id.localeCompare(b.id));
      const disabled = new Set(state.disabledProviders);
      disabled.delete(providerID); // a freshly-added provider starts enabled
      return commit({ ...state, addedProviders: nextAdded, disabledProviders: [...disabled] });
    },

    removeProvider(providerID) {
      if (!providerID) throw err("invalid-input", "provider id required");
      return commit({ ...state, addedProviders: state.addedProviders.filter((p) => p.id !== providerID) });
    },
  };
}
