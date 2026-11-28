// Browser preferences for model-privacy marks. Local storage is the
// synchronous cache; the package registers this store with `host.preferences`
// so the account's settings sync carries it like other package preferences.
import { useSyncExternalStore } from "react";

export interface ModelPrivacyPrefs {
  /** Also mark zero-retention and kept-not-trained models. */
  showAll: boolean;
  /** The composer chip for a model that may keep or train on data. */
  composerChip: boolean;
}

export const MODEL_PRIVACY_PREFS_KEY = "polyth.modelPrivacyPrefs";

export const DEFAULT_MODEL_PRIVACY_PREFS: Readonly<ModelPrivacyPrefs> = Object.freeze({
  showAll: false,
  composerChip: true,
});

export function sanitizeModelPrivacyPrefs(value: unknown): ModelPrivacyPrefs {
  let raw = value;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = undefined;
    }
  }
  const record = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Partial<Record<keyof ModelPrivacyPrefs, unknown>>
    : {};
  return {
    showAll: typeof record.showAll === "boolean" ? record.showAll : DEFAULT_MODEL_PRIVACY_PREFS.showAll,
    composerChip: typeof record.composerChip === "boolean" ? record.composerChip : DEFAULT_MODEL_PRIVACY_PREFS.composerChip,
  };
}

const listeners = new Set<() => void>();
let cache: ModelPrivacyPrefs | undefined;

const samePrefs = (left: ModelPrivacyPrefs, right: ModelPrivacyPrefs): boolean =>
  left.showAll === right.showAll && left.composerChip === right.composerChip;

function readStorage(): ModelPrivacyPrefs {
  try {
    if (typeof localStorage !== "undefined") return sanitizeModelPrivacyPrefs(localStorage.getItem(MODEL_PRIVACY_PREFS_KEY));
  } catch {
    // Storage can be denied (private mode, sandboxed frames): defaults apply.
  }
  return { ...DEFAULT_MODEL_PRIVACY_PREFS };
}

const emit = (): void => {
  for (const listener of [...listeners]) listener();
};

export function getModelPrivacyPrefs(): ModelPrivacyPrefs {
  cache ??= readStorage();
  return cache;
}

/** Replace the whole record (the account-sync adapter writes this way). */
export function replaceModelPrivacyPrefs(value: unknown): void {
  const next = sanitizeModelPrivacyPrefs(value);
  if (samePrefs(next, getModelPrivacyPrefs())) return;
  cache = next;
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(MODEL_PRIVACY_PREFS_KEY, JSON.stringify(next));
  } catch {
    // The in-memory value still applies for this page.
  }
  emit();
}

export function updateModelPrivacyPrefs(patch: Partial<ModelPrivacyPrefs>): void {
  replaceModelPrivacyPrefs({ ...getModelPrivacyPrefs(), ...patch });
}

function onStorage(event: StorageEvent): void {
  if (event.key !== null && event.key !== MODEL_PRIVACY_PREFS_KEY) return;
  const next = readStorage();
  if (cache && samePrefs(next, cache)) return;
  cache = next;
  emit();
}

export function subscribeModelPrivacyPrefs(listener: () => void): () => void {
  if (listeners.size === 0 && typeof window !== "undefined") window.addEventListener("storage", onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

export function useModelPrivacyPrefs(): ModelPrivacyPrefs {
  return useSyncExternalStore(subscribeModelPrivacyPrefs, getModelPrivacyPrefs, getModelPrivacyPrefs);
}

/** Test seam. */
export function resetModelPrivacyPrefsCache(): void {
  cache = undefined;
}
