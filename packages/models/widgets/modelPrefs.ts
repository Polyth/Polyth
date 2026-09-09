// Reactive browser wrapper around account-owned model preferences.
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
import {
  accountStorageGet,
  accountStorageKey,
  accountStorageSet,
} from "@polyth/web/account-storage";

let prefs: ModelPrefs = parseModelPrefs(accountStorageGet(MODEL_PREFS_KEY));
const listeners = new Set<() => void>();

// localStorage remains browser-local, but its key is account-scoped. The
// storage event keeps open tabs for the same authenticated account in sync.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== accountStorageKey(MODEL_PREFS_KEY)) return;
    prefs = parseModelPrefs(event.newValue);
    for (const listener of [...listeners]) listener();
  });
}

const commit = (next: ModelPrefs): void => {
  prefs = next;
  accountStorageSet(MODEL_PREFS_KEY, serializeModelPrefs(prefs));
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
