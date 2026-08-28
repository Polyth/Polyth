// Reactive browser wrapper around model prefs. Persists polyth.modelPrefs.
import { useSyncExternalStore } from "react";
import {
  MODEL_PREFS_KEY,
  parseModelPrefs,
  recordRecent,
  reorderFavorite,
  reorderProvider,
  serializeModelPrefs,
  setProviderExpanded,
  toggleFavorite,
  type ModelPrefs,
  type ModelSort,
} from "@polyth/models";

const read = (): string | null => {
  try { return localStorage.getItem(MODEL_PREFS_KEY); } catch { return null; }
};
const write = (v: string): void => {
  try { localStorage.setItem(MODEL_PREFS_KEY, v); } catch { /* private mode */ }
};

let prefs: ModelPrefs = parseModelPrefs(read());
const listeners = new Set<() => void>();

const commit = (next: ModelPrefs): void => {
  prefs = next;
  write(serializeModelPrefs(prefs));
  for (const l of [...listeners]) l();
};

export function getModelPrefs(): ModelPrefs {
  return prefs;
}

export function toggleModelFavorite(key: string): void {
  commit(toggleFavorite(prefs, key));
}

/** Favorites reorder from the desktop drag list or the phone Edit controls. */
export function reorderModelFavorites(draggedKey: string, targetKey: string): void {
  commit(reorderFavorite(prefs, draggedKey, targetKey));
}

export function setModelSort(sort: ModelSort): void {
  commit({ ...prefs, sort });
}

export function noteModelUsed(key: string): void {
  commit(recordRecent(prefs, key));
}

export function setModelProviderExpanded(providerId: string, expanded: boolean): void {
  commit(setProviderExpanded(prefs, providerId, expanded));
}

export function reorderModelProviders(
  providerIds: readonly string[],
  draggedId: string,
  targetId: string,
): void {
  commit(reorderProvider(prefs, providerIds, draggedId, targetId));
}

export function useModelPrefs(): ModelPrefs {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    getModelPrefs,
  );
}
