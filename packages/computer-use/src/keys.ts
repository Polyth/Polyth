import { invalid } from "./errors.ts";

export type Modifier = "ctrl" | "alt" | "shift" | "meta";

/** Named keys every driver maps; printable characters are a separate kind. */
export const NAMED_KEYS = [
  "enter", "escape", "tab", "space", "backspace", "delete", "insert",
  "home", "end", "pageup", "pagedown", "up", "down", "left", "right",
  "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
] as const;
export type NamedKey = typeof NAMED_KEYS[number];

export type Key = { kind: "named"; name: NamedKey } | { kind: "char"; char: string };

export interface KeyChord {
  modifiers: Modifier[];
  key?: Key;
}

const MODIFIER_ALIASES: Record<string, Modifier> = {
  ctrl: "ctrl", control: "ctrl", ctl: "ctrl",
  alt: "alt", option: "alt", opt: "alt",
  shift: "shift",
  meta: "meta", cmd: "meta", command: "meta", super: "meta", win: "meta", windows: "meta",
};

const KEY_ALIASES: Record<string, NamedKey> = {
  return: "enter", esc: "escape", del: "delete", ins: "insert", bksp: "backspace",
  pgup: "pageup", pgdn: "pagedown", page_up: "pageup", page_down: "pagedown", prior: "pageup", next: "pagedown",
  arrowup: "up", arrowdown: "down", arrowleft: "left", arrowright: "right", spacebar: "space",
};

/** Characters a chord may name directly: the US layout keys all drivers know. */
const CHORD_CHARS = new Set("abcdefghijklmnopqrstuvwxyz0123456789-=[]\\;',./`");

const MODIFIER_ORDER: readonly Modifier[] = ["ctrl", "alt", "shift", "meta"];

export const parseModifier = (value: string): Modifier => {
  const modifier = MODIFIER_ALIASES[value.trim().toLowerCase()];
  if (!modifier) throw invalid(`Unknown modifier "${value}"; use ctrl, alt, shift or meta (cmd/win)`);
  return modifier;
};

export const sortModifiers = (modifiers: Iterable<Modifier>): Modifier[] =>
  MODIFIER_ORDER.filter((modifier) => new Set(modifiers).has(modifier));

/** Parses "ctrl+shift+t", "cmd+space", "Return", "F5" or "+" style chords. */
export const parseChord = (value: string): KeyChord => {
  const text = value.trim();
  if (!text) throw invalid("keys is empty");
  if (text.length > 64) throw invalid("keys is too long; send one chord per call");
  // "+" alone and a trailing "++" mean the plus key.
  const parts = text === "+" ? ["+"] : text.endsWith("++")
    ? [...text.slice(0, -2).split("+"), "+"]
    : text.split("+");
  const modifiers = new Set<Modifier>();
  let key: Key | undefined;
  // A chord of modifiers only ("shift", "ctrl+alt") presses just those.
  const onlyModifiers = parts.every((part) => MODIFIER_ALIASES[part.trim().toLowerCase()]);
  for (const [index, raw] of parts.entries()) {
    const part = raw.trim();
    if (!part) throw invalid(`Malformed chord "${value}"`);
    const lower = part.toLowerCase();
    const modifier = MODIFIER_ALIASES[lower];
    if (modifier && (index < parts.length - 1 || onlyModifiers)) {
      modifiers.add(modifier);
      continue;
    }
    if (index !== parts.length - 1) throw invalid(`"${part}" in "${value}" is not a modifier; the key goes last`);
    const named = (NAMED_KEYS as readonly string[]).includes(lower) ? lower as NamedKey : KEY_ALIASES[lower];
    if (named) key = { kind: "named", name: named };
    else if (part.length === 1 && (CHORD_CHARS.has(lower) || part === "+")) key = { kind: "char", char: part };
    else throw invalid(`Unknown key "${part}"; use names like enter, escape, tab, f5, up or one character. Type text with action "type".`);
  }
  return { modifiers: sortModifiers(modifiers), ...(key ? { key } : {}) };
};

export const describeChord = (chord: KeyChord): string => [
  ...chord.modifiers,
  ...(chord.key ? [chord.key.kind === "named" ? chord.key.name : chord.key.char] : []),
].join("+");

/** "+" and upper-case letters need shift on a US layout; drivers press the
 * base key with shift added, so "ctrl+T" means ctrl+shift+t. */
const SHIFTED: Record<string, string> = { "+": "=", "_": "-", "{": "[", "}": "]", "|": "\\", ":": ";", "\"": "'", "<": ",", ">": ".", "?": "/", "~": "`" };

export const baseCharacter = (char: string): { char: string; shift: boolean } => {
  if (SHIFTED[char]) return { char: SHIFTED[char], shift: true };
  if (char >= "A" && char <= "Z") return { char: char.toLowerCase(), shift: true };
  return { char, shift: false };
};
