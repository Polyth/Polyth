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
      extraResources: Array<{ to: string; filter?: string[] }>;
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
  assert.equal(pkg.build.extraResources.some(({ to }) => to === "opencode/${platform}-${arch}"), true);
  assert.equal(pkg.build.extraResources.some(({ to }) => to === "chromium/${platform}-${arch}"), true);
  assert.equal(pkg.build.extraResources.some(({ to }) => to === "packages"), true);
  assert.equal(pkg.build.extraResources.some(({ to }) => to === "polyth-link"), true);
  assert.equal(pkg.build.extraResources.some(({ to }) => to === "runtime-supervisor"), true);
  // The Windows harness job boundary ships beside the Linux supervisor.
  assert.ok(pkg.build.extraResources.find(({ to }) => to === "runtime-supervisor")?.filter?.includes("win32/polyth-job.exe"));
  assert.equal(pkg.build.extraResources.some(({ to }) => to === "server/agentToolsMcp.mjs"), true);
});

test("manual desktop workflow builds selectable Windows, Linux and macOS artifacts without publishing", async () => {
  const workflow = await readFile(join(repositoryRoot, ".github/workflows/build-apps.yml"), "utf8");
  const releaseWorkflow = await readFile(join(repositoryRoot, ".github/workflows/release.yml"), "utf8");
  const rootPackage = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };

  assert.match(rootPackage.scripts["desktop:stage-chromium"] ?? "", /@polyth\/desktop.*stage:chromium/);
  for (const required of [
    "type: boolean",
    "macos_x64:",
    "macos_arm64:",
    "windows_x64:",
    "windows_arm64:",
    "linux_x64:",
    "linux_arm64:",
    "macos-15-intel",
    "windows-11-arm",
    "ubuntu-24.04-arm",
    "--linux AppImage --${{ matrix.arch }} --publish never",
    "--win nsis --${{ matrix.arch }} --publish never",
    "--mac dmg --${{ matrix.arch }} --publish never",
    "CSC_LINK",
    "APPLE_APP_SPECIFIC_PASSWORD",
    "Select macOS signing mode",
    "SIGN_CSC_LINK: ${{ secrets.CSC_LINK }}",
    "Build Developer ID signed and notarized DMG",
    "Build ad-hoc signed DMG",
    "must be unset for an ad-hoc macOS build",
    "--config.mac.identity=-",
    "--config.mac.notarize=false",
    "Verify packaged macOS signatures",
    "codesign --verify --deep --strict",
    "spctl --assess --type execute",
    "polyth-macos-dmg-x64-${{ steps.mac_signing.outputs.mode }}",
    "polyth-macos-dmg-arm64-${{ steps.mac_signing.outputs.mode }}",
    "*-mac-x64.dmg",
    "*-mac-arm64.dmg",
    "npx playwright-core install chromium",
    "${{ runner.temp }}/playwright-mac-x64",
    "${{ runner.temp }}/playwright-mac-arm64",
    "npm run build:desktop",
    "npm run desktop:stage-chromium",
    "npm run desktop:download-opencode",
    "release/*.AppImage",
    "release/*.exe",
    "retention-days: 5",
    "apps/desktop/test/startup-smoke.mjs",
    "Smoke-test packaged macOS app",
    "Smoke-test packaged Windows app",
  ]) {
    assert.ok(workflow.includes(required), `manual desktop build workflow must include ${required}`);
  }
  assert.doesNotMatch(workflow, /inputs\.target/);
  assert.doesNotMatch(workflow, /--publish always/);
  assert.doesNotMatch(
    workflow,
    /\n    env:\n      CSC_LINK: \$\{\{ secrets\.CSC_LINK \}\}/,
    "macOS signing secrets must not exist at job scope; empty CSC_LINK resolves to the app directory",
  );
  assert.doesNotMatch(workflow, /CSC_LINK= \\/);
  assert.doesNotMatch(workflow, /CSC_IDENTITY_AUTO_DISCOVERY/);
  assert.doesNotMatch(workflow, /(?:^|\s)-c\.mac\.(?:identity|notarize)=/m);
  assert.doesNotMatch(workflow, /--universal/);
  assert.match(workflow, /mode=developer-id/);
  assert.match(workflow, /mode=adhoc/);
  assert.match(workflow, /these are not trusted release artifacts/);
  assert.match(releaseWorkflow, /Require macOS signing and notarization/);
  assert.doesNotMatch(releaseWorkflow, /--config\.mac\.identity=-/);
  assert.doesNotMatch(releaseWorkflow, /--config\.mac\.notarize=false/);
  assert.match(workflow, /POLYTH_MAC_MULTI_ARCH/);

  const installed = workflow.indexOf("npx playwright-core install chromium");
  const bundled = workflow.indexOf("run: npm run build:desktop");
  const staged = workflow.indexOf("run: npm run desktop:stage-chromium");
  const packaged = workflow.indexOf("npx electron-builder");
  assert.ok(installed >= 0 && installed < bundled, "Playwright Chromium must be provisioned before the desktop build");
  assert.ok(bundled >= 0 && bundled < staged, "Chromium must be staged after bundling");
  assert.ok(staged >= 0 && staged < packaged, "Chromium must be staged before electron-builder");
});

