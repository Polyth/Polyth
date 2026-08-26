// Terminal emulator core: VT parsing, screen model, colors, scrollback,
// alternate screen, resize, selection extraction, and host responses.
import test from "node:test";
import assert from "node:assert/strict";
import {
  ATTR_BOLD, ATTR_INVERSE, ATTR_UNDERLINE, COLOR_DEFAULT,
  charWidth, createTerminalEmulator, isRgbColor, packRgb, rgbOf,
} from "../widgets/terminal/emulator.ts";

const emu = (cols = 20, rows = 5, scrollback = 100) =>
  createTerminalEmulator({ cols, rows, scrollback });

/** Rendered text of one absolute row (trailing blanks trimmed). */
const rowText = (t: ReturnType<typeof emu>, index: number) => t.rowInfo(index).text;

/** All screen rows as text. */
const screenText = (t: ReturnType<typeof emu>) => {
  const start = t.scrollbackLength();
  const out: string[] = [];
  for (let i = 0; i < t.rows(); i++) out.push(rowText(t, start + i));
  return out;
};

test("plain text prints and cursor advances", () => {
  const t = emu();
  t.write("hello");
  assert.equal(rowText(t, 0), "hello");
  assert.deepEqual([t.cursor().x, t.cursor().y], [5, 0]);
});

test("CR/LF move the cursor without clearing the line", () => {
  const t = emu();
  t.write("abc\r\ndef");
  assert.equal(rowText(t, 0), "abc");
  assert.equal(rowText(t, 1), "def");
  t.write("\rD");
  assert.equal(rowText(t, 1), "Def");
});

test("autowrap wraps at the right margin and marks the line wrapped", () => {
  const t = emu(5, 3);
  t.write("abcdefg");
  assert.equal(rowText(t, 0), "abcde");
  assert.equal(rowText(t, 1), "fg");
  assert.equal(t.line(0)!.wrapped, true);
  assert.equal(t.line(1)!.wrapped, false);
});

test("wrap is deferred: printing in the last column leaves cursor on the row", () => {
  const t = emu(5, 3);
  t.write("abcde");
  assert.equal(t.cursor().y, 0, "no premature wrap");
  t.write("\rX");
  assert.equal(rowText(t, 0), "Xbcde");
});

test("cursor movement: CUU/CUD/CUF/CUB/CUP clamp to the screen", () => {
  const t = emu(10, 4);
  t.write("\x1b[2;3H"); // row 2 col 3
  assert.deepEqual([t.cursor().x, t.cursor().y], [2, 1]);
  t.write("\x1b[A\x1b[A\x1b[A"); // clamped at top
  assert.equal(t.cursor().y, 0);
  t.write("\x1b[10B");
  assert.equal(t.cursor().y, 3);
  t.write("\x1b[99C");
  assert.equal(t.cursor().x, 9);
  t.write("\x1b[2D");
  assert.equal(t.cursor().x, 7);
});

test("ED clear screen variants", () => {
  const t = emu(10, 3);
  t.write("111\r\n222\r\n333");
  t.write("\x1b[2;2H\x1b[0J"); // clear from cursor down
  assert.deepEqual(screenText(t), ["111", "2", ""]);
  const u = emu(10, 3);
  u.write("111\r\n222\r\n333");
  u.write("\x1b[2;2H\x1b[1J"); // clear from top to cursor (inclusive)
  assert.deepEqual(screenText(u), ["", "  2", "333"]);
  u.write("\x1b[2J");
  assert.deepEqual(screenText(u), ["", "", ""]);
});

test("EL erases within a line honoring current bg (BCE)", () => {
  const t = emu(10, 2);
  t.write("abcdefghij\x1b[1;4H");
  t.write("\x1b[41m\x1b[K"); // erase to EOL with red bg
  assert.equal(rowText(t, 0), "abc");
  assert.equal(t.line(0)!.bg[5], 1, "erased cells carry the red background");
});

test("ICH/DCH/ECH edit within a line", () => {
  const t = emu(10, 2);
  t.write("abcdef\x1b[1;2H\x1b[2@"); // insert two blanks at col 2
  assert.equal(rowText(t, 0), "a  bcdef");
  t.write("\x1b[1;2H\x1b[2P"); // delete two chars
  assert.equal(rowText(t, 0), "abcdef");
  t.write("\x1b[1;2H\x1b[3X"); // erase three chars in place
  assert.equal(rowText(t, 0), "a   ef");
});

