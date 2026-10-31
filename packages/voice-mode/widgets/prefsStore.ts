// Voice mode preferences: local cache + subscription. The host mirrors them
// through the account settings transport via `host.preferences.register`.
import { useSyncExternalStore } from "react";
import { VOICE_MODE_PREFS_KEY, parseVoiceModePrefs, type VoiceModePrefs } from "../src/prefs.ts";

const read = (): string | null => {
  try { return localStorage.getItem(VOICE_MODE_PREFS_KEY); } catch { return null; }
};

let prefs: VoiceModePrefs = parseVoiceModePrefs(read());
const listeners = new Set<() => void>();

const publish = () => {
  try { localStorage.setItem(VOICE_MODE_PREFS_KEY, JSON.stringify(prefs)); } catch { /* private mode */ }
  for (const listener of [...listeners]) listener();
};

export function getVoiceModePrefs(): VoiceModePrefs {
  return prefs;
}

export function replaceVoiceModePrefs(value: unknown): void {
  prefs = parseVoiceModePrefs(JSON.stringify(value));
  publish();
}

export function setVoiceModePrefs(patch: Partial<VoiceModePrefs>): void {
  prefs = parseVoiceModePrefs(JSON.stringify({ ...prefs, ...patch }));
  publish();
}

export function subscribeVoiceModePrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useVoiceModePrefs(): VoiceModePrefs {
  return useSyncExternalStore(subscribeVoiceModePrefs, getVoiceModePrefs, getVoiceModePrefs);
}
