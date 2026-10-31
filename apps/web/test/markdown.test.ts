// Shared Markdown pipeline — parser (incl. streaming/incomplete input),
// URL sanitation, file-reference grammar, merged thinking. Pure, DOM-free.
import { test } from "node:test";
import assert from "node:assert";
import { parseMarkdown, parseInline, collectImages, holdBackStreamingTail, splitFrontmatter } from "../src/markdown/parse.ts";
import { sanitizeLinkHref, sanitizeImageSrc, isVideoSource } from "../src/markdown/sanitize.ts";
import { parseFileRef, findFileRefs } from "../src/markdown/fileReference.ts";

test("file references retain Unicode repository-relative names and ranges", () => {
  assert.deepEqual(parseFileRef("документи/опис.md:3-8"), { path: "документи/опис.md", startLine: 3, endLine: 8 });
  assert.deepEqual(findFileRefs("See 資料/説明.ts:7.").filter((part) => part.kind === "ref").map((part) => part.loc.path), ["資料/説明.ts"]);
  assert.equal(parseFileRef("документи/../опис.md"), null);
});
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

test("parse: an opener with extra info tokens keeps the language and the rest as info", () => {
  const b = parseMarkdown("```ui steps Release plan\n- done | Spec | approved\n```")[0]!;
  assert.ok(b.kind === "code");
  assert.equal(b.lang, "ui");
  assert.equal(b.info, "steps Release plan");
  assert.equal(b.text, "- done | Spec | approved");
  assert.equal(b.closed, true);
  // No extra tokens → no info field, so ordinary code fences are unchanged.
  const plain = parseMarkdown("```ts\nconst x = 1;\n```")[0]!;
  assert.ok(plain.kind === "code");
  assert.equal(plain.lang, "ts");
  assert.equal(plain.info, undefined);
});