test("desktop first-run setup hides operator tooling and restarts automatically", async () => {
  const mainSource = await readFile(join(desktopDir, "src", "main.ts"), "utf8");
  const preloadSource = await readFile(join(desktopDir, "src", "preload.ts"), "utf8");
  const setupSource = await readFile(
    join(repositoryRoot, "apps", "web", "src", "components", "SetupScreen.tsx"),
    "utf8",
  );
  const serverSource = await readFile(join(repositoryRoot, "packages", "server", "src", "index.ts"), "utf8");

  assert.match(serverSource, /issueSetupClaim\(\)/);
  assert.match(mainSource, /desktop:setup:claim/);
  assert.match(mainSource, /desktopSetupClaims\.request\(request\)/);
  assert.match(mainSource, /restartDesktopSetupServer/);
  assert.match(preloadSource, /requestSetupClaim/);
  assert.match(preloadSource, /restartAfterSetup/);
  // Desktop skips the operator's setup-code step and restarts on its own.
  assert.match(setupSource, /const steps: SetupStep\[\] = !desktop \? \["claim", "account", "recovery"\]/);
  assert.match(setupSource, /usage === "people" \? \["usage", "account", "recovery"\] : \["usage"\]/);
  assert.match(setupSource, /bridge\.requestSetupClaim\(\{ fresh \}\)/);
  assert.match(setupSource, /desktop\.restartAfterSetup\(\)/);
});

