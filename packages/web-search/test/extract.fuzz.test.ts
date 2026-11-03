import assert from "node:assert/strict";
import test from "node:test";
import { decodeBody } from "../src/fetch.ts";
import { extractReadablePage, parseHtml } from "../src/extract.ts";
import { assertBoundedTime, forEachFuzzInput } from "./fuzzInput.ts";

const TOKENS = ["<html>", "<head>", "<body>", "<p>", "</p>", "<div ", "<a href=\"", "<a href=javascript:", "<img src=", "<script>", "</script>", "<style>", "<!--", "-->", "<![CDATA[", "<table>", "<tr>", "<td>", "<ul>", "<li>", "<pre>", "<code>", "<br/>", "<meta charset=", "<meta name=\"description\" content=\"", "<base href=", "&amp;", "&#x41;", "&#99999999;", "&nbsp;"];
/** Markup that never completes: a scanner that re-reads the tail from every later "<" is quadratic. */
const UNTERMINATED_TAGS = [
  "<div ", "<a href=javascript:", "<img src=", "<meta charset=", "<base href=", "<a href=\"", "<meta name=\"description\" content=\"",
  "<a b<a b", "<a b=\"<a b=", "<!x", "<?x", "</a ", "<script></script", "<style></STYLE ",
];
const PAGE_URL = "https://example.com/page";

test("parseHtml and extractReadablePage never throw and return well-typed pages", () => {
  forEachFuzzInput(TOKENS, (input) => {
    parseHtml(input);
    const page = extractReadablePage(input, PAGE_URL);
    assert.equal(typeof page.markdown, "string");
    assert.ok(page.title === null || typeof page.title === "string");
    assert.ok(page.description === null || typeof page.description === "string");
    assert.equal(typeof page.likelyNeedsJavaScript, "boolean");
    assert.doesNotMatch(page.markdown, /\]\(\s*javascript:/i, "javascript: link survived");
  });
});

test("decodeBody never throws on any bytes and charset label", () => {
  forEachFuzzInput(["charset=", "encoding=", "utf-8", "iso-8859-1", "utf-16le", "x-nonsense", "\"", "?>", "<?xml "], (input) => {
    const body = Buffer.from(input, "latin1");
    for (const contentType of ["", "text/html", `text/html; charset=${input.slice(0, 40)}`, "application/xml", "text/plain"]) {
      assert.equal(typeof decodeBody(body, contentType), "string");
    }
    assert.equal(typeof decodeBody(Buffer.concat([Buffer.from("<meta charset="), body]), "text/html"), "string");
  });
});

test("HTML extraction and charset sniffing handle 50k repetitions of each token in bounded time", () => {
  assertBoundedTime([...TOKENS, ...UNTERMINATED_TAGS], (input) => extractReadablePage(`<body>${input}`, PAGE_URL), { limitMs: 500 });
  assertBoundedTime(["<meta", "<?xml", "charset="], (input) => decodeBody(Buffer.from(input, "latin1"), "text/html"));
});

// Regression: the regex tokenizer took ~55 s for 50k unterminated `<div ` (quadratic) while
// MAX_HTML_CHARS admits 3M characters; the scanner now reads a failed tag's tail once.
test("parseHtml is linear on unterminated markup", () => {
  assertBoundedTime(UNTERMINATED_TAGS, parseHtml, { limitMs: 300 });
});

// Regression: 20k nested `<table>` took ~0.7 s (renderTable searched the whole subtree per level).
test("extractReadablePage is near-linear on deeply nested tables", () => {
  assertBoundedTime(["<table>"], (input) => extractReadablePage(`<body>${input}`, PAGE_URL), { reps: 20_000, limitMs: 300 });
});

type Tree = { tag: string; attrs: string; children: (Tree | string)[] };
const shape = (node: Tree): unknown =>
  [node.tag, ...(node.attrs ? [node.attrs] : []), ...node.children.map((child) => (typeof child === "string" ? child : shape(child)))];

test("parseHtml keeps the tolerant tag grammar: incomplete markup is text", () => {
  const parse = (html: string) => (shape(parseHtml(html)) as unknown[]).slice(1);
  assert.deepEqual(parse(`<a href="x y" data-x=v/ b>t</a>`), [["a", ` href="x y" data-x=v/ b`, "t"]]);
  assert.deepEqual(parse("<br/><img src=a.png/>x"), [["br"], ["img", " src=a.png/"], "x"]);
  assert.deepEqual(parse("<p class = 'c' id=i>one<p>two"), [["p", " class = 'c' id=i", "one"], ["p", "two"]]);
  assert.deepEqual(parse("<div <div x"), ["<", "div ", "<", "div x"]);
  assert.deepEqual(parse("<a b=>x</a b>"), ["<", "a b=>x", "<", "/a b>"]);
  assert.deepEqual(parse("<!doctype html><?xml x?><!-- c --><![CDATA[d]]>e<!f"), ["e", "<", "!f"]);
  assert.deepEqual(parse("<script>if (a</b) x</SCRIPTX></Script foo>y"), [["script", "if (a</b) x</SCRIPTX>"], "y"]);
  assert.deepEqual(parse("<title>a</title"), [["title", "a</title"]]);
  assert.deepEqual(parse("<ul><li>a<li>b</ul>c"), [["ul", ["li", "a"], ["li", "b"]], "c"]);
});
