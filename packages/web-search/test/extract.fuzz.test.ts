import assert from "node:assert/strict";
import test from "node:test";
import { decodeBody } from "../src/fetch.ts";
import { extractReadablePage, parseHtml } from "../src/extract.ts";
import { assertBoundedTime, forEachFuzzInput } from "./fuzzInput.ts";

const TOKENS = ["<html>", "<head>", "<body>", "<p>", "</p>", "<div ", "<a href=\"", "<a href=javascript:", "<img src=", "<script>", "</script>", "<style>", "<!--", "-->", "<![CDATA[", "<table>", "<tr>", "<td>", "<ul>", "<li>", "<pre>", "<code>", "<br/>", "<meta charset=", "<meta name=\"description\" content=\"", "<base href=", "&amp;", "&#x41;", "&#99999999;", "&nbsp;"];
/** Opening tags that never close: the tokenizer's attribute group backtracks over the tail from every start. */
const UNTERMINATED_TAGS = ["<div ", "<a href=javascript:", "<img src=", "<meta charset=", "<base href=", "<a href=\"", "<meta name=\"description\" content=\""];
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
  assertBoundedTime(TOKENS, (input) => extractReadablePage(`<body>${input}`, PAGE_URL), { limitMs: 500, skip: [...UNTERMINATED_TAGS, "<table>"] });
  assertBoundedTime(["<meta", "<?xml", "charset="], (input) => decodeBody(Buffer.from(input, "latin1"), "text/html"));
});

// Finding: 3k unterminated `<div ` already cost ~0.2 s and 50k cost ~55 s (quadratic), while
// MAX_HTML_CHARS admits 3M characters, so one hostile page can pin the server for hours.
test("parseHtml is linear on unterminated opening tags", { todo: "quadratic tag tokenizer" }, () => {
  assertBoundedTime(UNTERMINATED_TAGS, parseHtml, { reps: 3_000, limitMs: 100 });
});

// Finding: 50k nested `<table>` take ~1.6 s in extractReadablePage (renderTable re-searches the subtree per level).
test("extractReadablePage is near-linear on deeply nested tables", { todo: "quadratic nested-table render" }, () => {
  assertBoundedTime(["<table>"], (input) => extractReadablePage(`<body>${input}`, PAGE_URL), { reps: 20_000, limitMs: 200 });
});
