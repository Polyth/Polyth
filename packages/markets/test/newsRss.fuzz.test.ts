import assert from "node:assert/strict";
import test from "node:test";
import { parseMarketRss } from "../src/providers/news.ts";
import { assertBoundedTime, forEachFuzzInput } from "./fuzzInput.ts";

const TOKENS = ["<item>", "</item>", "<item ", "<title>", "</title>", "<link>", "</link>", "<pubDate>", "<source>", "<![CDATA[", "]]>", "&#", "&#x", "&#99999999;", "&#xD800;", "&lt;", "https://example.com/a", "javascript:alert(1)"];

const parse = (xml: string) => parseMarketRss(xml, "SYM", "test", "Pub");

test("parseMarketRss never throws and only yields http(s) items", () => {
  forEachFuzzInput(TOKENS, (input) => {
    const items = parse(input);
    assert.ok(items.length <= 50);
    for (const item of items) assert.match(item.url, /^https?:\/\//);
  });
});

test("parseMarketRss decodes out-of-range numeric references instead of throwing", () => {
  const [item] = parse("<item><title>a&#99999999;b&#xD800;c</title><link>https://example.com/x</link></item>");
  assert.equal(item?.title, "a�b�c");
});

test("parseMarketRss handles 50k repetitions of each token in bounded time", () => {
  assertBoundedTime(TOKENS, parse);
});

test("parseMarketRss recovers a well-formed item after hostile noise", () => {
  forEachFuzzInput(TOKENS, (input) => {
    const items = parse(`${input.replace(/<\/?item/gi, "")}<item><title>T</title><link>https://example.com/ok</link></item>`);
    assert.ok(items.some((item) => item.title === "T"), "well-formed item lost");
  });
});
