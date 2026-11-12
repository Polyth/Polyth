import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { discoverHarnessExecutable } from "@polyth/harness-runtime/executable-discovery";
import { copilotCacheRoot, preinstalledCopilotDirectories } from "../src/preinstalled.ts";

test("the cache root follows the Copilot SDK on each system", () => {
  assert.equal(copilotCacheRoot({ platform: "darwin", home: "/Users/sam", env: {} }), "/Users/sam/Library/Caches");
  assert.equal(copilotCacheRoot({ platform: "linux", home: "/home/sam", env: {} }), "/home/sam/.cache");
  assert.equal(copilotCacheRoot({ platform: "linux", home: "/home/sam", env: { XDG_CACHE_HOME: "/var/cache/sam" } }), "/var/cache/sam");
  // A relative XDG_CACHE_HOME is ignored, as the SDK does.
  assert.equal(copilotCacheRoot({ platform: "linux", home: "/home/sam", env: { XDG_CACHE_HOME: "cache" } }), "/home/sam/.cache");
  assert.equal(copilotCacheRoot({ platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\sam\\AppData\\Local" } }), "C:\\Users\\sam\\AppData\\Local");
  assert.equal(copilotCacheRoot({ platform: "win32", env: {} }), undefined);
});

test("Windows looks in the installer's folder first, even before anything is unpacked", async () => {
  assert.deepEqual(
    await preinstalledCopilotDirectories({ platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\sam\\AppData\\Local" } }),
    ["C:\\Users\\sam\\AppData\\Local\\GitHubCopilotCLI"],
  );
  assert.deepEqual(await preinstalledCopilotDirectories({ platform: "win32", env: {} }), []);
  assert.deepEqual(await preinstalledCopilotDirectories({ platform: "darwin", home: "/nonexistent-home", env: {} }), []);
});

test("the CLI the GitHub Copilot app unpacked is found: complete copies only, newest first", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX layout");
  const home = await mkdtemp(join(tmpdir(), "polyth-copilot-app-"));
  try {
    const cache = join(home, "Library", "Caches", "github-copilot-sdk", "cli");
    const copy = async (version: string, options: { marker: boolean; at: number }) => {
      const dir = join(cache, version);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "copilot"), "#!/bin/sh\n");
      await chmod(join(dir, "copilot"), 0o755);
      if (options.marker) {
        await writeFile(join(dir, ".copilot-cli.ok"), "11");
        await utimes(join(dir, ".copilot-cli.ok"), options.at, options.at);
      }
      return dir;
    };
    const older = await copy("1.0.101-2", { marker: true, at: 1_700_000_000 });
    const newer = await copy("1.0.106-8", { marker: true, at: 1_800_000_000 });
    await copy("1.0.107-1", { marker: false, at: 1_900_000_000 }); // still being unpacked
    await writeFile(join(cache, ".install.lock"), "");
    const directories = await preinstalledCopilotDirectories({ platform: "darwin", home, env: {} });
    assert.deepEqual(directories, [newer, older]);
    // The shared resolver then finds it without it being on PATH.
    const report = await discoverHarnessExecutable("copilot", {
      env: { PATH: "" }, platform: "darwin", home, additionalDirectories: directories, loginShellProbe: false,
    });
    assert.equal(report.hit?.launcherPath, join(newer, "copilot"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
