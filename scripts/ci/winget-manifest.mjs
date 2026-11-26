#!/usr/bin/env node
// The winget manifests of the desktop app, written from a release's Windows
// installers.
//
// Homebrew needs nothing per release: the cask lives in homebrew/homebrew-cask
// and Homebrew's autobump follows `livecheck :github_latest` on the release
// feed. winget has no such bot, so every stable version is a manifest a person
// submits to microsoft/winget-pkgs. The publish job of nightly.yml (stable
// update-feed run) and release.yml (manual master release) writes them from the
// release they just published and attaches polyth-winget-<version>.tar.gz, so a
// submission starts from the release page instead of a hand edit.
//
//   node scripts/ci/winget-manifest.mjs [--if-present] <version> <release-date> <assetsDir> <outDir> [owner/repo]
//
// <assetsDir> is a release's assets (nightly.yml's assembled feed); every
// `Polyth-<version>-win-<arch>.exe` in it becomes one Installers entry with the
// sha256 of that file. Only the regular edition is described: a
// `-workstation` asset is a different product with its own feed and identifier
// (docs/operations/releases.md), so it is skipped rather than published under
// Polyth.Polyth.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { channelOfVersion } from "./update-feed.mjs";

/** The identifier microsoft/winget-pkgs files this package under. */
export const WINGET_IDENTIFIER = "Polyth.Polyth";
/** The manifest schema the files declare (https://aka.ms/winget-manifest.<kind>.<version>.schema.json). */
export const WINGET_MANIFEST_VERSION = "1.28.0";
export const WINGET_LOCALE = "en-US";
export const WINGET_REPOSITORY = "Polyth/Polyth";

/** winget's Architecture value for the arch token of an electron-builder asset name. */
const ARCHITECTURES = { x64: "x64", arm64: "arm64", ia32: "x86" };
/** x64 first, so a rerun writes the same order whatever readdir returns. */
const ARCHITECTURE_ORDER = ["x64", "arm64", "x86"];
const STABLE_VERSION = /^\d+\.\d+\.\d+$/;
const RELEASE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const SHA256 = /^[0-9A-F]{64}$/;

/** What the store page says, in the manifest rather than in a README. */
const PRODUCT = {
  publisher: "Polyth",
  publisherUrl: "https://polyth.app",
  supportUrl: "https://github.com/Polyth/Polyth/issues",
  homepage: "https://polyth.app",
  // apps/desktop/package.json productName and appId: the installed app is Polyth.app.
  displayName: "Polyth",
  license: "Apache-2.0",
  licenseUrl: "https://github.com/Polyth/Polyth/blob/master/LICENSE",
  shortDescription: "One workspace for every coding agent, on one permanent history.",
  tags: ["ai", "coding-agent", "developer-tools", "agent", "chat", "electron"],
};

const DESCRIPTION = `Polyth is a workspace for running and reviewing coding agents. It runs the agent
command-line tools you already have (Claude Code, Codex, OpenCode, Pi, Antigravity,
Cursor, DeepSeek Harness and GitHub Copilot) behind one permanent conversation
history: switch the agent mid-conversation, keep the context, and review every change
next to the chat.

The desktop app bundles its own Polyth server, its own copy of OpenCode and a
Chromium browser for the agent, so it needs no separate server. One Polyth server can
also be shared: the same chats are reachable from the browser, the desktop window and
a paired phone, with permission requests answered from whichever device is at hand.

Polyth is free and open source (Apache-2.0), with no paid edition. Projects, history,
settings and secrets stay on the machine that runs it.`;

const assertVersion = (version) => {
  if (!STABLE_VERSION.test(version ?? "")) {
    throw new Error(`winget gets stable releases only, not ${version}`);
  }
  if (channelOfVersion(version) !== "stable") {
    throw new Error(`${version} is not a stable release`);
  }
};

const assertReleaseDate = (releaseDate) => {
  if (!RELEASE_DATE.test(releaseDate ?? "") || Number.isNaN(Date.parse(`${releaseDate}T00:00:00Z`))) {
    throw new Error(`ReleaseDate must be a YYYY-MM-DD date, not ${releaseDate}`);
  }
  if (new Date(`${releaseDate}T00:00:00Z`).toISOString().slice(0, 10) !== releaseDate) {
    throw new Error(`ReleaseDate ${releaseDate} is not a real calendar day`);
  }
};

/**
 * The Windows installers of one release, as winget Installers entries.
 * `-workstation` files are another product and are skipped; an unknown arch is
 * an error, because publishing it under a guessed Architecture key would install
 * the wrong binary.
 */
export function windowsInstallers(assetsDir, version) {
  assertVersion(version);
  const escaped = version.replaceAll(".", "\\.");
  const pattern = new RegExp(`^Polyth-${escaped}-win-(.+)\\.exe$`);
  const installers = [];
  for (const name of readdirSync(resolve(assetsDir))) {
    const match = pattern.exec(name);
    if (!match) continue;
    if (match[1].includes("-workstation")) continue;
    const architecture = ARCHITECTURES[match[1]];
    if (!architecture) throw new Error(`No winget Architecture for "${match[1]}" in ${name}`);
    installers.push({
      architecture,
      file: name,
      sha256: createHash("sha256").update(readFileSync(join(resolve(assetsDir), name))).digest("hex").toUpperCase(),
    });
  }
  return installers.sort((left, right) => ARCHITECTURE_ORDER.indexOf(left.architecture) - ARCHITECTURE_ORDER.indexOf(right.architecture));
}

