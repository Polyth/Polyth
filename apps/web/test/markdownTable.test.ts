// Markdown tables must stay readable at any width: a wide grid scrolls inside
// its own region, and a narrow message column never squeezes a cell until a
// word breaks into one letter per line. These are the two halves of the
// defect — the DOM must carry a scroll wrapper, and the CSS must give the
// table a natural width inside it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { register } from "node:module";

register("./tsxHooks.mjs", import.meta.url);

const { parseMarkdown } = await import("../src/markdown/parse.ts");
const { renderBlocks } = await import("../src/markdown/render.tsx");
const { createElement, Fragment } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { readWebStylesSync } = await import("./webStyles.ts");

const css = readWebStylesSync();
const read = (path: string) => readFileSync(resolve(import.meta.dirname, path), "utf8");

test("a Markdown table renders inside an accessible scroll region", () => {
  const md = "| Feature | Model |\n| --- | --- |\n| HTML pages | Sonnet 5.5 |\n";
  const html = renderToStaticMarkup(createElement(Fragment, null, ...renderBlocks(parseMarkdown(md), "t")));
  // The scroll region wraps the table, so a narrow column scrolls the grid
  // instead of crushing a cell.
  assert.match(html, /<div[^>]*class="md-table-scroll"[^>]*>\s*<table[^>]*class="md-table"/);
  assert.ok(html.indexOf('class="md-table-scroll"') < html.indexOf('class="md-table"'));
  // Keyboard and screen-reader reach: the region is focusable and labelled.
  assert.match(html, /class="md-table-scroll"[^>]*tabindex="0"/);
  assert.match(html, /class="md-table-scroll"[^>]*role="region"/);
  assert.match(html, /class="md-table-scroll"[^>]*aria-label="Table"/);
  // The table itself stays a real table (not a block), so columns align.
  assert.match(html, /<table[^>]*class="md-table"[^>]*>\s*<thead>/);
});

test("the table scroll region never clips the grid vertically", () => {
  const wrapper = css.match(/\.md-table-scroll\s*\{[^}]*\}/s)?.[0] ?? "";
  assert.match(wrapper, /overflow-x:\s*auto/);
  assert.match(wrapper, /overflow-y:\s*hidden/);
  assert.match(wrapper, /max-width:\s*100%/);
});

test("the table keeps its natural width and lets the wrapper absorb narrowness", () => {
  // `width: max-content` is the actual fix: the table stops being squeezed to
  // the container width, so columns keep their content width and the wrapper
  // scrolls instead of the cells collapsing.
  const table = css.match(/\.md-table\s*\{[^}]*\}/s)?.[0] ?? "";
  assert.match(table, /width:\s*max-content/);
  assert.match(table, /min-width:\s*100%/);
  assert.match(table, /font-size:\s*var\(--font-response\)/);
});

test("table cells break between words, never inside one", () => {
  const cell = css.match(/\.md-table :is\(th, td\)\s*\{[^}]*\}/s)?.[0] ?? "";
  assert.match(cell, /word-break:\s*normal/);
  assert.match(cell, /overflow-wrap:\s*break-word/);
  assert.match(cell, /hyphens:\s*none/);
  // A readable floor stops a column collapsing to one glyph per line, which is
  // what produced the "Мо / дел / ь" break in the report.
  assert.match(cell, /min-width:\s*6ch/);
});

test("an inline code token in a cell stays whole and scrolls with the table", () => {
  const code = css.match(/\.md-table :is\(th, td\) code\s*\{[^}]*\}/s)?.[0] ?? "";
  assert.match(code, /white-space:\s*nowrap/);
});

test("code-hosting relies on the host scroll wrapper instead of blocking the table", () => {
  const pkg = read("../../../packages/code-hosting/widgets/styles.css");
  // `display: block` on the table would break its internal layout; the host
  // wrapper now owns the overflow.
  assert.doesNotMatch(pkg, /\.pr-body \.md-table\s*,\s*\n?\s*\.pr-comment-body \.md-table \{[^}]*display:\s*block/);
  assert.match(pkg, /\.pr-body \.md-table-scroll/);
});

test("every locale names the table region", () => {
  const dir = resolve(import.meta.dirname, "../src/i18n/locales");
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".ts")) continue;
    const source = readFileSync(resolve(dir, name), "utf8");
    assert.match(source, /"markdown\.table":\s*"[^"]+"/, name);
  }
});
