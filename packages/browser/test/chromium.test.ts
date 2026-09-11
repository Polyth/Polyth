import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHROMIUM_CANDIDATE_PATHS, createChromiumDriver, findChromiumExecutable } from "../src/index.ts";

const gated = process.env.POLYTH_REAL_CHROMIUM === "1";

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

test("bundled Chromium policy prevents ambient executable fallback", async () => {
  assert.equal(
    await findChromiumExecutable({ POLYTH_REQUIRE_BUNDLED_CHROMIUM: "1" }),
    null,
  );
});

test("a failed Chromium launch does not poison the next open", { skip: !gated }, async () => {
  const real = await findChromiumExecutable();
  assert.ok(real, "Chromium executable must be available");
  const dir = await mkdtemp(join(tmpdir(), "polyth-chromium-retry-"));
  const bin = join(dir, "chrome");
  const driver = createChromiumDriver(bin);
  const options = {
    width: 800,
    height: 600,
    deviceScaleFactor: 1,
    colorScheme: "no-preference" as const,
    guardNavigation: async () => {},
    guardNetworkEgress: async () => {},
  };
  try {
    await assert.rejects(() => driver.open(options));
    await symlink(real, bin);
    const page = await driver.open(options);
    await page.close();
  } finally {
    await driver.close();
    await rm(dir, { recursive: true, force: true });
  }
});
