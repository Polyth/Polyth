import assert from "node:assert/strict";
import test from "node:test";
import { bingResultsMatchQuery, createBingProvider, parseBingResults } from "../src/providers/bing.ts";
import { createExaProvider, parseExaResults } from "../src/providers/exa.ts";
import { createFirecrawlProvider, parseFirecrawlResults } from "../src/providers/firecrawl.ts";
import { createParallelProvider, parseParallelResults } from "../src/providers/parallel.ts";
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

const fixed = { resolve: async () => ["93.184.216.34"], now: () => Date.parse("2026-11-25T12:00:00Z") };
const reply = (status: number, body: string) => ({ status, headers: new Headers(), body: Buffer.from(body) });
const rejectsWith = (code: string) => (cause: unknown): boolean => {
  assert.equal((cause as { code?: string }).code, code);
  return true;
};

const exaPayload = {
  requestId: "r1",
  results: [
    { id: "https://example.com/release", url: "https://example.com/release", title: "Polyth release notes", publishedDate: "2026-11-20T00:00:00.000Z", highlights: ["First\n\nhighlight.", "Second."] },
    { url: "https://example.org/plain", title: "No highlights" },
  ],
};
const eventStream = (message: unknown): string => `event: message\ndata: ${JSON.stringify(message)}\n\n`;
const toolText = (payload: unknown): unknown => ({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } });

test("Exa parser keeps titles, dates and bounded highlights", () => {
  assert.deepEqual(parseExaResults(exaPayload), [
    { title: "Polyth release notes", url: "https://example.com/release", snippet: "First highlight. … Second.", publishedAt: "2026-11-20T00:00:00.000Z" },
    { title: "No highlights", url: "https://example.org/plain", snippet: "", publishedAt: undefined },
  ]);
  const long = parseExaResults({ results: [{ url: "https://example.com/", highlights: ["x".repeat(5_000)] }] });
  assert.equal(String(long[0]?.snippet).length, 600);
  assert.throws(() => parseExaResults({ results: "none" }), rejectsWith("provider-invalid-response"));
});

test("Exa provider calls the keyless tool once with translated filters and reads an event stream", async () => {
  let observed: URL | undefined;
  let headers: Record<string, string> | undefined;
  let body: { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } } | undefined;
  const provider = createExaProvider({
    ...fixed,
    transport: async (url, _pin, init) => {
      observed = url;
      headers = init.headers;
      body = JSON.parse(String(init.body));
      return reply(200, eventStream(toolText(exaPayload)));
    },
  });
  const results = await provider.search(request());
  assert.equal(observed?.hostname, "mcp.exa.ai");
  assert.equal(headers?.authorization, undefined);
  assert.equal(headers?.["x-api-key"], undefined);
  assert.equal(body?.method, "tools/call");
  assert.equal(body?.params?.name, "web_search_advanced_exa");
  assert.deepEqual(body?.params?.arguments, {
    query: "Polyth release notes",
    numResults: 3,
    enableHighlights: true,
    highlightsMaxCharacters: 500,
    moderation: true,
    userLocation: "UA",
    startPublishedDate: "2026-11-18",
  });
  assert.equal(results.length, 2);
});

test("keyless tool failures become errors the fallback chain understands", async () => {
  const exa = (status: number, text: string) => createExaProvider({ ...fixed, transport: async () => reply(status, text) });
  await assert.rejects(exa(429, "slow down").search(request()), rejectsWith("rate-limited"));
  await assert.rejects(exa(401, "no").search(request()), rejectsWith("provider-unavailable"));
  await assert.rejects(exa(200, "<html>maintenance</html>").search(request()), rejectsWith("provider-invalid-response"));
  await assert.rejects(exa(200, eventStream({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "Rate limit exceeded" }] } })).search(request()), rejectsWith("rate-limited"));
  await assert.rejects(exa(200, eventStream({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "Input validation error" }] } })).search(request()), rejectsWith("provider-unavailable"));
  await assert.rejects(exa(200, JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "429 Too Many Requests" } })).search(request()), rejectsWith("rate-limited"));
  await assert.rejects(exa(200, eventStream({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "not json" }] } })).search(request()), rejectsWith("provider-invalid-response"));
});