test("IL/DL insert and delete lines inside the scroll region", () => {
  const t = emu(10, 4);
  t.write("aa\r\nbb\r\ncc\r\ndd");
  t.write("\x1b[2;2H\x1b[1L"); // insert line at row 2
  assert.deepEqual(screenText(t), ["aa", "", "bb", "cc"]);
  t.write("\x1b[2;1H\x1b[1M"); // delete row 2
  assert.deepEqual(screenText(t), ["aa", "bb", "cc", ""]);
});

test("scroll region (DECSTBM) scrolls only inside the region", () => {
  const t = emu(10, 4);
  t.write("aa\r\nbb\r\ncc\r\ndd");
  t.write("\x1b[2;3r"); // region rows 2..3
  t.write("\x1b[3;1H\n"); // LF at region bottom scrolls the region
  assert.deepEqual(screenText(t), ["aa", "cc", "", "dd"]);
  assert.equal(t.scrollbackLength(), 0, "region scroll never leaks to scrollback");
});

test("full-screen scroll pushes into scrollback; ED 3 clears it", () => {
  const t = emu(10, 2, 100);
  t.write("one\r\ntwo\r\nthree\r\nfour");
  assert.equal(t.scrollbackLength(), 2);
  assert.equal(rowText(t, 0), "one");
  assert.equal(rowText(t, 1), "two");
  assert.deepEqual(screenText(t), ["three", "four"]);
  t.write("\x1b[3J");
  assert.equal(t.scrollbackLength(), 0);
});

test("scrollback is capped", () => {
  const t = emu(10, 2, 10);
  for (let i = 0; i < 500; i++) t.write(`line${i}\r\n`);
  assert.ok(t.scrollbackLength() <= 10 + 256, `capped (${t.scrollbackLength()})`);
});

test("SGR 16-color, bright, 256-color and truecolor parse into cells", () => {
  const t = emu(40, 2);
  t.write("\x1b[31mR\x1b[92mG\x1b[38;5;123mX\x1b[38;2;1;2;3mT\x1b[0mN");
  const line = t.line(0)!;
  assert.equal(line.fg[0], 1, "red");
  assert.equal(line.fg[1], 10, "bright green");
  assert.equal(line.fg[2], 123, "256-color");
  assert.ok(isRgbColor(line.fg[3]!), "truecolor flag");
  assert.equal(rgbOf(line.fg[3]!), (1 << 16) | (2 << 8) | 3);
  assert.equal(line.fg[4], COLOR_DEFAULT, "reset");
});

test("SGR colon subparameter forms (38:5:n and 38:2::r:g:b)", () => {
  const t = emu(40, 2);
  t.write("\x1b[38:5:200mA\x1b[38:2::10:20:30mB\x1b[38:2:40:50:60mC");
  const line = t.line(0)!;
  assert.equal(line.fg[0], 200);
  assert.equal(rgbOf(line.fg[1]!), (10 << 16) | (20 << 8) | 30);
  assert.equal(rgbOf(line.fg[2]!), (40 << 16) | (50 << 8) | 60);
});

test("SGR attributes set and clear", () => {
  const t = emu(40, 2);
  t.write("\x1b[1;4;7mA\x1b[22;24;27mB");
  const line = t.line(0)!;
  assert.equal(line.attrs[0]! & (ATTR_BOLD | ATTR_UNDERLINE | ATTR_INVERSE), ATTR_BOLD | ATTR_UNDERLINE | ATTR_INVERSE);
  assert.equal(line.attrs[1], 0);
});

test("alternate screen 1049 saves, clears, and restores the primary", () => {
  const t = emu(10, 3);
  t.write("main\r\nsecond");
  t.write("\x1b[?1049h");
  assert.equal(t.modes().altScreen, true);
  assert.deepEqual(screenText(t), ["", "", ""], "alt starts blank");
  assert.equal(t.scrollbackLength(), 0, "alt hides scrollback");
  t.write("ALT UI");
  assert.equal(rowText(t, 0), "ALT UI");
  t.write("\x1b[?1049l");
  assert.equal(t.modes().altScreen, false);
  assert.deepEqual(screenText(t), ["main", "second", ""], "primary restored");
});

