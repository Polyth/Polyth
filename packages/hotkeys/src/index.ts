// Editable hotkey map. Combos are stored as "mod+shift+k" strings ("mod" =
// ⌘ on Apple platforms, Ctrl elsewhere). The shell matches keydown events
// against the map; Settings > Shortcuts edits and persists it under
// localStorage "polyth.hotkeys".

export type HotkeyAction =
  | "palette"
  | "searchFiles"
  | "searchSessions"
  | "settings"
  | "newSession"
  | "focusComposer"
  | "viewFiles"
  | "viewGit"
  | "viewTerminal";

export const HOTKEYS_KEY = "polyth.hotkeys";

export const HOTKEY_ACTIONS: ReadonlyArray<{ id: HotkeyAction; label: string }> = [
  { id: "palette", label: "Command palette" },
  { id: "searchFiles", label: "Search files" },
  { id: "searchSessions", label: "Search sessions" },
  { id: "settings", label: "Settings" },
  { id: "newSession", label: "New session" },
  { id: "focusComposer", label: "Focus composer" },
  { id: "viewFiles", label: "Files view" },
  { id: "viewGit", label: "Git view" },
  { id: "viewTerminal", label: "Terminal view" },
];

export const DEFAULT_KEYMAP: Record<HotkeyAction, string> = {
  palette: "mod+k",
  searchFiles: "mod+p",
  searchSessions: "mod+shift+f",
  settings: "mod+,",
  newSession: "mod+n",
  focusComposer: "mod+i",
  viewFiles: "mod+shift+e",
  viewGit: "mod+shift+g",
  viewTerminal: "mod+j",
};

export interface KeyEventLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

const MODIFIER_KEYS = new Set(["meta", "control", "ctrl", "shift", "alt", "os"]);
const NAMED_KEYS = new Set([
  "escape", "enter", "tab", "space", "backspace", "delete", "home", "end",
  "pageup", "pagedown", "arrowup", "arrowdown", "arrowleft", "arrowright",
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]);
const validKey = (key: string): boolean => key.length === 1 || NAMED_KEYS.has(key);

/** Normalize a combo string: lowercase, ordered mods, single main key. */
export function normalizeCombo(raw: string): string | null {
  const parts = raw.toLowerCase().split("+").map((p) => p.trim()).filter(Boolean);
  const mods = { mod: false, shift: false, alt: false };
  let key = "";
  for (const p of parts) {
    if (p === "mod" || p === "meta" || p === "cmd" || p === "ctrl" || p === "control") mods.mod = true;
    else if (p === "shift") mods.shift = true;
    else if (p === "alt" || p === "option") mods.alt = true;
    else if (!key) key = p;
    else return null; // two main keys
  }
  if (!key || MODIFIER_KEYS.has(key) || !validKey(key)) return null;
  return [mods.mod ? "mod" : "", mods.shift ? "shift" : "", mods.alt ? "alt" : "", key].filter(Boolean).join("+");
}

/** Combo of a keydown event, or null when only modifiers are down. */
export function comboFromEvent(e: KeyEventLike): string | null {
  const key = e.key.toLowerCase();
  if (MODIFIER_KEYS.has(key)) return null;
  return [
    e.metaKey || e.ctrlKey ? "mod" : "",
    e.shiftKey ? "shift" : "",
    e.altKey ? "alt" : "",
    key,
  ].filter(Boolean).join("+");
}

/** Merge stored overrides with defaults; unknown actions and bad combos drop. */
export function parseKeymap(raw: string | null): Record<HotkeyAction, string> {
  const map = { ...DEFAULT_KEYMAP };
  try {
    const data = JSON.parse(raw ?? "") as Record<string, unknown>;
    for (const { id } of HOTKEY_ACTIONS) {
      const v = data[id];
      if (typeof v === "string") {
        const norm = normalizeCombo(v);
        if (norm) map[id] = norm;
      }
    }
  } catch {
    // defaults
  }
  return resolveKeymapConflicts(map);
}

/** Repair legacy or hand-edited maps so each combo has one owner. When a
 * duplicate appears, the later action receives the first unused default. */
export function resolveKeymapConflicts(
  map: Record<HotkeyAction, string>,
): Record<HotkeyAction, string> {
  const next = { ...map };
  const used = new Set<string>();
  const defaults = HOTKEY_ACTIONS.map(({ id }) => DEFAULT_KEYMAP[id]);
  for (const { id } of HOTKEY_ACTIONS) {
    const wanted = next[id];
    if (!used.has(wanted)) {
      used.add(wanted);
      continue;
    }
    const replacement = [DEFAULT_KEYMAP[id], ...defaults].find((combo) => !used.has(combo));
    if (replacement) next[id] = replacement;
    used.add(next[id]);
  }
  return next;
}

/** Assign one binding without creating a collision. The previous owner gets
 * the edited action's old combo, which makes rebinding predictable and fully
 * reversible instead of silently disabling a command. */
export function rebindKeymap(
  map: Record<HotkeyAction, string>,
  action: HotkeyAction,
  rawCombo: string,
): Record<HotkeyAction, string> {
  const combo = normalizeCombo(rawCombo);
  if (!combo) return map;
  const previous = map[action];
  const owner = HOTKEY_ACTIONS.find(({ id }) => id !== action && map[id] === combo)?.id;
  const next = { ...map, [action]: combo };
  if (owner) next[owner] = previous;
  return resolveKeymapConflicts(next);
}

export function serializeKeymap(map: Record<HotkeyAction, string>): string {
  const overrides: Record<string, string> = {};
  for (const { id } of HOTKEY_ACTIONS) {
    if (map[id] !== DEFAULT_KEYMAP[id]) overrides[id] = map[id];
  }
  return JSON.stringify(overrides);
}

/** First action whose combo matches the event, or null. */
export function matchAction(map: Record<HotkeyAction, string>, e: KeyEventLike): HotkeyAction | null {
  const combo = comboFromEvent(e);
  if (!combo) return null;
  for (const { id } of HOTKEY_ACTIONS) {
    if (map[id] === combo) return id;
  }
  return null;
}

/** Actions sharing a combo with another action (for the editor's warnings). */
export function findConflicts(map: Record<HotkeyAction, string>): HotkeyAction[] {
  const seen = new Map<string, HotkeyAction[]>();
  for (const { id } of HOTKEY_ACTIONS) {
    const list = seen.get(map[id]) ?? [];
    list.push(id);
    seen.set(map[id], list);
  }
  return [...seen.values()].filter((l) => l.length > 1).flat();
}

/** Human label: "⌘⇧E" on mac, "Ctrl+Shift+E" elsewhere. */
export function formatCombo(combo: string, mac: boolean): string {
  const parts = combo.split("+");
  const key = parts[parts.length - 1] ?? "";
  const keyLabel = key.length === 1 ? key.toUpperCase() : key[0]!.toUpperCase() + key.slice(1);
  if (mac) {
    return (
      (parts.includes("mod") ? "⌘" : "") +
      (parts.includes("shift") ? "⇧" : "") +
      (parts.includes("alt") ? "⌥" : "") +
      keyLabel
    );
  }
  return [
    parts.includes("mod") ? "Ctrl" : "",
    parts.includes("shift") ? "Shift" : "",
    parts.includes("alt") ? "Alt" : "",
    keyLabel,
  ].filter(Boolean).join("+");
}
