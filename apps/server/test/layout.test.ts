import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  bundleLayout,
  bundleTarget,
  LAUNCHER,
  PACKAGE_NAME,
  releaseName,
  RUNTIME_EXTERNALS,
  stagePackageJson,
} from "../src/layout.ts";

const repositoryRoot = join(import.meta.dirname, "..", "..", "..");

test("release archives are named by version and Node's platform-arch", () => {
  assert.equal(bundleTarget("linux", "x64"), "linux-x64");
  assert.equal(bundleTarget("darwin", "arm64"), "darwin-arm64");
  assert.throws(() => bundleTarget("freebsd", "x64"), /unsupported server bundle platform/);
  assert.throws(() => bundleTarget("linux", "ia32"), /unsupported server bundle architecture/);
  assert.equal(releaseName("1.2.356", "linux-arm64"), "polyth-server-1.2.356-linux-arm64");
  assert.equal(releaseName("1.2.357-nightly", "linux-x64"), "polyth-server-1.2.357-nightly-linux-x64");
  assert.throws(() => releaseName("v1.2.3", "linux-x64"), /invalid server bundle version/);
  assert.throws(() => releaseName("1.2.3/../x", "linux-x64"), /invalid server bundle version/);
});

test("the install tree keeps Desktop's resources layout", () => {
  const layout = bundleLayout("/opt/polyth");
  assert.deepEqual(layout, {
    root: "/opt/polyth",
    dist: join("/opt/polyth", "dist"),
    resources: join("/opt/polyth", "resources"),
    webDist: join("/opt/polyth", "resources", "web"),
    webPackages: join("/opt/polyth", "resources", "packages"),
  });
});

test("the package root installs the polyth command and pins its runtime externals", () => {
  const manifest = stagePackageJson({
    version: "1.2.356",
    dependencies: { typescript: "5.9.3", esbuild: "0.28.2" },
    nodeEngine: ">=22.16.0",
  });
  assert.equal(manifest.name, PACKAGE_NAME);
  assert.equal(manifest.version, "1.2.356");
  assert.equal(manifest.type, "module");
  assert.deepEqual(manifest.bin, { polyth: "bin/polyth.mjs" });
  assert.deepEqual(manifest.engines, { node: ">=22.16.0" });
  assert.deepEqual(Object.keys(manifest.dependencies), ["esbuild", "typescript"], "sorted, exact versions");
  assert.equal("private" in manifest, false, "publishable");
  assert.match(LAUNCHER, /^#!\/usr\/bin\/env node\n/);
  assert.match(LAUNCHER, /import "\.\.\/dist\/cli\.mjs";/);
});

test("the server keeps outside its bundle what Desktop keeps outside its own", () => {
  // Desktop's runtime dependencies are its externals plus its own updater.
  const desktop = JSON.parse(readFileSync(join(repositoryRoot, "apps", "desktop", "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };
  const desktopExternals = Object.keys(desktop.dependencies).filter((name) => name !== "electron-updater").sort();
  assert.deepEqual([...RUNTIME_EXTERNALS].sort(), desktopExternals);
});
