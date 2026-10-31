// Touch-terminal model: Termux extra-keys syntax, sticky modifiers, the FN
// layer, the live IME bridge, buffer URL collection, stored preferences and
// touch-selection geometry.
import test from "node:test";
import assert from "node:assert/strict";
import {
  consumeModifiers, encodeExtraKey, encodeTypedText, layoutFor, NO_MODIFIERS, parseExtraKeys,
  parseLenientJson, TERMUX_DEFAULT_EXTRA_KEYS, toggleModifier, withModifiers,
  type ExtraKeyAction, type Modifiers,
} from "../widgets/terminal/extraKeys.ts";
import { createImeBridge, diffImeText, IME_SENTINEL } from "../widgets/terminal/imeBridge.ts";
import { collectUrls } from "../widgets/terminal/linkify.ts";
import { normalizeTouchPrefs } from "../widgets/terminal/touchPrefs.ts";
import { extendFromWord, moveSelectionEdge, orderedSelection } from "../widgets/terminal/touchSelection.ts";

const plain = { appCursorKeys: false };
const app = { appCursorKeys: true };
const mods = (patch: Partial<Modifiers>): Modifiers => ({ ...NO_MODIFIERS, ...patch });
const bytes = (action: ExtraKeyAction, m: Modifiers = NO_MODIFIERS, state = plain) => encodeExtraKey(action, m, state).bytes;

test("the Termux default layout parses into its two familiar rows", () => {
  const parsed = parseExtraKeys(TERMUX_DEFAULT_EXTRA_KEYS);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.layout.map((row) => row.map((key) => key.label)), [
    ["ESC", "/", "-", "HOME", "↑", "END", "PGUP"],
    ["TAB", "CTRL", "ALT", "←", "↓", "→", "PGDN"],
  ]);
  const dash = parsed.layout[0]![2]!;
  assert.deepEqual(dash.popup, { label: "|", action: { kind: "text", text: "|" } });
  assert.equal(parsed.layout[0]![4]!.repeat, true, "arrows repeat while held");
  assert.equal(parsed.layout[0]![0]!.repeat, false);
  assert.deepEqual(parsed.layout[1]![1]!.action, { kind: "modifier", modifier: "ctrl" });
});

test("Termux syntax accepts aliases, macros, display names, literals and flat rows", () => {
  const parsed = parseExtraKeys(`[
    "escape", {key: "page_up", display: "⇞"}, {macro: "CTRL d", display: "exit", popup: {macro: "CTRL c"}},
    'KEYBOARD', 'DRAWER', 'ls -la', "F12"
  ]`);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.layout.length, 1, "a flat array is one row");
  const [esc, pgup, macro, keyboard, drawer, literal, f12] = parsed.layout[0]!;
  assert.deepEqual(esc!.action, { kind: "key", key: "Escape" });
  assert.equal(pgup!.label, "⇞");
  assert.deepEqual(pgup!.action, { kind: "key", key: "PageUp" });
  assert.equal(macro!.label, "exit");
  assert.equal(bytes(macro!.action), "\x04");
  assert.equal(bytes(macro!.popup!.action), "\x03");
  assert.deepEqual(keyboard!.action, { kind: "command", command: "keyboard" });
  assert.deepEqual(drawer!.action, { kind: "command", command: "drawer" });
  assert.equal(bytes(literal!.action), "ls -la", "unknown names are typed literally, as in Termux");
  assert.equal(bytes(f12!.action), "\x1b[24~");
});

test("invalid layouts report where they fail and stored garbage falls back", () => {
  for (const [source, fragment] of [
    ["", "unexpected end"],
    ["[['ESC',]", "expected"],
    ["{key: 'a'}", "array of rows"],
    ["[[]]", "row 1: empty"],
    ["[[{display: 'x'}]]", "missing \"key\""],
    [`[${Array(7).fill("['A']").join(",")}]`, "at most 6 rows"],
  ] as const) {
    const parsed = parseExtraKeys(source);
    assert.equal(parsed.ok, false, source);
    if (!parsed.ok) assert.match(parsed.error, new RegExp(fragment.replace(/[[\]]/g, "\\$&")), source);
  }
  assert.equal(layoutFor("not a layout")[0]![0]!.label, "ESC");
  assert.deepEqual(parseLenientJson(`{a: 'it\\'s', "b": [1, true, null]}`), { a: "it's", b: [1, true, null] });
});