test("DECAWM off stops wrapping; chars overwrite the last column", () => {
  const t = emu(5, 2);
  t.write("\x1b[?7l");
  t.write("abcdefgh");
  assert.equal(rowText(t, 0), "abcdh");
  assert.equal(t.cursor().y, 0);
});

test("modes: DECCKM, bracketed paste, mouse tracking, focus reporting", () => {
  const t = emu();
  t.write("\x1b[?1h\x1b[?2004h\x1b[?1002h\x1b[?1006h\x1b[?1004h");
  const m = t.modes();
  assert.equal(m.appCursorKeys, true);
  assert.equal(m.bracketedPaste, true);
  assert.equal(m.mouseTracking, 1002);
  assert.equal(m.mouseSgr, true);
  assert.equal(m.focusReporting, true);
  t.write("\x1b[?1l\x1b[?2004l\x1b[?1002l");
  assert.equal(t.modes().appCursorKeys, false);
  assert.equal(t.modes().bracketedPaste, false);
  assert.equal(t.modes().mouseTracking, 0);
});

test("cursor visibility and style (DECTCEM + DECSCUSR)", () => {
  const t = emu();
  assert.equal(t.cursor().visible, true);
  t.write("\x1b[?25l");
  assert.equal(t.cursor().visible, false);
  t.write("\x1b[?25h\x1b[5 q");
  assert.equal(t.cursor().style, "bar");
  assert.equal(t.cursor().blink, true);
  t.write("\x1b[4 q");
  assert.equal(t.cursor().style, "underline");
  assert.equal(t.cursor().blink, false);
});

test("DECSC/DECRC and CSI s/u save and restore cursor + attributes", () => {
  const t = emu(20, 4);
  t.write("\x1b[31m\x1b[2;5H\x1b7");
  t.write("\x1b[0m\x1b[4;1Hmoved");
  t.write("\x1b8X");
  const line = t.line(1)!;
  assert.equal(line.chars[4], "X");
  assert.equal(line.fg[4], 1, "restored red fg");
});

test("tab stops: HT, custom HTS, TBC", () => {
  const t = emu(30, 2);
  t.write("\tX");
  assert.equal(t.line(0)!.chars[8], "X");
  t.write("\r\x1b[2J\x1b[H");
  t.write("\x1b[3g"); // clear all stops
  t.write("ab\x1bH"); // set stop at col 2
  t.write("\r\tY");
  assert.equal(t.line(0)!.chars[2], "Y", "custom stop honored");
});

test("RI at top scrolls down; IND at bottom scrolls up", () => {
  const t = emu(10, 3, 0);
  t.write("aa\r\nbb\r\ncc");
  t.write("\x1b[1;1H\x1bM"); // RI at top
  assert.deepEqual(screenText(t), ["", "aa", "bb"]);
  t.write("\x1b[3;1H\x1bD"); // IND at bottom
  assert.deepEqual(screenText(t), ["aa", "bb", ""]);
});

test("OSC 0/2 set the title; OSC 8 hyperlinks attach to cells", () => {
  const t = emu(30, 2);
  t.write("\x1b]2;my title\x07");
  assert.equal(t.title(), "my title");
  t.write("\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\ plain");
  const line = t.line(0)!;
  assert.ok(line.links, "links recorded");
  assert.equal(t.linkUrl(line.links![0]!), "https://example.com");
  assert.equal(line.links![5], 0, "link cleared after empty OSC 8");
});

