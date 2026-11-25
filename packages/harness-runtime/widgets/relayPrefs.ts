// Relay UI preference: whether a Relay hand-over shows as a divider in the
// chat timeline. A pure per-person UI preference (never chat history). Local
// cache + subscription; the host mirrors it through the account settings
// transport via `host.preferences.register` (see index/runtime registration).
import { useSyncExternalStore } from "react";

export const RELAY_PREFS_KEY = "polyth.relayPrefs";
export const RELAY_PREFS_ID = "package.harness-runtime.relay";

export interface RelayPrefs {
  /** Show "Relay moved this chat to …" in the timeline. Default off. */
  showHandovers: boolean;
}
export const DEFAULT_RELAY_PREFS: RelayPrefs = { showHandovers: false };

const sanitize = (value: unknown): RelayPrefs => {
  const raw = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown; } catch { return undefined; } })() : value;
  return { showHandovers: typeof raw === "object" && raw !== null && (raw as { showHandovers?: unknown }).showHandovers === true };
};

const readLocal = (): RelayPrefs => {
  try { return typeof localStorage === "undefined" ? DEFAULT_RELAY_PREFS : sanitize(localStorage.getItem(RELAY_PREFS_KEY)); } catch { return DEFAULT_RELAY_PREFS; }
};

let prefs = readLocal();
const listeners = new Set<() => void>();

export const getRelayPrefs = (): RelayPrefs => prefs;

export function replaceRelayPrefs(value: unknown): void {
  const next = sanitize(value);
  if (next.showHandovers === prefs.showHandovers) return;
  prefs = next;
  try { localStorage.setItem(RELAY_PREFS_KEY, JSON.stringify(prefs)); } catch { /* storage unavailable: the synced copy stays authoritative */ }
  for (const listener of [...listeners]) listener();
}

export const subscribeRelayPrefs = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export const useRelayPrefs = (): RelayPrefs => useSyncExternalStore(subscribeRelayPrefs, getRelayPrefs, getRelayPrefs);
