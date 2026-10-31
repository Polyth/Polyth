import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assembleFeed,
  channelMetadataAliases,
  channelOfVersion,
  electronBuilderFeedArgs,
  mergeMacMetadata,
  metadataUrls,
  resolveBuildVersion,
  resolveFeedRepository,
  resolveReleaseChannel,
} from "../ci/update-feed.mjs";
import { MAC_LEGACY_ELECTRON_VERSION, macLegacyBuilderArgs } from "../ci/mac-legacy.mjs";

const mac = (arch: string) => [
  "version: 0.1.86",
  "files:",
  `  - url: Polyth-0.1.86-mac-${arch}.zip`,
  "    sha512: zip==",
  "    size: 10",
  `  - url: Polyth-0.1.86-mac-${arch}.dmg`,
  "    sha512: dmg==",
  "    size: 20",
  `path: Polyth-0.1.86-mac-${arch}.zip`,
  "sha512: zip==",
  "releaseDate: '2026-10-08T06:00:00.000Z'",
  "",
].join("\n");

test("the feed repository must be owner/repo", () => {
  assert.equal(resolveFeedRepository(undefined), null);
  assert.equal(resolveFeedRepository("  "), null);
  assert.deepEqual(resolveFeedRepository("example-org/polyth-release-builder"), {
    owner: "example-org", repo: "polyth-release-builder",
  });
  for (const bad of ["devmaxer", "a/b/c", "a/..", "-a/b", "a/b c", "a/b;rm"]) {
    assert.throws(() => resolveFeedRepository(bad), /owner\/repo/, bad);
  }
});

test("the builder run number becomes a newer patch version", () => {
  assert.equal(resolveBuildVersion("0.1.0", undefined), null);
  assert.equal(resolveBuildVersion("0.1.0", "86"), "0.1.86");
  assert.equal(resolveBuildVersion("2.3.4", "5"), "2.3.5");
  assert.throws(() => resolveBuildVersion("2.3.4", "4"), /greater/);
  assert.throws(() => resolveBuildVersion("0.1.0", "1.5"), /integer/);
  assert.throws(() => resolveBuildVersion("0.1.0-beta.1", "9"), /stable/);
});

test("each release channel versions its builds distinctly", () => {
  assert.equal(resolveReleaseChannel(undefined), "stable");
  assert.equal(resolveReleaseChannel(" nightly "), "nightly");
  assert.throws(() => resolveReleaseChannel("beta"), /stable, test, nightly/);
  assert.equal(resolveBuildVersion("0.1.0", "140", "stable"), "0.1.140");
  assert.equal(resolveBuildVersion("0.1.0", "141", "test"), "0.1.141-beta");
  assert.equal(resolveBuildVersion("0.1.0", "142", "nightly"), "0.1.142-nightly");
  assert.equal(channelOfVersion("0.1.140"), "stable");
  assert.equal(channelOfVersion("0.1.141-beta"), "test");
  assert.equal(channelOfVersion("0.1.142-nightly"), "nightly");
  assert.equal(channelOfVersion("0.1.142-rc.1"), null);
  assert.deepEqual(channelMetadataAliases("nightly"), ["nightly"]);
  assert.deepEqual(channelMetadataAliases("test"), ["beta"]);
  // Test-channel updaters also accept stable releases and read beta*.yml there.
  assert.deepEqual(channelMetadataAliases("stable"), ["beta"]);
});

test("feed builds pass the publish target and version to electron-builder", () => {
  assert.deepEqual(electronBuilderFeedArgs({}, "0.1.0"), []);
  assert.deepEqual(electronBuilderFeedArgs({ POLYTH_UPDATE_REPOSITORY: "o/r", POLYTH_BUILD_NUMBER: "86" }, "0.1.0"), [
    "--config.publish.provider=github",
    "--config.publish.owner=o",
    "--config.publish.repo=r",
    "--config.publish.releaseType=release",
    "--config.publish.channel=latest",
    "--config.extraMetadata.version=0.1.86",
  ]);
  assert.deepEqual(electronBuilderFeedArgs({ POLYTH_BUILD_NUMBER: "87", POLYTH_RELEASE_CHANNEL: "nightly" }, "0.1.0"), [
    "--config.extraMetadata.version=0.1.87-nightly",
    "--config.buildVersion=0.1.87",
    "--config.mac.bundleShortVersion=0.1.87",
  ]);
});

