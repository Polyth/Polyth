import assert from "node:assert/strict";
import test from "node:test";
import {
  LARGE_PASTE_CHAR_THRESHOLD,
  LARGE_PASTE_LINE_THRESHOLD,
  formatPasteSize,
  isLargeTextPaste,
  mimeForPasteFilename,
  pasteByteLength,
  suggestPasteFilename,
} from "../src/pasteAttach.ts";

test("thresholds are exported for settings and call sites", () => {
  assert.equal(LARGE_PASTE_CHAR_THRESHOLD, 2000);
  assert.equal(LARGE_PASTE_LINE_THRESHOLD, 25);
});

test("isLargeTextPaste trips on char or line count", () => {
  assert.equal(isLargeTextPaste("short"), false);
  assert.equal(isLargeTextPaste("x".repeat(LARGE_PASTE_CHAR_THRESHOLD - 1)), false);
  assert.equal(isLargeTextPaste("x".repeat(LARGE_PASTE_CHAR_THRESHOLD)), true);
  assert.equal(isLargeTextPaste(Array(LARGE_PASTE_LINE_THRESHOLD - 1).fill("line").join("\n")), false);
  assert.equal(isLargeTextPaste(Array(LARGE_PASTE_LINE_THRESHOLD).fill("line").join("\n")), true);
  // Short lines still count toward the line threshold.
  assert.equal(isLargeTextPaste(Array(30).fill("a").join("\n")), true);
});

test("suggestPasteFilename uses index and conservative extensions", () => {
  assert.equal(suggestPasteFilename("hello", 1), "pasted-context-1.txt");
  assert.equal(suggestPasteFilename("hello", 3.9), "pasted-context-3.txt");
  assert.equal(suggestPasteFilename("hello", 0), "pasted-context-1.txt");

  const json = `${"{\n  \"name\": \"polyth\",\n  \"ok\": true\n}"}\n`.repeat(5);
  assert.equal(suggestPasteFilename(json, 2), "pasted-context-2.json");

  const yaml = ["a: 1", "b: 2", "c: 3", "d: 4", "e: 5"].join("\n");
  assert.equal(suggestPasteFilename(yaml, 1), "pasted-context-1.yaml");

  const ts = 'import { foo } from "./bar";\nexport interface Foo { x: string }\n';
  assert.equal(suggestPasteFilename(ts, 1), "pasted-context-1.ts");

  const py = "def greet(name):\n    return name\n";
  assert.equal(suggestPasteFilename(py, 1), "pasted-context-1.py");

  const md = "# Title\n\nSome prose.\n";
  assert.equal(suggestPasteFilename(md, 1), "pasted-context-1.md");
});

test("formatPasteSize and mime helpers", () => {
  assert.equal(formatPasteSize(40), "40 B");
  assert.equal(formatPasteSize(1536), "1.5 KB");
  assert.equal(formatPasteSize(12_288), "12 KB");
  assert.equal(pasteByteLength("café"), 5);
  assert.equal(mimeForPasteFilename("pasted-context-1.json"), "application/json");
  assert.equal(mimeForPasteFilename("pasted-context-1.txt"), "text/plain");
});
