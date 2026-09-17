import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string): string => readFileSync(path, "utf8");

test("release quality contract covers stable and Polyth Link tests", () => {
  const script = read("scripts/ci/release-quality.mjs");
  assert.match(script, /select-tests\.mjs", "ci"/);
  assert.match(script, /select-tests\.mjs", "polyth-link"/);
  for (const project of [
    "packages/contracts",
    "packages/plugins",
    "packages/server",
    "packages/control-plane",
    "packages/identity",
    "apps/mobile",
    "apps/desktop",
  ]) {
    assert.ok(script.includes(`"${project}"`), `release gate must typecheck ${project}`);
  }
});

test("Android and desktop publication jobs require reusable release quality gate", () => {
  const android = read(".github/workflows/android-release.yml");
  assert.match(android, /quality-gate:\n\s+uses: \.\/\.github\/workflows\/release-quality\.yml/);
  assert.match(android, /release:\n\s+needs: quality-gate/);
  assert.match(android, /java-version: "21"/);

  const native = read(".github/workflows/polyth-link-native.yml");
  assert.match(native, /java-version: "21"/);
  assert.match(native, /:app:assembleDebug :app:assembleAndroidTest/);

  const appGradle = read("apps/mobile/android/app/build.gradle");
  const capacitorGradle = read("apps/mobile/android/app/capacitor.build.gradle");
  assert.match(appGradle, /sourceCompatibility JavaVersion\.VERSION_21/);
  assert.match(appGradle, /targetCompatibility JavaVersion\.VERSION_21/);
  assert.match(capacitorGradle, /sourceCompatibility JavaVersion\.VERSION_21/);
  assert.match(capacitorGradle, /targetCompatibility JavaVersion\.VERSION_21/);

  const desktop = read(".github/workflows/desktop-release.yml");
  assert.match(desktop, /quality-gate:\n\s+uses: \.\/\.github\/workflows\/release-quality\.yml/);
  assert.match(desktop, /package:\n[\s\S]*?needs: \[quality-gate, plan\]/);

  const reusable = read(".github/workflows/release-quality.yml");
  assert.match(reusable, /node scripts\/ci\/release-quality\.mjs/);
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