test("per-architecture macOS metadata merges into one file list", () => {
  const merged = mergeMacMetadata([mac("x64"), mac("arm64")]);
  assert.deepEqual(metadataUrls(merged).sort(), [
    "Polyth-0.1.86-mac-arm64.dmg", "Polyth-0.1.86-mac-arm64.zip",
    "Polyth-0.1.86-mac-x64.dmg", "Polyth-0.1.86-mac-x64.zip",
  ]);
  assert.match(merged, /^path: Polyth-0\.1\.86-mac-x64\.zip$/m);
  assert.equal(merged.match(/^files:/gm)?.length, 1);
  assert.throws(() => mergeMacMetadata([mac("x64"), mac("arm64").replace("0.1.86", "0.1.85")]), /differ/);
});

test("assembling the feed requires every platform's metadata and files", () => {
  const root = mkdtempSync(join(tmpdir(), "update-feed-"));
  try {
    const products = join(root, "products");
    const put = (dir: string, name: string, content = "x") => {
      mkdirSync(join(products, dir), { recursive: true });
      writeFileSync(join(products, dir, name), content);
    };
    for (const arch of ["x64", "arm64"]) {
      put(`products-mac-dmg-${arch}`, `latest-mac.${arch}.partial.yml`, mac(arch));
      for (const ext of ["zip", "dmg", "zip.blockmap"]) put(`products-mac-dmg-${arch}`, `Polyth-0.1.86-mac-${arch}.${ext}`);
    }
    put("products-windows-exe", "latest.yml", "version: 0.1.86\nfiles:\n  - url: Polyth-0.1.86-win-x64.exe\n    sha512: a\n    size: 1\npath: Polyth-0.1.86-win-x64.exe\n");
    put("products-windows-exe", "Polyth-0.1.86-win-x64.exe");
    put("products-windows-exe", "Polyth-0.1.86-win-x64.exe.blockmap");
    put("products-linux-appimage", "appimage-e2e.log");
    put("products-ios-app", "ios-simulator.app.zip");
    put("products-android-apk", "app-debug.apk");
    put("products-linux-appimage", "Polyth-0.1.86-linux-x86_64.AppImage");
    const feed = join(root, "feed");
    assert.throws(() => assembleFeed(products, feed), /missing latest-linux\.yml/);

    put("products-linux-appimage", "latest-linux.yml", "version: 0.1.86\nfiles:\n  - url: Polyth-0.1.86-linux-x86_64.AppImage\n    sha512: a\n    size: 1\npath: Polyth-0.1.86-linux-x86_64.AppImage\n");
    const result = assembleFeed(products, feed);
    assert.equal(result.version, "0.1.86");
    assert.deepEqual(result.warnings, ["The macOS 12 build is missing; this release has no legacy-mac.yml"]);
    assert.ok(result.files.includes("latest-mac.yml"));
    assert.deepEqual(result.files, [
      "Polyth-0.1.86-android.apk",
      "Polyth-0.1.86-linux-x86_64.AppImage",
      "Polyth-0.1.86-mac-arm64.dmg", "Polyth-0.1.86-mac-arm64.zip", "Polyth-0.1.86-mac-arm64.zip.blockmap",
      "Polyth-0.1.86-mac-x64.dmg", "Polyth-0.1.86-mac-x64.zip", "Polyth-0.1.86-mac-x64.zip.blockmap",
      "Polyth-0.1.86-win-x64.exe", "Polyth-0.1.86-win-x64.exe.blockmap",
      "beta-linux.yml", "beta-mac.yml", "beta.yml",
      "latest-linux.yml", "latest-mac.yml", "latest.yml",
    ]);
    assert.equal(readFileSync(join(feed, "beta-mac.yml"), "utf8"), readFileSync(join(feed, "latest-mac.yml"), "utf8"));
    assert.throws(() => assembleFeed(products, feed, "nightly"), /0\.1\.86 does not belong to the nightly channel/);
    assert.equal(metadataUrls(readFileSync(join(feed, "latest-mac.yml"), "utf8")).length, 4);

    for (const [dir, name] of [
      ["products-mac-dmg-x64", "latest-mac.x64.partial.yml"], ["products-mac-dmg-arm64", "latest-mac.arm64.partial.yml"],
      ["products-windows-exe", "latest.yml"], ["products-linux-appimage", "latest-linux.yml"],
    ]) {
      const path = join(products, dir, name);
      writeFileSync(path, readFileSync(path, "utf8").replace("version: 0.1.86", "version: 0.1.86-nightly"));
    }
    const nightly = assembleFeed(products, feed, "nightly");
    assert.deepEqual([nightly.version, nightly.prerelease], ["0.1.86-nightly", true]);
    assert.deepEqual(nightly.files.filter((file) => file.endsWith(".yml")), [
      "latest-linux.yml", "latest-mac.yml", "latest.yml", "nightly-linux.yml", "nightly-mac.yml", "nightly.yml",
    ]);

    assert.ok(nightly.files.includes("Polyth-0.1.86-nightly-android.apk"));

    // A failed Android job leaves the APK out without blocking the desktop release.
    rmSync(join(products, "products-android-apk"), { recursive: true });
    assert.ok(!assembleFeed(products, feed, "nightly").files.some((file) => file.endsWith(".apk")));
    put("products-android-apk", "app-debug.apk");
    put("products-ios-app", "other.apk");
    assert.throws(() => assembleFeed(products, feed, "nightly"), /more than one APK/);
    rmSync(join(products, "products-ios-app", "other.apk"));

    rmSync(join(products, "products-windows-exe", "Polyth-0.1.86-win-x64.exe"));
    assert.throws(() => assembleFeed(products, feed, "nightly"), /latest\.yml references Polyth-0\.1\.86-win-x64\.exe/);

    rmSync(join(products, "products-mac-dmg-arm64"), { recursive: true });
    assert.throws(() => assembleFeed(products, feed, "nightly"), /missing the arm64 macOS metadata/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const legacyMac = (version: string) => [
  `version: ${version}`,
  "files:",
  `  - url: Polyth-${version}-mac-legacy-x64.zip`,
  "    sha512: zip==",
  "    size: 10",
  `  - url: Polyth-${version}-mac-legacy-x64.dmg`,
  "    sha512: dmg==",
  "    size: 20",
  `path: Polyth-${version}-mac-legacy-x64.zip`,
  "sha512: zip==",
  "",
].join("\n");

test("the macOS 12 package is Electron 43 with its own file names", () => {
  assert.match(MAC_LEGACY_ELECTRON_VERSION, /^43\.\d+\.\d+$/);
  assert.deepEqual(macLegacyBuilderArgs(), [
    `--config.electronVersion=${MAC_LEGACY_ELECTRON_VERSION}`,
    "--config.mac.minimumSystemVersion=12.0",
    "--config.mac.artifactName=${productName}-${version}-mac-legacy-${arch}.${ext}",
  ]);
});

test("the macOS 12 feed ships as legacy-mac.yml alone, beside the regular metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "update-feed-legacy-"));
  try {
    const products = join(root, "products");
    const put = (dir: string, name: string, content = "x") => {
      mkdirSync(join(products, dir), { recursive: true });
      writeFileSync(join(products, dir, name), content);
    };
    for (const arch of ["x64", "arm64"]) {
      put(`products-mac-dmg-${arch}`, `latest-mac.${arch}.partial.yml`, mac(arch));
      for (const ext of ["zip", "dmg"]) put(`products-mac-dmg-${arch}`, `Polyth-0.1.86-mac-${arch}.${ext}`);
    }
    put("products-windows-exe", "latest.yml", "version: 0.1.86\nfiles:\n  - url: Polyth-0.1.86-win-x64.exe\n    sha512: a\n    size: 1\npath: Polyth-0.1.86-win-x64.exe\n");
    put("products-windows-exe", "Polyth-0.1.86-win-x64.exe");
    put("products-linux-appimage", "latest-linux.yml", "version: 0.1.86\nfiles:\n  - url: Polyth-0.1.86-linux-x86_64.AppImage\n    sha512: a\n    size: 1\npath: Polyth-0.1.86-linux-x86_64.AppImage\n");
    put("products-linux-appimage", "Polyth-0.1.86-linux-x86_64.AppImage");
    put("products-mac-dmg-legacy", "legacy-mac.yml", legacyMac("0.1.86"));
    for (const ext of ["zip", "dmg", "zip.blockmap"]) put("products-mac-dmg-legacy", `Polyth-0.1.86-mac-legacy-x64.${ext}`);
    const feed = join(root, "feed");

    const result = assembleFeed(products, feed);
    assert.deepEqual(result.warnings, []);
    assert.ok(result.files.includes("legacy-mac.yml"));
    // No channel copies: the macOS 12 build reads only legacy-mac.yml on stable releases.
    assert.ok(!result.files.some((file) => /^(beta|nightly)-legacy|legacy-mac\.(beta|nightly)/.test(file)));
    for (const ext of ["zip", "dmg", "zip.blockmap"]) assert.ok(result.files.includes(`Polyth-0.1.86-mac-legacy-x64.${ext}`));
    // The regular metadata never names the macOS 12 package.
    assert.ok(!readFileSync(join(feed, "latest-mac.yml"), "utf8").includes("mac-legacy"));

    rmSync(join(products, "products-mac-dmg-legacy", "Polyth-0.1.86-mac-legacy-x64.dmg"));
    assert.throws(() => assembleFeed(products, feed), /legacy-mac\.yml references Polyth-0\.1\.86-mac-legacy-x64\.dmg/);
    put("products-mac-dmg-legacy", "legacy-mac.yml", legacyMac("0.1.85"));
    assert.throws(() => assembleFeed(products, feed), /legacy-mac\.yml is version 0\.1\.85, the release is 0\.1\.86/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
