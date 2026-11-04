import assert from "node:assert/strict";
import test from "node:test";
import { CHAT_BLOCK_VIEWS, chatBlockMarkdown, parseChatBlock, splitFields } from "../src/parse.ts";
import { assertBoundedTime, forEachFuzzInput } from "./fuzzInput.ts";

const TOKENS = ["- ", "* ", "1. ", "- [x] ", "- [ ] ", " | ", "|", "\\|", "\\\\", "> ", "·", " · ", "pick=one", "pick=many", "from=", "cols=", "https://example.com/a.png", "a.csv", "+3%", "3,5,4", "tone=danger", "\n", "\r\n", ...CHAT_BLOCK_VIEWS];

test("parseChatBlock never throws for any view, open or closed", () => {
  forEachFuzzInput(TOKENS, (input) => {
    for (const closed of [true, false]) {
      const result = parseChatBlock(input, closed);
      if (result.ok) assert.ok(CHAT_BLOCK_VIEWS.includes(result.doc.view));
    }
    for (const view of CHAT_BLOCK_VIEWS) {
      const result = parseChatBlock(`${view} Title · pick=many\n${input}`);
      assert.equal(result.ok, true, `view ${view} must parse any body`);
      if (result.ok) assert.equal(typeof chatBlockMarkdown(result.doc), "string");
    }
    splitFields(input);
  });
});

/** The cells of one Markdown table row, split on unescaped pipes and unescaped. */
function tableCells(row: string): string[] {
  const cells: string[] = [];
  let cell = "";
  for (let i = 1; i < row.length - 1; i++) {
    if (row[i] === "\\" && i + 1 < row.length - 1) { cell += row[++i]; continue; }
    if (row[i] === "|") { cells.push(cell.replace(/^ | $/g, "")); cell = ""; continue; }
    cell += row[i];
  }
  cells.push(cell.replace(/^ | $/g, ""));
  return cells;
}

test("chatBlockMarkdown table cells round-trip through pipe and backslash escaping", () => {
  forEachFuzzInput(["|", "\\", "\\|", "\\\\"], (input) => {
    const cell = input.replace(/[\r\n]/g, " ").trim();
    if (!cell) return;
    const result = parseChatBlock(`table\n- ${cell.replace(/\|/g, "")}`);
    assert.ok(result.ok);
    // Hand-built doc: the escaper must keep an arbitrary cell inside its own column.
    const doc = { ...result.doc, view: "table" as const, columns: ["A", "B"], items: [{ ...result.doc.items[0]!, cells: [cell, "z"] }], notes: [] };
    const rows = chatBlockMarkdown(doc).split("\n");
    assert.equal(rows.length, 3, "one header, one rule, one row");
    assert.deepEqual(tableCells(rows[2]!), [cell, "z"]);
  });
});

test("parseChatBlock handles 50k repetitions of each token in bounded time", () => {
  assertBoundedTime(TOKENS, (input) => {
    for (const view of ["cards", "table", "form", "chart"]) parseChatBlock(`${view} T\n${input}`);
  }, { limitMs: 800 }); // four parses per token
});
