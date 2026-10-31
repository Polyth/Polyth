// Model preferences: favorites, provider/model sort, search. Pure logic —
// the web layer keeps a synchronous account-local cache while the canonical
// preference object is mirrored through the server-backed client settings blob.

export type ModelSort = "provider" | "name" | "recent";

export interface ModelPrefs {
  favorites: string[];      // "providerID/modelID" keys, insertion order
  sort: ModelSort;
  recents: string[];        // most-recent-first "providerID/modelID" keys
  providerOrder: string[];     // harness-qualified "harness::provider" keys
  expandedProviders: string[]; // harness-qualified "harness::provider" keys
  /** Providers switched off in this account's model picker
   *  ("harness::provider"). The switch is a bulk change: the provider's
   *  models, including ones it adds later, stay out unless turned back on one
   *  by one (`shownModels`). Presentation only: routes keep working. */
  hiddenProviders: string[];
  /** Single models left out of a provider that is on ("harness::provider/model"). */
  hiddenModels: string[];
  /** Single models turned back on inside a provider that is off. */
  shownModels: string[];
}

export interface ModelLike {
  harnessId?: string;
  providerID: string;
  modelID: string;
  name?: string;
}

export const MODEL_PREFS_KEY = "polyth.modelPrefs";

export const modelKey = (m: ModelLike): string => `${m.harnessId ? `${m.harnessId}::` : ""}${m.providerID}/${m.modelID}`;
export const providerPreferenceKey = (harnessId: string | undefined, providerId: string): string =>
  providerId.includes("::") ? providerId : `${harnessId || "opencode"}::${providerId}`;

export function defaultModelPrefs(): ModelPrefs {
  return { favorites: [], sort: "provider", recents: [], providerOrder: [], expandedProviders: [], hiddenProviders: [], hiddenModels: [], shownModels: [] };
}

/** Bounds for the synced preference blob. A provider switch hides any number
 *  of models with one key; single-model keys are for the exceptions. */
const MAX_HIDDEN_PROVIDERS = 200;
const MAX_HIDDEN_MODELS = 2000;
/** "harness::provider" — the hidden lists never guess a harness. */
const QUALIFIED_PROVIDER = /^[^:/\s]+::[^/\s]+$/;
/** "harness::provider/model" */
const QUALIFIED_MODEL = /^[^:/\s]+::[^/\s]+\/.+$/;
/** "harness::provider" of a qualified model key (a provider id has no "/"). */
const providerOfModelKey = (key: string): string => key.slice(0, key.indexOf("/"));

export function parseModelPrefs(raw: string | null): ModelPrefs {
  try {
    const data = JSON.parse(raw ?? "") as Partial<ModelPrefs>;
    const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    // Favorites predate harness support and were exclusively populated by
    // OpenCode's provider catalog. Their origin is therefore known.
    const modelKeys = (v: unknown): string[] => strs(v).map((key) => key.includes("::") ? key : `opencode::${key}`);
    // Provider preferences predate the multi-harness picker and therefore
    // belong to OpenCode when they have no explicit harness qualifier.
    const providerKeys = (v: unknown): string[] => strs(v).map((key) =>
      key.includes("::") ? key : providerPreferenceKey("opencode", key));
    const sort: ModelSort = data.sort === "name" || data.sort === "recent" ? data.sort : "provider";
    const hiddenProviders = [...new Set(strs(data.hiddenProviders).filter((key) => QUALIFIED_PROVIDER.test(key)))].slice(0, MAX_HIDDEN_PROVIDERS);
    const off = new Set(hiddenProviders);
    // A single-model choice only means something against its provider's
    // switch: hidden inside a provider that is on, shown inside one that is off.
    const exceptions = (v: unknown, providerOff: boolean): string[] =>
      [...new Set(strs(v).filter((key) => QUALIFIED_MODEL.test(key) && off.has(providerOfModelKey(key)) === providerOff))].slice(0, MAX_HIDDEN_MODELS);
    return {
      favorites: [...new Set(modelKeys(data.favorites))],
      sort,
      recents: [...new Set(modelKeys(data.recents))].slice(0, 20),
      providerOrder: [...new Set(providerKeys(data.providerOrder))].slice(0, 100),
      expandedProviders: [...new Set(providerKeys(data.expandedProviders))].slice(0, 100),
      hiddenProviders,
      hiddenModels: exceptions(data.hiddenModels, false),
      shownModels: exceptions(data.shownModels, true),
    };
  } catch {
    return defaultModelPrefs();
  }
}

