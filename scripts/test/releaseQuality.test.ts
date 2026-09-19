import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const text = (path: string) => readFileSync(path, "utf8");

test("CI owns the repository quality contract and app builds stay manual", () => {
  const script = text("scripts/ci/release-quality.mjs");
  assert.match(script, /select-tests\.mjs", "ci"/);
  assert.match(script, /select-tests\.mjs", "polyth-link"/);
  assert.match(script, /polyth-link-core", "--bin", "polyth-link-ws-echo"/);

  const ci = text(".github/workflows/ci.yml");
  assert.match(ci, /pull_request:/);
  assert.match(ci, /push:\n\s+branches:\n\s+- master/);
  assert.match(ci, /workflow_dispatch:/);
  assert.match(ci, /node scripts\/ci\/release-quality\.mjs/);
  assert.match(ci, /cargo fmt --all -- --check/);
  assert.match(ci, /cargo clippy --workspace --all-targets --all-features -- -D warnings/);
  assert.match(ci, /cargo test --workspace --all-targets/);

  const builds = text(".github/workflows/build-apps.yml");
  assert.match(builds, /workflow_dispatch:/);
  assert.doesNotMatch(builds, /^\s*push:/m);
  for (const target of ["android-apk", "ios-app", "windows-exe", "linux-appimage", "all"]) {
    assert.ok(builds.includes(`- ${target}`), `manual build target must include ${target}`);
  }
  assert.match(builds, /java-version: "21"/);
  assert.match(builds, /:app:assembleDebug/);
  assert.match(builds, /CODE_SIGNING_ALLOWED=NO/);
  assert.match(builds, /--win nsis --x64 --publish never/);
  assert.match(builds, /--linux AppImage --x64 --publish never/);
  assert.doesNotMatch(builds, /--publish always/);

  const codemagic = text("codemagic.yaml");
  assert.match(codemagic, /xcode: 26\.6/);
  assert.ok(
    codemagic.indexOf("Validate release quality") < codemagic.indexOf("Build signed IPA"),
    "TestFlight signing must remain gated by release quality",
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
