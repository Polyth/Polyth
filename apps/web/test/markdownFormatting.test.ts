// Chat formatting must read as written: a quote is a quote (also with the
// default borderless appearance), lists keep their nesting, numbering and the
// code inside a step, tables keep their column alignment, and a bare link or
// file path never swallows the sentence's closing punctuation.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./tsxHooks.mjs", import.meta.url);

const { parseMarkdown, parseInline, holdBackStreamingTail } = await import("../src/markdown/parse.ts");
const { renderBlocks } = await import("../src/markdown/render.tsx");
const { findFileRefs } = await import("../src/markdown/fileReference.ts");
const { createElement, Fragment } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { readWebStylesSync } = await import("./webStyles.ts");

const css = readWebStylesSync();
const html = (md: string): string => renderToStaticMarkup(createElement(Fragment, null, ...renderBlocks(parseMarkdown(md), "t")));
const rule = (selector: string): string => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`(?:^|\\n|\\})\\s*${escaped}\\s*\\{[^}]*\\}`))?.[0] ?? "";
};
const FENCE = "```";

// ------------------------------------------------------------------ quotes

test("a quote renders as a classed blockquote with its own blocks", () => {
  const out = html("> first line\n> second line\n>\n> > earlier voice\n\nreply");
  assert.match(out, /^<blockquote class="md-quote"><p class="md-para"><span>first line\nsecond line<\/span><\/p><blockquote class="md-quote">/);
  assert.match(out, /<\/blockquote><\/blockquote><p class="md-para"><span>reply<\/span><\/p>$/);
});

