import assert from "node:assert/strict";
import test from "node:test";
import { dedupeMarketNews, parseMarketRss } from "../src/providers/news.ts";

const RSS = `<?xml version="1.0"?><rss><channel>
  <item><title><![CDATA[Nvidia &amp; AI demand rises]]></title><link>https://example.com/a</link><source>Example Wire</source><pubDate>Wed, 09 Sep 2026 18:00:00 GMT</pubDate></item>
  <item><title>Second story</title><link>https://example.com/b</link><pubDate>Wed, 09 Sep 2026 17:00:00 GMT</pubDate></item>
  <item><title>Bad link</title><link>javascript:alert(1)</link></item>
</channel></rss>`;

test("RSS parser normalizes bounded market news without a parser dependency", () => {
  const items = parseMarketRss(RSS, "NVDA", "fixture", "Fallback");
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {
    title: "Nvidia & AI demand rises",
    url: "https://example.com/a",
    publisher: "Example Wire",
    publishedAt: "2026-09-09T18:00:00.000Z",
    symbol: "NVDA",
    source: "fixture",
  });
  assert.equal(items[1]?.publisher, "Fallback");
});

test("news dedupe prefers newest unique title/url", () => {
  const items = dedupeMarketNews([
    { title: "Same Story!", url: "https://a.example/1", publisher: "A", publishedAt: "2026-09-09T17:00:00.000Z", symbol: "NVDA", source: "a" },
    { title: "Same story", url: "https://b.example/2", publisher: "B", publishedAt: "2026-09-09T18:00:00.000Z", symbol: "NVDA", source: "b" },
    { title: "Other", url: "https://a.example/1", publisher: "C", publishedAt: "2026-09-09T19:00:00.000Z", symbol: "NVDA", source: "c" },
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.source, "c");
});
