import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string): string => readFileSync(path, "utf8");

test("repository quality contract covers stable and Polyth Link tests", () => {
  const script = read("scripts/ci/release-quality.mjs");
  assert.match(script, /QUALITY_TEST_FILES/);
  assert.match(script, /release-version\.test\.ts/);
  assert.match(script, /releaseQuality\.test\.ts/);
  assert.match(script, /release-quality-gates\.test\.ts/);
  assert.match(script, /apps\/desktop\/test\/configuration\.test\.ts/);
  for (const project of [
    "packages/contracts",
    "packages/plugins",
    "packages/server",
    "packages/control-plane",
    "packages/identity",
    "packages/tenancy",
    "packages/secure-safe",
    "packages/pairing-qr",
    "packages/tunnel",
    "packages/terminal",
    "packages/markets",
    "apps/mobile",
  ]) {
    assert.ok(script.includes(`"${project}"`), `release gate must typecheck ${project}`);
  }
});

test("master CI is automatic while build and release workflows stay manual", () => {
  const ci = read(".github/workflows/ci.yml");
  assert.match(ci, /pull_request:/);
  assert.match(ci, /push:\n\s+branches:\n\s+- master/);
  assert.match(ci, /node scripts\/ci\/release-quality\.mjs/);

  const builds = read(".github/workflows/build-apps.yml");
  assert.match(builds, /workflow_dispatch:/);
  assert.doesNotMatch(builds, /^\s*push:/m);
  assert.match(builds, /java-version: "21"/);
  assert.match(builds, /:app:assembleDebug/);
  assert.match(builds, /CODE_SIGNING_ALLOWED=NO/);
  assert.match(builds, /--win nsis --x64 --publish never/);
  assert.match(builds, /--linux AppImage --x64 --publish never/);
  assert.doesNotMatch(builds, /--publish always/);
  assert.match(builds, /mac-dmg/);
  assert.match(builds, /npm-packages/);

  const release = read(".github/workflows/release.yml");
  assert.match(release, /workflow_dispatch:/);
  assert.doesNotMatch(release, /^\s*push:/m);
  assert.match(release, /Require master/);
  assert.match(release, /gh release create/);
  assert.match(release, /--draft/);
  assert.match(release, /gh release edit .*--draft=false/);
  assert.match(release, /latest\.yml latest-arm64\.yml latest-mac\.yml latest-linux\.yml/);
  assert.match(release, /npm publish/);
  assert.match(release, /upload-google-play/);

  const appGradle = read("apps/mobile/android/app/build.gradle");
  const capacitorGradle = read("apps/mobile/android/app/capacitor.build.gradle");
  assert.match(appGradle, /sourceCompatibility JavaVersion\.VERSION_21/);
  assert.match(appGradle, /targetCompatibility JavaVersion\.VERSION_21/);
  assert.match(capacitorGradle, /sourceCompatibility JavaVersion\.VERSION_21/);
  assert.match(capacitorGradle, /targetCompatibility JavaVersion\.VERSION_21/);
});

test("TestFlight runs release quality gate before signing and uses pinned Xcode", () => {
  const codemagic = read("codemagic.yaml");
  const gate = codemagic.indexOf("- name: Release quality gate");
  const nativeBuild = codemagic.indexOf("- name: Build native Polyth Link XCFramework");
  const signing = codemagic.indexOf("- name: Set up code signing");
  const ipa = codemagic.indexOf("- name: Build signed IPA");

  assert.ok(gate >= 0, "Codemagic release quality gate is required");
  assert.ok(gate < nativeBuild, "quality gate must run before native release build");
  assert.ok(gate < signing, "quality gate must run before code signing");
  assert.ok(gate < ipa, "quality gate must run before signed IPA creation");
  assert.match(codemagic, /node scripts\/ci\/release-quality\.mjs/);
  assert.match(codemagic, /xcode: 26\.6/);
  assert.doesNotMatch(codemagic, /xcode: latest/);
});
