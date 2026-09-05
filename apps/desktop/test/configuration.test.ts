import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

const desktopDir = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(desktopDir, "../..");

test("desktop packaging covers each supported updater target", async () => {
  const pkg = JSON.parse(await readFile(join(desktopDir, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
    build: {
      linux: { target: string[] };
      mac: {
        target: string[];
        notarize: boolean;
        entitlements: string;
        entitlementsInherit: string;
        x64ArchFiles: string;
      };
      win: { target: string[] };
      publish: { provider: string; owner: string; repo: string; releaseType: string };
      extraResources: Array<{ to: string }>;
    };
  };

  assert.equal(typeof pkg.dependencies["electron-updater"], "string");
  assert.equal(typeof pkg.dependencies["node-pty"], "string", "packaged terminals require a real PTY runtime");
  assert.equal(typeof pkg.dependencies.esbuild, "string", "plugin UI bundling requires esbuild at runtime");
  assert.deepEqual(pkg.build.linux.target, ["AppImage"]);
  assert.deepEqual(pkg.build.mac.target, ["dmg", "zip"]);
  assert.equal(pkg.build.mac.notarize, true);
  assert.equal(pkg.build.mac.entitlements, "build/entitlements.mac.plist");
  assert.equal(pkg.build.mac.entitlementsInherit, pkg.build.mac.entitlements);
  assert.equal(
    pkg.build.mac.x64ArchFiles,
    "{**/node_modules/{esbuild,@esbuild/*,node-pty/prebuilds/*}/**,**/Resources/opencode/darwin-*/opencode}",
  );
  assert.deepEqual(pkg.build.win.target, ["nsis"]);
  assert.deepEqual(pkg.build.publish, {
    provider: "github",
    owner: "otto-assistant",
    repo: "polyth",
    releaseType: "release",
  });
  assert.equal(pkg.build.extraResources.some(({ to }) => to === "opencode"), true);
  assert.equal(pkg.build.extraResources.some(({ to }) => to === "packages"), true);
  assert.equal(pkg.build.extraResources.some(({ to }) => to === "polyth-link"), true);
});

test("release workflow builds all platforms and uploads updater metadata", async () => {
  const workflow = await readFile(join(repositoryRoot, ".github/workflows/desktop-release.yml"), "utf8");
  for (const required of [
    "ubuntu-24.04",
    "macos-14",
    "windows-2025",
    "--linux AppImage --x64",
    "--linux AppImage --arm64",
    "--mac dmg zip --universal",
    "@esbuild/darwin-x64@$ESBUILD_VERSION",
    "@esbuild/darwin-arm64@$ESBUILD_VERSION",
    "--win nsis --x64",
    "--win nsis --arm64 --config.publish.channel=latest-arm64",
    "release/*.AppImage",
    "release/*.dmg",
    "release/*.zip",
    "release/*.exe",
    "release/latest*.yml",
  ]) {
    assert.match(workflow, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("pinned OpenCode lock covers packaged CPU and operating-system targets", async () => {
  const mainSource = await readFile(join(desktopDir, "src", "main.ts"), "utf8");
  const lock = JSON.parse(await readFile(join(desktopDir, "opencode.json"), "utf8")) as {
    version: string;
    targets: Record<string, { archive: string; sha256: string }>;
  };
  assert.match(lock.version, /^\d+\.\d+\.\d+$/);
  for (const target of [
    "linux-x64",
    "linux-arm64",
    "darwin-x64",
    "darwin-arm64",
    "win32-x64",
    "win32-arm64",
  ]) {
    assert.match(lock.targets[target]?.sha256 ?? "", /^[a-f0-9]{64}$/);
  }
  assert.match(
    mainSource,
    /opencode:\s*\{\s*bin:\s*binary,\s*binarySource:\s*"bundled"\s+as const\s*\}/,
    "desktop must label its absolute resources executable as bundled",
  );
  assert.match(mainSource, /packagedResource\(join\("polyth-link"/);
  assert.match(mainSource, /POLYTH_LINK_HOST/);
  const buildSource = await readFile(join(desktopDir, "build.ts"), "utf8");
  assert.match(buildSource, /resources", "polyth-link"/);
});
