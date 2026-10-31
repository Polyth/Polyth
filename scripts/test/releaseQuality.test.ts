import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const text = (path: string) => readFileSync(path, "utf8");

test("CI owns the repository quality contract and app builds stay manual", () => {
  const script = text("scripts/ci/release-quality.mjs");
  for (const file of [
    "scripts/test/release-version.test.ts",
    "scripts/test/releaseQuality.test.ts",
    "scripts/test/release-quality-gates.test.ts",
    "scripts/test/agentBeta.test.ts",
    "apps/desktop/test/configuration.test.ts",
    "packages/server/test/canonicalAuth.test.ts",
    "packages/server/test/runtimeSecurityBinding.test.ts",
    "packages/server/test/debugAgentAccess.test.ts",
    "packages/server/test/routeRegistry.test.ts",
    "packages/harness-runtime/test/agentBeta.test.ts",
    "packages/backend-opencode/test/delegation.test.ts",
  ]) {
    assert.ok(script.includes(`"${file}"`), `quality gate must include ${file}`);
  }
  assert.match(script, /polyth-link-core", "--bin", "polyth-link-ws-echo"/);

  const ci = text(".github/workflows/ci.yml");
  // Pushes and pull requests to devel and master run CI; the full suite runs
  // automatically only on a public repository, where standard runners are free.
  assert.match(ci, /push:\n\s+branches:\n\s+- devel\n\s+- master/);
  assert.match(ci, /pull_request:\n\s+branches:\n\s+- devel\n\s+- master/);
  assert.match(ci, /github\.event\.repository\.private == false/);
  assert.match(ci, /vars\.CI_DISABLED != '1'/);
  assert.match(ci, /workflow_dispatch:/);
  assert.match(ci, /node scripts\/ci\/release-quality\.mjs/);
  assert.match(ci, /cargo fmt --all -- --check/);
  assert.match(ci, /cargo clippy --workspace --all-targets --all-features -- -D warnings/);
  assert.match(ci, /cargo test --workspace --all-targets/);

  const builds = text(".github/workflows/build-apps.yml");
  assert.match(builds, /workflow_dispatch:/);
  assert.doesNotMatch(builds, /^\s*push:/m);
  for (const input of [
    "android_apk:",
    "ios_simulator:",
    "macos_x64:",
    "macos_arm64:",
    "windows_x64:",
    "windows_arm64:",
    "linux_x64:",
    "linux_arm64:",
    "npm_packages:",
  ]) {
    assert.ok(builds.includes(input), `manual build input must include ${input}`);
  }
  assert.match(builds, /type: boolean/);
  assert.doesNotMatch(builds, /inputs\.target/);
  assert.match(builds, /java-version: "21"/);
  assert.match(builds, /:app:assembleDebug/);
  assert.match(builds, /CODE_SIGNING_ALLOWED=NO/);
  assert.match(builds, /--win nsis --\$\{\{ matrix\.arch \}\} --publish never/);
  assert.match(builds, /--linux AppImage --\$\{\{ matrix\.arch \}\} --publish never/);
  assert.match(builds, /--mac dmg --\$\{\{ matrix\.arch \}\} --publish never/);
  assert.match(builds, /polyth-macos-dmg-x64/);
  assert.match(builds, /polyth-macos-dmg-arm64/);
  assert.match(builds, /SIGN_CSC_LINK: \$\{\{ secrets\.CSC_LINK \}\}/);
  assert.match(builds, /APPLE_APP_SPECIFIC_PASSWORD/);
  assert.doesNotMatch(builds, /\n    env:\n      CSC_LINK: \$\{\{ secrets\.CSC_LINK \}\}/);
  assert.doesNotMatch(builds, /CSC_LINK= \\/);
  assert.match(builds, /must be unset for an ad-hoc macOS build/);
  assert.match(builds, /--config\.mac\.identity=-/);
  assert.match(builds, /--config\.mac\.notarize=false/);
  assert.doesNotMatch(builds, /(?:^|\s)-c\.mac\.(?:identity|notarize)=/m);
  assert.doesNotMatch(builds, /--universal/);

  const release = text(".github/workflows/release.yml");
  assert.match(release, /Require macOS signing and notarization/);
  assert.doesNotMatch(release, /--config\.mac\.identity=-/);
  assert.doesNotMatch(release, /--config\.mac\.notarize=false/);
  assert.match(builds, /npm pack --workspace @polyth\/contracts/);
  assert.match(builds, /npm pack --workspace @polyth\/package-sdk/);
  assert.doesNotMatch(builds, /--publish always/);

  // Signed iOS moved off Codemagic into the external builder; the Xcode pin it
  // used to declare now lives in remote-build.mjs and is asserted at runtime.
  const remote = text("scripts/ci/remote-build.mjs");
  assert.match(remote, /POLYTH_IOS_XCODE_VERSION/);
  assert.match(remote, /IOS_XCODE_VERSION = process\.env\.POLYTH_IOS_XCODE_VERSION \?\? "27\.1"/);
  assert.ok(
    remote.indexOf("Authority=Apple Distribution:") < remote.indexOf('"publish", "--path"'),
    "an unverified archive must never reach TestFlight",
  );
});

test("manual Android APK build targets the real com.polyth.mobile app with Java 21", () => {
  const gradle = text("apps/mobile/android/app/build.gradle");
  const builds = text(".github/workflows/build-apps.yml");
  assert.match(gradle, /sourceCompatibility JavaVersion\.VERSION_21/);
  assert.match(gradle, /targetCompatibility JavaVersion\.VERSION_21/);
  assert.match(builds, /java-version: "21"/);
  assert.match(builds, /:app:assembleDebug/);
  assert.match(builds, /outputs\/apk\/debug\/\*\.apk/);
  assert.equal(existsSync("apps/mobile/android/app/src/androidTest/java/com/getcapacitor/myapp/ExampleInstrumentedTest.java"), false);
  assert.equal(existsSync("apps/mobile/android/app/src/androidTest/java/com/polyth/mobile/ExampleInstrumentedTest.java"), true);
});
