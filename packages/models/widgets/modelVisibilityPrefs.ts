// Account-scoped provider/model visibility for the "Providers & Models" page.
//
// This is the browser cache of the same account-owned list the server keeps in
// the synced client-settings blob (`modelVisibility`). It is the display half
// of the toggle pair: `modelPrefs` hides *harness-qualified* models in the
// composer picker, while this list hides entries of the OpenCode provider
// catalogue. Both are per-user and follow the account onto every client, which
// is why this is a synced section and NOT a host-global store.
//
// The server remains authoritative: it writes the section, broadcasts the blob
// to every client of the account, and the page reads its catalogue already
// filtered for the requesting user. This module only keeps the local view in
// step while a mutation is in flight and across inbound frames.
import { useSyncExternalStore } from "react";

/** Shape written by the server. Kept structural so the browser bundle does not
 *  import server-only modules. */
export interface ModelVisibilityPrefs {
  disabledProviders: string[];
  disabledModels: string[];
  addedProviders: string[];
}

const EMPTY: ModelVisibilityPrefs = { disabledProviders: [], disabledModels: [], addedProviders: [] };

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0))].sort()
    : [];

/** Parse a server section defensively — an older or hand-edited blob must never
 *  break the page, and the field set is exactly the three toggle lists. */
export function parseModelVisibilityPrefs(value: unknown): ModelVisibilityPrefs {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...EMPTY };
  const raw = value as Record<string, unknown>;
  const added = Array.isArray(raw.addedProviders)
    ? raw.addedProviders.flatMap((entry): string[] => {
        if (typeof entry === "string" && entry) return [entry];
        if (entry && typeof entry === "object" && !Array.isArray(entry)) {
          const id = (entry as Record<string, unknown>).id;
          return typeof id === "string" && id ? [id] : [];
        }
        return [];
      })
    : [];
  return {
    disabledProviders: strings(raw.disabledProviders),
    disabledModels: strings(raw.disabledModels),
    addedProviders: [...new Set(added)].sort(),
  };
}

let prefs: ModelVisibilityPrefs = { ...EMPTY };
const listeners = new Set<() => void>();

const emit = (): void => {
  for (const listener of [...listeners]) listener();
};

export function getModelVisibilityPrefs(): ModelVisibilityPrefs {
  return prefs;
}

/** Apply the authoritative server snapshot (boot, reconnect, or WS frame).
 *  No-op when nothing changed so inbound echoes cannot loop. */
export function replaceModelVisibilityPrefs(next: ModelVisibilityPrefs): void {
  const normalized = parseModelVisibilityPrefs(next);
  if (JSON.stringify(normalized) === JSON.stringify(prefs)) return;
  prefs = normalized;
  emit();
}

export function subscribeModelVisibilityPrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Local optimistic overlay for one toggle so the switch responds immediately;
 *  the server's next snapshot (or the mutation response) is authoritative. */
export function setLocalProviderEnabled(providerID: string, enabled: boolean): void {
  const set = new Set(prefs.disabledProviders);
  if (enabled) set.delete(providerID); else set.add(providerID);
  replaceModelVisibilityPrefs({ ...prefs, disabledProviders: [...set] });
}

export function setLocalModelEnabled(key: string, enabled: boolean): void {
  if (!key.includes("/")) return;
  const set = new Set(prefs.disabledModels);
  if (enabled) set.delete(key); else set.add(key);
  replaceModelVisibilityPrefs({ ...prefs, disabledModels: [...set] });
}

export function useModelVisibilityPrefs(): ModelVisibilityPrefs {
  return useSyncExternalStore(subscribeModelVisibilityPrefs, getModelVisibilityPrefs);
}
