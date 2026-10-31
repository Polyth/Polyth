import assert from "node:assert/strict";
import test from "node:test";
import { SessionOutputCache, OUTPUT_CACHE_SCHEME } from "@polyth/session/output-cache";
import { pageToolOutput } from "../src/agentTools.ts";

/** A test-runner-shaped log: the interesting failure is deep in the middle.
 *  Sized past the paging threshold (~16k chars ≈ 4k tokens). */
const noisyLog = (): string => {
  const rows: string[] = [];
  for (let line = 1; line <= 1_500; line += 1) {
    rows.push(line === 747
      ? "FAIL src/checkout.spec.ts > applies discount > throws"
      : `  ok ${line} - passing assertion for case ${line} in the checkout suite`);
  }
  return rows.join("\n");
};

const tool = (name: string) => ({ name });

test("a 50k-char tool output reaches the model as a bounded preview with a URI", () => {
  const cache = new SessionOutputCache();
  const raw = noisyLog();
  assert.ok(raw.length > 50_000, `fixture was only ${raw.length} chars`);
  const result = pageToolOutput(cache, "s1", tool("run_tests"), { output: raw });
  assert.ok(result.output.length < 4_000, `payload was ${result.output.length}`);
  const uri = String((result.metadata as { outputCacheUri?: string }).outputCacheUri);
  assert.ok(uri.startsWith(OUTPUT_CACHE_SCHEME), uri);
  assert.equal((result.metadata as { outputPaged?: boolean }).outputPaged, true);
  assert.equal((result.metadata as { outputTotalLines?: number }).outputTotalLines, 1500);
  assert.equal((result.metadata as { outputTotalChars?: number }).outputTotalChars, raw.length);
  // The instruction names the tool and its parameters, so the model can act.
  assert.match(result.output, /read_file with start_line and end_line/);
  assert.match(result.output, new RegExp(`Full output \\(1500 lines\\) cached at ${OUTPUT_CACHE_SCHEME}`));
});

test("the truncated payload keeps the head and the tail", () => {
  const cache = new SessionOutputCache();
  const raw = noisyLog();
  const result = pageToolOutput(cache, "s1", tool("run_tests"), { output: raw });
  assert.ok(result.output.startsWith(raw.slice(0, 200)));
  assert.ok(result.output.includes(raw.slice(-200)));
});

test("the middle failure line is recoverable through the cached URI", () => {
  const cache = new SessionOutputCache();
  const raw = noisyLog();
  const result = pageToolOutput(cache, "s1", tool("run_tests"), { output: raw });
  const uri = String((result.metadata as { outputCacheUri?: string }).outputCacheUri);
  const slice = cache.read("s1", uri, { startLine: 747, endLine: 747 });
  assert.equal(slice?.lines[0], "FAIL src/checkout.spec.ts > applies discount > throws");
});

test("existing tool metadata is preserved alongside the paging receipt", () => {
  const cache = new SessionOutputCache();
  const result = pageToolOutput(cache, "s1", tool("run_tests"), {
    output: noisyLog(),
    metadata: { exitCode: 1, framework: "vitest" },
  });
  assert.equal((result.metadata as { exitCode?: number }).exitCode, 1);
  assert.equal((result.metadata as { framework?: string }).framework, "vitest");
  assert.equal((result.metadata as { outputPaged?: boolean }).outputPaged, true);
});

test("a small output is delivered byte-identical with no metadata added", () => {
  const cache = new SessionOutputCache();
  const result = pageToolOutput(cache, "s1", tool("list_files"), { output: "a.ts\nb.ts" });
  assert.deepEqual(result, { output: "a.ts\nb.ts" });
  assert.equal(cache.count("s1"), 0);
});

test("the paging tool's own output is never re-paged", () => {
  const cache = new SessionOutputCache();
  const raw = noisyLog();
  const result = pageToolOutput(cache, "s1", tool("read_file"), { output: raw });
  // Re-paging would hide the exact lines the model asked to read.
  assert.equal(result.output, raw);
  assert.equal(cache.count("s1"), 0);
});

test("without a cache or a session, output is passed through untouched", () => {
  const raw = noisyLog();
  assert.deepEqual(pageToolOutput(undefined, "s1", tool("t"), { output: raw }), { output: raw });
  assert.deepEqual(pageToolOutput(new SessionOutputCache(), undefined, tool("t"), { output: raw }), { output: raw });
});

test("cached output ages out and the URI stops resolving after its turn budget", () => {
  const cache = new SessionOutputCache();
  const result = pageToolOutput(cache, "s1", tool("run_tests"), { output: noisyLog() });
  const uri = String((result.metadata as { outputCacheUri?: string }).outputCacheUri);
  for (let turn = 1; turn <= 5; turn += 1) {
    cache.advanceTurn("s1");
    if (turn < 5) assert.equal(cache.has("s1", uri), true, `evicted after ${turn} turns`);
  }
  assert.equal(cache.has("s1", uri), false);
  assert.equal(cache.bytes("s1"), 0);
});

test("closing the session releases its cached output immediately", () => {
  const cache = new SessionOutputCache();
  const result = pageToolOutput(cache, "s1", tool("run_tests"), { output: noisyLog() });
  const uri = String((result.metadata as { outputCacheUri?: string }).outputCacheUri);
  assert.ok(cache.bytes("s1") > 0);
  cache.clear("s1");
  assert.equal(cache.has("s1", uri), false);
  assert.equal(cache.bytes("s1"), 0);
});

test("two sessions cannot read each other's cached output", () => {
  const cache = new SessionOutputCache();
  const mine = pageToolOutput(cache, "s1", tool("t"), { output: noisyLog() });
  const mineUri = String((mine.metadata as { outputCacheUri?: string }).outputCacheUri);
  const other = pageToolOutput(cache, "s2", tool("t"), { output: noisyLog() });
  const otherUri = String((other.metadata as { outputCacheUri?: string }).outputCacheUri);
  assert.notEqual(mineUri, otherUri);
  assert.equal(cache.has("s2", mineUri), false);
  assert.ok(cache.has("s2", otherUri));
});