export function serializeModelPrefs(p: ModelPrefs): string {
  return JSON.stringify(p);
}

export function isFavorite(p: ModelPrefs, key: string): boolean {
  return p.favorites.includes(key);
}

export function toggleFavorite(p: ModelPrefs, key: string): ModelPrefs {
  return {
    ...p,
    favorites: p.favorites.includes(key) ? p.favorites.filter((k) => k !== key) : [...p.favorites, key],
  };
}

/** Move `draggedKey` in front of `targetKey` inside the saved favorites order.
 *  Desktop drag-and-drop uses this ordering seam; unknown keys and self-moves
 *  are no-ops. */
export function reorderFavorite(p: ModelPrefs, draggedKey: string, targetKey: string): ModelPrefs {
  if (draggedKey === targetKey) return p;
  if (!p.favorites.includes(draggedKey) || !p.favorites.includes(targetKey)) return p;
  const favorites = p.favorites.filter((k) => k !== draggedKey);
  favorites.splice(favorites.indexOf(targetKey), 0, draggedKey);
  return { ...p, favorites };
}

export function recordRecent(p: ModelPrefs, key: string): ModelPrefs {
  return { ...p, recents: [key, ...p.recents.filter((k) => k !== key)].slice(0, 20) };
}

export function setProviderExpanded(
  p: ModelPrefs,
  providerId: string,
  expanded: boolean,
  harnessId?: string,
): ModelPrefs {
  const key = providerPreferenceKey(harnessId, providerId);
  return {
    ...p,
    expandedProviders: expanded
      ? [...p.expandedProviders.filter((id) => id !== key), key]
      : p.expandedProviders.filter((id) => id !== key),
  };
}

export function reorderProvider(
  p: ModelPrefs,
  providerIds: readonly string[],
  draggedId: string,
  targetId: string,
  harnessId?: string,
): ModelPrefs {
  const visibleKeys = providerIds.map((id) => providerPreferenceKey(harnessId, id));
  const draggedKey = providerPreferenceKey(harnessId, draggedId);
  const targetKey = providerPreferenceKey(harnessId, targetId);
  const ordered = [
    ...p.providerOrder.filter((id) => visibleKeys.includes(id)),
    ...visibleKeys.filter((id) => !p.providerOrder.includes(id)),
  ];
  const from = ordered.indexOf(draggedKey);
  const to = ordered.indexOf(targetKey);
  if (from < 0 || to < 0 || from === to) return p;
  const next = [...ordered];
  const [dragged] = next.splice(from, 1);
  if (!dragged) return p;
  next.splice(to, 0, dragged);
  const reordered = [...next];
  const visible = new Set(visibleKeys);
  let cursor = 0;
  const providerOrder = p.providerOrder.map((id) =>
    visible.has(id) ? reordered[cursor++]! : id);
  providerOrder.push(...reordered.slice(cursor));
  return { ...p, providerOrder };
}

export function orderProviders<T extends { id: string }>(
  providers: readonly T[],
  p: ModelPrefs,
  harnessId?: string,
): T[] {
  const rank = new Map(p.providerOrder.map((id, index) => [id, index]));
  return providers
    .map((provider, index) => ({ provider, index }))
    .sort((a, b) =>
      (rank.get(providerPreferenceKey(harnessId, a.provider.id)) ?? Number.MAX_SAFE_INTEGER)
      - (rank.get(providerPreferenceKey(harnessId, b.provider.id)) ?? Number.MAX_SAFE_INTEGER)
      || a.index - b.index)
    .map(({ provider }) => provider);
}

/** A predicate that is true for a model this account's picker leaves out: a
 *  provider that is off hides its models except the ones turned back on, a
 *  provider that is on shows its models except the ones turned off. Build it
 *  once per list. */
