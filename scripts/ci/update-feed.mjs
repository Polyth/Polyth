#!/usr/bin/env node
// Desktop auto-update feed for builds produced by the external release
// builder (see docs/operations/releases.md, "External builder feed").
//
// remote-build.mjs uses the pure helpers to bake the feed repository and a
// monotonically increasing build version into each desktop package. The
// builder's publish job runs the CLI to assemble every platform's outputs
// into one GitHub Release asset set:
//
//   node scripts/ci/update-feed.mjs assemble <productsDir> <feedDir>
//
// It merges the per-architecture macOS metadata into one latest-mac.yml,
// verifies that every file each latest*.yml references is present, adds the
// channel copies electron-updater looks for, and writes `version=…` and
// `prerelease=true|false` to $GITHUB_OUTPUT when set. The macOS 12 package's
// legacy-mac.yml (scripts/ci/mac-legacy.mjs) joins the set when it was built.
//
// POLYTH_RELEASE_CHANNEL picks the release channel (stable | test | nightly,
// default stable). Test and nightly versions carry a semver prerelease id
// (X.Y.N-beta, X.Y.N-nightly) and are published as GitHub prereleases; the
// desktop updater (apps/desktop/src/updaterChannel.ts) keys on that id.
import { appendFileSync, cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MAC_LEGACY_METADATA } from "./mac-legacy.mjs";

const REPOSITORY = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;
const STABLE_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
/** Each macOS architecture is built and signed on its own native runner; x64 first. */
const MAC_ARCHITECTURES = ["x64", "arm64"];
/** Platform metadata electron-updater reads for the targets the builder ships. */
export const REQUIRED_METADATA = ["latest.yml", "latest-linux.yml", "latest-mac.yml"];

/** Release channel → semver prerelease id. Stable versions carry none. */
export const CHANNEL_PRERELEASE_IDS = { stable: null, test: "beta", nightly: "nightly" };
export const RELEASE_CHANNELS = Object.keys(CHANNEL_PRERELEASE_IDS);

/** POLYTH_RELEASE_CHANNEL → channel; unset is stable, the builder's original behaviour. */
export function resolveReleaseChannel(value) {
  const raw = value?.trim() || "stable";
  if (!Object.hasOwn(CHANNEL_PRERELEASE_IDS, raw)) {
    throw new Error(`POLYTH_RELEASE_CHANNEL must be one of ${RELEASE_CHANNELS.join(", ")}, got ${JSON.stringify(raw)}`);
  }
  return raw;
}

/** Channel a feed version belongs to: X.Y.N → stable, X.Y.N-beta → test, X.Y.N-nightly → nightly. */
export function channelOfVersion(version) {
  const id = /^\d+\.\d+\.\d+(?:-([0-9A-Za-z-]+)(?:\.[0-9A-Za-z.-]+)?)?$/.exec(version ?? "")?.[1] ?? null;
  return RELEASE_CHANNELS.find((channel) => CHANNEL_PRERELEASE_IDS[channel] === id) ?? null;
}

/**
 * Extra metadata names a channel's release carries. electron-updater reads
 * `<prerelease id>*.yml` from a prerelease, and an updater set to the test
 * channel (`beta`) also reads `beta*.yml` from the stable releases it accepts.
 */
export function channelMetadataAliases(channel) {
  const id = CHANNEL_PRERELEASE_IDS[resolveReleaseChannel(channel)];
  return id ? [id] : [CHANNEL_PRERELEASE_IDS.test];
}

export function macPartialMetadataName(arch) {
  return `latest-mac.${arch}.partial.yml`;
}

/** `owner/repo` → GitHub publish target, or null when the feed is not configured. */
export function resolveFeedRepository(value) {
  const raw = value?.trim();
  if (!raw) return null;
  const match = REPOSITORY.exec(raw);
  if (!match || match[2] === "." || match[2] === "..") {
    throw new Error(`POLYTH_UPDATE_REPOSITORY must be "owner/repo", got ${JSON.stringify(raw)}`);
  }
  return { owner: match[1], repo: match[2] };
}

/**
 * Feed builds share the manifest's X.Y.Z, so electron-updater would never
 * see a newer release. The builder's run number becomes the patch component:
 * X.Y.Z + build N → X.Y.N. N must exceed Z so a feed build never sorts below
 * the manifest version it was built from. Run numbers are shared by every
 * channel, so versions never collide; test and nightly append their id.
 */
