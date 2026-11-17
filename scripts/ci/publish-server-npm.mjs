#!/usr/bin/env node
// Publishes the packaged server's npm packages from a release build's products
// (scripts/ci/remote-build.mjs target `server`, one product directory per
// platform). Only a complete set is published, platform packages first, so
// `polyth` never names an `@polyth/server-<target>` that is not on the
// registry. Authentication and reruns: scripts/ci/npm-publish.mjs.
//
//   node scripts/ci/publish-server-npm.mjs <productsDir> <version>
//
// POLYTH_SERVER_NPM_CHANNELS: comma-separated release channels to publish
// (default `stable`); the version's channel must be listed.
import { readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { npmDistTag, publishNpmSet } from "./npm-publish.mjs";
import { channelOfVersion, SERVER_TARGETS } from "./update-feed.mjs";

export { npmAuthMode, npmSupportsOidc } from "./npm-publish.mjs";
export const serverDistTag = npmDistTag;

function filesIn(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...filesIn(path));
    else found.push(path);
  }
  return found;
}

/**
 * The packages to publish, in order, or what is missing. The main package is
 * the same on every platform; the linux-x64 runner's copy is the one published.
 */
export function serverNpmPlan(productsDir, version) {
  const files = filesIn(resolve(productsDir));
  const named = (name) => files.find((file) => basename(file) === name);
  const packages = [];
  const missing = [];
  for (const target of SERVER_TARGETS) {
    const file = named(`polyth-server-${target}-${version}.tgz`);
    if (file) packages.push({ name: `@polyth/server-${target}`, file });
    else missing.push(`@polyth/server-${target}`);
  }
  const main = files.find((file) => basename(file) === `polyth-${version}.tgz` && /server-linux-x64/.test(file))
    ?? named(`polyth-${version}.tgz`);
  if (main) packages.push({ name: "polyth", file: main });
  else missing.push("polyth");
  return { packages, missing, tag: serverDistTag(version) };
}

export function channelPublishes(version, channels = "stable") {
  const listed = channels.split(",").map((channel) => channel.trim()).filter(Boolean);
  return listed.includes(channelOfVersion(version));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [productsDir, version] = process.argv.slice(2);
  if (!productsDir || !version) {
    console.error("usage: publish-server-npm.mjs <productsDir> <version>");
    process.exit(2);
  }
  if (!channelPublishes(version, process.env.POLYTH_SERVER_NPM_CHANNELS || "stable")) {
    console.log(`publish-server-npm: ${version} is a ${channelOfVersion(version)} release, not published to npm (POLYTH_SERVER_NPM_CHANNELS)`);
    process.exit(0);
  }
  const { packages, missing, tag } = serverNpmPlan(productsDir, version);
  if (missing.length > 0) {
    console.log(`::warning::publish-server-npm: ${missing.join(", ")} missing from this build; nothing is published to npm`);
    process.exit(0);
  }
  process.exit(publishNpmSet({ label: "publish-server-npm", packages, version, tag }));
}
