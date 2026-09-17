import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const text = (path: string) => readFileSync(path, "utf8");

test("all native release paths are blocked by the shared quality contract", () => {
  const script = text("scripts/ci/release-quality.mjs");
  assert.match(script, /select-tests\.mjs", "ci"/);
  assert.match(script, /select-tests\.mjs", "polyth-link"/);
  assert.match(script, /polyth-link-core", "--bin", "polyth-link-ws-echo"/);

  const android = text(".github/workflows/android-release.yml");
  assert.match(android, /quality-gate:\n    uses: \.\/\.github\/workflows\/release-quality\.yml/);
  assert.match(android, /release:\n    needs: quality-gate/);
  assert.match(android, /java-version: "21"/);

  const desktop = text(".github/workflows/desktop-release.yml");
  assert.match(desktop, /needs: \[quality-gate, plan\]/);
  assert.ok(
    desktop.indexOf("Verify packaged artifacts exist") < desktop.indexOf("Publish verified release artifact"),
    "desktop publishing must happen only after packaged-artifact verification",
  );
  assert.ok(
    desktop.indexOf("End-to-end test packaged AppImage") < desktop.indexOf("Publish verified release artifact"),
    "desktop publishing must happen only after AppImage smoke testing",
  );

  const codemagic = text("codemagic.yaml");
  assert.match(codemagic, /xcode: 26\.6/);
  assert.ok(
    codemagic.indexOf("Validate release quality") < codemagic.indexOf("Build signed IPA"),
    "TestFlight signing must be gated by release quality",
  );
});

test("Android native CI compiles the real com.polyth.mobile instrumented suite with Java 21", () => {
  const gradle = text("apps/mobile/android/app/build.gradle");
  const native = text(".github/workflows/polyth-link-native.yml");
  assert.match(gradle, /sourceCompatibility JavaVersion\.VERSION_21/);
  assert.match(gradle, /targetCompatibility JavaVersion\.VERSION_21/);
  assert.match(native, /java-version: "21"/);
  assert.match(native, /:app:assembleDebug :app:assembleAndroidTest/);
  assert.equal(existsSync("apps/mobile/android/app/src/androidTest/java/com/getcapacitor/myapp/ExampleInstrumentedTest.java"), false);
  assert.equal(existsSync("apps/mobile/android/app/src/androidTest/java/com/polyth/mobile/ExampleInstrumentedTest.java"), true);
});
