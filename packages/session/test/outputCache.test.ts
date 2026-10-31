import assert from "node:assert/strict";
import test from "node:test";
import {
  CACHE_TTL_TURNS,
  isOutputCacheUri,
  OUTPUT_CACHE_SCHEME,
  parseOutputCacheUri,
  SessionOutputCache,
} from "../src/outputCache.ts";

const lines = (count: number, width = 40): string =>
  Array.from({ length: count }, (_, index) => `line ${index + 1} ${"x".repeat(width)}`).join("\n");

test("a small output passes through byte-identical", () => {
  const cache = new SessionOutputCache();
  const result = cache.page("s1", "short output");
  assert.equal(result.paged, false);
  assert.equal(result.output, "short output");
  assert.equal("uri" in result, false);
});

test("a 50k-char output becomes a bounded preview plus a virtual URI", () => {
  const cache = new SessionOutputCache();
  const raw = lines(1200);
  assert.ok(raw.length > 50_000);
  const paged = cache.page("s1", raw, { tool: "run_tests" });
  assert.equal(paged.paged, true);
  // ~2k head + ~1k tail + the guidance note, not 50k.
  assert.ok(paged.output.length < 4_000, `payload was ${paged.output.length}`);
  assert.ok(paged.output.startsWith(raw.slice(0, 100)));
  assert.ok(paged.output.includes(raw.slice(-100)));
  assert.ok(isOutputCacheUri(paged.uri!));
  assert.match(
    paged.output,
    new RegExp(
      `Output truncated\\. Full output \\(${paged.totalLines} lines\\) cached at ${OUTPUT_CACHE_SCHEME}`,
    ),
  );
  assert.match(paged.output, /read_file with start_line and end_line/);
  // The omitted span is stated, not silently swallowed.
  assert.match(paged.output, /characters omitted/);
});

test("read_file returns the exact requested line slice", () => {
  const cache = new SessionOutputCache();
  const raw = lines(1200);
  const { uri } = cache.store("s1", raw);
  const slice = cache.read("s1", uri, { startLine: 100, endLine: 150 });
  assert.ok(slice);
  assert.equal(slice.lines.length, 51);
  assert.equal(slice.startLine, 100);
  assert.equal(slice.endLine, 150);
  assert.equal(slice.totalLines, 1200);
  assert.deepEqual(slice.lines, raw.split("\n").slice(99, 150));
});

test("line bounds are clamped and never empty by accident", () => {
  const cache = new SessionOutputCache();
  const { uri } = cache.store("s1", lines(10));
  assert.deepEqual(cache.read("s1", uri)!.lines.length, 10);
  assert.equal(cache.read("s1", uri, { startLine: 500 })!.lines.length, 1);
  assert.equal(cache.read("s1", uri, { startLine: 5, endLine: 1 })!.startLine, 5);
  // A nonsense bound falls back to the first line rather than throwing.
  assert.equal(cache.read("s1", uri, { startLine: 0 })!.startLine, 1);
});

test("a URI is only resolvable by the session it was minted for", () => {
  const cache = new SessionOutputCache();
  const { uri } = cache.store("s1", lines(50));
  assert.ok(cache.has("s1", uri));
  assert.equal(cache.has("s2", uri), false);
  assert.equal(cache.read("s2", uri), undefined);
});

test("entries expire after exactly the TTL turn budget", () => {
  const cache = new SessionOutputCache();
  const { uri } = cache.store("s1", lines(50));
  for (let turn = 1; turn < CACHE_TTL_TURNS; turn += 1) {
    cache.advanceTurn("s1");
    assert.equal(cache.has("s1", uri), true, `evicted early on turn ${turn}`);
  }
  cache.advanceTurn("s1");
  assert.equal(cache.has("s1", uri), false);
  assert.equal(cache.count("s1"), 0);
  assert.equal(cache.bytes("s1"), 0);
});

test("a turn only ages the session it belongs to", () => {
  const cache = new SessionOutputCache();
  const mine = cache.store("s1", lines(50));
  const other = cache.store("s2", lines(50));
  for (let turn = 0; turn < CACHE_TTL_TURNS; turn += 1) cache.advanceTurn("s1");
  assert.equal(cache.has("s1", mine.uri), false);
  assert.equal(cache.has("s2", other.uri), true);
});

test("the per-session byte ceiling evicts oldest first", () => {
  const entry = lines(20);
  // Room for exactly two entries (accounted as UTF-16): the third must push out the first.
  const budget = entry.length * 2 * 2 + 1;
  const cache = new SessionOutputCache({ maxBytes: budget });
  const first = cache.store("s1", entry);
  const second = cache.store("s1", entry);
  assert.equal(cache.count("s1"), 2);
  const third = cache.store("s1", entry);
  assert.equal(cache.has("s1", first.uri), false, "oldest entry should be evicted first");
  assert.equal(cache.has("s1", second.uri), true, "second entry must survive");
  assert.equal(cache.has("s1", third.uri), true, "newest entry must always survive");
  assert.ok(cache.bytes("s1") <= budget);
});

test("the process-wide byte ceiling evicts the oldest entry of any session", () => {
  const entry = lines(20);
  const cache = new SessionOutputCache({ maxTotalBytes: entry.length * 2 * 2 + 1 });
  const first = cache.store("s1", entry);
  const second = cache.store("s2", entry);
  const third = cache.store("s3", entry);
  assert.equal(cache.has("s1", first.uri), false, "idle sessions must not pin memory forever");
  assert.equal(cache.has("s2", second.uri), true);
  assert.equal(cache.has("s3", third.uri), true);
  assert.equal(cache.bytes("s1"), 0);
});

test("clearing a session releases its entries", () => {
  const cache = new SessionOutputCache();
  const mine = cache.store("s1", lines(50));
  const other = cache.store("s2", lines(50));
  cache.clear("s1");
  assert.equal(cache.has("s1", mine.uri), false);
  assert.equal(cache.bytes("s1"), 0);
  assert.equal(cache.has("s2", other.uri), true);
  cache.clearAll();
  assert.equal(cache.has("s2", other.uri), false);
});

test("URI parsing accepts the scheme and rejects look-alikes", () => {
  assert.equal(parseOutputCacheUri(`${OUTPUT_CACHE_SCHEME}tool_abc`), "tool_abc");
  assert.equal(parseOutputCacheUri(`${OUTPUT_CACHE_SCHEME}tool_abc/`), "tool_abc");
  assert.equal(isOutputCacheUri(`${OUTPUT_CACHE_SCHEME}anything`), true);
  assert.equal(parseOutputCacheUri(OUTPUT_CACHE_SCHEME), undefined);
  assert.equal(parseOutputCacheUri("polyth://pair?v=1"), undefined);
  assert.equal(parseOutputCacheUri("polyth/cache/tool_abc"), undefined);
  assert.equal(parseOutputCacheUri("/etc/passwd"), undefined);
});

test("store returns a unique URI per call", () => {
  const cache = new SessionOutputCache();
  const uris = new Set(Array.from({ length: 32 }, () => cache.store("s1", lines(3)).uri));
  assert.equal(uris.size, 32);
});