export function hiddenModelMatcher(p: Pick<ModelPrefs, "hiddenProviders" | "hiddenModels" | "shownModels">) {
  const providers = new Set(p.hiddenProviders);
  const hidden = new Set(p.hiddenModels);
  const shown = new Set(p.shownModels);
  return (model: ModelLike, fallbackHarnessId?: string): boolean => {
    if (providers.size === 0 && hidden.size === 0) return false;
    const harnessId = model.harnessId ?? fallbackHarnessId ?? "opencode";
    const key = `${harnessId}::${model.providerID}/${model.modelID}`;
    return providers.has(`${harnessId}::${model.providerID}`) ? !shown.has(key) : hidden.has(key);
  };
}

/** The provider switch for a qualified "harness::provider" key. */
function switchProvider(p: ModelPrefs, key: string, hidden: boolean): ModelPrefs {
  const prefix = `${key}/`;
  const rest = p.hiddenProviders.filter((id) => id !== key);
  return {
    ...p,
    hiddenProviders: hidden ? [...rest, key].slice(-MAX_HIDDEN_PROVIDERS) : rest,
    hiddenModels: p.hiddenModels.filter((model) => !model.startsWith(prefix)),
    shownModels: p.shownModels.filter((model) => !model.startsWith(prefix)),
  };
}

/** A provider switch is a bulk change over the provider's models: off leaves
 *  them all out (also ones the provider adds later), on brings them all back.
 *  Either way the provider's single-model choices start over. */
export function setProviderHidden(p: ModelPrefs, harnessId: string, providerId: string, hidden: boolean): ModelPrefs {
  const key = providerPreferenceKey(harnessId, providerId);
  return QUALIFIED_PROVIDER.test(key) ? switchProvider(p, key, hidden) : p;
}

/** Turn single models (harness-qualified keys) off or on, whatever their
 *  provider's switch says. `catalog` (the harness's model keys) lets a
 *  provider whose every model now reads the opposite of its switch fold into
 *  the switch, so the models it adds later follow that choice too. */
export function setModelsHidden(p: ModelPrefs, keys: readonly string[], hidden: boolean, catalog: readonly string[] = []): ModelPrefs {
  const valid = [...new Set(keys.filter((key) => QUALIFIED_MODEL.test(key)))];
  if (valid.length === 0) return p;
  const off = new Set(p.hiddenProviders);
  const changed = new Set(valid);
  // Under a provider that is off, a model turned on is the exception; under
  // one that is on, a model turned off is.
  const exceptions = valid.filter((key) => off.has(providerOfModelKey(key)) !== hidden);
  let next: ModelPrefs = {
    ...p,
    hiddenModels: [...p.hiddenModels.filter((key) => !changed.has(key)), ...(hidden ? exceptions : [])].slice(-MAX_HIDDEN_MODELS),
    shownModels: [...p.shownModels.filter((key) => !changed.has(key)), ...(hidden ? [] : exceptions)].slice(-MAX_HIDDEN_MODELS),
  };
  for (const provider of new Set(valid.map(providerOfModelKey))) {
    const models = catalog.filter((key) => key.startsWith(`${provider}/`));
    const providerOff = next.hiddenProviders.includes(provider);
    const against = new Set(providerOff ? next.shownModels : next.hiddenModels);
    if (models.length > 0 && models.every((key) => against.has(key))) next = switchProvider(next, provider, !providerOff);
  }
  return next;
}

/** Every provider and model of one harness back in the picker. */
export function showHarnessModels(p: ModelPrefs, harnessId: string): ModelPrefs {
  const prefix = `${harnessId}::`;
  return {
    ...p,
    hiddenProviders: p.hiddenProviders.filter((key) => !key.startsWith(prefix)),
    hiddenModels: p.hiddenModels.filter((key) => !key.startsWith(prefix)),
    shownModels: p.shownModels.filter((key) => !key.startsWith(prefix)),
  };
}

/** Favorites always float first (their own saved order), then the chosen sort. */
export function sortModels<T extends ModelLike>(models: readonly T[], p: ModelPrefs): T[] {
  const favRank = new Map(p.favorites.map((k, i) => [k, i]));
  const recRank = new Map(p.recents.map((k, i) => [k, i]));
  const label = (m: T): string => (m.name || m.modelID).toLowerCase();
  return [...models].sort((a, b) => {
    const fa = favRank.get(modelKey(a)) ?? Infinity;
    const fb = favRank.get(modelKey(b)) ?? Infinity;
    if (fa !== fb) return fa - fb;
    if (p.sort === "name") return label(a).localeCompare(label(b));
    if (p.sort === "recent") {
      const ra = recRank.get(modelKey(a)) ?? Infinity;
      const rb = recRank.get(modelKey(b)) ?? Infinity;
      if (ra !== rb) return ra - rb;
    }
    return a.providerID.localeCompare(b.providerID) || label(a).localeCompare(label(b));
  });
}

