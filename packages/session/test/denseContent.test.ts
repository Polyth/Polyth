import assert from "node:assert/strict";
import { test } from "node:test";

import { stripDenseContent } from "../src/index.ts";

const base64 = (length: number): string =>
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".repeat(Math.ceil(length / 64) + 1).slice(0, length);

test("data URIs and long base64 runs become a size marker", () => {
  const uri = `data:image/png;base64,${"A".repeat(2_048)}`;
  assert.equal(stripDenseContent(uri), "[base64 data, 3 KB omitted]");

  const run = base64(300);
  const stripped = stripDenseContent(`before ${run} after`);
  assert.equal(stripped, "before [base64 data, 1 KB omitted] after");

  // Below the threshold, a short base64-looking word stays as it is.
  assert.equal(stripDenseContent("token abcdef"), "token abcdef");
});

test("a fenced block over 4 KB keeps its first 20 and last 5 lines", () => {
  const body = Array.from({ length: 100 }, (_, index) => `const value${index} = "${"x".repeat(48)}";`);
  const fenced = ["```ts", ...body, "```"].join("\n");
  const stripped = stripDenseContent(fenced);
  const lines = stripped.split("\n");

  assert.equal(lines[0], "```ts");
  assert.equal(lines.at(-1), "```");
  assert.ok(lines.includes(body[0]!));
  assert.ok(lines.includes(body[19]!));
  assert.ok(!lines.includes(body[20]!));
  assert.ok(lines.includes(body[95]!));
  assert.equal(lines[21], "[… 75 lines omitted]");
  assert.equal(lines.length, 2 + 20 + 1 + 5);
});

test("a long run of log lines is cut the same way", () => {
  const log = Array.from({ length: 300 }, (_, index) => `2026-01-02T03:04:05Z step ${index} done`);
  const text = ["The build ran.", "", ...log, "", "That was all."].join("\n");
  const stripped = stripDenseContent(text);
  const lines = stripped.split("\n");

  assert.equal(lines[0], "The build ran.");
  assert.ok(lines.includes(log[0]!));
  assert.ok(lines.includes(log[19]!));
  assert.ok(!lines.includes(log[20]!));
  assert.ok(lines.includes(log.at(-1)!));
  assert.equal(lines[22], "[… 275 lines omitted]");
  assert.equal(lines.at(-1), "That was all.");
});

test("ordinary prose, short code and URLs are untouched", () => {
  const text = [
    "Please check https://example.com/a/very/long/path?with=query&and=values before we ship.",
    "",
    "```ts",
    "const answer = 42;",
    "```",
    "",
    "The metadata: value stays, and so does a short token: abc123.",
  ].join("\n");
  assert.equal(stripDenseContent(text), text);
});

test("stripping twice is the same as stripping once", () => {
  const fenced = ["```json", ...Array.from({ length: 120 }, (_, index) => `{"line": ${index}, "pad": "${"y".repeat(40)}"}`), "```"].join("\n");
  const logs = Array.from({ length: 250 }, (_, index) => `{"log": ${index}}`);
  const text = [`Inline ${base64(400)} and data:audio/wav;base64,${"B".repeat(500)}`, fenced, "", ...logs, "", "Done."].join("\n");

  const once = stripDenseContent(text);
  assert.equal(stripDenseContent(once), once);
});

test("5 MB of mixed content finishes well under a second", () => {
  const chunk = [
    "A paragraph of ordinary prose that a summarizer should keep, with a URL https://example.com/docs.",
    `Blob: data:application/octet-stream;base64,${"Q".repeat(2_000)}`,
    "```log",
    ...Array.from({ length: 40 }, (_, index) => `{"n": ${index}, "value": "${"z".repeat(60)}"}`),
    "```",
    ...Array.from({ length: 30 }, (_, index) => `2026-03-04T05:06:07Z tick ${index}`),
    "",
  ].join("\n");
  const text = chunk.repeat(Math.ceil(5 * 1024 * 1024 / chunk.length)).slice(0, 5 * 1024 * 1024);
  assert.ok(text.length >= 5 * 1024 * 1024 - chunk.length);

  const started = performance.now();
  const stripped = stripDenseContent(text);
  const elapsed = performance.now() - started;

  assert.ok(stripped.length > 0 && stripped.length < text.length);
  assert.ok(elapsed < 1_000, `took ${Math.round(elapsed)} ms`);
});