test("sticky modifiers arm for one key, lock on double tap, and release", () => {
  let m = toggleModifier(NO_MODIFIERS, "ctrl");
  assert.equal(m.ctrl, 1);
  assert.equal(consumeModifiers(m).ctrl, 0, "an armed modifier is spent by the next key");
  m = toggleModifier(m, "ctrl", true);
  assert.equal(m.ctrl, 2, "a double tap or long press locks");
  assert.equal(consumeModifiers(m).ctrl, 2, "a locked modifier survives keys");
  assert.equal(toggleModifier(m, "ctrl").ctrl, 0, "tapping a locked modifier releases it");
  assert.equal(consumeModifiers(NO_MODIFIERS), NO_MODIFIERS, "nothing to spend keeps identity");
});

test("extra keys encode like a hardware keyboard, including modifiers", () => {
  assert.equal(bytes({ kind: "key", key: "Escape" }), "\x1b");
  assert.equal(bytes({ kind: "key", key: "ArrowUp" }), "\x1b[A");
  assert.equal(bytes({ kind: "key", key: "ArrowUp" }, NO_MODIFIERS, app), "\x1bOA", "DECCKM switches to SS3");
  assert.equal(bytes({ kind: "key", key: "ArrowLeft" }, mods({ ctrl: 1 })), "\x1b[1;5D");
  assert.equal(bytes({ kind: "key", key: "Tab" }, mods({ shift: 1 })), "\x1b[Z");
  assert.equal(bytes({ kind: "key", key: " " }, mods({ ctrl: 1 })), "\x00");
  assert.equal(bytes({ kind: "text", text: "c" }, mods({ ctrl: 1 })), "\x03");
  assert.equal(bytes({ kind: "text", text: "x" }, mods({ alt: 1 })), "\x1bx");
  assert.equal(bytes({ kind: "text", text: "x" }, mods({ alt: 1, shift: 1 })), "\x1bX");
  assert.equal(bytes({ kind: "text", text: "1" }, mods({ ctrl: 1 })), "1", "no C0 form: the character itself");
});

test("the FN layer follows Termux's Volume-Up combinations", () => {
  const fn = mods({ fn: 1 });
  assert.equal(bytes({ kind: "text", text: "w" }, fn), "\x1b[A");
  assert.equal(bytes({ kind: "text", text: "a" }, fn), "\x1b[D");
  assert.equal(bytes({ kind: "text", text: "s" }, fn), "\x1b[B");
  assert.equal(bytes({ kind: "text", text: "d" }, fn), "\x1b[C");
  assert.equal(bytes({ kind: "text", text: "1" }, fn), "\x1bOP");
  assert.equal(bytes({ kind: "text", text: "0" }, fn), "\x1b[21~");
  assert.equal(bytes({ kind: "text", text: "e" }, fn), "\x1b");
  assert.equal(bytes({ kind: "text", text: "." }, fn), "\x1c");
  assert.equal(bytes({ kind: "text", text: "w" }, mods({ fn: 1, ctrl: 1 })), "\x1b[1;5A", "other modifiers still apply");
  assert.deepEqual(encodeExtraKey({ kind: "text", text: "q" }, fn, plain).commands, ["toggle-extra-keys"]);
});

test("typed text takes the sticky modifiers on its first character only", () => {
  assert.equal(encodeTypedText("hello", NO_MODIFIERS, plain).bytes, "hello");
  assert.equal(encodeTypedText("c", mods({ ctrl: 1 }), plain).bytes, "\x03");
  assert.equal(encodeTypedText("ab", mods({ ctrl: 1 }), plain).bytes, "\x01b");
  assert.equal(encodeTypedText("é", mods({ alt: 1 }), plain).bytes, "\x1bé");
  const merged = withModifiers({ key: "c", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }, mods({ ctrl: 2 }));
  assert.equal(merged.ctrlKey, true);
});

