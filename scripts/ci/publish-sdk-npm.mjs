#!/usr/bin/env node
// Publishes the public SDK packages (release.yml `publish_npm`) from the
// release's tarballs: @polyth/contracts first, since @polyth/package-sdk is
// built against it. Someone asked for this publication, so anything that
// stops it fails the job. Authentication and reruns: scripts/ci/npm-publish.mjs.
//
//   node scripts/ci/publish-sdk-npm.mjs <assetsDir> <version>
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { npmDistTag, publishNpmSet } from "./npm-publish.mjs";

export const SDK_PACKAGES = ["@polyth/contracts", "@polyth/package-sdk"];

/** `npm pack`'s file name for a scoped package. */
const tarballName = (name, version) => `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;

/** The tarballs to publish, in order, or the packages this release lacks. */
export function sdkNpmPlan(assetsDir, version) {
  const packages = [];
  const missing = [];
  for (const name of SDK_PACKAGES) {
    const file = join(resolve(assetsDir), tarballName(name, version));
    if (existsSync(file)) packages.push({ name, file });
    else missing.push(name);
  }
  return { packages, missing, tag: npmDistTag(version) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [assetsDir, version] = process.argv.slice(2);
  if (!assetsDir || !version) {
    console.error("usage: publish-sdk-npm.mjs <assetsDir> <version>");
    process.exit(2);
  }
  const { packages, missing, tag } = sdkNpmPlan(assetsDir, version);
  if (missing.length > 0) {
    console.log(`::error::publish-sdk-npm: no ${version} tarball for ${missing.join(", ")}`);
    process.exit(1);
  }
  process.exit(publishNpmSet({ label: "publish-sdk-npm", packages, version, tag, required: true }));
}
