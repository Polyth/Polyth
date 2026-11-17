#!/usr/bin/env node
// Publishes the packaged server's npm packages from a release build's products
// (scripts/ci/remote-build.mjs target `server`, one product directory per
// platform). Only a complete set is published, platform packages first, so
// `polyth` never names an `@polyth/server-<target>` that is not on the
// registry. Already-published versions are skipped, so a rerun is safe.
//
//   node scripts/ci/publish-server-npm.mjs <productsDir> <version>
//
// NODE_AUTH_TOKEN unset: nothing is published (a notice, not a failure).
// POLYTH_SERVER_NPM_CHANNELS: comma-separated release channels to publish
// (default `stable`); the version's channel must be listed.
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { channelOfVersion, SERVER_TARGETS } from "./update-feed.mjs";

/** The npm dist-tag of a release channel: stable installs by default. */
export function serverDistTag(version) {
  const channel = channelOfVersion(version);
  return channel === "stable" ? "latest" : channel;
}

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

function npm(args) {
  return spawnSync("npm", args, { encoding: "utf8", shell: process.platform === "win32" });
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
  if (!process.env.NODE_AUTH_TOKEN) {
    console.log("::notice::publish-server-npm: NPM_TOKEN is not set; the server is not published to npm");
    process.exit(0);
  }
  const { packages, missing, tag } = serverNpmPlan(productsDir, version);
  if (missing.length > 0) {
    console.log(`::warning::publish-server-npm: ${missing.join(", ")} missing from this build; nothing is published to npm`);
    process.exit(0);
  }
  for (const { name, file } of packages) {
    if (npm(["view", `${name}@${version}`, "version"]).status === 0) {
      console.log(`publish-server-npm: ${name}@${version} is already published`);
      continue;
    }
    const published = npm(["publish", file, "--access", "public", "--provenance", "--tag", tag]);
    process.stdout.write(published.stdout);
    if (published.status !== 0) {
      process.stderr.write(published.stderr);
      console.error(`publish-server-npm: ${name}@${version} failed`);
      process.exit(1);
    }
    console.log(`publish-server-npm: ${name}@${version} published (${tag})`);
  }
}
