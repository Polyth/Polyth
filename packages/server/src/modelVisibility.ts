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
import type {
  AvailableProviderDescriptor,
  CustomProviderConfigDto,
  CustomProviderProtocol,
  ModelDescriptor,
  ProviderOrigin,
  ProviderStatus,
} from "@polyth/contracts";
import { deriveProviderStatus } from "@polyth/contracts";
import { isCustomProviderEntry, protocolFromNpm } from "@polyth/backend-opencode";

export type AvailableProvider = AvailableProviderDescriptor;

/** A provider the user explicitly added via the "add a provider" picker.
 *  `name` is a display-name hint captured at add time (the row has no live
 *  model yet to source one from). */
export interface AddedProvider {
  id: string;
  name?: string;
  origin?: ProviderOrigin;
  protocol?: CustomProviderProtocol;
  authMode?: CustomProviderConfigDto["authMode"];
  hasStoredCredential?: boolean;
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
  origin: ProviderOrigin;
  enabled: boolean;
  configured: boolean;
  editable: boolean;
  removable: boolean;
  status: ProviderStatus;
  hasCredential: boolean;
  /** Runtime model-serving signal. Not the enable toggle. Kept for composer. */
  connected: boolean;
  models: ProviderCatalogModel[];
  custom?: CustomProviderConfigDto;
}

export interface ConfiguredProvider {
  id: string;
  name?: string;
  origin?: ProviderOrigin;
  protocol?: CustomProviderProtocol;
  authMode?: CustomProviderConfigDto["authMode"];
  baseURL?: string;
  hasHeaders?: boolean;
  headerNames?: string[];
  owned?: boolean;
  hasStoredCredential?: boolean;
  /** Models declared in the provider stanza (manual + last discovery). Shown
   *  even before OpenCode reloads and serves them. */
  models?: Array<{ id: string; name?: string; context?: number }>;
}

export interface VisibilityApplier {
  readConfig(): Promise<Record<string, unknown>>;
  applyProviderVisibility(v: { disabledProviders: string[]; blacklists: Record<string, string[]> }): Promise<void>;
}

/**
 * Durable per-account visibility. The Provider/Model toggles are account-owned
 * preferences: they follow the signed-in person onto every client, exactly like
 * the harness-model `modelPrefs` they sit next to in Settings → Harnesses.
 *
 * The host-global `model-visibility.json` store is NOT the account list — it is
 * the physical OpenCode mirror (`opencode.json` holds one config per host), and
 * it is also the migration seed for accounts that predate this section.
 * `write` persists the account's section into the synced client-settings blob;
 * the server broadcasts that blob so every other client converges.
 */
export interface VisibilityAccounts {
  /** The account's persisted `modelVisibility` section, or undefined when the
   *  account has never written one (callers then fall back to the seed). */
  read(userId: string): VisibilityState | undefined;
  /** Persist the section (undefined removes it, so the account sees the seed
   *  again). Returns false when there is no durable identity, so
   *  unattributed/background writes must not create the appearance of an
   *  account preference. */
  write(userId: string | undefined, state: VisibilityState | undefined): boolean;
  /** One entry per known account: its section, or undefined when it has none
   *  and therefore still sees the seed. Drives the physical OpenCode mirror:
   *  only what every account disables is written into the backend config. */
  states(): Array<VisibilityState | undefined>;
}

