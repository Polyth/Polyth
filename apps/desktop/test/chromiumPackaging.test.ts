import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stagedChromiumExecutable } from "../src/chromiumResource.ts";

const desktopDir = resolve(import.meta.dirname, "..");

test("desktop stages an exact installed Playwright Chromium and packages it as a resource", async () => {
  const pkg = JSON.parse(await readFile(join(desktopDir, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
    scripts: Record<string, string>;
    build: { files: string[]; extraResources: Array<{ from: string; to: string }>; mac: Record<string, unknown> };
  };
  const script = await readFile(join(desktopDir, "stage-chromium.mjs"), "utf8");
  const main = await readFile(join(desktopDir, "src", "main.ts"), "utf8");
  assert.equal(pkg.dependencies["playwright-core"], "1.62.1");
  assert.match(pkg.scripts["stage:chromium"] ?? "", /stage-chromium\.mjs/);
  assert.match(pkg.scripts.dist ?? "", /stage:chromium/);
  assert.deepEqual(
    pkg.build.extraResources.find((resource) => resource.to === "chromium"),
    { from: "resources/chromium", to: "chromium", filter: ["**/*"] },
  );
  assert.ok(pkg.build.files.includes("!**/node_modules/playwright-core/.local-browsers/**/*"), "only the staged resource copy is packaged");
  assert.equal("x64ArchFiles" in pkg.build.mac, false, "per-arch macOS builds must not carry universal merge exceptions");
  assert.match(script, /chromium\.executablePath\(\)/);
  assert.match(script, /playwrightCoreVersion/);
  assert.match(script, /Playwright Chromium is not installed/);
  assert.doesNotMatch(script, /playwright install|browserType\.launch|download/i);
  assert.match(main, /delete process\.env\.POLYTH_CHROMIUM_PATH/);
  assert.match(main, /POLYTH_REQUIRE_BUNDLED_CHROMIUM = "1"/);
});

test("packaged Chromium resolution is bounded by its generated metadata", async () => {
  const root = await mkdtemp(join("/tmp", "polyth-chromium-resource-"));
  try {
    const target = join(root, "chromium", "linux-x64");
    await mkdir(join(target, "chrome-linux"), { recursive: true });
    await writeFile(join(target, "polyth-chromium.json"), JSON.stringify({
      schemaVersion: 1,
      platform: "linux",
      arch: "x64",
      playwrightCoreVersion: "1.62.1",
      executable: "chrome-linux/chrome",
    }));
    await writeFile(join(target, "chrome-linux", "chrome"), "binary");
    assert.equal(
      stagedChromiumExecutable(root, "linux", "x64"),
      join(target, "chrome-linux", "chrome"),
    );
    await writeFile(join(target, "polyth-chromium.json"), JSON.stringify({
      schemaVersion: 1,
      platform: "linux",
      arch: "x64",
      playwrightCoreVersion: "1.62.1",
      executable: "../../outside",
    }));
    assert.equal(stagedChromiumExecutable(root, "linux", "x64"), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
