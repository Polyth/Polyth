import assert from "node:assert/strict";
import test from "node:test";
import { createDuckDuckGoProvider, parseDuckDuckGoResults } from "../src/providers/duckduckgo.ts";
import { createTavilyProvider, parseTavilyResults } from "../src/providers/tavily.ts";
import { normalizeSearchResults } from "../src/results.ts";
import type { ProviderSearchRequest } from "../src/types.ts";

const request = (): ProviderSearchRequest => ({
  query: "Polyth release notes",
  count: 3,
  region: "ua-uk",
  safeSearch: "strict",
  freshness: "week",
  signal: new AbortController().signal,
});

const html = `<!doctype html><html><head><title>Search at DuckDuckGo</title></head><body>
<table><tr><td><a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&amp;rut=x">Docs &amp; guides</a></td></tr>
<tr><td class="result-snippet">Primary <b>documentation</b>.</td></tr></table>
<table><tr><td><a class='result-link' href='https://example.org/news'>News</a></td></tr>
<tr><td class='result-snippet'>Recent update.</td></tr></table></body></html>`;

test("DuckDuckGo parser unwraps redirects, decodes text, and ignores non-results", () => {
  assert.deepEqual(parseDuckDuckGoResults(html), [
    { title: "Docs & guides", url: "https://example.com/docs", snippet: "Primary documentation.", publishedAt: null },
    { title: "News", url: "https://example.org/news", snippet: "Recent update.", publishedAt: null },
  ]);
  assert.deepEqual(parseDuckDuckGoResults("<a class='result-link' href='javascript:alert(1)'>bad</a>"), []);
});

test("DuckDuckGo provider sends bounded public HTTPS filters and returns parsed rows", async () => {
  let observed: URL | undefined;
  const provider = createDuckDuckGoProvider({
    resolve: async () => ["93.184.216.34"],
    transport: async (url) => {
      observed = url;
      return { status: 200, headers: new Headers(), body: Buffer.from(html) };
    },
  });
  const results = await provider.search(request());
  assert.equal(observed?.hostname, "lite.duckduckgo.com");
  assert.equal(observed?.searchParams.get("q"), "Polyth release notes");
  assert.equal(observed?.searchParams.get("kl"), "ua-uk");
  assert.equal(observed?.searchParams.get("df"), "w");
  assert.equal(observed?.searchParams.get("kp"), "-2");
  assert.equal(results.length, 2);
});

test("Tavily parsing and request translation keep the credential server-side", async () => {
  assert.deepEqual(parseTavilyResults({
    results: [{ title: "Release", url: "https://example.com/release", content: "Details", published_date: "2026-09-01T10:00:00Z" }],
  }), [{ title: "Release", url: "https://example.com/release", snippet: "Details", publishedAt: "2026-09-01T10:00:00Z" }]);

  let authorization = "";
  let body: Record<string, unknown> | undefined;
  const provider = createTavilyProvider({
    resolve: async () => ["93.184.216.34"],
    transport: async (_url, _pin, init) => {
      authorization = String(init.headers?.authorization ?? "");
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return {
        status: 200,
        headers: new Headers(),
        body: Buffer.from(JSON.stringify({ results: [{ title: "Release", url: "https://example.com/release", content: "Details" }] })),
      };
    },
  });
  const results = await provider.search(request(), "fixture-tavily-value");
  assert.equal(authorization, "Bearer fixture-tavily-value");
  assert.equal(body?.max_results, 3);
  assert.equal(body?.time_range, "week");
  assert.equal(body?.safe_search, true);
  assert.equal(JSON.stringify(results).includes("fixture-tavily-value"), false);
});

test("Tavily authentication errors never echo the credential", async () => {
  const provider = createTavilyProvider({
    resolve: async () => ["93.184.216.34"],
    transport: async () => ({ status: 401, headers: new Headers(), body: Buffer.from("denied") }),
  });
  await assert.rejects(provider.search(request(), "do-not-leak"), (cause: unknown) => {
    assert.equal((cause as { code?: string }).code, "auth-required");
    assert.equal((cause as Error).message.includes("do-not-leak"), false);
    return true;
  });
});

test("provider transport refuses private DNS answers before opening a socket", async () => {
  let transportCalls = 0;
  const provider = createDuckDuckGoProvider({
    resolve: async () => ["127.0.0.1"],
    transport: async () => {
      transportCalls += 1;
      return { status: 200, headers: new Headers(), body: Buffer.from("<title>DuckDuckGo</title>") };
    },
  });
  await assert.rejects(provider.search(request()), (cause: unknown) => {
    assert.equal((cause as { code?: string }).code, "provider-unavailable");
    return true;
  });
  assert.equal(transportCalls, 0);
});

test("normalization removes unsafe result URLs, duplicate fragments, and unbounded text", () => {
  const results = normalizeSearchResults([
    { title: "One", url: "https://example.com/a#first", snippet: "x".repeat(5_000), publishedAt: "not-a-date" },
    { title: "Duplicate", url: "https://example.com/a#second", snippet: "duplicate" },
    { title: "Local", url: "http://127.0.0.1/private", snippet: "blocked" },
  ]);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.url, "https://example.com/a");
  assert.equal(results[0]?.snippet?.length, 4_000);
  assert.equal(results[0]?.publishedAt, null);
});