export interface ModelVisibilityService {
  /** Account-visible state. Without a userId this is the host seed/mirror
   *  state, which server-global code (custom-provider admin) still needs. */
  state(userId?: string): VisibilityState;
  providerEnabled(providerID: string, userId?: string): boolean;
  modelEnabled(m: { providerID: string; modelID: string }, userId?: string): boolean;
  /** Models the pickers may show: enabled and (by default) connected. */
  filter(models: ModelDescriptor[], opts?: { includeDisconnected?: boolean; userId?: string }): ModelDescriptor[];
  catalog(models: ModelDescriptor[], userId?: string): ProviderCatalogEntry[];
  /** Candidates for the "add a provider" picker: `live` + `authMethodIds`
   *  (from the backend) minus everything catalog() already shows. */
  available(
    models: ModelDescriptor[],
    live: readonly AvailableProvider[],
    authMethodIds: readonly string[],
    userId?: string,
  ): AvailableProvider[];
  setProviderEnabled(providerID: string, enabled: boolean, userId?: string): Promise<VisibilityState>;
  setModelEnabled(key: string, enabled: boolean, userId?: string): Promise<VisibilityState>;
  /** Explicitly add a zero-model provider so it appears in catalog(); resets
   *  any stale disabled flag so a freshly-added row starts enabled. */
  addProvider(
    providerID: string,
    name?: string,
    origin?: ProviderOrigin,
    meta?: {
      protocol?: CustomProviderProtocol;
      authMode?: CustomProviderConfigDto["authMode"];
      hasStoredCredential?: boolean;
    },
    userId?: string,
  ): Promise<VisibilityState>;
  /** Undo addProvider — hides the row again. Credentials, if any were set,
   *  are left alone; re-adding may reconnect for free. */
  removeProvider(providerID: string, userId?: string): Promise<VisibilityState>;
  /** Seed from the backend config when no local store exists yet. */
  seed(): Promise<void>;
}

/** Physical union across accounts: a provider is physically disabled only when
 *  every known account disables it, and a model likewise. Providers added by
 *  any account stay added. */
