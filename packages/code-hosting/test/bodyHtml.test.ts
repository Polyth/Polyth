import assert from "node:assert/strict";
import test from "node:test";
import { htmlToMarkdown, htmlToPlainText, parseHostingBody } from "../widgets/bodyHtml.ts";

const DEPENDABOT = [
  "Bump actions/checkout from 4.4.0 to 7.0.1",
  "",
  "Updates `actions/checkout` from 4.4.0 to 7.0.1",
  "<details>",
  "<summary>Release notes</summary>",
  '<p><em>Sourced from <a href="https://github.com/actions/checkout/releases">actions/checkout\'s releases</a>.</em></p>',
  "<blockquote>",
  "<h2>v7.0.1</h2>",
  "<p>What's Changed</p>",
  "<ul>",
  '<li>skip running unsafe pr check if input is default by <a href="https://github.com/aiqiaoy"><code>@aiqiaoy</code></a> in <a href="https://redirect.github.com/actions/checkout/pull/2518">actions/checkout#2518</a></li>',
  "<li>trim only ascii whitespace by <a href=\"https://github.com/x\"><code>@x</code></a></li>",
  "</ul>",
  "</blockquote>",
  '<details open><summary>Commits</summary><ul><li><a href="https://example.com/c/1">abc123</a> first</li></ul></details>',
  "</details>",
  "",
  "<!-- internal marker -->",
].join("\n");

test("a Dependabot body becomes Markdown with a collapsible release-notes section", () => {
  const segments = parseHostingBody(DEPENDABOT);
  assert.equal(segments.length, 2);
  assert.equal(segments[0]?.kind, "markdown");
  const first = segments[0];
  if (first?.kind !== "markdown") throw new Error("expected markdown");
  assert.equal(first.text, "Bump actions/checkout from 4.4.0 to 7.0.1\n\nUpdates `actions/checkout` from 4.4.0 to 7.0.1");

  const notes = segments[1];
  if (notes?.kind !== "details") throw new Error("expected a details segment");
  assert.equal(notes.summary, "Release notes");
  assert.equal(notes.open, false);

  const inner = notes.segments
    .filter((segment) => segment.kind === "markdown")
    .map((segment) => segment.kind === "markdown" ? segment.text : "")
    .join("\n");
  assert.match(inner, /\*Sourced from \[actions\/checkout's releases\]\(https:\/\/github\.com\/actions\/checkout\/releases\)\.\*/);
  assert.match(inner, /## v7\.0\.1/);
  assert.match(inner, /- skip running unsafe pr check if input is default by \[`@aiqiaoy`\]\(https:\/\/github\.com\/aiqiaoy\) in \[actions\/checkout#2518\]\(https:\/\/redirect\.github\.com\/actions\/checkout\/pull\/2518\)/);
  assert.match(inner, /- trim only ascii whitespace by/);
  // Nested details stay a section of their own and keep their `open` state.
  const commits = notes.segments.find((segment) => segment.kind === "details");
  if (commits?.kind !== "details") throw new Error("expected nested details");
  assert.equal(commits.summary, "Commits");
  assert.equal(commits.open, true);
  assert.deepEqual(commits.segments, [{ kind: "markdown", text: "- [abc123](https://example.com/c/1) first" }]);

  // Nothing that looks like markup survives as HTML.
  assert.doesNotMatch(inner, /<\/?(?:details|summary|p|em|ul|li|a|code|blockquote|h2)\b/i);
});

test("plain Markdown keeps its exact bytes", () => {
  const markdown = [
    "## Summary",
    "",
    "- keeps **GFM** content and   spacing",
    "",
    "```html",
    "<details><summary>shown as code</summary></details>",
    "```",
    "",
    "Inline `<div class=\"x\">` example.",
  ].join("\n");
  assert.deepEqual(parseHostingBody(markdown), [{ kind: "markdown", text: markdown }]);
});

test("a <details> example inside a fence is code, not a section", () => {
  const body = ["```html", "<details>", "<summary>docs</summary>", "</details>", "```"].join("\n");
  const segments = parseHostingBody(body);
  assert.equal(segments.length, 1);
  assert.equal(segments[0]?.kind, "markdown");
});

test("an unterminated <details> keeps its text instead of dropping it", () => {
  const segments = parseHostingBody("Intro\n<details>\n<summary>half");
  assert.equal(segments.length, 1);
  const [segment] = segments;
  if (segment?.kind !== "markdown") throw new Error("expected markdown");
  assert.match(segment.text, /Intro/);
  assert.match(segment.text, /half/);
});

test("unsafe link and image targets are dropped, safe ones are kept", () => {
  const converted = htmlToMarkdown('<a href="javascript:alert(1)">click</a> <a href="mailto:a@b.c">mail</a> <img src="data:image/png;base64,AA" alt="x"> <img src="https://example.com/i.png" alt="y">');
  assert.doesNotMatch(converted, /javascript:|data:image/);
  assert.match(converted, /click/);
  assert.match(converted, /\[mail\]\(mailto:a@b\.c\)/);
  assert.match(converted, /!\[y\]\(https:\/\/example\.com\/i\.png\)/);
});

test("autolinks and emails that only look like tags stay text", () => {
  const source = "See <https://example.com/a> and <dev@example.com> for details.";
  assert.equal(htmlToMarkdown(source), source);
});

test("block markup becomes Markdown blocks", () => {
  const converted = htmlToMarkdown("<p>One &amp; two</p><h3>Heads up</h3><ul><li>a<br>b</li><li>c</li></ul><hr>");
  assert.equal(converted, "One & two\n\n### Heads up\n\n- a\nb\n- c\n\n---");
  assert.equal(htmlToPlainText("<summary>  Release <code>notes</code> &amp; more </summary>"), "Release notes & more");
});
