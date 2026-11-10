import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assembleFeed,
  assembleWorkstationFeed,
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

const WORKSTATION_MISSING = "The workstation edition is missing; this release has no workstation feed";

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
    assert.deepEqual(result.warnings, [
      "The macOS 12 build is missing; this release has no legacy-mac.yml",
      WORKSTATION_MISSING,
    ]);
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
    assert.deepEqual(result.warnings, [WORKSTATION_MISSING]);
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

test("the workstation edition joins stable releases as its own feed and never touches latest*.yml", () => {
  const root = mkdtempSync(join(tmpdir(), "update-feed-workstation-"));
  try {
    const products = join(root, "products");
    const put = (dir: string, name: string, content = "x") => {
      mkdirSync(join(products, dir), { recursive: true });
      writeFileSync(join(products, dir, name), content);
    };
    const single = (url: string) => `version: 0.1.86\nfiles:\n  - url: ${url}\n    sha512: a\n    size: 1\npath: ${url}\n`;
    const stdMac = (arch: string) => mac(arch);
    for (const arch of ["x64", "arm64"]) {
      put(`products-mac-dmg-${arch}`, `latest-mac.${arch}.partial.yml`, stdMac(arch));
      for (const ext of ["zip", "dmg"]) put(`products-mac-dmg-${arch}`, `Polyth-0.1.86-mac-${arch}.${ext}`);
    }
    put("products-windows-exe", "latest.yml", single("Polyth-0.1.86-win-x64.exe"));
    put("products-windows-exe", "Polyth-0.1.86-win-x64.exe");
    put("products-linux-appimage", "latest-linux.yml", single("Polyth-0.1.86-linux-x86_64.AppImage"));
    put("products-linux-appimage", "Polyth-0.1.86-linux-x86_64.AppImage");
    const feed = join(root, "feed");

    // Without workstation products: the standard feed still assembles, with a warning.
    const without = assembleFeed(products, feed);
    assert.ok(without.warnings.includes(WORKSTATION_MISSING));
    assert.ok(!without.files.some((file) => file.includes("workstation") || file.startsWith("SHA256SUMS")));

    for (const arch of ["x64", "arm64"]) {
      put(`products-mac-dmg-workstation-${arch}`, `workstation-mac.${arch}.partial.yml`,
        mac(arch).replaceAll(`mac-${arch}.`, `mac-${arch}-workstation.`));
      for (const ext of ["zip", "dmg", "zip.blockmap"]) put(`products-mac-dmg-workstation-${arch}`, `Polyth-0.1.86-mac-${arch}-workstation.${ext}`, `mac-${arch}`);
      put(`products-mac-dmg-workstation-${arch}`, `Polyth-0.1.86-workstation-sbom-mac-${arch}.cdx.json`, "{}");
    }
    put("products-windows-exe-workstation", "workstation.yml", single("Polyth-0.1.86-win-x64-workstation.exe"));
    put("products-windows-exe-workstation", "Polyth-0.1.86-win-x64-workstation.exe", "win");
    put("products-windows-exe-workstation", "Polyth-0.1.86-win-x64-workstation.exe.blockmap", "bm");
    put("products-windows-exe-workstation", "Polyth-0.1.86-workstation-sbom-win-x64.cdx.json", "{}");
    put("products-linux-appimage-workstation", "workstation-linux.yml", single("Polyth-0.1.86-linux-x86_64-workstation.AppImage"));
    put("products-linux-appimage-workstation", "Polyth-0.1.86-linux-x86_64-workstation.AppImage", "lin");
    put("products-linux-appimage-workstation", "Polyth-0.1.86-workstation-sbom-linux-x64.cdx.json", "{}");

    const result = assembleFeed(products, feed);
    assert.ok(!result.warnings.some((warning) => /workstation/i.test(warning)), result.warnings.join("; "));
    const names = result.files.filter((file) => file.includes("workstation") || file.startsWith("SHA256SUMS"));
    assert.deepEqual(names, [
      "Polyth-0.1.86-linux-x86_64-workstation.AppImage",
      "Polyth-0.1.86-mac-arm64-workstation.dmg", "Polyth-0.1.86-mac-arm64-workstation.zip", "Polyth-0.1.86-mac-arm64-workstation.zip.blockmap",
      "Polyth-0.1.86-mac-x64-workstation.dmg", "Polyth-0.1.86-mac-x64-workstation.zip", "Polyth-0.1.86-mac-x64-workstation.zip.blockmap",
      "Polyth-0.1.86-win-x64-workstation.exe", "Polyth-0.1.86-win-x64-workstation.exe.blockmap",
      "Polyth-0.1.86-workstation-sbom-linux-x64.cdx.json",
      "Polyth-0.1.86-workstation-sbom-mac-arm64.cdx.json", "Polyth-0.1.86-workstation-sbom-mac-x64.cdx.json",
      "Polyth-0.1.86-workstation-sbom-win-x64.cdx.json",
      "SHA256SUMS-workstation.txt",
      "workstation-linux.yml", "workstation-mac.yml", "workstation.yml",
    ]);
    // No channel copies, and nothing workstation in the standard metadata.
    assert.ok(!result.files.some((file) => /^(beta|nightly)-workstation|workstation-(beta|nightly)/.test(file)));
    for (const name of ["latest.yml", "latest-mac.yml", "latest-linux.yml", "beta.yml", "beta-mac.yml", "beta-linux.yml"]) {
      assert.ok(!readFileSync(join(feed, name), "utf8").includes("workstation"), name);
    }
    assert.equal(metadataUrls(readFileSync(join(feed, "workstation-mac.yml"), "utf8")).length, 4);
    const sums = readFileSync(join(feed, "SHA256SUMS-workstation.txt"), "utf8").trim().split("\n");
    const summed = sums.map((line) => line.split("  ")[1]);
    assert.deepEqual([...summed].sort(), names.filter((file) => file !== "SHA256SUMS-workstation.txt"));
    assert.ok(sums.every((line) => /^[0-9a-f]{64}  \S+$/.test(line)));

    // A missing platform is a warning, never an error.
    rmSync(join(products, "products-linux-appimage-workstation"), { recursive: true });
    const partial = assembleFeed(products, feed);
    assert.ok(partial.warnings.some((warning) => warning.includes("workstation-linux.yml")));
    assert.ok(!partial.files.includes("workstation-linux.yml"));
    assert.ok(partial.files.includes("workstation.yml"));

    // Workstation products never enter a non-stable channel's standard feed; the
    // edition is assembled separately for the nightly release (next test).
    for (const dir of readdirSync(products)) {
      for (const file of readdirSync(join(products, dir))) {
        if (!file.endsWith(".yml")) continue;
        const path = join(products, dir, file);
        writeFileSync(path, readFileSync(path, "utf8").replace(/^version: .*$/m, "version: 0.1.86-nightly"));
      }
    }
    const nightly = assembleFeed(products, feed, "nightly");
    assert.ok(!nightly.files.some((file) => file.includes("workstation") || file.startsWith("SHA256SUMS")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a nightly build's workstation edition assembles as its own asset set", () => {
  const root = mkdtempSync(join(tmpdir(), "update-feed-workstation-nightly-"));
  try {
    const version = "0.1.86-nightly";
    const products = join(root, "products");
    const put = (dir: string, name: string, content = "x") => {
      mkdirSync(join(products, dir), { recursive: true });
      writeFileSync(join(products, dir, name), content);
    };
    const single = (url: string) => `version: ${version}\nfiles:\n  - url: ${url}\n    sha512: a\n    size: 1\npath: ${url}\n`;
    const file = (dir: string, name: string, blockmap = true) => {
      put(dir, name, name);
      if (blockmap) put(dir, `${name}.blockmap`, "bm");
    };

    // Nothing to assemble is not an error.
    assert.equal(assembleWorkstationFeed(products, join(root, "none"), "nightly"), null);

    put("products-windows-exe-workstation", "workstation.yml", single(`Polyth-${version}-win-x64-workstation.exe`));
    file("products-windows-exe-workstation", `Polyth-${version}-win-x64-workstation.exe`);
    put("products-windows-exe-workstation", `Polyth-${version}-workstation-sbom-win-x64.cdx.json`, "{}");
    put("products-linux-appimage-workstation", "workstation-linux.yml", single(`Polyth-${version}-linux-x86_64-workstation.AppImage`));
    file("products-linux-appimage-workstation", `Polyth-${version}-linux-x86_64-workstation.AppImage`, false);
    put("products-linux-appimage-workstation", `Polyth-${version}-workstation-sbom-linux-x64.cdx.json`, "{}");
    for (const arch of ["x64", "arm64"]) {
      const zip = `Polyth-${version}-mac-${arch}-workstation.zip`;
      const dmg = `Polyth-${version}-mac-${arch}-workstation.dmg`;
      put(`products-mac-dmg-workstation-${arch}`, `workstation-mac.${arch}.partial.yml`,
        `version: ${version}\nfiles:\n  - url: ${zip}\n    sha512: z\n    size: 1\n  - url: ${dmg}\n    sha512: d\n    size: 1\npath: ${zip}\n`);
      file(`products-mac-dmg-workstation-${arch}`, zip);
      file(`products-mac-dmg-workstation-${arch}`, dmg);
      put(`products-mac-dmg-workstation-${arch}`, `Polyth-${version}-workstation-sbom-mac-${arch}.cdx.json`, "{}");
    }

    const out = join(root, "edition");
    const result = assembleWorkstationFeed(products, out, "nightly");
    assert.ok(result);
    assert.equal(result.version, version);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.files, [
      `Polyth-${version}-linux-x86_64-workstation.AppImage`,
      `Polyth-${version}-mac-arm64-workstation.dmg`, `Polyth-${version}-mac-arm64-workstation.dmg.blockmap`,
      `Polyth-${version}-mac-arm64-workstation.zip`, `Polyth-${version}-mac-arm64-workstation.zip.blockmap`,
      `Polyth-${version}-mac-x64-workstation.dmg`, `Polyth-${version}-mac-x64-workstation.dmg.blockmap`,
      `Polyth-${version}-mac-x64-workstation.zip`, `Polyth-${version}-mac-x64-workstation.zip.blockmap`,
      `Polyth-${version}-win-x64-workstation.exe`, `Polyth-${version}-win-x64-workstation.exe.blockmap`,
      `Polyth-${version}-workstation-sbom-linux-x64.cdx.json`,
      `Polyth-${version}-workstation-sbom-mac-arm64.cdx.json`,
      `Polyth-${version}-workstation-sbom-mac-x64.cdx.json`,
      `Polyth-${version}-workstation-sbom-win-x64.cdx.json`,
      "SHA256SUMS-workstation.txt",
      "workstation-linux.yml", "workstation-mac.yml", "workstation.yml",
    ]);
    assert.equal(metadataUrls(readFileSync(join(out, "workstation-mac.yml"), "utf8")).length, 4);
    const sums = readFileSync(join(out, "SHA256SUMS-workstation.txt"), "utf8").trim().split("\n");
    assert.deepEqual([...sums.map((line) => line.split("  ")[1])].sort(),
      result.files.filter((file) => file !== "SHA256SUMS-workstation.txt"));

    // A build only ever replaces assets of its own channel.
    assert.throws(() => assembleWorkstationFeed(products, out, "stable"), /does not belong to the stable channel/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
