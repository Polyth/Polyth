// Reactive wrapper around plugin-attributed @polyth/hotkeys actions: the shell
// matches keydowns against this map; Settings edits and persists it locally.
import { useSyncExternalStore } from "react";
import {
  DEFAULT_KEYMAP,
  HOTKEYS_KEY,
  normalizeCombo,
  parseKeymap,
  rebindKeymap,
  serializeKeymap,
  type HotkeyAction,
} from "@polyth/hotkeys";

type Keymap = Record<HotkeyAction, string>;

const TERMINAL_SHORTCUT_MIGRATION_KEY = "polyth.hotkeys.terminalBacktick.v1";

const read = (): string | null => {
  try {
    let raw = localStorage.getItem(HOTKEYS_KEY);
    if (localStorage.getItem(TERMINAL_SHORTCUT_MIGRATION_KEY) !== "1") {
      // Some older clients persisted the complete keymap rather than only
      // overrides, leaving the former Ctrl+J default pinned forever. Migrate
      // that exact legacy value once; later user-selected Ctrl+J bindings stay.
      try {
        const stored = JSON.parse(raw ?? "") as Record<string, unknown>;
        if (
          typeof stored.viewTerminal === "string"
          && normalizeCombo(stored.viewTerminal) === "mod+j"
        ) {
          delete stored.viewTerminal;
          raw = JSON.stringify(stored);
          localStorage.setItem(HOTKEYS_KEY, raw);
        }
      } catch {
        // Invalid storage already falls back through parseKeymap().
      }
      localStorage.setItem(TERMINAL_SHORTCUT_MIGRATION_KEY, "1");
    }
    return raw;
  } catch {
    return null;
  }
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