test("the IME bridge echoes composition live and turns edits into DELs", () => {
  assert.deepEqual(diffImeText("teh", "the "), { deletes: 2, insert: "he " });
  assert.deepEqual(diffImeText("привіт", "привітання"), { deletes: 0, insert: "ання" });
  assert.deepEqual(diffImeText("a👍", "a"), { deletes: 1, insert: "" }, "an emoji is one code point");

  const ime = createImeBridge();
  const S = IME_SENTINEL;
  assert.deepEqual(ime.update(`${S}l`, true), { deletes: 0, insert: "l", reset: false });
  assert.deepEqual(ime.update(`${S}ls`, true), { deletes: 0, insert: "s", reset: false });
  assert.deepEqual(ime.update(`${S}l`, true), { deletes: 1, insert: "", reset: false }, "backspace inside a composition");
  assert.deepEqual(ime.update(`${S}la `, false), { deletes: 0, insert: "a ", reset: true }, "the commit resets the field");
  assert.deepEqual(ime.update("", false), { deletes: 1, insert: "", reset: true }, "deleting the sentinel is Backspace");
  assert.deepEqual(ime.update("hello", false), { deletes: 0, insert: "hello", reset: true }, "a rewritten field keeps its text");
  ime.update(`${S}x`, true);
  ime.reset();
  assert.deepEqual(ime.update(`${S}y`, false), { deletes: 0, insert: "y", reset: true }, "reset forgets delivered text");
});

test("URL collection joins wrapped rows and lists each link once, newest first", () => {
  const rows = ["see https://example.com/a and", "https://exam", "ple.com/very/long", "again https://example.com/a"];
  const wrapped = [false, true, false, false];
  assert.deepEqual(
    collectUrls((i) => rows[i]!, (i) => wrapped[i]!, rows.length),
    ["https://example.com/a", "https://example.com/very/long"],
  );
});

test("stored touch preferences are validated", () => {
  assert.deepEqual(normalizeTouchPrefs(null), { fontSize: null, extraKeys: null, extraKeysVisible: "auto", bellVibrate: true });
  assert.deepEqual(
    normalizeTouchPrefs({ fontSize: 99, extraKeys: "[[", extraKeysVisible: "sometimes", bellVibrate: "no" }),
    { fontSize: 40, extraKeys: null, extraKeysVisible: "auto", bellVibrate: true },
  );
  assert.equal(normalizeTouchPrefs({ fontSize: 11.6, extraKeys: "[['ESC']]", extraKeysVisible: "off" }).fontSize, 12);
});

test("a held long press keeps its word while extending either way", () => {
  const word = { start: { row: 2, col: 6 }, end: { row: 2, col: 14 } };
  assert.deepEqual(orderedSelection(extendFromWord(word, { row: 4, col: 3 })), { start: { row: 2, col: 6 }, end: { row: 4, col: 3 } });
  assert.deepEqual(orderedSelection(extendFromWord(word, { row: 0, col: 9 })), { start: { row: 0, col: 9 }, end: { row: 2, col: 14 } });
  assert.deepEqual(extendFromWord(word, { row: 2, col: 10 }), { anchor: word.start, focus: word.end }, "back over the word: just the word");
});

test("selection handles move one end and never cross", () => {
  const sel = { start: { row: 1, col: 4 }, end: { row: 3, col: 2 } };
  assert.deepEqual(moveSelectionEdge(sel, "end", { row: 5, col: 7 }, 40).end, { row: 5, col: 7 });
  assert.deepEqual(moveSelectionEdge(sel, "start", { row: 0, col: 0 }, 40).start, { row: 0, col: 0 });
  assert.deepEqual(moveSelectionEdge(sel, "start", { row: 9, col: 0 }, 40).start, { row: 3, col: 1 }, "start stops a cell short");
  assert.deepEqual(moveSelectionEdge(sel, "end", { row: 0, col: 0 }, 40).end, { row: 1, col: 5 }, "end stops a cell short");
  const rowStart = { start: { row: 1, col: 0 }, end: { row: 2, col: 0 } };
  assert.deepEqual(moveSelectionEdge(rowStart, "start", { row: 2, col: 5 }, 40).start, { row: 1, col: 39 }, "wraps to the previous row's end");
});