test("the quote bar is content ink that the borderless appearance cannot clear", () => {
  // `body[data-hide-borders="true"] *` forces every border color transparent;
  // a bar drawn as a border showed the quote as a bare indent.
  assert.match(css, /body\[data-hide-borders="true"\] \*,[\s\S]*?border-color:\s*transparent !important/);
  const quote = rule(".md-quote");
  assert.ok(quote, "shared .md-quote rule");
  assert.doesNotMatch(quote, /border-inline-start|border-left/);
  assert.match(quote, /background:\s*var\(--md-quote-fill\)/);
  const bar = rule(".md-quote::before");
  assert.match(bar, /inset-inline-start:\s*0/);
  assert.match(bar, /background:\s*var\(--md-quote-bar\)/);
  assert.match(css, /--md-quote-bar:\s*color-mix\(in srgb, var\(--accent\)/);
  // No surface may bring back a border-drawn quote.
  assert.doesNotMatch(css, /\.bubble blockquote\s*\{/);
});

test("a quote inside the reader's prompt sits a step deeper, nested quotes stay unfilled", () => {
  assert.match(css, /\.msg\.user \.bubble \{ --md-quote-tint: 6\.5%; \}/);
  assert.match(rule(".md-quote"), /var\(--md-quote-tint, 4%\)/);
  assert.match(rule(".md-quote .md-quote"), /--md-quote-fill:\s*transparent/);
});

test("rules and table lines survive the borderless appearance too", () => {
  assert.match(html("a\n\n---\n\nb"), /<hr class="md-hr"\/>/);
  // Intentional lines inside content use the one ink that survives borderless.
  assert.match(rule(".md-hr"), /background:\s*linear-gradient\(90deg, transparent, var\(--borderless-edge\) 18%/);
  assert.match(css, /\.md-table th \{[^}]*box-shadow:\s*inset 0 -1px 0 color-mix/);
  assert.match(rule(".md-table td"), /box-shadow:\s*inset 0 calc\(-1 \* var\(--md-table-row-rule, 1px\)\) 0 var\(--borderless-edge\)/);
});

test("chat messages keep the line breaks their writer typed", () => {
  assert.match(css, /\.msg \.bubble :is\(\.md-para, \.md-li-text\) \{ white-space: pre-line; \}/);
});

// ------------------------------------------------------------------- lists

test("lists nest by indentation instead of flattening", () => {
  const [list] = parseMarkdown("- a\n  - a.1\n    1. deep\n- b");
  assert.ok(list?.kind === "list");
  assert.equal(list.items.length, 2);
  const nested = list.items[0]!.blocks?.[0];
  assert.ok(nested?.kind === "list" && !nested.ordered);
  assert.equal(nested.items[0]!.blocks?.[0]?.kind, "list");
  assert.match(html("- a\n  - a.1"), /^<ul><li><span class="md-li-text"><span>a<\/span><\/span><ul><li><span class="md-li-text"><span>a\.1<\/span><\/span><\/li><\/ul><\/li><\/ul>$/);
});

test("a step's indented code block stays in the step and the numbering continues", () => {
  const md = ["1. Install", "2. Build:", `   ${FENCE}bash`, "   npm run build", `   ${FENCE}`, "3. Check"].join("\n");
  const blocks = parseMarkdown(md);
  assert.equal(blocks.length, 1);
  const list = blocks[0]!;
  assert.ok(list.kind === "list" && list.ordered);
  assert.equal(list.items.length, 3);
  assert.deepEqual(list.items[1]!.blocks, [{ kind: "code", lang: "bash", text: "npm run build", closed: true }]);
});

test("an ordered list keeps its first number, also right under a paragraph line", () => {
  const blocks = parseMarkdown("Continuing:\n3. third\n4. fourth");
  assert.equal(blocks[0]!.kind, "para");
  const list = blocks[1]!;
  assert.ok(list.kind === "list" && list.start === 3);
  assert.match(html("3. third\n4. fourth"), /<ol start="3">/);
  const first = parseMarkdown("1. one")[0]!;
  assert.ok(first.kind === "list" && first.start === undefined);
});

test("blank lines between items keep one list; indented paragraphs belong to their item", () => {
  const blocks = parseMarkdown("1. **Step**\n\n   Details\n\n2. Next\n\nAfter");
  assert.deepEqual(blocks.map((b) => b.kind), ["list", "para"]);
  const list = blocks[0]!;
  assert.ok(list.kind === "list");
  assert.equal(list.items.length, 2);
  assert.equal(list.items[0]!.blocks?.[0]?.kind, "para");
});

test("a mixed task list keeps the plain items' bullets", () => {
  const mixed = html("- [x] done\n- plain");
  assert.match(mixed, /^<ul><li class="md-task-item">/);
  assert.match(mixed, /<li><span class="md-li-text"><span>plain<\/span><\/span><\/li><\/ul>$/);
  assert.match(mixed, /class="md-task-box" data-checked="true" aria-hidden="true"/);
  assert.match(html("- [x] a\n- [ ] b"), /^<ul class="md-task-list">/);
  // The task box hangs in the marker gutter of a mixed list.
  assert.match(css, /:is\(ul, ol\):not\(\.md-task-list\) > \.md-task-item \{ list-style: none; margin-inline-start: -1\.45em; \}/);
});

// ------------------------------------------------------------------ fences

test("an indented fence is a fence and loses its indentation", () => {
  const [code] = parseMarkdown(`  ${FENCE}ts\n  const a = 1;\n    nested();\n  ${FENCE}`);
  assert.deepEqual(code, { kind: "code", lang: "ts", text: "const a = 1;\n  nested();", closed: true });
});

test("a longer fence shows a shorter one as code", () => {
  const md = ["````md", `${FENCE}ts`, "x", FENCE, "````", "after"].join("\n");
  const blocks = parseMarkdown(md);
  assert.equal(blocks[0]!.kind, "code");
  assert.ok(blocks[0]!.kind === "code" && blocks[0]!.text === `${FENCE}ts\nx\n${FENCE}`);
  assert.equal(blocks[1]!.kind, "para");
  // Streaming tracks the same rule: the inner ``` does not reopen block context.
  assert.equal(holdBackStreamingTail(["````md", FENCE, "| a | b"].join("\n")), ["````md", FENCE, "| a | b"].join("\n"));
});

test("ChatGPT-style \\[ … \\] display math is a math block", () => {
  assert.deepEqual(parseMarkdown("\\[\nx^2\n\\]"), [{ kind: "mathBlock", tex: "x^2" }]);
  assert.deepEqual(parseInline("so \\(x\\) holds").map((n) => n.kind), ["text", "math", "text"]);
});

// ------------------------------------------------------------------ tables

test("tables keep GFM column alignment, escaped pipes and a regular grid", () => {
  const [table] = parseMarkdown("| A | B | C |\n| :-- | :-: | --: |\n| 1 | a \\| b |\n| x | y | z | extra |");
  assert.ok(table?.kind === "table");
  assert.deepEqual(table.align, ["left", "center", "right"]);
  assert.equal(table.rows[0]!.length, 3);
  assert.deepEqual(table.rows[0]![1], [{ kind: "text", text: "a | b" }]);
  assert.equal(table.rows[1]!.length, 3);
  const out = html("| A | B |\n| :-: | --: |\n| 1 | 2 |");
  assert.match(out, /<th style="text-align:center"><span>A<\/span><\/th><th style="text-align:end"><span>B<\/span><\/th>/);
  assert.match(out, /<td style="text-align:center"><span>1<\/span><\/td>/);
});

test("a one-column table parses; a lone rule stays a rule", () => {
  assert.equal(parseMarkdown("| Only |\n| --- |\n| a |")[0]!.kind, "table");
  assert.equal(parseMarkdown("text\n\n---")[1]!.kind, "hr");
});

test("<br> in a cell is a line break", () => {
  assert.deepEqual(parseInline("one<br>two").map((n) => n.kind), ["text", "break", "text"]);
  assert.match(html("| A |\n| - |\n| one<br/>two |"), /<td><span>one<\/span><br\/><span>two<\/span><\/td>/);
});

// ------------------------------------------------------------------ inline

test("a bare URL leaves the sentence's punctuation outside the link", () => {
  assert.deepEqual(parseInline("see https://x.dev/a?b=1."), [
    { kind: "text", text: "see " },
    { kind: "link", href: "https://x.dev/a?b=1", children: [{ kind: "text", text: "https://x.dev/a?b=1" }] },
    { kind: "text", text: "." },
  ]);
  const paren = parseInline("(see https://en.wikipedia.org/wiki/Foo_(bar))");
  assert.equal(paren[1]!.kind === "link" && paren[1]!.href, "https://en.wikipedia.org/wiki/Foo_(bar)");
  assert.deepEqual(paren[2], { kind: "text", text: ")" });
  const angle = parseInline("<https://polyth.app>");
  assert.deepEqual(angle, [{ kind: "link", href: "https://polyth.app", children: [{ kind: "text", text: "https://polyth.app" }] }]);
});

test("underscore emphasis works between words, never inside one", () => {
  assert.deepEqual(parseInline("an _em_ and __strong__").map((n) => n.kind), ["text", "em", "text", "strong"]);
  assert.deepEqual(parseInline("snake_case_name stays"), [{ kind: "text", text: "snake_case_name stays" }]);
  assert.deepEqual(parseInline("слово_тут_ і далі"), [{ kind: "text", text: "слово_тут_ і далі" }]);
});

test("a backslash escape is the literal character", () => {
  assert.deepEqual(parseInline("\\*not em\\* and 5 \\* 3"), [{ kind: "text", text: "*not em* and 5 * 3" }]);
  assert.deepEqual(parseInline("`a\\*b`"), [{ kind: "code", text: "a\\*b" }]);
});

test("a heading drops its closing hashes", () => {
  assert.deepEqual(parseMarkdown("## Title ##"), [{ kind: "heading", level: 2, inline: [{ kind: "text", text: "Title" }] }]);
});

test("a file reference shows the path, the sentence's period stays prose", () => {
  const parts = findFileRefs("See apps/web/src/markdown/render.tsx:376.");
  assert.deepEqual(parts.map((p) => p.text), ["See ", "apps/web/src/markdown/render.tsx:376", "."]);
  assert.equal(parts.map((p) => p.text).join(""), "See apps/web/src/markdown/render.tsx:376.");
});