const installerManifest = ({ version, releaseDate, installers, repository }) => {
  const entries = installers.map((installer) => [
    `- Architecture: ${installer.architecture}`,
    `  InstallerUrl: https://github.com/${repository}/releases/download/v${version}/${installer.file}`,
    `  InstallerSha256: ${installer.sha256}`,
  ].join("\n")).join("\n");
  return `# Generated by scripts/ci/winget-manifest.mjs; do not edit by hand.
PackageIdentifier: ${WINGET_IDENTIFIER}
PackageVersion: ${version}
Platform:
- Windows.Desktop
MinimumOSVersion: 10.0.0.0
InstallerType: nullsoft
Scope: user
UpgradeBehavior: install
ReleaseDate: "${releaseDate}"
Installers:
${entries}
ManifestType: installer
ManifestVersion: ${WINGET_MANIFEST_VERSION}
`;
};

const versionManifest = ({ version }) => `# Generated by scripts/ci/winget-manifest.mjs; do not edit by hand.
PackageIdentifier: ${WINGET_IDENTIFIER}
PackageVersion: ${version}
DefaultLocale: ${WINGET_LOCALE}
ManifestType: version
ManifestVersion: ${WINGET_MANIFEST_VERSION}
`;

const localeManifest = ({ version }) => `# Generated by scripts/ci/winget-manifest.mjs; do not edit by hand.
PackageIdentifier: ${WINGET_IDENTIFIER}
PackageVersion: ${version}
PackageLocale: ${WINGET_LOCALE}
Publisher: ${PRODUCT.publisher}
PublisherUrl: ${PRODUCT.publisherUrl}
PublisherSupportUrl: ${PRODUCT.supportUrl}
PackageName: ${PRODUCT.displayName}
PackageUrl: ${PRODUCT.homepage}
License: ${PRODUCT.license}
LicenseUrl: ${PRODUCT.licenseUrl}
ShortDescription: ${PRODUCT.shortDescription}
Description: |-
${DESCRIPTION.split("\n").map((line) => (line === "" ? "" : `  ${line}`)).join("\n")}
Tags:
${PRODUCT.tags.map((tag) => `- ${tag}`).join("\n")}
ReleaseNotesUrl: https://github.com/${WINGET_REPOSITORY}/releases/tag/v${version}
ManifestType: defaultLocale
ManifestVersion: ${WINGET_MANIFEST_VERSION}
`;

/** The three manifest files of one release, as `{ name, text }`. */
export function wingetManifests({ version, releaseDate, installers, repository = WINGET_REPOSITORY }) {
  assertVersion(version);
  assertReleaseDate(releaseDate);
  if (!REPOSITORY.test(repository ?? "")) throw new Error(`Not an owner/repo: ${repository}`);
  if (!Array.isArray(installers) || installers.length === 0) throw new Error("No Windows installer to describe");
  const seen = new Set();
  for (const installer of installers) {
    if (!ARCHITECTURE_ORDER.includes(installer.architecture)) {
      throw new Error(`No winget Architecture for ${JSON.stringify(installer.architecture)}`);
    }
    if (seen.has(installer.architecture)) throw new Error(`${installer.architecture} has more than one installer`);
    seen.add(installer.architecture);
    if (!SHA256.test(installer.sha256 ?? "")) throw new Error(`${installer.architecture}: sha256 must be uppercase hex`);
    if (typeof installer.file !== "string" || !/^Polyth-.+-win-.+\.exe$/.test(installer.file)) {
      throw new Error(`${installer.architecture}: unexpected installer file ${installer.file}`);
    }
  }
  return [
    { name: `${WINGET_IDENTIFIER}.yaml`, text: versionManifest({ version }) },
    { name: `${WINGET_IDENTIFIER}.installer.yaml`, text: installerManifest({ version, releaseDate, installers, repository }) },
    { name: `${WINGET_IDENTIFIER}.locale.${WINGET_LOCALE}.yaml`, text: localeManifest({ version }) },
  ];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // `--if-present` is for a release job: a release without a regular Windows
  // installer is a warning and no manifests, never a failed release.
  const optional = process.argv.includes("--if-present");
  const [version, releaseDate, assetsDir, outDir, repository] = process.argv.slice(2).filter((argument) => argument !== "--if-present");
  if (!version || !releaseDate || !assetsDir || !outDir) {
    console.error("usage: winget-manifest.mjs [--if-present] <version> <release-date> <assetsDir> <outDir> [owner/repo]");
    process.exit(2);
  }
  const installers = windowsInstallers(assetsDir, version);
  if (installers.length === 0) {
    if (!optional) throw new Error(`No Polyth-${version}-win-<arch>.exe in ${assetsDir}; nothing to write`);
    console.log(`::warning::Release ${version} carries no regular Windows installer; no winget manifests are written`);
    process.exit(0);
  }
  const manifests = wingetManifests({ version, releaseDate, installers, ...(repository ? { repository } : {}) });
  const directory = join(resolve(outDir), "manifests");
  mkdirSync(directory, { recursive: true });
  for (const manifest of manifests) {
    writeFileSync(join(directory, manifest.name), manifest.text);
    console.log(join(directory, manifest.name));
  }
  console.log(`winget: ${WINGET_IDENTIFIER} ${version} (${installers.map((installer) => installer.architecture).join(", ")})`);
}