export function resolveBuildVersion(baseVersion, buildNumber, channel = "stable") {
  const raw = buildNumber?.trim();
  if (!raw) return null;
  const base = STABLE_VERSION.exec(baseVersion ?? "");
  if (!base) throw new Error(`Desktop version must be stable X.Y.Z, got ${JSON.stringify(baseVersion)}`);
  if (!/^\d{1,9}$/.test(raw)) throw new Error(`POLYTH_BUILD_NUMBER must be a positive integer, got ${JSON.stringify(raw)}`);
  const build = Number(raw);
  if (build <= Number(base[3])) {
    throw new Error(`POLYTH_BUILD_NUMBER ${build} must be greater than the patch version of ${baseVersion}`);
  }
  const id = CHANNEL_PRERELEASE_IDS[resolveReleaseChannel(channel)];
  return `${base[1]}.${base[2]}.${build}${id ? `-${id}` : ""}`;
}

/** electron-builder `--config.*` overrides for a feed build; empty when unconfigured. */
export function electronBuilderFeedArgs(env, baseVersion) {
  const args = [];
  const feed = resolveFeedRepository(env.POLYTH_UPDATE_REPOSITORY);
  if (feed) {
    args.push(
      "--config.publish.provider=github",
      `--config.publish.owner=${feed.owner}`,
      `--config.publish.repo=${feed.repo}`,
      "--config.publish.releaseType=release",
      // A prerelease version would otherwise name its metadata after the id
      // (nightly-mac.yml); assembleFeed adds those copies itself.
      "--config.publish.channel=latest",
    );
  }
  const version = resolveBuildVersion(baseVersion, env.POLYTH_BUILD_NUMBER, env.POLYTH_RELEASE_CHANNEL);
  if (version) {
    args.push(`--config.extraMetadata.version=${version}`);
    // Keep the macOS bundle versions numeric for a prerelease build.
    const numeric = version.replace(/-.*$/, "");
    if (numeric !== version) args.push(`--config.buildVersion=${numeric}`, `--config.mac.bundleShortVersion=${numeric}`);
  }
  return args;
}

export function metadataVersion(text) {
  const match = /^version:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(text);
  if (!match) throw new Error("Update metadata has no version");
  return match[1];
}

export function metadataUrls(text) {
  const urls = new Set();
  for (const match of text.matchAll(/^\s*(?:-\s+)?(?:url|path):\s*['"]?([^'"\n]+?)['"]?\s*$/gm)) urls.add(match[1]);
  return [...urls];
}

/** Lines of the top-level `files:` list (each list item and its indented fields). */
function filesBlock(lines) {
  const start = lines.findIndex((line) => /^files:\s*$/.test(line));
  if (start < 0) throw new Error("Update metadata has no files list");
  let end = start + 1;
  while (end < lines.length && /^\s+\S/.test(lines[end])) end += 1;
  if (end === start + 1) throw new Error("Update metadata files list is empty");
  return { start, end };
}

/**
 * The builder signs each macOS architecture on its native runner, so each job
 * emits a latest-mac.yml naming only its own ZIP/DMG. electron-updater picks
 * the native-architecture file from a single latest-mac.yml listing both, so
 * splice every other architecture's `files:` items into the first one.
 */
export function mergeMacMetadata(texts) {
  if (texts.length === 0) throw new Error("No macOS update metadata to merge");
  const versions = new Set(texts.map(metadataVersion));
  if (versions.size !== 1) throw new Error(`macOS update metadata versions differ: ${[...versions].join(", ")}`);
  const base = texts[0].replace(/\r\n/g, "\n").split("\n");
  const { end } = filesBlock(base);
  const extra = texts.slice(1).flatMap((text) => {
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    const block = filesBlock(lines);
    return lines.slice(block.start + 1, block.end);
  });
  base.splice(end, 0, ...extra);
  return base.join("\n");
}

function filesIn(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesIn(path) : [path];
  });
}

