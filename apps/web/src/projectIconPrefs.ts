export const PROJECT_ICON_RECENT_KEY = "polyth.projectAppearance.recentIcons.v2";
export const PROJECT_ICON_FAVORITES_KEY = "polyth.projectAppearance.favoriteIcons.v1";

export interface ProjectIconPrefs {
  recent: string[];
  favorites: string[];
}

const DEFAULTS: ProjectIconPrefs = { recent: [], favorites: [] };
const listeners = new Set<() => void>();

function readList(key: string, limit: number): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "[]") as unknown;
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string" && item.length <= 512).slice(0, limit)
      : [];
  } catch {
    return [];
  }
}

function read(): ProjectIconPrefs {
  return {
    recent: readList(PROJECT_ICON_RECENT_KEY, 24),
    favorites: readList(PROJECT_ICON_FAVORITES_KEY, 80),
  };
}

let prefs = read();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

export function getProjectIconPrefs(): ProjectIconPrefs {
  return { recent: [...prefs.recent], favorites: [...prefs.favorites] };
}

export function replaceProjectIconPrefs(value: unknown): void {
  const raw = value && typeof value === "object" ? value as Partial<ProjectIconPrefs> : {};
  prefs = {
    recent: Array.isArray(raw.recent)
      ? [...new Set(raw.recent.filter((item): item is string => typeof item === "string" && item.length <= 512))].slice(0, 24)
      : [...DEFAULTS.recent],
    favorites: Array.isArray(raw.favorites)
      ? [...new Set(raw.favorites.filter((item): item is string => typeof item === "string" && item.length <= 512))].slice(0, 80)
      : [...DEFAULTS.favorites],
  };
  try {
    localStorage.setItem(PROJECT_ICON_RECENT_KEY, JSON.stringify(prefs.recent));
    localStorage.setItem(PROJECT_ICON_FAVORITES_KEY, JSON.stringify(prefs.favorites));
  } catch { /* cache is best effort */ }
  notify();
}

export function setProjectIconPrefs(value: ProjectIconPrefs): void {
  replaceProjectIconPrefs(value);
}

export function subscribeProjectIconPrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