test("a password-less first run and its owner session stay in-process", async () => {
  const mainSource = await readFile(join(desktopDir, "src", "main.ts"), "utf8");
  const preloadSource = await readFile(join(desktopDir, "src", "preload.ts"), "utf8");
  const serverSource = await readFile(join(repositoryRoot, "packages", "server", "src", "index.ts"), "utf8");
  const identityHttp = await readFile(join(repositoryRoot, "packages", "identity", "src", "http.ts"), "utf8");

  // Only Desktop asks the server for the channel, and only over trusted IPC.
  assert.match(mainSource, /desktopOwnerChannel: true/);
  assert.match(mainSource, /trustedHandle\("desktop:setup:local", completeLocalSetup\)/);
  assert.match(mainSource, /trustedHandle\("desktop:session:renew", ensureDesktopOwnerSession\)/);
  assert.match(mainSource, /trustedHandle\("desktop:session:confirm", confirmDesktopOwnerSession\)/);
  // A memory-only cookie: the token never rests in the profile's cookie database.
  assert.doesNotMatch(mainSource, /expirationDate/);
  assert.match(preloadSource, /completeLocalSetup: \(\) => ipcRenderer\.invoke\("desktop:setup:local"\)/);
  assert.match(preloadSource, /renewOwnerSession: \(\) => ipcRenderer\.invoke\("desktop:session:renew"\)/);
  // The token goes straight into the window's cookie jar, never to the page.
  assert.match(mainSource, /session\.defaultSession\.cookies\.set\(\{[\s\S]*?httpOnly: true,[\s\S]*?sameSite: "strict"/);
  assert.doesNotMatch(preloadSource, /issueLocalOwnerSession|cookieName/);
  assert.match(serverSource, /opts\.desktopOwnerChannel === true/);
  // No HTTP route can finish setup without a credential or mint that session.
  assert.doesNotMatch(identityHttp, /completeLocal|issueLocalOwnerSession/);
});

test("desktop chrome keeps native macOS/Windows controls and renderer actions clickable", async () => {
  const mainSource = await readFile(join(desktopDir, "src", "main.ts"), "utf8");
  const desktopSource = await readFile(join(repositoryRoot, "apps/web/src/desktop.tsx"), "utf8");
  const styles = await readFile(join(repositoryRoot, "apps/web/src/styles.css"), "utf8");

  assert.match(mainSource, /const chrome = desktopChromeOptions\(process\.platform, nativeTheme\.shouldUseDarkColors\)/);
  assert.match(mainSource, /\.\.\.chrome,/);
  // The Linux button theme must not repaint the whole app through prefers-color-scheme.
  assert.doesNotMatch(mainSource, /nativeTheme\.themeSource/);
  assert.match(desktopSource, /dataset\.desktopPlatform = platform/);
  // Native platforms get only the caption zone (an empty box the layouts keep
  // clear), never Polyth's own buttons.
  assert.match(desktopSource, /if \(NATIVE_CONTROL_PLATFORMS\.has\(info\.platform\)\) return captionZone;/);
  assert.match(styles, /body\.desktop-app :is\([\s\S]*?\.scrim,[\s\S]*?\)\s*\{[^}]*-webkit-app-region:\s*no-drag/s);
  assert.match(styles, /\.desktop-window-controls\s*\{[^}]*pointer-events:\s*none/s);
  assert.match(styles, /\.desktop-window-button\s*\{[^}]*pointer-events:\s*auto/s);
  assert.match(
    styles,
    /body\.desktop-app:is\(\[data-desktop-platform="darwin"\], \[data-desktop-platform="win32"\]\) \.desktop-window-controls\s*\{[^}]*display:\s*none/s,
  );
});

test("packaged desktop startup is self-contained across host platforms", async () => {
  const mainSource = await readFile(join(desktopDir, "src", "main.ts"), "utf8");
  const serverSource = await readFile(
    join(repositoryRoot, "packages/server/src/indexCore.ts"),
    "utf8",
  );
  const smokeSource = await readFile(join(desktopDir, "test", "startup-smoke.mjs"), "utf8");
  const terminalSource = await readFile(
    join(repositoryRoot, "packages/terminal/src/index.ts"),
    "utf8",
  );
  const releaseWorkflow = await readFile(
    join(repositoryRoot, ".github/workflows/release.yml"),
    "utf8",
  );

  assert.doesNotMatch(serverSource, /spawn\(\s*["']flock["']/);
  assert.doesNotMatch(serverSource, /OS advisory locking is unavailable/);
  assert.match(serverSource, /createServer as createNetServer/);
  assert.match(mainSource, /POLYTH_DESKTOP_STARTUP_SMOKE/);
  assert.match(mainSource, /Packaged OpenCode .* is missing at/);
  assert.match(mainSource, /Packaged Chromium is missing for/);
  assert.match(smokeSource, /Desktop startup smoke passed/);
  assert.match(terminalSource, /platform === "win32"/);
  assert.match(terminalSource, /env\.COMSPEC\?\.trim\(\) \|\| "cmd\.exe"/);
  assert.doesNotMatch(terminalSource, /const defaultShell = .*\/bin\/sh/);
  assert.match(releaseWorkflow, /Smoke-test packaged macOS app/);
  assert.match(releaseWorkflow, /Smoke-test packaged Windows app/);
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
    const pinned = lock.targets[target];
    assert.ok(pinned, `missing packaged OpenCode target ${target}`);
    assert.match(pinned.package, /^@opencode\/cli-(linux|darwin|windows)-(x64|arm64)$/);
    const archiveName = pinned.package.split("/").at(-1);
    assert.equal(
      pinned.tarball,
      `https://registry.npmjs.org/${pinned.package}/-/${archiveName}-${lock.version}.tgz`,
      `packaged OpenCode tarball for ${target} must match pinned version ${lock.version}`,
    );
    assert.match(pinned.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
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
  // Linux transparency/shadow geometry is pinned in windowChrome.test.ts.
  assert.match(mainSource, /desktopChromeOptions\(process\.platform/);
  const buildSource = await readFile(join(desktopDir, "build.ts"), "utf8");
  assert.match(buildSource, /resources", "polyth-link"/);
  assert.match(buildSource, /resources", "runtime-supervisor"/);
  assert.match(buildSource, /failed to build polyth-job\.exe/);
});
