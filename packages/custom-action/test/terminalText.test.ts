import test from "node:test";
import assert from "node:assert/strict";
import { terminalLines, terminalPlainText } from "../src/terminalText.ts";

test("SGR colors and weights become styled segments", () => {
  const [line] = terminalLines("\x1b[1;32mPASS\x1b[0m src/a.test.ts \x1b[38;5;196mred\x1b[39m \x1b[38;2;10;20;30mrgb\x1b[m");
  assert.deepEqual(line, [
    { text: "PASS", bold: true, fg: 2 },
    { text: " src/a.test.ts " },
    { text: "red", fg: "rgb(255, 0, 0)" },
    { text: " " },
    { text: "rgb", fg: "rgb(10, 20, 30)" },
  ]);
  const [bright] = terminalLines("\x1b[91;44mx\x1b[22;39;49m");
  assert.deepEqual(bright, [{ text: "x", fg: 9, bg: 4 }]);
});

test("carriage returns and erased lines collapse progress output", () => {
  assert.equal(terminalPlainText("Downloading 10%\rDownloading 55%\rDownloading 100%\r\ndone\r\n"), "Downloading 100%\ndone");
  // A shorter rewrite after an erase does not keep the old tail.
  assert.equal(terminalPlainText("building module 12\r\x1b[Kok\n"), "ok");
  // Without an erase a terminal keeps the overwritten tail, like a real one.
  assert.equal(terminalPlainText("abcdef\rXY"), "XYcdef");
  assert.equal(terminalPlainText("ab\bC"), "aC");
});

test("cursor-up rewrites replace earlier lines (multi-line progress)", () => {
  const raw = "step 1: waiting\nstep 2: waiting\n\x1b[2A\x1b[2Kstep 1: done\n\x1b[2Kstep 2: done\n";
  assert.equal(terminalPlainText(raw), "step 1: done\nstep 2: done");
});

test("control strings, titles and unfinished escapes never leak as text", () => {
  assert.equal(terminalPlainText("\x1b]0;window title\x07hello\x1b]8;;https://x\x1b\\link\x1b]8;;\x1b\\ \x1b(Bend\x1b["), "hellolink end");
  assert.equal(terminalPlainText("tab\there"), "tab     here");
  assert.equal(terminalPlainText("\x07bell\x00"), "bell");
});

test("trailing blanks are trimmed and an empty log stays empty", () => {
  assert.deepEqual(terminalLines(""), [[]]);
  assert.equal(terminalPlainText("one   \ntwo\n\n"), "one\ntwo\n");
});
