import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHROMIUM_CANDIDATE_PATHS, findChromiumExecutable } from "../src/index.ts";

test("well-known Chromium paths include /usr/local/bin and playwright fallbacks are last", () => {
  assert.ok(CHROMIUM_CANDIDATE_PATHS.includes("/usr/local/bin/google-chrome"));
  assert.ok(CHROMIUM_CANDIDATE_PATHS.includes("/usr/bin/google-chrome"));
  assert.ok(CHROMIUM_CANDIDATE_PATHS.includes("/opt/google/chrome/google-chrome"));
});

test("POLYTH_CHROMIUM_PATH wins when the file is executable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "polyth-chromium-"));
  const bin = join(dir, "chrome");
  try {
    await writeFile(bin, "#!/bin/sh\n");
    await chmod(bin, 0o755);
    assert.equal(await findChromiumExecutable({ POLYTH_CHROMIUM_PATH: bin }), bin);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a configured missing path does not silently fall through", async () => {
  assert.equal(
    await findChromiumExecutable({ POLYTH_CHROMIUM_PATH: "/definitely/not/a/chrome-binary" }),
    null,
  );
});