test("Parallel provider sends the query as objective and search query, with freshness in words", async () => {
  const payload = {
    search_id: "s1",
    results: [{ url: "https://example.com/a", title: "A", publish_date: "2026-11-01", excerpts: ["One.", "Two."] }],
  };
  assert.deepEqual(parseParallelResults(payload), [
    { title: "A", url: "https://example.com/a", snippet: "One. … Two.", publishedAt: "2026-11-01" },
  ]);
  let observed: URL | undefined;
  let args: Record<string, unknown> | undefined;
  const provider = createParallelProvider({
    ...fixed,
    transport: async (url, _pin, init) => {
      observed = url;
      args = (JSON.parse(String(init.body)) as { params: { arguments: Record<string, unknown> } }).params.arguments;
      // Parallel answers plain JSON and repeats the payload as structured content.
      return reply(200, JSON.stringify({ jsonrpc: "2.0", id: 1, result: { isError: false, content: [{ type: "text", text: "ignored" }], structuredContent: payload } }));
    },
  });
  const results = await provider.search(request());
  assert.equal(observed?.hostname, "search.parallel.ai");
  assert.deepEqual(args, {
    objective: "Polyth release notes\n\nOnly include pages published within the last 7 days.",
    search_queries: ["Polyth release notes"],
  });
  assert.equal(results[0]?.url, "https://example.com/a");
});

test("Firecrawl provider sends a fixed objective, never the query as one, and reads web results", async () => {
  const payload = {
    success: true,
    data: { web: [{ url: "https://example.com/a", title: "A", description: "First\nline.", position: 1 }] },
    creditsUsed: 0,
  };
  assert.deepEqual(parseFirecrawlResults(payload), [
    { title: "A", url: "https://example.com/a", snippet: "First line.", publishedAt: null },
  ]);
  assert.throws(() => parseFirecrawlResults({ success: false, error: "capped" }), rejectsWith("provider-unavailable"));
  assert.throws(() => parseFirecrawlResults({ success: true, data: {} }), rejectsWith("provider-invalid-response"));

  let observed: URL | undefined;
  let headers: Record<string, string> | undefined;
  let params: { name?: string; arguments?: Record<string, unknown> } | undefined;
  const provider = createFirecrawlProvider({
    ...fixed,
    transport: async (url, _pin, init) => {
      observed = url;
      headers = init.headers;
      params = (JSON.parse(String(init.body)) as { params: typeof params }).params;
      return reply(200, eventStream({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "ignored" }], structuredContent: payload } }));
    },
  });
  const results = await provider.search(request());
  assert.equal(observed?.hostname, "mcp.firecrawl.dev");
  assert.equal(headers?.authorization, undefined);
  assert.equal(params?.name, "firecrawl_search");
  assert.deepEqual(params?.arguments, {
    query: "Polyth release notes",
    objective: "Find web pages that answer a search query.",
    limit: 3,
    sources: ["web"],
    location: "Ukraine",
    tbs: "qdr:w",
  });
  assert.equal(results[0]?.url, "https://example.com/a");
});

test("Tavily without a credential uses keyless mode and reports its cap as a rate limit", async () => {
  let headers: Record<string, string> | undefined;
  const provider = createTavilyProvider({
    ...fixed,
    transport: async (_url, _pin, init) => {
      headers = init.headers;
      return reply(200, JSON.stringify({ results: [{ title: "Release", url: "https://example.com/release", content: "Details" }] }));
    },
  });
  assert.equal(provider.requiresCredential, false);
  assert.equal(provider.acceptsCredential, true);
  const results = await provider.search(request());
  assert.equal(headers?.["x-tavily-access-mode"], "keyless");
  assert.equal(headers?.authorization, undefined);
  assert.equal(results.length, 1);

  await provider.search(request(), "fixture-tavily-value");
  assert.equal(headers?.["x-tavily-access-mode"], undefined);
  assert.equal(headers?.authorization, "Bearer fixture-tavily-value");

  const capped = createTavilyProvider({ ...fixed, transport: async () => reply(429, JSON.stringify({ error: { code: "daily_cap_reached" } })) });
  await assert.rejects(capped.search(request()), (cause: unknown) => {
    assert.equal((cause as { code?: string }).code, "rate-limited");
    assert.match((cause as Error).message, /keyless limit/);
    return true;
  });
  const refused = createTavilyProvider({ ...fixed, transport: async () => reply(401, "") });
  await assert.rejects(refused.search(request()), rejectsWith("provider-unavailable"));
});

const bingLink = (target: string): string => `https://www.bing.com/ck/a?!&amp;&amp;p=abc&amp;u=a1${Buffer.from(target).toString("base64url")}&amp;ntb=1`;
const bingPage = (items: string): string => `<!doctype html><html><head><title>q - Bing</title></head><body><ol id="b_results">${items}<li class="b_pag"><p>Pagination</p></li></ol></body></html>`;
const bingItem = (href: string, title: string, snippet: string): string =>
  `<li class="b_algo" data-id><link rel="stylesheet" href="/rp/x.css"/><h2><a href="${href}" h="ID=SERP">${title}</a></h2><div class="b_caption"><p class="b_lineclamp2">${snippet}</p></div></li>`;

