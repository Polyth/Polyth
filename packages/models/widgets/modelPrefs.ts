// Reactive browser cache for server-owned, account-scoped model preferences.
// localStorage remains the synchronous bootstrap/migration cache; settingsSync
// mirrors the complete preference object to the authenticated Polyth server.
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

const emit = (): void => {
  for (const listener of [...listeners]) listener();
};

// The storage event keeps open tabs for the same authenticated account in sync.
// settingsSync observes the same listener set and mirrors those changes to the
// server, so another tab can never become a second persistence authority.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== accountStorageKey(MODEL_PREFS_KEY)) return;
    prefs = parseModelPrefs(event.newValue);
    emit();
  });
}

const commit = (next: ModelPrefs): void => {
  prefs = next;
  accountStorageSet(MODEL_PREFS_KEY, serializeModelPrefs(prefs));
  emit();
};

export function getModelPrefs(): ModelPrefs {
  return prefs;
}

/** Apply the authoritative server snapshot while refreshing the local cache. */
export function replaceModelPrefs(next: ModelPrefs): void {
  commit(next);
}

/** Shared subscription seam for React and server-settings synchronization. */
export function subscribeModelPrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
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

export function setModelProviderExpanded(providerId: string, expanded: boolean, harnessId?: string): void {
  commit(setProviderExpanded(prefs, providerId, expanded, harnessId));
}

export function reorderModelProviders(
  providerIds: readonly string[],
  draggedId: string,
  targetId: string,
  harnessId?: string,
): void {
  commit(reorderProvider(prefs, providerIds, draggedId, targetId, harnessId));
}

export function useModelPrefs(): ModelPrefs {
  return useSyncExternalStore(
    subscribeModelPrefs,
    getModelPrefs,
  );
}