/**
 * Builds the release asset set from every builder product directory. Only the
 * platform metadata and the files it references (plus their blockmaps) are
 * taken, so unrelated outputs (iOS archive, npm tarballs, smoke logs) never
 * reach the feed. The Android APK is the one download-only extra: it is copied
 * as `Polyth-<version>-android.apk` when the android-apk job produced it, and
 * its absence never blocks a desktop release.
 *
 * The macOS 12 package's `legacy-mac.yml` is taken as is, without channel
 * copies: that build follows stable releases only. Its absence never blocks a
 * release either; it is reported in `warnings`, and macOS 12 clients then find
 * no update until a later stable release carries it.
 */
export function assembleFeed(productsDir, feedDir, channel = "stable") {
  const releaseChannel = resolveReleaseChannel(channel);
  const out = resolve(feedDir);
  const byName = new Map();
  for (const file of filesIn(resolve(productsDir))) {
    const name = basename(file);
    if (byName.has(name)) throw new Error(`Two builder products are both named ${name}`);
    byName.set(name, file);
  }
  const macPartials = MAC_ARCHITECTURES.map((arch) => {
    const file = byName.get(macPartialMetadataName(arch));
    if (!file) throw new Error(`Update feed is missing the ${arch} macOS metadata`);
    return readFileSync(file, "utf8");
  });
  const metadata = new Map([["latest-mac.yml", mergeMacMetadata(macPartials)]]);
  for (const name of REQUIRED_METADATA) {
    if (metadata.has(name)) continue;
    const file = byName.get(name);
    if (!file) throw new Error(`Update feed is missing ${name}`);
    metadata.set(name, readFileSync(file, "utf8"));
  }
  const versions = new Set([...metadata.values()].map(metadataVersion));
  if (versions.size !== 1) throw new Error(`Update feed platforms disagree on the version: ${[...versions].join(", ")}`);
  const version = [...versions][0];
  if (channelOfVersion(version) !== releaseChannel) {
    throw new Error(`Update feed version ${version} does not belong to the ${releaseChannel} channel`);
  }
  const warnings = [];
  const legacyFile = byName.get(MAC_LEGACY_METADATA);
  const legacy = legacyFile ? readFileSync(legacyFile, "utf8") : null;
  if (legacy === null) warnings.push(`The macOS 12 build is missing; this release has no ${MAC_LEGACY_METADATA}`);
  else if (metadataVersion(legacy) !== version) {
    throw new Error(`${MAC_LEGACY_METADATA} is version ${metadataVersion(legacy)}, the release is ${version}`);
  }

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const writeMetadata = (name, text) => {
    writeFileSync(join(out, name), text);
    for (const url of metadataUrls(text)) {
      const file = url.includes("/") || url.includes("\\") ? undefined : byName.get(url);
      if (!file) throw new Error(`${name} references ${url}, which no builder product provides`);
      cpSync(file, join(out, url));
      const blockmap = byName.get(`${url}.blockmap`);
      if (blockmap) cpSync(blockmap, join(out, `${url}.blockmap`));
    }
  };
  for (const [name, text] of metadata) {
    writeMetadata(name, text);
    for (const alias of channelMetadataAliases(releaseChannel)) writeFileSync(join(out, name.replace(/^latest/, alias)), text);
  }
  if (legacy !== null) writeMetadata(MAC_LEGACY_METADATA, legacy);
  const apks = [...byName.values()].filter((file) => file.endsWith(".apk"));
  if (apks.length > 1) throw new Error(`Builder products hold more than one APK: ${apks.map((file) => basename(file)).join(", ")}`);
  if (apks.length === 1) cpSync(apks[0], join(out, `Polyth-${version}-android.apk`));
  return { version, channel: releaseChannel, prerelease: releaseChannel !== "stable", files: readdirSync(out).sort(), warnings };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, productsDir, feedDir] = process.argv.slice(2);
  if (command !== "assemble" || !productsDir || !feedDir) {
    console.error("usage: update-feed.mjs assemble <productsDir> <feedDir>");
    process.exit(2);
  }
  const { version, channel, prerelease, files, warnings } = assembleFeed(productsDir, feedDir, process.env.POLYTH_RELEASE_CHANNEL);
  console.log(`update-feed: ${channel} version ${version}`);
  for (const warning of warnings) console.log(`::warning::update-feed: ${warning}`);
  for (const file of files) console.log(`  ${file}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\nprerelease=${prerelease}\n`);
}