test("Bing parser unwraps tracked links, decodes text and stops at the result list", () => {
  const html = bingPage(
    bingItem(bingLink("https://example.com/docs?a=1&b=2"), "Docs &amp; <strong>guides</strong>", "Primary <strong>documentation</strong>.")
    + bingItem("https://example.org/news", "News", "Recent update.")
    + bingItem("javascript:alert(1)", "Bad", "Skipped by URL normalization.")
    + '<li class="b_algo"><h2>No link</h2></li>',
  );
  assert.deepEqual(parseBingResults(html).slice(0, 2), [
    { title: "Docs & guides", url: "https://example.com/docs?a=1&b=2", snippet: "Primary documentation.", publishedAt: null },
    { title: "News", url: "https://example.org/news", snippet: "Recent update.", publishedAt: null },
  ]);
  assert.equal(normalizeSearchResults(parseBingResults(html)).length, 2);
  assert.deepEqual(parseBingResults(bingPage(bingItem("https://www.bing.com/ck/a?u=zz", "Opaque", ""))), []);
});

test("Bing provider translates region, safe search and freshness", async () => {
  let observed: URL | undefined;
  const provider = createBingProvider({
    ...fixed,
    transport: async (url) => {
      observed = url;
      return reply(200, bingPage(bingItem("https://example.com/polyth", "Polyth release notes", "What changed.")));
    },
  });
  const results = await provider.search(request());
  assert.equal(observed?.hostname, "www.bing.com");
  assert.equal(observed?.searchParams.get("q"), "Polyth release notes");
  assert.equal(observed?.searchParams.get("count"), "3");
  assert.equal(observed?.searchParams.get("mkt"), "uk-UA");
  assert.equal(observed?.searchParams.get("adlt"), "strict");
  assert.equal(observed?.searchParams.get("filters"), 'ex1:"ez2"');
  assert.equal(results.length, 1);

  await provider.search({ ...request(), region: "wt-wt", freshness: "year" });
  assert.equal(observed?.searchParams.get("mkt"), null);
  assert.equal(observed?.searchParams.get("filters"), 'ex1:"ez5_20417_20782"');
});

test("Bing refuses a page about something else instead of returning it as results", async () => {
  const unrelated = bingPage(
    bingItem("https://www.speedtest.net/", "Speedtest by Ookla", "Test your internet connection.")
    + bingItem("https://www.speedtest.net/nl", "Speedtest", "Internetsnelheid meten.")
    + bingItem("https://www.speedtest.net/settings", "Settings", "Server selection."),
  );
  const bing = (status: number, html: string) => createBingProvider({ ...fixed, transport: async () => reply(status, html) });
  await assert.rejects(bing(200, unrelated).search(request()), rejectsWith("provider-invalid-response"));
  await assert.rejects(bing(200, "<html><body>Please solve the captcha</body></html>").search(request()), rejectsWith("rate-limited"));
  await assert.rejects(bing(200, "<html><body>New layout</body></html>").search(request()), rejectsWith("provider-invalid-response"));
  await assert.rejects(bing(429, "").search(request()), rejectsWith("rate-limited"));
  assert.deepEqual(await bing(200, '<html><body><ol id="b_results"><li class="b_no"><h1>There are no results</h1></li></ol></body></html>').search(request()), []);

  const row = (title: string) => ({ title, url: "https://example.com/", snippet: "" });
  assert.equal(bingResultsMatchQuery("how to use the zod library", [row("Speedtest"), row("LinkedIn")]), false);
  assert.equal(bingResultsMatchQuery("zod v4 migration", [row("Migrating to Zod 4"), row("Other"), row("Else")]), true);
  assert.equal(bingResultsMatchQuery("новини україна сьогодні", [row("Останні новини України")]), true);
  assert.equal(bingResultsMatchQuery("東京 天気", [row("Speedtest")]), true);
  assert.equal(bingResultsMatchQuery("how to", [row("Speedtest")]), true);
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
  const options = {
    resolve: async () => ["127.0.0.1"],
    transport: async () => {
      transportCalls += 1;
      return reply(200, "{}");
    },
  };
  for (const provider of [createExaProvider(options), createParallelProvider(options), createFirecrawlProvider(options), createTavilyProvider(options), createBingProvider(options)]) {
    await assert.rejects(provider.search(request()), rejectsWith("provider-unavailable"));
  }
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
