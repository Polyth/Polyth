// Reactive wrapper around plugin-attributed @polyth/hotkeys actions: the shell
// matches keydowns against this map; Settings edits and persists it locally.
import { useSyncExternalStore } from "react";
import {
  DEFAULT_KEYMAP,
  HOTKEYS_KEY,
  parseKeymap,
  rebindKeymap,
  serializeKeymap,
  type HotkeyAction,
} from "@polyth/hotkeys";

type Keymap = Record<HotkeyAction, string>;

const read = (): string | null => {
  try { return localStorage.getItem(HOTKEYS_KEY); } catch { return null; }
};
const write = (v: string): void => {
  try { localStorage.setItem(HOTKEYS_KEY, v); } catch { /* private mode */ }
};

let keymap: Keymap = parseKeymap(read());
const listeners = new Set<() => void>();

export function getKeymap(): Keymap {
  return keymap;
}

export function setBinding(action: HotkeyAction, combo: string): void {
  keymap = rebindKeymap(keymap, action, combo);
  write(serializeKeymap(keymap));
  for (const l of [...listeners]) l();
}

export function resetKeymap(): void {
  keymap = { ...DEFAULT_KEYMAP };
  write(serializeKeymap(keymap));
  for (const l of [...listeners]) l();
}

export function useKeymap(): Keymap {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    getKeymap,
  );
}
