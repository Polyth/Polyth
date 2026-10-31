// Touch extra-keys model (pure, DOM-free). The layout syntax is Termux's
// `extra-keys` property — rows of key names or `{key, popup, display, macro}`
// objects in lenient JSON (single quotes, bare object keys) — so an existing
// termux.properties line can be pasted as-is. Modifiers are sticky: a tap arms
// a modifier for the next key, a second quick tap or a long press locks it.
import { keyEventToBytes, type KeyLike, type KeymapState } from "./keymap.ts";

export type ModifierName = "ctrl" | "alt" | "shift" | "fn";
export type TouchCommand = "keyboard" | "drawer" | "paste" | "text-input" | "toggle-extra-keys";

export type ExtraKeyAction =
  | { kind: "modifier"; modifier: ModifierName }
  /** A DOM `KeyboardEvent.key` value, encoded through the shared keymap. */
  | { kind: "key"; key: string }
  | { kind: "text"; text: string }
  /** Termux macro: space-separated keys; a modifier applies to the next step. */
  | { kind: "macro"; steps: ExtraKeyAction[] }
  | { kind: "command"; command: TouchCommand };

export interface ExtraKeyPopup {
  label: string;
  action: ExtraKeyAction;
}

export interface ExtraKey {
  label: string;
  /** Spoken name for symbolic labels; `undefined` means the label reads well. */
  spoken?: SpokenKey;
  action: ExtraKeyAction;
  popup?: ExtraKeyPopup;
  /** Holding the key repeats it (Termux repeats navigation and delete keys). */
  repeat: boolean;
}

export type ExtraKeysLayout = ExtraKey[][];

/** Symbolic keys whose visible glyph needs a localized accessible name. */
export type SpokenKey =
  | "up" | "down" | "left" | "right" | "backspace" | "delete" | "enter"
  | "space" | "keyboard" | "drawer" | "paste" | "textInput";

/** termux-app's built-in default, byte-for-byte. */
export const TERMUX_DEFAULT_EXTRA_KEYS =
  "[['ESC','/',{key: '-', popup: '|'},'HOME','UP','END','PGUP'], ['TAB','CTRL','ALT','LEFT','DOWN','RIGHT','PGDN']]";

const MAX_ROWS = 6;
const MAX_KEYS_PER_ROW = 20;

interface NamedKey {
  action: ExtraKeyAction;
  label: string;
  spoken?: SpokenKey;
  repeat?: boolean;
}

const key = (name: string, label: string, extra: Partial<NamedKey> = {}): NamedKey =>
  ({ action: { kind: "key", key: name }, label, ...extra });

const NAMED_KEYS: Record<string, NamedKey> = {
  ESC: key("Escape", "ESC"),
  TAB: key("Tab", "TAB"),
  HOME: key("Home", "HOME"),
  END: key("End", "END"),
  PGUP: key("PageUp", "PGUP", { repeat: true }),
  PGDN: key("PageDown", "PGDN", { repeat: true }),
  INS: key("Insert", "INS"),
  DEL: key("Delete", "⌦", { spoken: "delete", repeat: true }),
  BKSP: key("Backspace", "⌫", { spoken: "backspace", repeat: true }),
  ENTER: key("Enter", "↵", { spoken: "enter" }),
  SPACE: key(" ", "␣", { spoken: "space", repeat: true }),
  UP: key("ArrowUp", "↑", { spoken: "up", repeat: true }),
  DOWN: key("ArrowDown", "↓", { spoken: "down", repeat: true }),
  LEFT: key("ArrowLeft", "←", { spoken: "left", repeat: true }),
  RIGHT: key("ArrowRight", "→", { spoken: "right", repeat: true }),
  CTRL: { action: { kind: "modifier", modifier: "ctrl" }, label: "CTRL" },
  ALT: { action: { kind: "modifier", modifier: "alt" }, label: "ALT" },
  SHIFT: { action: { kind: "modifier", modifier: "shift" }, label: "SHIFT" },
  FN: { action: { kind: "modifier", modifier: "fn" }, label: "FN" },
  KEYBOARD: { action: { kind: "command", command: "keyboard" }, label: "⌨", spoken: "keyboard" },
  DRAWER: { action: { kind: "command", command: "drawer" }, label: "☰", spoken: "drawer" },
  PASTE: { action: { kind: "command", command: "paste" }, label: "PASTE", spoken: "paste" },
  // Polyth extension: the text-input row Termux opens by swiping the bar.
  TEXT: { action: { kind: "command", command: "text-input" }, label: "ABC", spoken: "textInput" },
  BACKSLASH: { action: { kind: "text", text: "\\" }, label: "\\" },
  QUOTE: { action: { kind: "text", text: "\"" }, label: "\"" },
  APOSTROPHE: { action: { kind: "text", text: "'" }, label: "'" },
};
for (let n = 1; n <= 12; n++) NAMED_KEYS[`F${n}`] = key(`F${n}`, `F${n}`);

