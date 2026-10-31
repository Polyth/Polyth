import assert from "node:assert/strict";
import test from "node:test";
import { SessionOutputCache } from "@polyth/session/output-cache";
import {
  createReadFileAgentTool,
  FILES_PACKAGE_ID,
  isOutputCachePath,
  READ_FILE_DEFAULT_LINES,
  READ_FILE_MAX_CHARS,
  READ_FILE_MAX_LINES,
} from "../src/readFileTool.ts";

const lines = (count: number, width = 40): string =>
  Array.from({ length: count }, (_, index) => `line ${index + 1} ${"x".repeat(width)}`).join("\n");

const tool = (cache: SessionOutputCache | undefined) => {
  const contribution = createReadFileAgentTool(cache ? { outputCache: () => cache } : {});
  return { descriptor: contribution.descriptor, execute: contribution.execute! };
};

const context = (sessionId: string, cwd = process.cwd()) => ({
  sessionId,
  projectId: "p1",
  cwd,
});

test("the paging tool reads a cached log by exact line range", async () => {
  const cache = new SessionOutputCache();
  const raw = lines(1200);
  const { uri } = cache.store("s1", raw, { tool: "run_tests" });
  const result = await tool(cache).execute({ path: uri, start_line: 100, end_line: 150 }, context("s1"));
  assert.match(result.output, /lines 100-150 of 1200/);
  const body = result.output.slice(result.output.indexOf("\n\n") + 2);
  assert.deepEqual(body.split("\n"), raw.split("\n").slice(99, 150));
  assert.equal((result.metadata as { source?: string }).source, "output-cache");
  assert.equal((result.metadata as { totalLines?: number }).totalLines, 1200);
  // The slice the model asked for must not be re-paged out from under it.
  assert.ok(result.output.length < 16_000);
});

test("the paging tool points at the next range when more remains", async () => {
  const cache = new SessionOutputCache();
  const { uri } = cache.store("s1", lines(1200));
  const result = await tool(cache).execute({ path: uri, start_line: 1, end_line: 10 }, context("s1"));
  assert.match(result.output, /read_file with start_line 11 for more/);
});

test("an unbounded cache read returns one default window, not the whole entry", async () => {
  const cache = new SessionOutputCache();
  const { uri } = cache.store("s1", lines(20_000));
  const result = await tool(cache).execute({ path: uri }, context("s1"));
  assert.match(result.output, new RegExp(`lines 1-${READ_FILE_DEFAULT_LINES} of 20000`));
  const late = await tool(cache).execute({ path: uri, start_line: 6000, end_line: 19_000 }, context("s1"));
  assert.match(late.output, new RegExp(`lines 6000-${6000 + READ_FILE_MAX_LINES - 1} of 20000`));
});

test("a small entry read without bounds returns all of it", async () => {
  const cache = new SessionOutputCache();
  const raw = lines(40);
  const { uri } = cache.store("s1", raw);
  const result = await tool(cache).execute({ path: uri }, context("s1"));
  assert.match(result.output, /lines 1-40 of 40/);
  assert.ok(result.output.endsWith(raw));
});

test("one giant line is clipped instead of bypassing the pager", async () => {
  const cache = new SessionOutputCache();
  const { uri } = cache.store("s1", "y".repeat(READ_FILE_MAX_CHARS * 4));
  const result = await tool(cache).execute({ path: uri }, context("s1"));
  assert.ok(result.output.length < READ_FILE_MAX_CHARS + 500);
  assert.equal((result.metadata as { clipped?: boolean }).clipped, true);
});

test("a cache URI from another session is reported as missing", async () => {
  const cache = new SessionOutputCache();
  const { uri } = cache.store("s1", lines(40));
  await assert.rejects(
    () => tool(cache).execute({ path: uri, start_line: 1, end_line: 5 }, context("s2")),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "not-found");
      return true;
    },
  );
});

test("an expired cache URI is reported the same way as a foreign one", async () => {
  const cache = new SessionOutputCache({ ttlTurns: 1 });
  const { uri } = cache.store("s1", lines(40));
  cache.advanceTurn("s1");
  await assert.rejects(
    () => tool(cache).execute({ path: uri }, context("s1")),
    (error: Error & { code?: string }) => error.code === "not-found",
  );
});

test("an unavailable cache never silently falls back to the filesystem", async () => {
  await assert.rejects(
    () => tool(undefined).execute({ path: "polyth://cache/tool_abc" }, context("s1")),
    (error: Error & { code?: string }) => error.code === "not-found",
  );
});

test("filesystem paths are refused, absolute or relative", async () => {
  const execute = tool(new SessionOutputCache()).execute;
  for (const path of ["/etc/passwd", "package.json", "../../../etc/passwd", "tmp/x"]) {
    await assert.rejects(
      () => execute({ path }, context("s1")),
      (error: Error & { code?: string }) => error.code === "invalid-input",
      path,
    );
  }
});

test("line bounds are validated rather than silently coerced", async () => {
  const cache = new SessionOutputCache();
  const { uri } = cache.store("s1", lines(40));
  const execute = tool(cache).execute;
  const ctx = context("s1");
  await assert.rejects(() => execute({ path: uri, start_line: 0 }, ctx), /start_line must be a positive integer/);
  await assert.rejects(() => execute({ path: uri, end_line: 1.5 }, ctx), /end_line must be a positive integer/);
  await assert.rejects(
    () => execute({ path: uri, start_line: 10, end_line: 2 }, ctx),
    /end_line must be greater than or equal to start_line/,
  );
  await assert.rejects(() => execute({ path: "   " }, ctx), /path is required/);
});

test("the cache scheme is recognised only for polyth cache URIs", () => {
  assert.equal(isOutputCachePath("polyth://cache/tool_abc"), true);
  assert.equal(isOutputCachePath("polyth://pair?v=1"), false);
  assert.equal(isOutputCachePath("src/index.ts"), false);
});

test("the tool descriptor is a project-scoped read-only tool", () => {
  const descriptor = tool(new SessionOutputCache()).descriptor;
  assert.equal(descriptor.kind, "tool");
  if (descriptor.kind !== "tool") return;
  assert.equal(descriptor.owner, FILES_PACKAGE_ID);
  assert.equal(descriptor.name, "read_file");
  assert.equal(descriptor.mutating, false);
  assert.equal(descriptor.trust, "workspace");
  assert.deepEqual(descriptor.inputSchema.required, ["path"]);
});