export function filterModels<T extends ModelLike>(models: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...models];
  return models.filter((m) =>
    [m.providerID, m.modelID, m.name ?? ""].some((v) => v.toLowerCase().includes(q)),
  );
}

// ---------------------------------------------------------------- agent profiles

export interface ProfileLike {
  harnessId?: string;
  providerID: string;
  modelID: string;
  agent?: string;
  thinking?: string;
}

export interface ProfileRepair { field: string; from: string; to: string; reason: string }

export const THINKING_LEVELS = ["", "default", "low", "medium", "high"] as const;

/** Validate a profile against current capabilities. Pure: repairs are
 *  *proposed*, never silently persisted — the caller applies them visibly.
 *  When the adapter reported nothing (no models), nothing is checkable. */
export function validateProfile(
  profile: ProfileLike,
  models: readonly ModelLike[],
  agents: readonly { name: string; harnessId?: string }[],
): { valid: boolean; checked: boolean; repairs: ProfileRepair[] } {
  if (models.length === 0) return { valid: true, checked: false, repairs: [] };
  const repairs: ProfileRepair[] = [];
  const scopedModels = profile.harnessId
    ? models.filter((model) => model.harnessId === profile.harnessId)
    : models;
  const scopedAgents = profile.harnessId
    ? agents.filter((agent) => agent.harnessId === profile.harnessId)
    : agents;
  if (scopedModels.length === 0) return { valid: true, checked: false, repairs: [] };
  const key = `${profile.providerID}/${profile.modelID}`;
  if (!scopedModels.some((m) => m.providerID === profile.providerID && m.modelID === profile.modelID)) {
    const fallback = scopedModels[0]!;
    repairs.push({
      field: "model",
      from: key,
      to: `${fallback.providerID}/${fallback.modelID}`,
      reason: "model is no longer available from any provider",
    });
  }
  if (profile.agent && agents.length > 0 && !scopedAgents.some((a) => a.name === profile.agent)) {
    repairs.push({ field: "agent", from: profile.agent, to: "", reason: "agent preset is not available" });
  }
  if (profile.thinking !== undefined && !THINKING_LEVELS.includes(profile.thinking as typeof THINKING_LEVELS[number])) {
    repairs.push({ field: "thinking", from: profile.thinking, to: "default", reason: "unsupported thinking level" });
  }
  return { valid: repairs.length === 0, checked: true, repairs };
}

/** One-time favorites→profiles migration plan. Idempotent by construction:
 *  favorites whose provider/model already has a profile are skipped, so
 *  re-running produces an empty plan. */
export function planFavoriteMigration(
  prefs: ModelPrefs,
  models: readonly ModelLike[],
  existingProfiles: readonly ProfileLike[],
): Array<{ providerID: string; modelID: string; name: string }> {
  const covered = new Set(existingProfiles.map((p) => modelKey(p)));
  const out: Array<{ providerID: string; modelID: string; name: string }> = [];
  for (const key of prefs.favorites) {
    if (covered.has(key)) continue;
    const model = models.find((m) => modelKey(m) === key);
    if (!model) continue; // vanished model: nothing sensible to migrate
    covered.add(key);
    out.push({ providerID: model.providerID, modelID: model.modelID, name: model.name || model.modelID });
  }
  return out;
}

export {
  CUSTOM_PROVIDER_ADAPTERS,
  PROVIDER_ID_PATTERN,
  redactProviderError,
  slugifyProviderId,
  uniqueProviderId,
  validateAuthMode,
  validateCustomProviderInput,
  validateHeaderPatch,
  validateProtocol,
  validateProviderBaseURL,
  validateProviderId,
} from "./customProvider.ts";
export type { CustomProviderInput, ValidatedCustomProvider } from "./customProvider.ts";

export {
  deriveProviderStatus,
  filterProviderModels,
} from "./providerStatus.ts";
export type { ProviderStatusInput } from "./providerStatus.ts";

export { createProviderManager } from "./providerManager.ts";
export type { ProviderManager, VisibilityPort } from "./providerManager.ts";
