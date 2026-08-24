// Terminal support modules: keyboard/mouse/paste encoding, URL detection,
// buffer search, and the 256-color palette.
import test from "node:test";
import assert from "node:assert/strict";
import { encodeMouseEvent, encodePaste, keyEventToBytes, type KeyLike } from "../src/terminal/keymap.ts";
import { detectLinks } from "../src/terminal/linkify.ts";
import { searchBuffer } from "../src/terminal/search.ts";
import { cellColorCss, xterm256Hex } from "../src/terminal/palette.ts";
import { createTerminalEmulator, packRgb } from "../src/terminal/emulator.ts";

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...mods,
});
const norm = { appCursorKeys: false };
const app = { appCursorKeys: true };

test("keymap: named keys and DECCKM application mode", () => {
  assert.equal(keyEventToBytes(key("Enter"), norm), "\r");
  assert.equal(keyEventToBytes(key("Backspace"), norm), "\x7f");
  assert.equal(keyEventToBytes(key("Tab"), norm), "\t");
  assert.equal(keyEventToBytes(key("Tab", { shiftKey: true }), norm), "\x1b[Z");
  assert.equal(keyEventToBytes(key("Escape"), norm), "\x1b");
  assert.equal(keyEventToBytes(key("ArrowUp"), norm), "\x1b[A");
  assert.equal(keyEventToBytes(key("ArrowUp"), app), "\x1bOA");
  assert.equal(keyEventToBytes(key("Home"), norm), "\x1b[H");
  assert.equal(keyEventToBytes(key("End"), app), "\x1bOF");
  assert.equal(keyEventToBytes(key("Delete"), norm), "\x1b[3~");
  assert.equal(keyEventToBytes(key("PageUp"), norm), "\x1b[5~");
  assert.equal(keyEventToBytes(key("F1"), norm), "\x1bOP");
  assert.equal(keyEventToBytes(key("F5"), norm), "\x1b[15~");
  assert.equal(keyEventToBytes(key("F12"), norm), "\x1b[24~");
});

test("keymap: modifiers encode as CSI 1;mod / num;mod", () => {
  assert.equal(keyEventToBytes(key("ArrowRight", { ctrlKey: true }), norm), "\x1b[1;5C");
  assert.equal(keyEventToBytes(key("ArrowLeft", { altKey: true }), norm), "\x1b[1;3D");
  assert.equal(keyEventToBytes(key("ArrowUp", { shiftKey: true, ctrlKey: true }), app), "\x1b[1;6A");
  assert.equal(keyEventToBytes(key("Delete", { ctrlKey: true }), norm), "\x1b[3;5~");
  assert.equal(keyEventToBytes(key("F1", { shiftKey: true }), norm), "\x1b[1;2P");
});

test("keymap: Ctrl+letter C0 codes, Alt prefix, printables", () => {
  assert.equal(keyEventToBytes(key("c", { ctrlKey: true }), norm), "\x03");
  assert.equal(keyEventToBytes(key("d", { ctrlKey: true }), norm), "\x04");
  assert.equal(keyEventToBytes(key("Z", { ctrlKey: true }), norm), "\x1a");
  assert.equal(keyEventToBytes(key(" ", { ctrlKey: true }), norm), "\x00");
  assert.equal(keyEventToBytes(key("[", { ctrlKey: true }), norm), "\x1b");
  assert.equal(keyEventToBytes(key("a", { altKey: true }), norm), "\x1ba");
  assert.equal(keyEventToBytes(key("x"), norm), "x");
  assert.equal(keyEventToBytes(key("é"), norm), "é");
});

test("keymap: browser-level keys pass through as null", () => {
  assert.equal(keyEventToBytes(key("Shift"), norm), null);
  assert.equal(keyEventToBytes(key("v", { metaKey: true }), norm), null);
  assert.equal(keyEventToBytes(key("F13"), norm), null);
});

test("paste encoding: newline normalization and bracketed paste", () => {
  assert.equal(encodePaste("a\r\nb\nc", false), "a\rb\rc");
  assert.equal(encodePaste("hi", true), "\x1b[200~hi\x1b[201~");
  // embedded end-bracket cannot break out
  assert.equal(encodePaste("x\x1b[201~y", true), "\x1b[200~xy\x1b[201~");
});

