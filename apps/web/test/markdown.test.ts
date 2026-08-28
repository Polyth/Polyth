// WP4: shared Markdown pipeline — parser (incl. streaming/incomplete input),
// URL sanitation, file-reference grammar, merged thinking. Pure, DOM-free.
import { test } from "node:test";
import assert from "node:assert";
import { parseMarkdown, parseInline, collectImages } from "../src/markdown/parse.ts";
import { sanitizeLinkHref, sanitizeImageSrc } from "../src/markdown/sanitize.ts";
import { parseFileRef, findFileRefs } from "../src/markdown/fileReference.ts";
import { mergeThinking, messageJson, promptIndex } from "../src/utils.ts";
import type { AssistantMsg, RenderMessage, ToolMsg, UserMsg } from "../src/reduce.ts";

// ---------------------------------------------------------------- parser

test("parse: headings, lists, quote, hr, table", () => {
  const blocks = parseMarkdown([
    "# Title",
    "",
    "- a",
    "- b",
    "",
    "1. one",
    "",
    "> quoted",
    "",
    "---",
    "",
    "| h1 | h2 |",
    "| -- | -- |",
    "| a  | b  |",
  ].join("\n"));
  const kinds = blocks.map((b) => b.kind);
  assert.deepEqual(kinds, ["heading", "list", "list", "quote", "hr", "table"]);
  const table = blocks[5]!;
  assert.ok(table.kind === "table" && table.rows.length === 1 && table.header.length === 2);
});

test("parse: streaming unterminated fence never throws and stays open", () => {
  const blocks = parseMarkdown("```ts\nconst x = 1;\nconst y =");
  assert.equal(blocks.length, 1);
  const b = blocks[0]!;
  assert.ok(b.kind === "code");
  assert.equal(b.closed, false);
  assert.equal(b.lang, "ts");
  assert.match(b.text, /const y =$/);
});

test("parse: dangling emphasis degrades to literal text", () => {
  const inline = parseInline("an *unclosed emphasis");
  assert.deepEqual(inline, [{ kind: "text", text: "an *unclosed emphasis" }]);
});

test("parse: inline code, links, images, math", () => {
  const inline = parseInline('see `code` and [x](https://x.dev) and ![alt](https://x.dev/i.png) and $e=mc^2$');
  const kinds = inline.map((i) => i.kind);
  assert.deepEqual(kinds, ["text", "code", "text", "link", "text", "image", "text", "math"]);
});

test("parse: escaped dollar stays literal", () => {
  const inline = parseInline("price \\$5 and \\$6");
  assert.deepEqual(inline, [{ kind: "text", text: "price $5 and $6" }]);
});

test("parse: display math block", () => {
  const blocks = parseMarkdown("$$\n\\int_0^1 x dx\n$$");
  assert.equal(blocks[0]!.kind, "mathBlock");
});

test("collectImages dedupes and keeps order", () => {
  const blocks = parseMarkdown("![a](https://x/1.png) ![b](https://x/2.png)\n\n![c](https://x/1.png)");
  const imgs = collectImages(blocks);
  assert.deepEqual(imgs.map((i) => i.src), ["https://x/1.png", "https://x/2.png"]);
});

// ---------------------------------------------------------------- sanitize

test("links: unsafe schemes are dropped", () => {
  assert.equal(sanitizeLinkHref("javascript:alert(1)"), null);
  assert.equal(sanitizeLinkHref("JaVaScRiPt:alert(1)"), null);
  assert.equal(sanitizeLinkHref("data:text/html,<script>"), null);
  assert.equal(sanitizeLinkHref("vbscript:x"), null);
  assert.equal(sanitizeLinkHref("file:///etc/passwd"), null);
  assert.equal(sanitizeLinkHref("//evil.example"), null);
});

test("links: http(s), mailto, anchors survive", () => {
  assert.equal(sanitizeLinkHref("https://x.dev/a?b=c"), "https://x.dev/a?b=c");
  assert.equal(sanitizeLinkHref("http://x.dev"), "http://x.dev");
  assert.equal(sanitizeLinkHref("mailto:a@b.c"), "mailto:a@b.c");
  assert.equal(sanitizeLinkHref("#section"), "#section");
});

test("images: traversal and unsafe schemes rejected; project paths rewritten", () => {
  assert.equal(sanitizeImageSrc("javascript:x", { projectId: "p1" }), null);
  assert.equal(sanitizeImageSrc("data:image/png;base64,AAAA", { projectId: "p1" }), null);
  assert.equal(sanitizeImageSrc("../secret.png", { projectId: "p1" }), null);
  assert.equal(sanitizeImageSrc("a/../../b.png", { projectId: "p1" }), null);
  assert.equal(sanitizeImageSrc("/etc/passwd", { projectId: "p1" }), null);
  assert.equal(sanitizeImageSrc("//host/i.png", { projectId: "p1" }), null);
  assert.equal(sanitizeImageSrc("docs/a.png"), null); // no project context
  assert.equal(
    sanitizeImageSrc("docs/a b.png", { projectId: "p 1" }),
    "/api/files/raw?projectId=p%201&path=docs%2Fa%20b.png",
  );
  assert.equal(sanitizeImageSrc("https://x.dev/i.png"), "https://x.dev/i.png");
});