const ALIASES: Record<string, string> = {
  ESCAPE: "ESC", CONTROL: "CTRL", SHFT: "SHIFT", FUNCTION: "FN", RETURN: "ENTER",
  BACKSPACE: "BKSP", DELETE: "DEL", INSERT: "INS",
  PAGEUP: "PGUP", PAGE_UP: "PGUP", PAGEDOWN: "PGDN", PAGE_DOWN: "PGDN",
  ARROW_UP: "UP", ARROW_DOWN: "DOWN", ARROW_LEFT: "LEFT", ARROW_RIGHT: "RIGHT",
};

/** Resolve one Termux key name; unknown names are literal text, as in Termux. */
export function resolveKeyName(raw: string): NamedKey {
  const upper = raw.toUpperCase();
  const named = NAMED_KEYS[ALIASES[upper] ?? upper];
  if (named) return named;
  return { action: { kind: "text", text: raw }, label: raw };
}

function parseMacro(source: string): ExtraKeyAction {
  const steps = source.trim().split(/\s+/).filter(Boolean).map((part) => resolveKeyName(part).action);
  if (steps.length === 0) throw new Error("macro is empty");
  return { kind: "macro", steps };
}

// ------------------------------------------------------------ lenient parser

type Value = string | number | boolean | null | Value[] | { [key: string]: Value };

/** Parse JSON with Termux's leniencies: single quotes and bare object keys. */
export function parseLenientJson(source: string): Value {
  let i = 0;
  const fail = (message: string): never => { throw new Error(`${message} at position ${i + 1}`); };
  const space = () => { while (i < source.length && /\s/.test(source[i]!)) i++; };
  const string = (): string => {
    const quote = source[i++]!;
    let out = "";
    while (i < source.length && source[i] !== quote) {
      const ch = source[i++]!;
      if (ch !== "\\") { out += ch; continue; }
      const esc = source[i++];
      if (esc === undefined) break;
      if (esc === "n") out += "\n";
      else if (esc === "t") out += "\t";
      else if (esc === "r") out += "\r";
      else if (esc === "u" && /^[0-9a-fA-F]{4}$/.test(source.slice(i, i + 4))) {
        out += String.fromCharCode(parseInt(source.slice(i, i + 4), 16));
        i += 4;
      } else out += esc;
    }
    if (source[i] !== quote) fail("unterminated string");
    i++;
    return out;
  };
  const word = (): string => {
    const start = i;
    while (i < source.length && /[\w$.+-]/.test(source[i]!)) i++;
    if (start === i) fail(`unexpected "${source[i] ?? "end of input"}"`);
    return source.slice(start, i);
  };
  const value = (): Value => {
    space();
    const ch = source[i];
    if (ch === "[") {
      i++;
      const out: Value[] = [];
      space();
      while (source[i] !== "]") {
        out.push(value());
        space();
        if (source[i] === ",") { i++; space(); continue; }
        if (source[i] !== "]") fail("expected , or ]");
      }
      i++;
      return out;
    }
    if (ch === "{") {
      i++;
      const out: Record<string, Value> = {};
      space();
      while (source[i] !== "}") {
        const name = source[i] === "'" || source[i] === "\"" ? string() : word();
        space();
        if (source[i] !== ":") fail("expected :");
        i++;
        out[name] = value();
        space();
        if (source[i] === ",") { i++; space(); continue; }
        if (source[i] !== "}") fail("expected , or }");
      }
      i++;
      return out;
    }
    if (ch === "'" || ch === "\"") return string();
    if (ch === undefined) return fail("unexpected end of input");
    const bare = word();
    if (bare === "true") return true;
    if (bare === "false") return false;
    if (bare === "null") return null;
    const num = Number(bare);
    return Number.isFinite(num) ? num : bare;
  };
  const out = value();
  space();
  if (i < source.length) fail("unexpected trailing input");
  return out;
}