test("parse: a prose line wrapping inline code in triple ticks is not a fence", () => {
  assert.equal(parseMarkdown("wrap ```the code``` inline")[0]!.kind, "para");
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

test("collectImages skips video files (they render as players, not gallery photos)", () => {
  const blocks = parseMarkdown("![clip](https://x/demo.mp4) ![b](https://x/2.png)");
  assert.deepEqual(collectImages(blocks).map((i) => i.src), ["https://x/2.png"]);
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

test("images: sanitizeImageSrc appends sessionId and repositoryId when provided", () => {
  assert.equal(
    sanitizeImageSrc(".polyth/screenshots/shot.jpg", { projectId: "p1", sessionId: "sess-123" }),
    "/api/files/raw?projectId=p1&path=.polyth%2Fscreenshots%2Fshot.jpg&sessionId=sess-123",
  );
  assert.equal(
    sanitizeImageSrc(".polyth/screenshots/shot.jpg", { projectId: "p1", sessionId: "sess-123", repositoryId: "repo-456" }),
    "/api/files/raw?projectId=p1&path=.polyth%2Fscreenshots%2Fshot.jpg&sessionId=sess-123&repositoryId=repo-456",
  );
  assert.equal(
    sanitizeImageSrc("images/diagram.png", { projectId: "p1", repositoryId: "repo-456" }),
    "/api/files/raw?projectId=p1&path=images%2Fdiagram.png&repositoryId=repo-456",
  );
  assert.equal(
    sanitizeImageSrc("images/diagram.png", { projectId: "p1", sessionId: null, repositoryId: null }),
    "/api/files/raw?projectId=p1&path=images%2Fdiagram.png",
  );
  assert.equal(
    sanitizeImageSrc("https://example.com/pic.png", { projectId: "p1", sessionId: "sess-123", repositoryId: "repo-456" }),
    "https://example.com/pic.png",
  );
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

test("file refs: value pairs, ratios and event names stay text", () => {
  // A slash alone is not a path. Each of these was linkified into a
  // nonexistent editor path before the last-segment rule.
  for (const token of [
    "static/visible", "fixed/hidden", "35/35", "origin/master", "turn/stopped",
    "assistant/message", "tool/result", "v1/v2", "input/output", "Europe/Kyiv",
    "iOS/Android", "apps/web", "packages/server", "api/harnesses/capabilities",
  ]) {
    assert.equal(parseFileRef(token), null, token);
    assert.equal(findFileRefs(token).filter((s) => s.kind === "ref").length, 0, token);
  }
  // …inside a sentence too, and the surrounding prose survives.
  const segs = findFileRefs("`html static/visible` замість fixed/hidden");
  assert.equal(segs.filter((s) => s.kind === "ref").length, 0);
  assert.equal(segs.map((s) => s.text).join(""), "`html static/visible` замість fixed/hidden");
});

test("file refs: a file name keeps working, with or without a directory", () => {
  assert.deepEqual(parseFileRef("apps/web/src/mobileViewport.ts"), { path: "apps/web/src/mobileViewport.ts" });
  assert.deepEqual(parseFileRef("docs/README"), { path: "docs/README" });
  assert.deepEqual(parseFileRef("infra/Dockerfile"), { path: "infra/Dockerfile" });
  // A bare extension-less name stays prose.
  assert.equal(parseFileRef("README"), null);
  assert.equal(findFileRefs("see the README").filter((s) => s.kind === "ref").length, 0);
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

test("file refs: command operands stay text, not links", () => {
  // Run starts with a command word → the whole run is command text.
  assert.equal(findFileRefs("node server/dist/index.cjs").filter((s) => s.kind === "ref").length, 0);
  assert.equal(findFileRefs("node --experimental-strip-types packages/server/src/index.ts").filter((s) => s.kind === "ref").length, 0);
  // Command word mid-prose → the following path operand stays text.
  assert.equal(findFileRefs("Let me run node server/dist/index.cjs").filter((s) => s.kind === "ref").length, 0);
  // A plain path in prose still linkifies.
  assert.equal(findFileRefs("see src/app.ts:12 for details").filter((s) => s.kind === "ref").length, 1);
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
  const fenced = promptIndex([user("u3", "```ts\nconst x = 1;\n```"), user("u4", "x".repeat(200))]);
  assert.equal(fenced[0]!.preview, "const x = 1;");
  assert.equal(fenced[1]!.preview, `${"x".repeat(127)}…`);
});

// ---------------------------------------------------------------- code-block overflow

test("codeBlockOverflow: short content is not collapsible; taller than viewport collapses to a third", async () => {
  const { codeBlockOverflow } = await import("../src/markdown/codeBlock.ts");
  assert.deepEqual(codeBlockOverflow(200, 900), { collapsible: false, collapsedMax: 300 });
  assert.deepEqual(codeBlockOverflow(900, 900), { collapsible: false, collapsedMax: 300 });
  assert.deepEqual(codeBlockOverflow(901, 900), { collapsible: true, collapsedMax: 300 });
});

// ------------------------------------------------------- streaming hold-back

test("hold-back: pipe rows wait for a separator before rendering", () => {
  // Header still arriving, or complete but no separator yet: withheld.
  assert.equal(holdBackStreamingTail("Intro\n\n| a | b"), "Intro\n");
  assert.equal(holdBackStreamingTail("Intro\n\n| a | b |\n"), "Intro\n");
  // A partial separator could still become one.
  assert.equal(holdBackStreamingTail("Intro\n\n| a | b |\n| --"), "Intro\n");
  // The separator line may still gain columns while it is the open line.
  assert.equal(holdBackStreamingTail("Intro\n\n| a | b |\n| -- | -- |"), "Intro\n");
  // Separator terminated: the table renders.
  const settled = "Intro\n\n| a | b |\n| -- | -- |\n";
  assert.equal(holdBackStreamingTail(settled), settled);
  assert.ok(parseMarkdown(holdBackStreamingTail(settled)).some((b) => b.kind === "table"));
});

test("hold-back: an established table only withholds its unfinished row", () => {
  const table = "| a | b |\n| -- | -- |\n| 1 | 2 |\n";
  assert.equal(holdBackStreamingTail(`${table}| 3 |`), table.slice(0, -1));
  assert.equal(holdBackStreamingTail(`${table}| 3 | 4 |\n`), `${table}| 3 | 4 |\n`);
  // Header written without a leading pipe still counts as an established table.
  const bare = "a | b\n--|--\n| 1 | 2 |\n";
  assert.equal(holdBackStreamingTail(`${bare}| 3`), bare.slice(0, -1));
});

test("hold-back: settled prose pipes and fenced code are never withheld", () => {
  // Two complete pipe lines with no separator between them: the first is prose.
  assert.equal(holdBackStreamingTail("| one\n| two\nmore"), "| one\n| two\nmore");
  assert.equal(holdBackStreamingTail("| one\n| two\n"), "| one");
  // Inside an unterminated fence or $$ block nothing changes type.
  const fenced = "```text\n| a | b\n| c";
  assert.equal(holdBackStreamingTail(fenced), fenced);
  const math = "$$\n| x |";
  assert.equal(holdBackStreamingTail(math), math);
  // After a closed fence, block context resumes.
  assert.equal(holdBackStreamingTail("```\ncode\n```\n| a"), "```\ncode\n```");
  // Ordinary prose streams untouched.
  assert.equal(holdBackStreamingTail("Hello **wor"), "Hello **wor");
  assert.equal(holdBackStreamingTail(""), "");
});

test("hold-back: a lone partial block marker waits for its line", () => {
  assert.equal(holdBackStreamingTail("Text\n#"), "Text");
  assert.equal(holdBackStreamingTail("Text\n``"), "Text");
  assert.equal(holdBackStreamingTail("Text\n$"), "Text");
  // Once the line has content it renders normally.
  assert.equal(holdBackStreamingTail("Text\n# Head"), "Text\n# Head");
  // A terminated marker line is final and is not withheld.
  assert.equal(holdBackStreamingTail("Text\n#\n"), "Text\n#\n");
});

// ----------------------------------------------------------------- video

test("isVideoSource: known video extensions, case-insensitive and query/hash aware", () => {
  for (const src of ["clip.mp4", "a/b/clip.webm", "CLIP.MOV", "x.m4v", "x.OGV", "demo.mp4?t=2", "demo.webm#frag"]) {
    assert.equal(isVideoSource(src), true, src);
  }
  for (const src of ["pic.png", "clip.mp4.txt", "mp4", "clip.mp4x", "", "notes.md", "clip.mp4.png"]) {
    assert.equal(isVideoSource(src), false, src);
  }
  // A query does not carry the extension: the path before ?/# decides.
  assert.equal(isVideoSource("clip.mp4?x=.png"), true);
  assert.equal(isVideoSource("clip.png?x=.mp4"), false);
});

// ------------------------------------------------------------ frontmatter

test("splitFrontmatter: simple keys, quotes, inline and block lists", () => {
  const result = splitFrontmatter([
    "---",
    "title: \"Release plan\"",
    "tags: [a, b, c]",
    "authors:",
    "  - Ada",
    "  - Grace",
    "draft: false",
    "---",
    "# Body",
    "text",
  ].join("\n"));
  assert.ok(result);
  assert.deepEqual(result!.properties, [
    { key: "title", value: "Release plan" },
    { key: "tags", value: "a, b, c" },
    { key: "authors", value: "Ada, Grace" },
    { key: "draft", value: "false" },
  ]);
  assert.equal(result!.body, "# Body\ntext");
});

test("splitFrontmatter: CRLF, `...` fence and colons in values", () => {
  const crlf = splitFrontmatter("---\r\ntitle: X\r\n...\r\nbody");
  assert.deepEqual(crlf, { properties: [{ key: "title", value: "X" }], body: "body", dropped: 0 });
  const colon = splitFrontmatter("---\nurl: https://x.dev/a:b\n---\ntext");
  assert.deepEqual(colon!.properties, [{ key: "url", value: "https://x.dev/a:b" }]);
  assert.equal(colon!.dropped, 0);
});

test("splitFrontmatter: empty frontmatter, no closing fence and a mid-document hr are safe", () => {
  assert.deepEqual(splitFrontmatter("---\n---\nbody"), { properties: [], body: "body", dropped: 0 });
  // No closing fence within the document → not frontmatter at all.
  assert.equal(splitFrontmatter("---\ntitle: X\nbody"), null);
  // An hr that is not on the very first line is untouched.
  assert.equal(splitFrontmatter("# Heading\n\n---\n\nmore"), null);
  // First line must be exactly `---`.
  assert.equal(splitFrontmatter(" ---\ntitle: X\n---"), null);
  assert.equal(splitFrontmatter("text\n---\na: b\n---"), null);
});

test("splitFrontmatter: nested maps stay raw in the previous value, never throws", () => {
  const nested = splitFrontmatter("---\nmeta:\n  name: x\n  level: 2\ntitle: T\n---\nbody");
  assert.deepEqual(nested!.properties, [
    { key: "meta", value: "name: x level: 2" },
    { key: "title", value: "T" },
  ]);
  // Comment lines are skipped rather than throwing.
  assert.deepEqual(splitFrontmatter("---\n# comment\nkey: v\n---\n")!.properties, [{ key: "key", value: "v" }]);
});

test("splitFrontmatter: prose between two leading rules is a document, never dropped", () => {
  assert.equal(splitFrontmatter("---\nSome intro text\n---\nmore"), null);
  assert.equal(splitFrontmatter("---\ntitle: X\nA sentence without a key\n---\nmore"), null);
  assert.equal(splitFrontmatter("---\n  indented first\n---\nmore"), null);
});

test("splitFrontmatter: caps properties at 50 and values at 500 chars", () => {
  const lines = ["---"];
  for (let i = 0; i < 60; i++) lines.push(`k${i}: v${i}`);
  lines.push("---", "body");
  const capped = splitFrontmatter(lines.join("\n"))!;
  assert.equal(capped.properties.length, 50);
  assert.equal(capped.properties.at(-1)!.key, "k49");
  assert.equal(capped.dropped, 10, "the dropped count is reported");
  const long = splitFrontmatter(`---\nbig: ${"x".repeat(900)}\n---\n`);
  assert.equal(long!.properties[0]!.value.length, 500);
  assert.ok(long!.properties[0]!.value.endsWith("…"), "a truncated value is marked");
  assert.equal(long!.properties[0]!.value.slice(0, -1), "x".repeat(499));
  // A value at the cap exactly is untouched.
  const exact = splitFrontmatter(`---\nbig: ${"x".repeat(500)}\n---\n`);
  assert.equal(exact!.properties[0]!.value, "x".repeat(500));
  assert.equal(exact!.properties[0]!.value.endsWith("…"), false);
});

test("splitFrontmatter: a closing fence too far down is not frontmatter", () => {
  const lines = ["---"];
  for (let i = 0; i < 250; i++) lines.push(`k${i}: v`);
  lines.push("---");
  assert.equal(splitFrontmatter(lines.join("\n")), null);
});
