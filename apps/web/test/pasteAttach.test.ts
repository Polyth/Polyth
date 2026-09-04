import assert from "node:assert/strict";
import test from "node:test";
import {
  LARGE_PASTE_CHAR_THRESHOLD,
  LARGE_PASTE_LINE_THRESHOLD,
  attachText,
  formatPasteSize,
  isLargeTextPaste,
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
});

test("suggestPasteFilename is always .txt with a stable index", () => {
  assert.equal(suggestPasteFilename(1), "pasted-context-1.txt");
  assert.equal(suggestPasteFilename(3.9), "pasted-context-3.txt");
  assert.equal(suggestPasteFilename(0), "pasted-context-1.txt");
  assert.equal(suggestPasteFilename(2), "pasted-context-2.txt");
});

test("formatPasteSize and byte length", () => {
  assert.equal(formatPasteSize(40), "40 B");
  assert.equal(formatPasteSize(1536), "1.5 KB");
  assert.equal(formatPasteSize(12_288), "12 KB");
  assert.equal(pasteByteLength("café"), 5);
});

test("attachText uploads a text/plain File to the captured session", async () => {
  const calls: Array<{ projectId: string; sessionId: string | null | undefined; name: string; type: string }> = [];
  const result = await attachText(
    "proj-a",
    "sess-a",
    "lots of pasted context",
    4,
    async (projectId, sessionId, file) => {
      calls.push({ projectId, sessionId, name: file.name, type: file.type });
      return { ok: true };
    },
  );
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [{
    projectId: "proj-a",
    sessionId: "sess-a",
    name: "pasted-context-4.txt",
    type: "text/plain",
  }]);
});