test("mouse encoding: SGR and legacy, wheel, tracking-mode gates", () => {
  const sgr = { mouseTracking: 1000, mouseSgr: true };
  assert.equal(
    encodeMouseEvent({ button: 0, col: 5, row: 3, kind: "down" }, sgr),
    "\x1b[<0;5;3M",
  );
  assert.equal(
    encodeMouseEvent({ button: 0, col: 5, row: 3, kind: "up" }, sgr),
    "\x1b[<0;5;3m",
  );
  assert.equal(
    encodeMouseEvent({ button: 64, col: 1, row: 1, kind: "wheel" }, sgr),
    "\x1b[<64;1;1M",
  );
  const legacy = encodeMouseEvent({ button: 0, col: 2, row: 4, kind: "down" }, { mouseTracking: 1000, mouseSgr: false });
  assert.equal(legacy, `\x1b[M${String.fromCharCode(32)}${String.fromCharCode(34)}${String.fromCharCode(36)}`);
  assert.equal(encodeMouseEvent({ button: 0, col: 1, row: 1, kind: "down" }, { mouseTracking: 0, mouseSgr: true }), null);
  assert.equal(encodeMouseEvent({ button: 0, col: 1, row: 1, kind: "move" }, sgr), null, "motion needs 1002/1003");
  assert.equal(
    encodeMouseEvent({ button: 0, col: 1, row: 1, kind: "move" }, { mouseTracking: 1002, mouseSgr: true }),
    "\x1b[<32;1;1M",
  );
  assert.equal(
    encodeMouseEvent({ button: 3, col: 8, row: 5, kind: "move" }, { mouseTracking: 1003, mouseSgr: true }),
    "\x1b[<35;8;5M",
    "1003 reports motion without a pressed button",
  );
});

test("linkify finds URLs and trims trailing prose punctuation", () => {
  assert.deepEqual(detectLinks("no links here"), []);
  const found = detectLinks("see https://example.com/a?b=1, ok");
  assert.equal(found.length, 1);
  assert.equal(found[0]!.url, "https://example.com/a?b=1");
  assert.equal(found[0]!.start, 4);

  const wiki = detectLinks("read https://en.wikipedia.org/wiki/Rust_(language)!");
  assert.equal(wiki[0]!.url, "https://en.wikipedia.org/wiki/Rust_(language)");

  const paren = detectLinks("(https://example.com/page)");
  assert.equal(paren[0]!.url, "https://example.com/page");

  const two = detectLinks("http://one.example.dev and https://two.example.dev/x");
  assert.equal(two.length, 2);

  const extra = detectLinks("docs at www.example.dev, mailto:dev@example.dev or ftp://files.example.dev/a");
  assert.deepEqual(extra.map((link) => link.url), [
    "https://www.example.dev",
    "mailto:dev@example.dev",
    "ftp://files.example.dev/a",
  ]);
});

test("search finds matches across scrollback with case and regex options", () => {
  const t = createTerminalEmulator({ cols: 20, rows: 3, scrollback: 100 });
  t.write("Error: nope\r\nfine\r\nerror again\r\nERROR LAST\r\n");
  const all = searchBuffer(t.rowInfo, t.bufferLength(), "error", {});
  assert.equal(all.length, 3, "case-insensitive by default");
  const cased = searchBuffer(t.rowInfo, t.bufferLength(), "error", { caseSensitive: true });
  assert.equal(cased.length, 1);
  const re = searchBuffer(t.rowInfo, t.bufferLength(), "^err\\w+", { regex: true, caseSensitive: true });
  assert.equal(re.length, 1);
  assert.equal(re[0]!.startCol, 0);
  assert.equal(re[0]!.endCol, 5);
  assert.deepEqual(searchBuffer(t.rowInfo, t.bufferLength(), "(bad[", { regex: true }), [], "invalid regex is empty, not a throw");
});

test("search maps wide-glyph rows back to grid columns", () => {
  const t = createTerminalEmulator({ cols: 20, rows: 2 });
  t.write("a你好b");
  const hits = searchBuffer(t.rowInfo, t.bufferLength(), "b", {});
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.startCol, 5, "b sits after two wide glyphs");
});

test("palette: 256-color cube and grayscale, cell CSS resolution", () => {
  assert.equal(xterm256Hex(16), "#000000");
  assert.equal(xterm256Hex(196), "#ff0000");
  assert.equal(xterm256Hex(21), "#0000ff");
  assert.equal(xterm256Hex(231), "#ffffff");
  assert.equal(xterm256Hex(232), "#080808");
  assert.equal(xterm256Hex(255), "#eeeeee");
  assert.equal(cellColorCss(-1), null);
  assert.equal(cellColorCss(3), "var(--term-a3)");
  assert.equal(cellColorCss(196), "#ff0000");
  assert.equal(cellColorCss(packRgb(1, 2, 3)), "#010203");
});