// ---------------------------------------------------------------- file refs

test("file refs: path, line, line:col, range", () => {
  assert.deepEqual(parseFileRef("src/app.ts"), { path: "src/app.ts" });
  assert.deepEqual(parseFileRef("src/app.ts:42"), { path: "src/app.ts", startLine: 42 });
  assert.deepEqual(parseFileRef("src/app.ts:42:7"), { path: "src/app.ts", startLine: 42, column: 7 });
  assert.deepEqual(parseFileRef("src/app.ts:10-20"), { path: "src/app.ts", startLine: 10, endLine: 20 });
});

test("file refs: non-paths are rejected", () => {
  assert.equal(parseFileRef("https://x.dev/a.ts"), null);
  assert.equal(parseFileRef("hello"), null);
  assert.equal(parseFileRef("word:12"), null);
  assert.equal(parseFileRef("/etc/passwd"), null);
  assert.equal(parseFileRef("../up.ts"), null);
  assert.equal(parseFileRef("a\\b.ts"), null);
  assert.equal(parseFileRef("src/app.ts:20-10"), null); // inverted range
  assert.equal(parseFileRef("src/app.ts:0"), null);     // lines are 1-based
});

test("file refs: trailing punctuation trimmed inside prose", () => {
  const loc = parseFileRef("src/app.ts:42.");
  assert.deepEqual(loc, { path: "src/app.ts", startLine: 42 });
});

test("findFileRefs splits prose into text and ref segments", () => {
  const segs = findFileRefs("see src/app.ts:12 for details");
  const refs = segs.filter((s) => s.kind === "ref");
  assert.equal(refs.length, 1);
  assert.deepEqual((refs[0] as { loc: unknown }).loc, { path: "src/app.ts", startLine: 12 });
  assert.equal(segs.map((s) => s.text).join(""), "see src/app.ts:12 for details");
});

// ---------------------------------------------------------------- thinking

const user = (id: string, text: string): UserMsg => ({ kind: "user", id, eventSeq: 1, text, time: 0 });
const asst = (id: string, text: string, reasoning: string, finalized = true): AssistantMsg =>
  ({ kind: "assistant", id, partId: id, eventSeq: 1, text, reasoning, finalized, time: 0 });
const tool = (id: string): ToolMsg => ({ kind: "tool", id, callId: id, eventSeq: 1, tool: "bash", input: {}, status: "done", time: 0 });

test("mergeThinking folds reasoning-only parts into the next answer", () => {
  const msgs: RenderMessage[] = [user("u1", "hi"), asst("a1", "", "step one"), asst("a2", "", "step two"), asst("a3", "answer", "final")];
  const out = mergeThinking(msgs);
  assert.equal(out.length, 2);
  const a = out[1]!;
  assert.ok(a.kind === "assistant");
  assert.equal(a.text, "answer");
  assert.equal(a.reasoning, "step one\n\nstep two\n\nfinal");
});

test("mergeThinking keeps the earliest reasoning start and latest end across merges", () => {
  const withSpan = (id: string, reasoning: string, startedAt: number, endedAt: number): AssistantMsg =>
    ({ ...asst(id, "", reasoning), reasoningStartedAt: startedAt, reasoningEndedAt: endedAt });
  const msgs: RenderMessage[] = [
    withSpan("a1", "step one", 1_000, 4_000),
    withSpan("a2", "step two", 5_000, 9_000),
    { ...asst("a3", "answer", "final"), reasoningStartedAt: 10_000, reasoningEndedAt: 19_000 },
  ];
  const out = mergeThinking(msgs);
  assert.equal(out.length, 1);
  const a = out[0]!;
  assert.ok(a.kind === "assistant");
  assert.equal(a.reasoningStartedAt, 1_000);
  assert.equal(a.reasoningEndedAt, 19_000);
});

test("mergeThinking: tool call cuts the run; trailing run keeps streaming state", () => {
  const msgs: RenderMessage[] = [asst("a1", "", "before tool"), tool("t1"), asst("a2", "", "still going", false)];
  const out = mergeThinking(msgs);
  assert.equal(out.length, 3);
  const first = out[0]!;
  assert.ok(first.kind === "assistant" && first.finalized === true); // proven done by the tool call
  const last = out[2]!;
  assert.ok(last.kind === "assistant" && last.finalized === false);  // still streaming
});

test("messageJson and promptIndex", () => {
  const j = JSON.parse(messageJson(asst("a1", "hello", "why", true)));
  assert.equal(j.role, "assistant");
  assert.equal(j.text, "hello");
  const idx = promptIndex([user("u1", "first prompt\nmore"), asst("a1", "x", ""), user("u2", "second")]);
  assert.deepEqual(idx.map((p) => p.preview), ["first prompt", "second"]);
});