function actionFromEntry(entry: Value, where: string): { label: string; spoken?: SpokenKey; action: ExtraKeyAction; repeat: boolean } {
  if (typeof entry === "string" || typeof entry === "number") {
    const named = resolveKeyName(String(entry));
    return { label: named.label, ...(named.spoken ? { spoken: named.spoken } : {}), action: named.action, repeat: named.repeat ?? false };
  }
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${where}: expected a key name or object`);
  const display = typeof entry.display === "string" ? entry.display : undefined;
  if (typeof entry.macro === "string") {
    return { label: display ?? entry.macro, action: parseMacro(entry.macro), repeat: false };
  }
  if (typeof entry.key !== "string" && typeof entry.key !== "number") throw new Error(`${where}: missing "key" or "macro"`);
  const named = resolveKeyName(String(entry.key));
  return {
    label: display ?? named.label,
    ...(named.spoken && !display ? { spoken: named.spoken } : {}),
    action: named.action,
    repeat: named.repeat ?? false,
  };
}

export type LayoutParseResult = { ok: true; layout: ExtraKeysLayout } | { ok: false; error: string };

/** Parse a Termux `extra-keys` value. A flat array is accepted as one row. */
export function parseExtraKeys(source: string): LayoutParseResult {
  try {
    const parsed = parseLenientJson(source.trim());
    if (!Array.isArray(parsed)) throw new Error("expected an array of rows");
    const rows = parsed.length > 0 && parsed.every((row) => !Array.isArray(row)) ? [parsed] : parsed;
    if (rows.length === 0) throw new Error("no rows");
    if (rows.length > MAX_ROWS) throw new Error(`at most ${MAX_ROWS} rows`);
    const layout = rows.map((row, r) => {
      if (!Array.isArray(row)) throw new Error(`row ${r + 1}: expected an array`);
      if (row.length === 0) throw new Error(`row ${r + 1}: empty`);
      if (row.length > MAX_KEYS_PER_ROW) throw new Error(`row ${r + 1}: at most ${MAX_KEYS_PER_ROW} keys`);
      return row.map((entry, c): ExtraKey => {
        const where = `row ${r + 1}, key ${c + 1}`;
        const base = actionFromEntry(entry, where);
        const out: ExtraKey = { ...base };
        if (entry && typeof entry === "object" && !Array.isArray(entry) && entry.popup !== undefined) {
          const popup = actionFromEntry(entry.popup, `${where} popup`);
          out.popup = { label: popup.label, action: popup.action };
        }
        return out;
      });
    });
    return { ok: true, layout };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

const DEFAULT_LAYOUT = (() => {
  const parsed = parseExtraKeys(TERMUX_DEFAULT_EXTRA_KEYS);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.layout;
})();

/** Layout for a stored preference; an invalid stored value falls back. */
export function layoutFor(source: string | null | undefined): ExtraKeysLayout {
  if (!source) return DEFAULT_LAYOUT;
  const parsed = parseExtraKeys(source);
  return parsed.ok ? parsed.layout : DEFAULT_LAYOUT;
}

// ------------------------------------------------------- sticky modifiers

/** 0 off, 1 armed for the next key, 2 locked until tapped again. */
export type ModifierLevel = 0 | 1 | 2;
export type Modifiers = Readonly<Record<ModifierName, ModifierLevel>>;

export const NO_MODIFIERS: Modifiers = { ctrl: 0, alt: 0, shift: 0, fn: 0 };

/** Tap: off → armed, armed/locked → off. `lock` (double tap / long press) locks. */
export function toggleModifier(mods: Modifiers, name: ModifierName, lock = false): Modifiers {
  const next: ModifierLevel = lock ? (mods[name] === 2 ? 0 : 2) : mods[name] === 0 ? 1 : 0;
  return { ...mods, [name]: next };
}

/** A non-modifier key was sent: armed modifiers release, locked ones stay. */
export function consumeModifiers(mods: Modifiers): Modifiers {
  if (mods.ctrl !== 1 && mods.alt !== 1 && mods.shift !== 1 && mods.fn !== 1) return mods;
  return {
    ctrl: mods.ctrl === 2 ? 2 : 0,
    alt: mods.alt === 2 ? 2 : 0,
    shift: mods.shift === 2 ? 2 : 0,
    fn: mods.fn === 2 ? 2 : 0,
  };
}

export const hasModifiers = (mods: Modifiers): boolean =>
  mods.ctrl !== 0 || mods.alt !== 0 || mods.shift !== 0 || mods.fn !== 0;

// ----------------------------------------------------------------- encoding

/**
 * FN layer, following Termux's Volume-Up combinations: WASD arrows, P/N page
 * keys, digits F1–F10, E/T Escape/Tab, B/F/X Alt-words, L/H/U symbols, and
 * `.` for Ctrl+\ (SIGQUIT). Q and K toggle the extra keys.
 */
const FN_LAYER: Record<string, ExtraKeyAction> = {
  w: { kind: "key", key: "ArrowUp" },
  a: { kind: "key", key: "ArrowLeft" },
  s: { kind: "key", key: "ArrowDown" },
  d: { kind: "key", key: "ArrowRight" },
  p: { kind: "key", key: "PageUp" },
  n: { kind: "key", key: "PageDown" },
  e: { kind: "key", key: "Escape" },
  t: { kind: "key", key: "Tab" },
  b: { kind: "text", text: "\x1bb" },
  f: { kind: "text", text: "\x1bf" },
  x: { kind: "text", text: "\x1bx" },
  l: { kind: "text", text: "|" },
  h: { kind: "text", text: "~" },
  u: { kind: "text", text: "_" },
  ".": { kind: "text", text: "\x1c" },
  q: { kind: "command", command: "toggle-extra-keys" },
  k: { kind: "command", command: "toggle-extra-keys" },
  "0": { kind: "key", key: "F10" },
};
for (let n = 1; n <= 9; n++) FN_LAYER[String(n)] = { kind: "key", key: `F${n}` };

export interface EncodedInput {
  bytes: string;
  commands: TouchCommand[];
}

const keyLike = (name: string, mods: Modifiers): KeyLike => ({
  key: name,
  ctrlKey: mods.ctrl !== 0,
  altKey: mods.alt !== 0,
  shiftKey: mods.shift !== 0,
  metaKey: false,
});

/** Encode one character with the active modifiers. */
function encodeChar(ch: string, mods: Modifiers, state: KeymapState, out: EncodedInput): void {
  if (mods.fn !== 0) {
    const mapped = FN_LAYER[ch.toLowerCase()];
    if (mapped) { encodeInto(mapped, { ...mods, fn: 0 }, state, out); return; }
  }
  const shifted = mods.shift !== 0 ? ch.toUpperCase() : ch;
  const bytes = keyEventToBytes(keyLike(shifted, { ...mods, shift: 0 }), state);
  // Ctrl with a character that has no C0 form (Ctrl+1) sends the character.
  out.bytes += bytes ?? (mods.alt !== 0 ? `\x1b${shifted}` : shifted);
}

function encodeInto(action: ExtraKeyAction, mods: Modifiers, state: KeymapState, out: EncodedInput): void {
  switch (action.kind) {
    case "modifier":
      return;
    case "command":
      out.commands.push(action.command);
      return;
    case "key": {
      if (action.key.length === 1) { encodeChar(action.key, mods, state, out); return; }
      out.bytes += keyEventToBytes(keyLike(action.key, mods), state) ?? "";
      return;
    }
    case "text": {
      const chars = Array.from(action.text);
      if (chars.length === 1) { encodeChar(chars[0]!, mods, state, out); return; }
      out.bytes += action.text;
      return;
    }
    case "macro": {
      let pending: Modifiers = mods;
      for (const step of action.steps) {
        if (step.kind === "modifier") {
          pending = { ...pending, [step.modifier]: 1 };
          continue;
        }
        encodeInto(step, pending, state, out);
        pending = NO_MODIFIERS;
      }
      return;
    }
  }
}

/** Encode an extra-key action under the current sticky modifiers. */
export function encodeExtraKey(action: ExtraKeyAction, mods: Modifiers, state: KeymapState): EncodedInput {
  const out: EncodedInput = { bytes: "", commands: [] };
  encodeInto(action, mods, state, out);
  return out;
}

/**
 * Software-keyboard text with sticky modifiers: the first character takes
 * the modifiers (Ctrl+C typed as CTRL then "c"), the rest is literal.
 */
export function encodeTypedText(text: string, mods: Modifiers, state: KeymapState): EncodedInput {
  const out: EncodedInput = { bytes: "", commands: [] };
  if (!hasModifiers(mods)) { out.bytes = text; return out; }
  const chars = Array.from(text);
  const first = chars.shift();
  if (first === undefined) return out;
  encodeChar(first, mods, state, out);
  out.bytes += chars.join("");
  return out;
}

/** Merge sticky modifiers into a hardware key event. */
export function withModifiers<T extends KeyLike>(event: T, mods: Modifiers): KeyLike {
  return {
    key: event.key,
    ctrlKey: event.ctrlKey || mods.ctrl !== 0,
    altKey: event.altKey || mods.alt !== 0,
    shiftKey: event.shiftKey || mods.shift !== 0,
    metaKey: event.metaKey,
  };
}

/** FN-layer translation for a hardware key, or null when FN does not apply. */
export function fnLayerAction(key: string): ExtraKeyAction | null {
  return key.length === 1 ? FN_LAYER[key.toLowerCase()] ?? null : null;
}
