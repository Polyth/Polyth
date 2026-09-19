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
  assert.deepEqual(pkg.build.win.target, ["nsis"]);
  assert.deepEqual(pkg.build.publish, {
    provider: "github",
    owner: "Polyth",
    repo: "Polyth",
    releaseType: "release",
  });
  assert.equal(pkg.build.extraResources.some(({ to }) => to === "opencode"), true);
  assert.equal(pkg.build.extraResources.some(({ to }) => to === "packages"), true);
  assert.equal(pkg.build.extraResources.some(({ to }) => to === "polyth-link"), true);
  assert.equal(pkg.build.extraResources.some(({ to }) => to === "runtime-supervisor"), true);
  assert.equal(pkg.build.extraResources.some(({ to }) => to === "server/agentToolsMcp.mjs"), true);
});

test("manual desktop workflow builds Windows, Linux and macOS artifacts without publishing", async () => {
  const workflow = await readFile(join(repositoryRoot, ".github/workflows/build-apps.yml"), "utf8");
  const rootPackage = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };

  assert.match(rootPackage.scripts["desktop:stage-chromium"] ?? "", /@polyth\/desktop.*stage:chromium/);
  for (const required of [
    "ubuntu-24.04",
    "windows-2025",
    "--linux AppImage --x64 --publish never",
    "--win nsis --x64 --publish never",
    "--mac dmg zip --x64 --arm64 --publish never",
    "release/*.dmg",
    "release/*.zip",
    "npx playwright-core install chromium",
    "${{ runner.temp }}/playwright-mac-x64",
    "${{ runner.temp }}/playwright-mac-arm64",
    "npm run build:desktop",
    "npm run desktop:stage-chromium",
    "npm run desktop:download-opencode",
    "release/*.AppImage",
    "release/*.exe",
  ]) {
    assert.ok(workflow.includes(required), `manual desktop build workflow must include ${required}`);
  }
  assert.doesNotMatch(workflow, /--publish always/);
  assert.doesNotMatch(workflow, /--universal/);
  assert.match(workflow, /POLYTH_MAC_MULTI_ARCH/);

  const installed = workflow.indexOf("npx playwright-core install chromium");
  const bundled = workflow.indexOf("run: npm run build:desktop");
  const staged = workflow.indexOf("run: npm run desktop:stage-chromium");
  const packaged = workflow.indexOf("npx electron-builder");
  assert.ok(installed >= 0 && installed < bundled, "Playwright Chromium must be provisioned before the desktop build");
  assert.ok(bundled >= 0 && bundled < staged, "Chromium must be staged after bundling");
  assert.ok(staged >= 0 && staged < packaged, "Chromium must be staged before electron-builder");
});

test("pinned OpenCode lock covers packaged CPU and operating-system targets", async () => {
  const mainSource = await readFile(join(desktopDir, "src", "main.ts"), "utf8");
  const lock = JSON.parse(await readFile(join(desktopDir, "opencode.json"), "utf8")) as {
    version: string;
    targets: Record<string, { package: string; tarball: string; integrity: string }>;
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
    assert.match(lock.targets[target]?.package ?? "", /^@opencode\/cli-(linux|darwin|windows)-(x64|arm64)$/);
    assert.match(lock.targets[target]?.tarball ?? "", /^https:\/\/registry\.npmjs\.org\/@opencode\/cli-[^/]+\/-\/cli-[^/]+-2\.0\.3\.tgz$/);
    assert.match(lock.targets[target]?.integrity ?? "", /^sha512-[A-Za-z0-9+/]+={0,2}$/);
  }
  assert.match(
    mainSource,
    /opencode:\s*\{\s*bin:\s*binary,\s*binarySource:\s*"bundled"(?:\s+as\s+const)?\s*\}/,
    "desktop must label its absolute resources executable as bundled",
  );
  assert.match(mainSource, /packagedResource\(join\("polyth-link"/);
  assert.match(mainSource, /POLYTH_LINK_HOST/);
  assert.match(mainSource, /roundedCorners:\s*true/);
  assert.match(mainSource, /enable-transparent-visuals/);
  assert.match(mainSource, /transparent:\s*process\.platform === "linux"/);
  assert.match(mainSource, /hasShadow:\s*process\.platform !== "linux"/);
  assert.match(mainSource, /backgroundColor:\s*process\.platform === "linux" \? "#00000000" : "#121110"/);
  const buildSource = await readFile(join(desktopDir, "build.ts"), "utf8");
  assert.match(buildSource, /resources", "polyth-link"/);
  assert.match(buildSource, /resources", "runtime-supervisor"/);
});