test("DSR and DA respond through onResponse", () => {
  const t = emu(20, 5);
  const replies: string[] = [];
  t.onResponse((d) => replies.push(d));
  t.write("\x1b[3;7H\x1b[6n");
  assert.deepEqual(replies, ["\x1b[3;7R"]);
  t.write("\x1b[5n\x1b[c");
  assert.equal(replies[1], "\x1b[0n");
  assert.match(replies[2]!, /^\x1b\[\?62/);
});

test("OSC 11 background query replies with the configured color", () => {
  const t = createTerminalEmulator({ cols: 10, rows: 2, queryBg: "#102030" });
  const replies: string[] = [];
  t.onResponse((d) => replies.push(d));
  t.write("\x1b]11;?\x07");
  assert.equal(replies[0], "\x1b]11;rgb:1010/2020/3030\x07");
});

test("bell fires the callback and unknown sequences never throw", () => {
  const t = emu();
  let bells = 0;
  t.onBell(() => bells++);
  t.write("\x07\x1b[>999x\x1b]999;whatever\x07\x1bP1;2|junk\x1b\\ok\x07");
  assert.equal(bells, 2);
  assert.equal(rowText(t, 0), "ok");
});

test("DEC special graphics render box drawing", () => {
  const t = emu(10, 2);
  t.write("\x1b(0lqqk\x1b(B");
  assert.equal(rowText(t, 0), "┌──┐");
});

test("wide chars occupy two cells; overwriting a half clears the glyph", () => {
  const t = emu(10, 2);
  t.write("你好");
  const line = t.line(0)!;
  assert.equal(line.chars[0], "你");
  assert.equal(line.chars[1], "");
  assert.equal(line.chars[2], "好");
  assert.equal(t.cursor().x, 4);
  t.write("\x1b[1;2HX"); // overwrite the tail half
  assert.equal(t.line(0)!.chars[0], " ", "orphaned head cleared");
  assert.equal(t.line(0)!.chars[1], "X");
});

test("erasing either half of a wide glyph clears the complete cell pair", () => {
  const t = emu(10, 2);
  t.write("A你B\x1b[1;3H\x1b[X"); // erase from the trailing half
  const line = t.line(0)!;
  assert.equal(line.chars[1], " ");
  assert.equal(line.chars[2], " ");
  assert.equal(line.chars[3], "B");
  assert.equal(line.fg[1], COLOR_DEFAULT);
  assert.equal(line.fg[2], COLOR_DEFAULT);
});

test("wide char at the margin wraps whole", () => {
  const t = emu(5, 3);
  t.write("abcd漢");
  assert.equal(rowText(t, 0), "abcd");
  assert.equal(t.line(1)!.chars[0], "漢");
});

test("combining marks attach to the previous cell", () => {
  const t = emu(10, 2);
  t.write("e\u0301x");
  const line = t.line(0)!;
  assert.equal(line.chars[0], "e\u0301");
  assert.equal(line.chars[1], "x");
});

test("charWidth covers narrow, wide, combining and zero-width", () => {
  assert.equal(charWidth(0x61), 1);
  assert.equal(charWidth(0x4e00), 2);
  assert.equal(charWidth(0x301), 0);
  assert.equal(charWidth(0x200b), 0);
  assert.equal(charWidth(0x1f600), 2);
});

test("rowInfo maps text indexes to columns for wide rows", () => {
  const t = emu(10, 2);
  t.write("a你b");
  const info = t.rowInfo(0);
  assert.equal(info.text, "a你b");
  assert.ok(info.map);
  assert.equal(info.map![0], 0);
  assert.equal(info.map![1], 1); // 你 head at col 1
  assert.equal(info.map![2], 3); // b at col 3
});

test("REP repeats the last printed glyph", () => {
  const t = emu(20, 2);
  t.write("=\x1b[5b");
  assert.equal(rowText(t, 0), "======");
});

test("DECALN fills the screen with E", () => {
  const t = emu(4, 2);
  t.write("\x1b#8");
  assert.deepEqual(screenText(t), ["EEEE", "EEEE"]);
});

test("resize wider pads lines; narrower truncates; taller pulls from scrollback", () => {
  const t = emu(10, 3, 100);
  t.write("one\r\ntwo\r\nthree\r\nfour\r\nfive");
  assert.equal(t.scrollbackLength(), 2);
  t.resize(15, 3);
  assert.equal(t.cols(), 15);
  assert.equal(rowText(t, t.scrollbackLength()), "three");
  t.resize(15, 5);
  assert.equal(t.rows(), 5);
  assert.equal(t.scrollbackLength(), 0, "grown rows pulled back from scrollback");
  assert.equal(rowText(t, 0), "one");
  t.resize(15, 2);
  assert.ok(t.scrollbackLength() >= 1, "shrink pushes rows into scrollback");
});

test("getText extracts ranges, joins wrapped lines, trims trailing blanks", () => {
  const t = emu(5, 4, 100);
  t.write("abcdefg\r\nxy");
  // row0 "abcde" (wrapped) row1 "fg" row2 "xy"
  const all = t.getText({ row: 0, col: 0 }, { row: 2, col: 2 });
  assert.equal(all, "abcdefg\nxy");
  const mid = t.getText({ row: 0, col: 2 }, { row: 1, col: 1 });
  assert.equal(mid, "cdef");
  const reversed = t.getText({ row: 2, col: 2 }, { row: 0, col: 0 });
  assert.equal(reversed, "abcdefg\nxy", "order normalizes");
});

test("clearBuffer drops scrollback and blanks the screen", () => {
  const t = emu(10, 2, 100);
  t.write("a\r\nb\r\nc\r\nd");
  assert.ok(t.scrollbackLength() > 0);
  t.clearBuffer();
  assert.equal(t.scrollbackLength(), 0);
  assert.deepEqual(screenText(t), ["", ""]);
  assert.deepEqual([t.cursor().x, t.cursor().y], [0, 0]);
});

test("reset restores a pristine terminal", () => {
  const t = emu(10, 3, 100);
  t.write("\x1b[31m\x1b[?1049h\x1b[?2004hstuff");
  t.reset();
  assert.equal(t.modes().altScreen, false);
  assert.equal(t.modes().bracketedPaste, false);
  assert.equal(t.scrollbackLength(), 0);
  assert.deepEqual(screenText(t), ["", "", ""]);
  t.write("x");
  assert.equal(t.line(0)!.fg[0], COLOR_DEFAULT);
});

test("onUpdate coalesces per write and reports mutations", () => {
  const t = emu();
  let updates = 0;
  const sub = t.onUpdate(() => updates++);
  t.write("hello world this is a longer chunk\r\nwith two lines");
  assert.equal(updates, 1, "one update per write batch");
  t.write("\x1b[?25l");
  assert.equal(updates, 2);
  sub.dispose();
  t.write("more");
  assert.equal(updates, 2);
});

test("DEC synchronized output suppresses intermediate paints until release", () => {
  const t = emu();
  let updates = 0;
  t.onUpdate(() => updates++);
  t.write("\x1b[?2026hfirst");
  t.write("\rsecond");
  assert.equal(updates, 0);
  assert.equal(rowText(t, 0), "second");
  t.write("\x1b[?2026l");
  assert.equal(updates, 1);
});

test("split escape sequences across write chunks parse correctly", () => {
  const t = emu(20, 3);
  t.write("\x1b[");
  t.write("3");
  t.write("1mred");
  assert.equal(t.line(0)!.fg[0], 1);
  t.write("\x1b]2;spl");
  t.write("it\x07");
  assert.equal(t.title(), "split");
  t.write("\r\x1b%Gutf8");
  assert.equal(rowText(t, 0), "utf8", "ESC % G is consumed as charset selection");
});

test("split surrogate pairs remain one wide glyph", () => {
  const t = emu(10, 2);
  const smile = "😀";
  t.write(smile[0]!);
  assert.equal(t.cursor().x, 0, "high surrogate is buffered");
  t.write(smile[1]!);
  assert.equal(t.line(0)!.chars[0], smile);
  assert.equal(t.line(0)!.chars[1], "");
  assert.equal(t.cursor().x, 2);
});

test("8-bit C1 CSI, OSC, ST, IND, and NEL forms are accepted", () => {
  const t = emu(20, 3);
  t.write("\x9b31mred\x9b0m");
  assert.equal(t.line(0)!.fg[0], 1);
  t.write("\x9d2;c1 title\x9c");
  assert.equal(t.title(), "c1 title");
  t.write("\x9d8;;https://example.com\x9clink\x9d8;;\x9c");
  assert.equal(t.linkUrl(t.line(0)!.links![3]!), "https://example.com");
  t.write("\x85next\x84down");
  assert.deepEqual(screenText(t), ["redlink", "next", "    down"]);
});

test("packRgb round-trips", () => {
  const c = packRgb(255, 128, 7);
  assert.ok(isRgbColor(c));
  assert.equal(rgbOf(c), (255 << 16) | (128 << 8) | 7);
});
