// Model preferences: favorites, provider/model sort, search. Pure logic —
// the web app persists the serialized form under localStorage "polyth.modelPrefs"
// and feeds it to the picker + Settings Providers/Models page.

export type ModelSort = "provider" | "name" | "recent";

export interface ModelPrefs {
  favorites: string[];      // "providerID/modelID" keys, insertion order
  sort: ModelSort;
  recents: string[];        // most-recent-first "providerID/modelID" keys
}

export interface ModelLike {
  providerID: string;
  modelID: string;
  name?: string;
}

export const MODEL_PREFS_KEY = "polyth.modelPrefs";

export const modelKey = (m: ModelLike): string => `${m.providerID}/${m.modelID}`;

export function defaultModelPrefs(): ModelPrefs {
  return { favorites: [], sort: "provider", recents: [] };
}

export function parseModelPrefs(raw: string | null): ModelPrefs {
  try {
    const data = JSON.parse(raw ?? "") as Partial<ModelPrefs>;
    const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    const sort: ModelSort = data.sort === "name" || data.sort === "recent" ? data.sort : "provider";
    return {
      favorites: [...new Set(strs(data.favorites))],
      sort,
      recents: [...new Set(strs(data.recents))].slice(0, 20),
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

export function recordRecent(p: ModelPrefs, key: string): ModelPrefs {
  return { ...p, recents: [key, ...p.recents.filter((k) => k !== key)].slice(0, 20) };
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
