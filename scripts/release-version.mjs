#!/usr/bin/env node
/**
 * Aligned release version gate for GitHub Actions and Codemagic.
 *
 * Validates matching stable semver (X.Y.Z only) across root/apps/mobile/apps/desktop and public npm SDK packages
 * package.json files, computes a bounded Android versionCode, optionally validates
 * release tags, and exports POLYTH_* variables to GITHUB_ENV / CM_ENV when present.
 */
import { readFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

const PACKAGE_PATHS = [
  join(REPO_ROOT, "package.json"),
  join(REPO_ROOT, "apps/mobile/package.json"),
  join(REPO_ROOT, "apps/desktop/package.json"),
  join(REPO_ROOT, "packages/contracts/package.json"),
  join(REPO_ROOT, "packages/package-sdk/package.json"),
];

/** @type {const} */
export const STABLE_SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

export const ANDROID_VERSION_COMPONENT_MAX = 999;
export const ANDROID_VERSION_CODE_MAX = 2_100_000_000;

/**
 * @param {string} version
 * @returns {{ major: number, minor: number, patch: number }}
 */
export function parseStableSemver(version) {
  const match = STABLE_SEMVER_RE.exec(version.trim());
  if (!match) {
    throw new Error(
      `Release version must use stable semver X.Y.Z; received ${version}`,
    );
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);

  if (minor > ANDROID_VERSION_COMPONENT_MAX || patch > ANDROID_VERSION_COMPONENT_MAX) {
    throw new Error(
      `Android versionCode mapping requires minor and patch <= ${ANDROID_VERSION_COMPONENT_MAX}; received ${version}`,
    );
  }

  return { major, minor, patch };
}

/**
 * Supported-domain Android versionCode:
 * major * 1_000_000 + minor * 1_000 + patch + 1
 * @param {string} version
 */
export function computeAndroidVersionCode(version) {
  const { major, minor, patch } = parseStableSemver(version);
  const code = major * 1_000_000 + minor * 1_000 + patch + 1;

  if (!Number.isSafeInteger(code) || code < 1 || code > ANDROID_VERSION_CODE_MAX) {
    throw new Error(`Computed Android versionCode ${code} is invalid`);
  }

  return code;
}

/**
 * @param {string} path
 */
export function readPackageVersion(path) {
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw);
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error(`Missing version in ${path}`);
  }
  return parsed.version;
}

/**
 * @param {Record<string, string | undefined>} env
 */
export function resolveReleaseTag(env) {
  if (env.GITHUB_REF_TYPE === "tag" && env.GITHUB_REF_NAME) {
    return env.GITHUB_REF_NAME;
  }
  if (env.CM_TAG) {
    return env.CM_TAG.startsWith("v") ? env.CM_TAG : `v${env.CM_TAG}`;
  }
  if (env.POLYTH_RELEASE_TAG) {
    return env.POLYTH_RELEASE_TAG.startsWith("v")
      ? env.POLYTH_RELEASE_TAG
      : `v${env.POLYTH_RELEASE_TAG}`;
  }
  return "";
}

/**
 * @param {Record<string, string | undefined>} env
 */
export function shouldValidateReleaseTag(env) {
  return env.GITHUB_REF_TYPE === "tag" || Boolean(env.CM_TAG);
}

/**
 * @param {Record<string, string | undefined>} env
 */
export function resolveIosCurrentProjectVersion(env, androidVersionCode) {
  if (env.POLYTH_IOS_CURRENT_PROJECT_VERSION) {
    const value = String(env.POLYTH_IOS_CURRENT_PROJECT_VERSION).trim();
    if (!/^\d+$/.test(value)) {
      throw new Error(
        `POLYTH_IOS_CURRENT_PROJECT_VERSION must be a positive integer; received ${value}`,
      );
    }
    return value;
  }

  return String(androidVersionCode);
}

/**
 * @param {Record<string, string | undefined>} [env=process.env]
 * @param {{ repoRoot?: string, packagePaths?: string[] }} [options]
 */
export function computeReleaseVersion(env = process.env, options = {}) {
  const packagePaths = options.packagePaths ?? PACKAGE_PATHS;
  const versions = packagePaths.map((path) => readPackageVersion(path));
  const unique = [...new Set(versions)];
  if (unique.length !== 1) {
    throw new Error(
      `Aligned package.json versions must match: ${packagePaths.map((path, index) => `${path}=${versions[index]}`).join(", ")}`,
    );
  }

  const version = unique[0];
  parseStableSemver(version);
  const androidVersionCode = computeAndroidVersionCode(version);
  const releaseTag = resolveReleaseTag(env);
  const expectedTag = `v${version}`;

  if (shouldValidateReleaseTag(env)) {
    if (!releaseTag) {
      throw new Error("Release tag validation requested but no tag was resolved");
    }
    if (releaseTag !== expectedTag) {
      throw new Error(
        `Release tag ${releaseTag} does not match package version ${version} (expected ${expectedTag})`,
      );
    }
  }

  const iosCurrentProjectVersion = resolveIosCurrentProjectVersion(
    env,
    androidVersionCode,
  );

  return {
    version,
    releaseTag: releaseTag || expectedTag,
    androidVersionCode,
    iosMarketingVersion: version,
    iosCurrentProjectVersion,
  };
}

/**
 * @param {string} filePath
 * @param {Record<string, string | number>} values
 */
export function appendEnvFile(filePath, values) {
  if (!filePath) {
    return;
  }
  const lines = Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${key}=${value}`);
  if (lines.length === 0) {
    return;
  }
  appendFileSync(filePath, `${lines.join("\n")}\n`);
}

/**
 * @param {ReturnType<typeof computeReleaseVersion>} result
 * @param {Record<string, string | undefined>} env
 */
export function exportReleaseEnv(result, env = process.env) {
  const payload = {
    POLYTH_VERSION: result.version,
    POLYTH_RELEASE_TAG: result.releaseTag,
    POLYTH_ANDROID_VERSION_CODE: String(result.androidVersionCode),
    POLYTH_IOS_MARKETING_VERSION: result.iosMarketingVersion,
    POLYTH_IOS_CURRENT_PROJECT_VERSION: result.iosCurrentProjectVersion,
  };

  appendEnvFile(env.GITHUB_ENV, payload);
  appendEnvFile(env.CM_ENV, payload);

  return payload;
}

function main() {
  const result = computeReleaseVersion();
  const exported = exportReleaseEnv(result);
  console.log(
    `release-version: ${exported.POLYTH_VERSION} (${exported.POLYTH_RELEASE_TAG}) `
    + `android=${exported.POLYTH_ANDROID_VERSION_CODE} `
    + `ios=${exported.POLYTH_IOS_CURRENT_PROJECT_VERSION}`,
  );
}

const invokedDirectly = process.argv[1]
  && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`release-version: ${message}`);
    process.exit(1);
  }
}
