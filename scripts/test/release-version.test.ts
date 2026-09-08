import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  ANDROID_VERSION_CODE_MAX,
  ANDROID_VERSION_COMPONENT_MAX,
  appendEnvFile,
  computeAndroidVersionCode,
  computeReleaseVersion,
  exportReleaseEnv,
  parseStableSemver,
  readPackageVersion,
  resolveIosCurrentProjectVersion,
  resolveReleaseTag,
  shouldValidateReleaseTag,
} from "../release-version.mjs";

test("parseStableSemver accepts stable X.Y.Z versions", () => {
  assert.deepEqual(parseStableSemver("0.1.0"), { major: 0, minor: 1, patch: 0 });
  assert.deepEqual(parseStableSemver("1.0.0"), { major: 1, minor: 0, patch: 0 });
  assert.deepEqual(parseStableSemver("1.0.1"), { major: 1, minor: 0, patch: 1 });
  assert.deepEqual(parseStableSemver("1.1.0"), { major: 1, minor: 1, patch: 0 });
  assert.deepEqual(parseStableSemver("1.999.999"), { major: 1, minor: 999, patch: 999 });
});

test("parseStableSemver rejects invalid and prerelease versions", () => {
  assert.throws(() => parseStableSemver("v1.0.0"), /stable semver/);
  assert.throws(() => parseStableSemver("1.0"), /stable semver/);
  assert.throws(() => parseStableSemver("1.2.3-beta.1"), /stable semver/);
  assert.throws(() => parseStableSemver("1.2.3+build"), /stable semver/);
});

test("parseStableSemver rejects out-of-range minor and patch", () => {
  assert.throws(
    () => parseStableSemver(`1.${ANDROID_VERSION_COMPONENT_MAX + 1}.0`),
    /minor and patch <= 999/,
  );
  assert.throws(
    () => parseStableSemver(`1.0.${ANDROID_VERSION_COMPONENT_MAX + 1}`),
    /minor and patch <= 999/,
  );
});

test("computeAndroidVersionCode maps supported versions", () => {
  assert.equal(computeAndroidVersionCode("0.1.0"), 1001);
  assert.equal(computeAndroidVersionCode("1.0.0"), 1_000_001);
  assert.equal(computeAndroidVersionCode("1.0.1"), 1_000_002);
  assert.equal(computeAndroidVersionCode("1.1.0"), 1_001_001);
  assert.equal(computeAndroidVersionCode("1.999.999"), 1_999_999 + 1);
});

test("computeAndroidVersionCode is monotonic within the supported domain", () => {
  assert.ok(computeAndroidVersionCode("1.0.999") < computeAndroidVersionCode("1.1.0"));
  assert.ok(computeAndroidVersionCode("1.999.999") < computeAndroidVersionCode("2.0.0"));
});

test("computeAndroidVersionCode rejects overflow and collisions from invalid tuples", () => {
  assert.throws(
    () => computeAndroidVersionCode(`2.${ANDROID_VERSION_COMPONENT_MAX + 1}.0`),
    /minor and patch <= 999/,
  );

  const maxMajor = Math.floor((ANDROID_VERSION_CODE_MAX - 1) / 1_000_000);
  assert.throws(
    () => computeAndroidVersionCode(`${maxMajor + 1}.0.0`),
    /invalid/,
  );
});

test("aligned repo package.json versions pass the release gate", () => {
  const result = computeReleaseVersion();
  assert.equal(result.version, readPackageVersion(join(process.cwd(), "package.json")));
  assert.equal(result.androidVersionCode, computeAndroidVersionCode(result.version));
  assert.match(result.releaseTag, /^v\d+\.\d+\.\d+$/);
});

test("release tag validation passes for matching tag refs", () => {
  const result = computeReleaseVersion({
    GITHUB_REF_TYPE: "tag",
    GITHUB_REF_NAME: "v0.1.0",
  });
  assert.equal(result.releaseTag, "v0.1.0");
});

test("release tag validation passes for Codemagic CM_TAG", () => {
  const result = computeReleaseVersion({ CM_TAG: "v0.1.0" });
  assert.equal(result.releaseTag, "v0.1.0");
});

test("release tag validation fails on mismatch", () => {
  assert.throws(
    () => computeReleaseVersion({ GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v9.9.9" }),
    /does not match package version/,
  );
});

test("manual contexts do not require tag validation", () => {
  const result = computeReleaseVersion({ GITHUB_REF_TYPE: "branch" });
  assert.equal(result.releaseTag, `v${result.version}`);
});

test("resolveReleaseTag prefers GitHub tag refs", () => {
  assert.equal(
    resolveReleaseTag({ GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v1.2.3" }),
    "v1.2.3",
  );
  assert.equal(resolveReleaseTag({ CM_TAG: "0.4.5" }), "v0.4.5");
});

test("shouldValidateReleaseTag is true only for tag contexts", () => {
  assert.equal(shouldValidateReleaseTag({ GITHUB_REF_TYPE: "tag" }), true);
  assert.equal(shouldValidateReleaseTag({ CM_TAG: "v0.1.0" }), true);
  assert.equal(shouldValidateReleaseTag({ GITHUB_REF_TYPE: "branch" }), false);
});

test("resolveIosCurrentProjectVersion prefers explicit CI override", () => {
  assert.equal(
    resolveIosCurrentProjectVersion({ POLYTH_IOS_CURRENT_PROJECT_VERSION: "42" }, 1001),
    "42",
  );
  assert.equal(resolveIosCurrentProjectVersion({}, 1001), "1001");
});

test("computeReleaseVersion rejects mismatched package.json versions", () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-release-version-"));
  try {
    const writeVersion = (relativePath, version) => {
      const fullPath = join(dir, relativePath);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(
        fullPath,
        JSON.stringify({ name: "fixture", version }, null, 2),
      );
    };
    writeVersion("package.json", "1.0.0");
    writeVersion("apps/mobile/package.json", "1.0.0");
    writeVersion("apps/desktop/package.json", "1.0.1");
    assert.throws(
      () => computeReleaseVersion({}, {
        packagePaths: [
          join(dir, "package.json"),
          join(dir, "apps/mobile/package.json"),
          join(dir, "apps/desktop/package.json"),
        ],
      }),
      /Aligned package.json versions must match/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exportReleaseEnv writes GitHub and Codemagic env files", () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-release-env-"));
  const githubEnv = join(dir, "github.env");
  const codemagicEnv = join(dir, "codemagic.env");
  try {
    const result = computeReleaseVersion();
    const exported = exportReleaseEnv(result, {
      GITHUB_ENV: githubEnv,
      CM_ENV: codemagicEnv,
    });
    const githubContents = readFileSync(githubEnv, "utf8");
    const codemagicContents = readFileSync(codemagicEnv, "utf8");
    for (const key of [
      "POLYTH_VERSION",
      "POLYTH_RELEASE_TAG",
      "POLYTH_ANDROID_VERSION_CODE",
      "POLYTH_IOS_MARKETING_VERSION",
      "POLYTH_IOS_CURRENT_PROJECT_VERSION",
    ]) {
      assert.match(githubContents, new RegExp(`^${key}=`, "m"));
      assert.match(codemagicContents, new RegExp(`^${key}=`, "m"));
    }
    assert.equal(exported.POLYTH_VERSION, result.version);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("appendEnvFile is a no-op without env file paths", () => {
  assert.doesNotThrow(() => appendEnvFile("", { POLYTH_VERSION: "0.0.0" }));
});