export function physicalUnion(states: readonly VisibilityState[]): VisibilityState {
  if (states.length === 0) return { disabledProviders: [], disabledModels: [], addedProviders: [] };
  const providerCounts = new Map<string, number>();
  const modelCounts = new Map<string, number>();
  const added = new Map<string, AddedProvider>();
  for (const state of states) {
    for (const id of new Set(state.disabledProviders)) providerCounts.set(id, (providerCounts.get(id) ?? 0) + 1);
    for (const key of new Set(state.disabledModels)) modelCounts.set(key, (modelCounts.get(key) ?? 0) + 1);
    for (const p of state.addedProviders) if (!added.has(p.id)) added.set(p.id, p);
  }
  const all = states.length;
  return {
    disabledProviders: [...providerCounts.entries()].filter(([, n]) => n >= all).map(([id]) => id).sort(),
    disabledModels: [...modelCounts.entries()].filter(([, n]) => n >= all).map(([key]) => key).sort(),
    addedProviders: [...added.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
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
      const origin = (entry as Record<string, unknown>).origin;
      const protocol = (entry as Record<string, unknown>).protocol;
      const authMode = (entry as Record<string, unknown>).authMode;
      const hasStoredCredential = (entry as Record<string, unknown>).hasStoredCredential;
      byId.set(id, {
        id,
        ...(typeof name === "string" && name ? { name } : {}),
        ...(origin === "builtin" || origin === "custom" || origin === "externally-configured"
          ? { origin }
          : {}),
        ...(protocol === "openai-compatible" || protocol === "openai-responses" ? { protocol } : {}),
        ...(authMode === "api-key" || authMode === "none" ? { authMode } : {}),
        ...(hasStoredCredential === true ? { hasStoredCredential: true } : {}),
      });
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

type CatalogDraft = Omit<ProviderCatalogEntry, "status">;

/** Drop Polyth-owned custom rows whose physical stanza never landed (restart
 *  before Apply & Restart). npm-matching stanzas without origin=custom stay
 *  externally-configured — never auto-own them. */
export function dropGhostCustomProviders(
  added: readonly AddedProvider[],
  physicalIds: ReadonlySet<string>,
): AddedProvider[] {
  return added.filter((row) => row.origin !== "custom" || physicalIds.has(row.id));
}

function modelsFromConfigEntry(rec: Record<string, unknown>): ConfiguredProvider["models"] {
  const raw = rec.models;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: NonNullable<ConfiguredProvider["models"]> = [];
  for (const [id, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!id.trim()) continue;
    const model = entry && typeof entry === "object" && !Array.isArray(entry)
      ? entry as Record<string, unknown>
      : {};
    const limit = model.limit && typeof model.limit === "object" && !Array.isArray(model.limit)
      ? model.limit as Record<string, unknown>
      : {};
    out.push({
      id,
      ...(typeof model.name === "string" && model.name ? { name: model.name } : {}),
      ...(typeof limit.context === "number" ? { context: limit.context } : {}),
    });
  }
  return out.length ? out : undefined;
}

function originOf(
  id: string,
  configuredById: ReadonlyMap<string, ConfiguredProvider>,
  addedById: ReadonlyMap<string, AddedProvider>,
): ProviderOrigin {
  return configuredById.get(id)?.origin ?? addedById.get(id)?.origin ?? "builtin";
}

export function buildProviderCatalog(
  models: ModelDescriptor[],
  state: VisibilityState,
  configuredProviders: readonly ConfiguredProvider[] = [],
): ProviderCatalogEntry[] {
  const configuredById = new Map(configuredProviders.filter((p) => p.id).map((p) => [p.id, p]));
  const addedById = new Map(state.addedProviders.map((p) => [p.id, p]));
  const disabledProviderIds = new Set(state.disabledProviders);
  const disabledModelKeys = new Set(state.disabledModels);
  const byProvider = new Map<string, CatalogDraft>();
  const modelKeys = new Map<string, Set<string>>();
  const put = (
    id: string,
    name: string,
    extras: {
      configured?: boolean;
      connected?: boolean;
      origin?: ProviderOrigin;
      editable?: boolean;
      removable?: boolean;
      hasCredential?: boolean;
      custom?: CustomProviderConfigDto;
    } = {},
  ): CatalogDraft => {
    const existing = byProvider.get(id);
    if (existing) {
      if (name && existing.name === existing.id) existing.name = name;
      if (extras.configured) existing.configured = true;
      if (extras.connected) existing.connected = true;
      if (extras.hasCredential) existing.hasCredential = true;
      if (extras.custom && !existing.custom) existing.custom = extras.custom;
      if (extras.origin && existing.origin === "builtin") existing.origin = extras.origin;
      if (extras.editable) existing.editable = true;
      if (extras.removable) existing.removable = true;
      return existing;
    }
    const configured = extras.configured ?? configuredById.has(id);
    const origin = extras.origin ?? originOf(id, configuredById, addedById);
    const ownedCustom = origin === "custom" && configuredById.get(id)?.owned !== false;
    const row: CatalogDraft = {
      id,
      // The bare id marks "no display name yet": a later source may upgrade it,
      // and whatever is still unnamed is humanized below.
      name: name || id,
      origin,
      enabled: !disabledProviderIds.has(id),
      configured,
      editable: extras.editable ?? ownedCustom,
      removable: extras.removable ?? (ownedCustom || addedById.has(id)),
      connected: extras.connected ?? false,
      hasCredential: extras.hasCredential ?? false,
      models: [],
      ...(extras.custom ? { custom: extras.custom } : {}),
    };
    byProvider.set(id, row);
    modelKeys.set(id, new Set());
    return row;
  };

  for (const provider of configuredProviders) {
    if (!provider.id) continue;
    const custom: CustomProviderConfigDto | undefined = provider.protocol && provider.baseURL
      ? {
          protocol: provider.protocol,
          baseURL: provider.baseURL,
          ...(provider.authMode === "none" || provider.authMode === "api-key"
            ? { authMode: provider.authMode }
            : {}),
          hasHeaders: provider.hasHeaders === true || (provider.headerNames?.length ?? 0) > 0,
          headerNames: provider.headerNames ?? [],
          ...(provider.models?.length
            ? { modelIDs: provider.models.map((model) => model.id) }
            : {}),
        }
      : undefined;
    const origin: ProviderOrigin = provider.origin
      ?? (provider.owned === true
        ? "custom"
        : provider.protocol && provider.owned === false
          ? "externally-configured"
          : "builtin");
    put(provider.id, provider.name || provider.id, {
      configured: true,
      origin,
      editable: origin === "custom" && provider.owned !== false,
      removable: origin === "custom" && provider.owned !== false,
      ...(typeof provider.hasStoredCredential === "boolean"
        ? { hasCredential: provider.hasStoredCredential }
        : {}),
      ...(custom ? { custom } : {}),
    });
  }
  for (const added of state.addedProviders) {
    put(added.id, added.name || added.id, {
      origin: added.origin,
      removable: true,
      ...(added.origin === "custom" ? { editable: true } : {}),
      ...(added.hasStoredCredential ? { hasCredential: true } : {}),
    });
  }
  // Disabled providers stay in the managed list even with zero models.
  for (const id of state.disabledProviders) {
    put(id, id, {});
  }

  for (const m of models) {
    const managed = byProvider.has(m.providerID);
    // Unconfigured, disconnected OpenCode catalogue rows stay in Add Provider.
    if (!managed && m.connected === false) continue;
    const entry = put(
      m.providerID,
      m.providerName ?? m.providerID,
      { connected: m.connected !== false },
    );
    if (m.connected !== false) {
      entry.connected = true;
    }
    const key = modelVisibilityKey(m);
    const seen = modelKeys.get(entry.id) ?? new Set<string>();
    if (seen.has(key)) continue;
    seen.add(key);
    modelKeys.set(entry.id, seen);
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
      enabled: entry.enabled && !disabledModelKeys.has(key),
    });
  }

  for (const provider of configuredProviders) {
    const entry = byProvider.get(provider.id);
    if (!entry || !provider.models) continue;
    const seen = modelKeys.get(entry.id) ?? new Set<string>();
    for (const model of provider.models) {
      const key = `${provider.id}/${model.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entry.models.push({
        providerID: provider.id,
        modelID: model.id,
        key,
        name: model.name || model.id,
        ...(model.context !== undefined ? { context: model.context } : {}),
        connected: false,
        enabled: entry.enabled && !disabledModelKeys.has(key),
      });
    }
  }

  const out = [...byProvider.values()].map((entry) => ({
    ...entry,
    // An OpenCode config entry without `name` (e.g. `command-code`) or a
    // provider OpenCode hides has no display name; a custom provider's name is
    // exactly what the user typed.
    name: entry.name === entry.id && entry.origin !== "custom" ? humanizeProviderId(entry.id) : entry.name,
    status: deriveProviderStatus({
      enabled: entry.enabled,
      configured: entry.configured,
      hasCredential: entry.hasCredential,
      connected: entry.connected,
      ...(entry.custom?.authMode === "none"
        ? { authRequired: false as const }
        : entry.custom?.authMode === "api-key"
          ? { authRequired: true as const }
          : {}),
    }),
  }));
  for (const p of out) p.models.sort((a, b) => a.name.localeCompare(b.name));
  out.sort((a, b) => {
    const rank = (p: ProviderCatalogEntry) => (p.enabled ? 0 : 1) + (p.connected ? 0 : 1);
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
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
  for (const id of state.disabledProviders) ids.add(id);
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

export function createModelVisibilityService(opts: {
  file: string;
  applier?: VisibilityApplier;
  /** Durable per-account sections (client-settings blob). Absent = legacy
   *  single-user behaviour, where the host store IS the only visibility. */
  accounts?: VisibilityAccounts;
  /** Called after an account's section is persisted so the server can sync it
   *  to that account's other clients. */
  onAccountChange?: (userId: string, state: VisibilityState) => void;
}): ModelVisibilityService {
  mkdirSync(dirname(opts.file), { recursive: true });

  let loaded = false;
  let seed: VisibilityState = { disabledProviders: [], disabledModels: [], addedProviders: [] };
  let configuredProviders: ConfiguredProvider[] = [];
  try {
    seed = parseVisibility(JSON.parse(readFileSync(opts.file, "utf8")));
    loaded = true;
  } catch { /* no store yet — seed() may fill it from the backend config */ }

  const persistSeed = () => atomicWriteSync(opts.file, `${JSON.stringify(seed, null, 2)}\n`);

  /** The state an account sees: its own durable section, else the host seed.
   *  A user id is required for account scoping; server-global callers (custom
   *  provider admin) intentionally read the seed. */
  const stateOf = (userId?: string): VisibilityState => {
    if (!userId || !opts.accounts) return seed;
    return opts.accounts.read(userId) ?? seed;
  };

  /** What the backend config must hold: a provider or model is physically
   *  disabled only when every account disables it. An account without a
   *  section votes with the seed, which it still sees. */
  const physicalState = (): VisibilityState => {
    if (!opts.accounts) return seed;
    const states = opts.accounts.states().map((state) => state ?? seed);
    return physicalUnion(states.length > 0 ? states : [seed]);
  };

  const apply = (state: VisibilityState) => opts.applier?.applyProviderVisibility({
    disabledProviders: state.disabledProviders,
    blacklists: blacklistsOf(state),
  });

  /** Persist the seed (no account) or an account's section, then mirror the
   *  physical union to the backend config. A failed apply rolls the write
   *  back, so Polyth and OpenCode never disagree about what is visible. */
  const commit = async (next: VisibilityState, userId?: string): Promise<VisibilityState> => {
    const parsed = parseVisibility(next);
    if (!userId || !opts.accounts) {
      const before = seed;
      seed = parsed;
      try {
        await apply(physicalState());
      } catch (e) {
        seed = before;
        throw err("conflict", `backend apply failed, change rolled back: ${(e as Error).message}`);
      }
      persistSeed();
      return seed;
    }
    const accounts = opts.accounts;
    const before = accounts.read(userId);
    if (!accounts.write(userId, parsed)) {
      throw err("conflict", "no durable account identity for this visibility change");
    }
    try {
      await apply(physicalState());
    } catch (e) {
      accounts.write(userId, before);
      throw err("conflict", `backend apply failed, change rolled back: ${(e as Error).message}`);
    }
    opts.onAccountChange?.(userId, parsed);
    return parsed;
  };

  return {
    state: (userId) => stateOf(userId),
    providerEnabled: (providerID, userId) => !stateOf(userId).disabledProviders.includes(providerID),
    modelEnabled: (m, userId) => isModelVisible({ ...m, name: m.modelID }, stateOf(userId)),
    filter: (models, o) => filterVisibleModels(models, stateOf(o?.userId), o ?? {}),
    catalog: (models, userId) => buildProviderCatalog(models, stateOf(userId), configuredProviders),
    available: (models, live, authMethodIds, userId) =>
      buildAvailableProviders(live, authMethodIds, shownProviderIds(models, stateOf(userId), configuredProviders)),

    async seed(): Promise<void> {
      if (!opts.applier) return;
      try {
        const config = await opts.applier.readConfig();
        const provider = config.provider;
        if (provider && typeof provider === "object" && !Array.isArray(provider)) {
          configuredProviders = Object.entries(provider as Record<string, unknown>).map(([id, entry]) => {
            const rec = entry && typeof entry === "object" && !Array.isArray(entry)
              ? entry as Record<string, unknown>
              : {};
            const custom = isCustomProviderEntry(rec);
            const options = rec.options && typeof rec.options === "object" && !Array.isArray(rec.options)
              ? rec.options as Record<string, unknown>
              : {};
            const baseURL = typeof options.baseURL === "string" ? options.baseURL : undefined;
            const added = seed.addedProviders.find((p) => p.id === id);
            const owned = added?.origin === "custom";
            const origin: ProviderOrigin | undefined = owned
              ? "custom"
              : custom
                ? "externally-configured"
                : added?.origin;
            const protocol = added?.protocol ?? protocolFromNpm(rec.npm);
            const headersRaw = options.headers && typeof options.headers === "object" && !Array.isArray(options.headers)
              ? options.headers as Record<string, unknown>
              : undefined;
            const headerNames = headersRaw
              ? Object.keys(headersRaw).filter((key) => typeof headersRaw[key] === "string")
              : [];
            const configModels = modelsFromConfigEntry(rec);
            return {
              id,
              ...(typeof rec.name === "string" ? { name: rec.name } : {}),
              ...(origin ? { origin } : {}),
              ...(protocol ? { protocol } : {}),
              ...(added?.authMode ? { authMode: added.authMode } : {}),
              ...(baseURL ? { baseURL } : {}),
              ...(headerNames.length ? { hasHeaders: true, headerNames } : {}),
              ...(owned ? { owned: true } : custom ? { owned: false } : {}),
              ...(added?.hasStoredCredential ? { hasStoredCredential: true } : {}),
              ...(configModels ? { models: configModels } : {}),
            };
          });
        }
        if (!loaded) {
          seed = visibilityFromBackendConfig(config);
          persistSeed();
          loaded = true;
        } else {
          const physicalIds = new Set(configuredProviders.map((p) => p.id));
          const nextAdded = dropGhostCustomProviders(seed.addedProviders, physicalIds);
          if (nextAdded.length !== seed.addedProviders.length) {
            seed = { ...seed, addedProviders: nextAdded };
            persistSeed();
          }
        }
      } catch (e) {
        // A corrupt backend config must not brick boot; start empty in memory.
        console.warn("[polyth] model visibility seed skipped:", (e as Error).message);
      }
    },

    setProviderEnabled(providerID, enabled, userId) {
      if (!providerID) throw err("invalid-input", "provider id required");
      const current = stateOf(userId);
      const set = new Set(current.disabledProviders);
      if (enabled) set.delete(providerID);
      else set.add(providerID);
      return commit({ ...current, disabledProviders: [...set] }, userId);
    },

    setModelEnabled(key, enabled, userId) {
      const i = key.indexOf("/");
      if (i <= 0 || i === key.length - 1) throw err("invalid-input", `model key must be "providerID/modelID", got "${key}"`);
      const current = stateOf(userId);
      const set = new Set(current.disabledModels);
      if (enabled) set.delete(key);
      else set.add(key);
      return commit({ ...current, disabledModels: [...set] }, userId);
    },

    addProvider(providerID, name, origin?: ProviderOrigin, meta?: {
      protocol?: CustomProviderProtocol;
      authMode?: CustomProviderConfigDto["authMode"];
      hasStoredCredential?: boolean;
    }, userId?: string) {
      if (!providerID) throw err("invalid-input", "provider id required");
      const current = stateOf(userId);
      const previous = current.addedProviders.find((p) => p.id === providerID);
      const nextAdded = [
        ...current.addedProviders.filter((p) => p.id !== providerID),
        {
          id: providerID,
          ...(name ? { name } : previous?.name ? { name: previous.name } : {}),
          ...(origin ? { origin } : previous?.origin ? { origin: previous.origin } : {}),
          ...(meta?.protocol ?? previous?.protocol
            ? { protocol: meta?.protocol ?? previous?.protocol }
            : {}),
          ...(meta?.authMode ?? previous?.authMode
            ? { authMode: meta?.authMode ?? previous?.authMode }
            : {}),
          ...((meta?.hasStoredCredential ?? previous?.hasStoredCredential)
            ? { hasStoredCredential: true as const }
            : {}),
        },
      ].sort((a, b) => a.id.localeCompare(b.id));
      const disabled = new Set(current.disabledProviders);
      disabled.delete(providerID); // a freshly-added provider starts enabled
      return commit({ ...current, addedProviders: nextAdded, disabledProviders: [...disabled] }, userId);
    },

    removeProvider(providerID, userId) {
      if (!providerID) throw err("invalid-input", "provider id required");
      const current = stateOf(userId);
      return commit({
        ...current,
        addedProviders: current.addedProviders.filter((p) => p.id !== providerID),
        disabledProviders: current.disabledProviders.filter((id) => id !== providerID),
      }, userId);
    },
  };
}
