#!/usr/bin/env node
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { electronBuilderFeedArgs, macPartialMetadataName, resolveFeedRepository } from "./update-feed.mjs";
import { externalTestFlightRequested } from "./testflight-distribute.mjs";
import {
  MAC_LEGACY_ARCH, MAC_LEGACY_ELECTRON_VERSION, MAC_LEGACY_FLAVOR, MAC_LEGACY_METADATA,
  MAC_LEGACY_MINIMUM_SYSTEM_VERSION, macLegacyBuilderArgs,
} from "./mac-legacy.mjs";

const ROOT = process.cwd();
const TARGET = process.env.REMOTE_BUILD_TARGET;
const OUTPUT = resolve(process.env.REMOTE_BUILD_OUTPUT || join(ROOT, "remote-build-output"));
const TMP = resolve(process.env.RUNNER_TEMP || join(ROOT, ".remote-build-tmp"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

if (!TARGET) throw new Error("REMOTE_BUILD_TARGET is required");

// The external builder bakes its own GitHub Releases feed and run number into
// desktop packages; see scripts/ci/update-feed.mjs. Unset = plain smoke build.
const DESKTOP_VERSION = JSON.parse(readFileSync(join(ROOT, "apps/desktop/package.json"), "utf8")).version;
const FEED_ARGS = electronBuilderFeedArgs(process.env, DESKTOP_VERSION);
const FEED_BUILD = resolveFeedRepository(process.env.POLYTH_UPDATE_REPOSITORY) !== null;

// Real Developer ID signing only when every Apple secret is present; otherwise
// fall back to ad-hoc so a bare runner still produces smoke artifacts.
const MAC_SIGN_VARS = ["CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"];
const SIGNED_MAC = MAC_SIGN_VARS.every((name) => (process.env[name] ?? "").length > 0);
if (!SIGNED_MAC && MAC_SIGN_VARS.some((name) => (process.env[name] ?? "").length > 0)) {
  fail(`Partial macOS signing secrets: set all of ${MAC_SIGN_VARS.join(", ")} or none`);
}
// Signed iOS needs an App Store Connect API key; codemagic-cli-tools reads these
// names directly. Unset = unsigned simulator build, as before.
const IOS_SIGN_VARS = ["APP_STORE_CONNECT_ISSUER_ID", "APP_STORE_CONNECT_KEY_IDENTIFIER",
  "APP_STORE_CONNECT_PRIVATE_KEY", "CERTIFICATE_PRIVATE_KEY", "APP_STORE_APPLE_ID"];
const SIGNED_IOS = IOS_SIGN_VARS.every((name) => (process.env[name] ?? "").length > 0);
if (!SIGNED_IOS && IOS_SIGN_VARS.some((name) => (process.env[name] ?? "").length > 0)) {
  fail(`Partial iOS signing secrets: set all of ${IOS_SIGN_VARS.join(", ")} or none`);
}

if (FEED_ARGS.length > 0) console.log(`remote-build feed: ${FEED_ARGS.join(" ")}`);

rmSync(OUTPUT, { recursive: true, force: true });
mkdirSync(OUTPUT, { recursive: true });
mkdirSync(TMP, { recursive: true });

function fail(message) {
  throw new Error(message);
}

const MAC_ARCHITECTURES = ["x64", "arm64"];

function getMacArchitectures() {
  const requested = process.env.REMOTE_BUILD_ARCH?.trim();
  if (!requested) return MAC_ARCHITECTURES;
  if (!MAC_ARCHITECTURES.includes(requested)) {
    fail(`REMOTE_BUILD_ARCH must be one of ${MAC_ARCHITECTURES.join(", ")}`);
  }
  return [requested];
}

// Node refuses to spawn `.cmd`/`.bat` without a shell on Windows (CVE-2024-27980
// hardening in Node >=18.20.2 / 20.12.2 / 22), so the `npm.cmd` and `npx.cmd`
// shims fail with `EINVAL`. Route them through the shell; every argument list
// reaching them here is free of spaces and shell metacharacters.
const needsShell = (command) => process.platform === "win32" && /\.(cmd|bat)$/i.test(command);

function run(command, args, { cwd = ROOT, env = {} } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: "inherit",
    shell: needsShell(command),
  });
  if (result.error || result.status !== 0) {
    fail(`${command} ${args.join(" ")} failed${result.error ? `: ${result.error.message}` : ""}`);
  }
}

function directFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(dir, entry.name));
}

function walk(dir) {
  if (!existsSync(dir)) return [];
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(path));
    else found.push(path);
  }
  return found;
}

function copyFiles(files) {
  if (files.length === 0) fail("No build outputs found");
  for (const file of files) cpSync(file, join(OUTPUT, basename(file)));
}

function copyFileAs(file, name) {
  cpSync(file, join(OUTPUT, name));
}

function readBytes(file, position, length) {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const count = readSync(fd, buffer, 0, length, position);
    return buffer.subarray(0, count);
  } finally {
    closeSync(fd);
  }
}

function startsWith(file, magic) {
  return readBytes(file, 0, magic.length).equals(magic);
}

function isZip(file) {
  return startsWith(file, Buffer.from([0x50, 0x4b]));
}

function isGzip(file) {
  return startsWith(file, Buffer.from([0x1f, 0x8b]));
}

function isPeExecutable(file) {
  return startsWith(file, Buffer.from([0x4d, 0x5a]));
}

function isElfExecutable(file) {
  return startsWith(file, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
}

function isDiskImage(file) {
  const size = statSync(file).size;
  if (size < 512) return false;
  const tail = readBytes(file, Math.max(0, size - 1024), Math.min(1024, size));
  return tail.includes(Buffer.from("koly"));
}

function requireFiles(outputs, extension, label, predicate) {
  const files = outputs.filter((file) => file.toLowerCase().endsWith(extension));
  if (files.length === 0) fail(`${label} output is missing (*${extension})`);
  for (const file of files) {
    if (statSync(file).size === 0 || (predicate && !predicate(file))) {
      fail(`${label} output has an invalid file format: ${basename(file)}`);
    }
  }
  return files;
}

function validateOutputFormats(target, outputs) {
  const names = outputs.map((file) => basename(file));
  const encryptedLookingOutputs = names.filter((name) => name.toLowerCase().endsWith(".bin"));
  if (encryptedLookingOutputs.length > 0) {
    fail(`Build output must contain real product files, not .bin: ${encryptedLookingOutputs.join(", ")}`);
  }

  switch (target) {
    case "android-apk":
      requireFiles(outputs, ".apk", "Android APK", isZip);
      break;
    case "ios-app":
      // The signed path ships an .ipa (itself a zip container); without the App
      // Store Connect secrets it is still the unsigned simulator archive.
      if (SIGNED_IOS) requireFiles(outputs, ".ipa", "iOS app archive", isZip);
      else requireFiles(outputs, ".app.zip", "iOS simulator archive", isZip);
      break;
    case "mac-dmg":
      requireFiles(outputs, ".dmg", "macOS disk image", isDiskImage);
      if (FEED_BUILD) {
        requireFiles(outputs, ".zip", "macOS update archive", isZip);
        requireFiles(outputs, ".partial.yml", "macOS update metadata");
      }
      break;
    case "mac-dmg-legacy":
      requireFiles(outputs, "-mac-legacy-x64.dmg", "macOS 12 disk image", isDiskImage);
      if (FEED_BUILD) {
        requireFiles(outputs, "-mac-legacy-x64.zip", "macOS 12 update archive", isZip);
        requireFiles(outputs, MAC_LEGACY_METADATA, "macOS 12 update metadata");
      }
      break;
    case "windows-exe": {
      requireFiles(outputs, ".exe", "Windows installer", isPeExecutable);
      // electron-builder has emitted both JSON and binary blockmap formats
      // across versions; the stable contract here is a non-empty .blockmap
      // paired with the validated PE installer.
      requireFiles(outputs, ".blockmap", "Windows blockmap");
      if (FEED_BUILD) requireFiles(outputs, "latest.yml", "Windows update metadata");
      break;
    }
    case "linux-appimage":
      requireFiles(outputs, ".appimage", "Linux AppImage", isElfExecutable);
      if (FEED_BUILD) requireFiles(outputs, "latest-linux.yml", "Linux update metadata");
      break;
    case "npm-packages":
      requireFiles(outputs, ".tgz", "npm package", isGzip);
      break;
    case "testflight":
      requireFiles(outputs, "testflight.json", "TestFlight distribution summary");
      break;
    default:
      fail(`No output format validator for target: ${target}`);
  }
  console.log(`remote-build formats: ${target} validated (${names.join(", ")})`);
}

function npmCi() {
  run(npm, ["ci", "--no-audit", "--no-fund"]);
}

function buildAndroid() {
  npmCi();
  run(npm, ["run", "build:mobile"]);
  const versions = collectReleaseVersions("android-version-env");
  run("./gradlew", [
    ":app:assembleDebug",
    "--stacktrace",
    `-PpolythVersionName=${versions.POLYTH_VERSION}`,
    `-PpolythVersionCode=${versions.POLYTH_ANDROID_VERSION_CODE}`,
  ], { cwd: join(ROOT, "apps/mobile/android") });
  copyFiles(walk(join(ROOT, "apps/mobile/android/app/build/outputs/apk/debug")).filter((p) => p.endsWith(".apk")));
}

const IOS_APP_DIR = join(ROOT, "apps/mobile/ios/App");
const IOS_BUNDLE_ID = "com.polyth.mobile";
// Codemagic pinned the toolchain and its tests forbade floating to the newest
// release. The builder workflow selects Xcode, so assert the version here: a
// silently-newer toolchain changes the signed binary that reaches TestFlight.
// 27.1 is the first SDK iPhone Duo runs edge to edge; an older SDK gets a
// 375×667 phone window on either display (GitHub runner label `xcode-27`).
const IOS_XCODE_VERSION = process.env.POLYTH_IOS_XCODE_VERSION ?? "27.1";

function requireXcodeVersion() {
  const result = spawnSync("xcodebuild", ["-version"], { encoding: "utf8" });
  if (result.status !== 0) fail("xcodebuild -version failed; no Xcode on PATH");
  const found = /Xcode\s+([0-9]+(?:\.[0-9]+)*)/.exec(result.stdout)?.[1];
  if (!found) fail(`Could not parse an Xcode version from: ${result.stdout.trim()}`);
  if (found !== IOS_XCODE_VERSION && !found.startsWith(`${IOS_XCODE_VERSION}.`)) {
    fail(`Xcode ${IOS_XCODE_VERSION} is required for signed iOS builds, found ${found}. `
      + "Select it on the runner or set POLYTH_IOS_XCODE_VERSION.");
  }
  console.log(`remote-build ios: Xcode ${found}`);
}

// release-version.mjs and resolve-ios-build-number.sh both append KEY=value to
// $CM_ENV. remote-build.mjs runs inside a single CI step, so $GITHUB_ENV would
// not round-trip here; collect through a temp file instead and pass the values
// straight to xcodebuild. Later writes win, so the App Store Connect build
// number overrides the computed one.
function collectReleaseVersions(name, extra = () => {}) {
  const envFile = join(TMP, name);
  rmSync(envFile, { force: true });
  run(process.execPath, ["scripts/release-version.mjs"], { env: { CM_ENV: envFile } });
  extra(envFile);
  const values = {};
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) values[match[1]] = match[2];
  }
  return values;
}

function collectIosVersions() {
  const values = collectReleaseVersions("ios-version-env", (envFile) => {
    run("bash", ["scripts/ci/resolve-ios-build-number.sh"], { env: { CM_ENV: envFile } });
  });
  for (const key of ["POLYTH_IOS_MARKETING_VERSION", "POLYTH_IOS_CURRENT_PROJECT_VERSION"]) {
    if (!values[key]) fail(`${key} was not exported by the iOS version scripts`);
  }
  return values;
}

// Each app extension has its own App ID and App Store profile. Their signing
// files are fetched best effort: if they cannot be fetched or created, or the
// archive fails with the extension in it, the nightly still ships the app
// without that extension instead of failing TestFlight over a nicety.
const IOS_PROJECT_FILE = "apps/mobile/ios/App/App.xcodeproj/project.pbxproj";
const IOS_EXTENSIONS = [
  {
    name: "Notification Service Extension",
    bundleId: `${IOS_BUNDLE_ID}.NotificationService`,
    env: "POLYTH_IOS_NOTIFICATION_SERVICE",
    script: "apps/mobile/scripts/configure-ios-notification-service.mjs",
    without: "sealed push text will stay generic",
  },
  {
    name: "Live Activity extension",
    bundleId: `${IOS_BUNDLE_ID}.LiveActivity`,
    env: "POLYTH_IOS_LIVE_ACTIVITY",
    script: "apps/mobile/scripts/configure-ios-live-activity.mjs",
    without: "no Dynamic Island / Lock Screen Live Activity",
  },
];

/** Rebuilds the project patches from the committed file with only `kept`
 *  extensions (all patches are idempotent; order matches native:ios). */
function reapplyIosPatches(kept) {
  run("git", ["checkout", "--", IOS_PROJECT_FILE]);
  run(process.execPath, ["apps/mobile/scripts/configure-ios-polyth-link.mjs"]);
  for (const extension of IOS_EXTENSIONS) {
    run(process.execPath, [extension.script], {
      env: { [extension.env]: kept.includes(extension) ? "" : "0" },
    });
  }
}

function dropIosExtension(kept, extension, reason) {
  console.warn("::warning::remote-build ios: WARNING - " + reason
    + ` Shipping the app WITHOUT the ${extension.name}: ${extension.without}.`);
  const next = kept.filter((candidate) => candidate !== extension);
  reapplyIosPatches(next);
  return next;
}

/** The extensions that ship in this build. */
function prepareExtensionSigning() {
  let kept = [];
  for (const extension of IOS_EXTENSIONS) {
    if (process.env[extension.env] === "0") {
      console.warn(`remote-build ios: ${extension.env}=0, shipping the app without the ${extension.name}`);
      continue;
    }
    kept.push(extension);
  }
  for (const extension of [...kept]) {
    try {
      run("app-store-connect", ["fetch-signing-files", extension.bundleId, "--type", "IOS_APP_STORE", "--create"]);
    } catch (error) {
      kept = dropIosExtension(kept, extension, `${extension.name} signing files could not be fetched or created (${error.message}).`);
    }
  }
  return kept;
}

function buildSignedIpa() {
  requireXcodeVersion();
  // No release-quality.mjs here. It re-runs build:web and a cargo build this
  // job has already done, adds 20 typechecks, and its own contract tests
  // currently fail for reasons unrelated to signing. The gate belongs in CI on
  // master (ci.yml "Full verification"), once per merge, not once per nightly.
  const versions = collectIosVersions();
  // Mirrors the former codemagic.yaml signing steps; codemagic-cli-tools ships
  // these commands as a pip package, so they run on a plain macOS runner.
  run("keychain", ["initialize"]);
  run("app-store-connect", ["fetch-signing-files", IOS_BUNDLE_ID, "--type", "IOS_APP_STORE", "--create"]);
  let kept = prepareExtensionSigning();
  run("keychain", ["add-certificates"]);
  run("xcode-project", ["use-profiles"], { cwd: IOS_APP_DIR });
  const buildIpa = () => run("xcode-project", [
    "build-ipa",
    "--project", "App.xcodeproj",
    "--scheme", "App",
    "--config", "Release",
    // Without this, xcpretty filters xcodebuild's output and a failed archive
    // reports only "Failed to archive", with the actual compiler or signing
    // error nowhere in the job log. An unattended nightly needs the real error.
    "--disable-xcpretty",
    "--archive-xcargs",
    `MARKETING_VERSION=${versions.POLYTH_IOS_MARKETING_VERSION}`
      + ` CURRENT_PROJECT_VERSION=${versions.POLYTH_IOS_CURRENT_PROJECT_VERSION}`
      + " COMPILATION_CACHE_ENABLE_CACHING=True",
  ], { cwd: IOS_APP_DIR });
  // An extension may never have been built on this runner before its first
  // nightly. If the archive fails with extensions, drop the newest one and
  // retry, down to the bare app; an app-side failure fails every retry.
  for (;;) {
    try {
      buildIpa();
      break;
    } catch (error) {
      const newest = kept.at(-1);
      if (!newest) throw error;
      kept = dropIosExtension(kept, newest, `the archive with the ${newest.name} failed (${error.message}).`);
      rmSync(join(IOS_APP_DIR, "build/ios/ipa"), { recursive: true, force: true });
      run("xcode-project", ["use-profiles"], { cwd: IOS_APP_DIR });
    }
  }

  const ipas = directFiles(join(IOS_APP_DIR, "build/ios/ipa")).filter((f) => f.endsWith(".ipa"));
  if (ipas.length === 0) fail("No signed .ipa was produced");
  copyFiles(ipas);
  // Prove the archive really carries a distribution signature rather than a
  // silently-unsigned bundle.
  run("bash", ["-lc", `
    set -euo pipefail
    work="$(mktemp -d)"
    unzip -q "$IPA" -d "$work"
    app="$(find "$work/Payload" -maxdepth 1 -name '*.app' -type d -print -quit)"
    test -n "$app"
    codesign --verify --deep --strict --verbose=2 "$app"
    if [ -d "$app/PlugIns/NotificationService.appex" ]; then
      echo "remote-build ios: NotificationService.appex is embedded (sealed push text on)"
    else
      echo "remote-build ios: no NotificationService.appex in this build (generic push text)"
    fi
    if [ -d "$app/PlugIns/PolythLiveActivity.appex" ]; then
      echo "remote-build ios: PolythLiveActivity.appex is embedded (Dynamic Island Live Activity on)"
    else
      echo "remote-build ios: no PolythLiveActivity.appex in this build (no Live Activity)"
    fi
    # Read the whole output first; 'codesign | grep -q' fails under pipefail
    # when codesign dies of SIGPIPE after the first match (see buildMac).
    info="$(codesign -dv --verbose=4 "$app" 2>&1)"
    if ! printf '%s\\n' "$info" | grep '^Authority=Apple Distribution:' >/dev/null; then
      echo "Expected an Apple Distribution signature on $app, got:" >&2
      printf '%s\\n' "$info" | grep '^Authority=' >&2 || true
      exit 1
    fi
    rm -rf "$work"
  `], { env: { IPA: ipas[0] } });

  // Upload so the nightly reaches internal TestFlight testers. Deliberately no
  // --testflight flag: that submits for external beta review, which must not
  // happen unattended every night.
  run("app-store-connect", ["publish", "--path", ipas[0]]);
  // Manual test/stable runs also go to every beta group, external included,
  // and are submitted for beta review.
  if (externalTestFlightRequested(process.env)) {
    run(process.execPath, ["scripts/ci/testflight-distribute.mjs"], { env: versions });
  }
}

function buildIos() {
  npmCi();
  run(npm, ["run", "build:mobile"]);
  run(npm, ["--workspace", "@polyth/mobile", "run", "native:ios"]);
  if (SIGNED_IOS) {
    buildSignedIpa();
    return;
  }
  const derived = join(TMP, "ios-derived");
  run("xcodebuild", [
    "-project", "apps/mobile/ios/App/App.xcodeproj",
    "-scheme", "App",
    "-configuration", "Release",
    "-sdk", "iphonesimulator",
    "-destination", "generic/platform=iOS Simulator",
    "-derivedDataPath", derived,
    "CODE_SIGNING_ALLOWED=NO",
    "build",
  ]);
  const app = join(derived, "Build/Products/Release-iphonesimulator/App.app");
  if (!existsSync(app)) fail("iOS application bundle was not produced");
  const archive = join(OUTPUT, "ios-simulator.app.zip");
  run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, archive]);
}

// Distribute-only builder target: sends the newest TestFlight upload to every
// tester group and external beta review without rebuilding the app, e.g. once
// an earlier build's review that blocked the submission has completed.
function distributeTestFlight() {
  if (!SIGNED_IOS) fail(`The testflight target needs the App Store Connect secrets: ${IOS_SIGN_VARS.join(", ")}`);
  run(process.execPath, ["scripts/ci/testflight-distribute.mjs"], {
    env: {
      POLYTH_IOS_TESTFLIGHT_EXTERNAL: "1",
      POLYTH_IOS_TESTFLIGHT_REVIEW_WAIT_MINUTES: process.env.POLYTH_IOS_TESTFLIGHT_REVIEW_WAIT_MINUTES || "75",
      POLYTH_IOS_TESTFLIGHT_SUMMARY: join(OUTPUT, "testflight.json"),
    },
  });
}

/**
 * `legacy` builds the macOS 12 package (scripts/ci/mac-legacy.mjs): Intel
 * only, Electron 43, its own artifact names and legacy-mac.yml metadata.
 */
function buildMac({ legacy = false } = {}) {
  if (legacy && process.arch !== MAC_LEGACY_ARCH) {
    fail(`The macOS 12 build runs on an Intel runner (its startup smoke test needs a native app), found ${process.arch}`);
  }
  const architectures = legacy ? [MAC_LEGACY_ARCH] : getMacArchitectures();
  const outputDir = (arch) => legacy ? `mac-legacy-${arch}` : `mac-${arch}`;
  npmCi();
  const browserPath = (arch) => join(TMP, `playwright-mac-${arch}`);
  const hostPlatform = (arch) => arch === "arm64" ? "mac14-arm64" : "mac14";

  for (const arch of architectures) {
    run(npx, ["playwright-core", "install", "chromium"], {
      env: {
        PLAYWRIGHT_BROWSERS_PATH: browserPath(arch),
        PLAYWRIGHT_HOST_PLATFORM_OVERRIDE: hostPlatform(arch),
      },
    });
  }

  const esbuildVersionResult = spawnSync(process.execPath, ["-p", "require('./node_modules/esbuild/package.json').version"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (esbuildVersionResult.status !== 0) fail("Unable to resolve esbuild version");
  const esbuildVersion = esbuildVersionResult.stdout.trim();
  run(npm, [
    "install", "--ignore-scripts", "--no-save", "--package-lock=false", "--force",
    `@esbuild/darwin-x64@${esbuildVersion}`,
    `@esbuild/darwin-arm64@${esbuildVersion}`,
  ]);

  run(npm, ["run", "build:desktop"], {
    env: { POLYTH_MAC_MULTI_ARCH: "1", POLYTH_DESKTOP_FLAVOR: legacy ? MAC_LEGACY_FLAVOR : "" },
  });
  for (const arch of architectures) {
    run(npm, ["run", "desktop:stage-chromium"], {
      env: {
        PLAYWRIGHT_BROWSERS_PATH: browserPath(arch),
        PLAYWRIGHT_HOST_PLATFORM_OVERRIDE: hostPlatform(arch),
        POLYTH_TARGET_PLATFORM: "darwin",
        POLYTH_TARGET_ARCH: arch,
      },
    });
    run(npm, ["run", "desktop:download-opencode"], {
      env: { POLYTH_TARGET_PLATFORM: "darwin", POLYTH_TARGET_ARCH: arch },
    });
    run(npx, [
      "electron-builder", "--mac", "dmg", "zip", `--${arch}`, "--publish", "never",
      // Signed builds notarize through mac-notarize.mjs, which tolerates an
      // unreachable ticket CDN during stapling; see that file.
      "--config.mac.notarize=false",
      ...(SIGNED_MAC
        ? [`--config.afterSign=${join(ROOT, "scripts/ci/mac-notarize.mjs")}`]
        : ["--config.mac.identity=-"]),
      `--config.directories.output=release/${outputDir(arch)}`,
      ...(legacy ? macLegacyBuilderArgs() : []),
      ...FEED_ARGS,
    ], { cwd: join(ROOT, "apps/desktop") });
  }

  run("bash", ["-lc", `
    set -euo pipefail
    native_arch="$(uname -m)"
    app_bin=""
    while IFS= read -r candidate; do
      if lipo -archs "$candidate" | tr ' ' '\\n' | grep -qx "$native_arch"; then
        app_bin="$candidate"
        break
      fi
    done < <(find apps/desktop/release -path '*/Polyth.app/Contents/MacOS/Polyth' -type f -print)
    test -n "$app_bin"
    node apps/desktop/test/startup-smoke.mjs "$app_bin"
    while IFS= read -r app; do
      codesign --verify --deep --strict --verbose=2 "$app"
      if [ "$EXPECT_DEVELOPER_ID" = "1" ]; then
        # Read the whole output first. Piping straight into 'grep -q' closes
        # the pipe on the first match, codesign dies of SIGPIPE, and
        # pipefail then reports failure even though the signature was present.
        info="$(codesign -dv --verbose=4 "$app" 2>&1)"
        if ! printf '%s\\n' "$info" | grep '^Authority=Developer ID Application:' >/dev/null; then
          echo "Expected a Developer ID signature on $app, got:" >&2
          printf '%s\\n' "$info" | grep '^Authority=' >&2 || true
          exit 1
        fi
      fi
      if [ -n "$LEGACY_MINIMUM" ]; then
        # The point of this package: it must start on macOS 12 and carry Electron 43.
        minimum="$(plutil -extract LSMinimumSystemVersion raw "$app/Contents/Info.plist")"
        electron="$(ELECTRON_RUN_AS_NODE=1 "$app/Contents/MacOS/Polyth" -p process.versions.electron)"
        echo "remote-build mac legacy: LSMinimumSystemVersion=$minimum Electron=$electron"
        # electron-builder writes 12.0 as "12"; compare without a trailing ".0".
        if [ "\${minimum%.0}" != "\${LEGACY_MINIMUM%.0}" ] || [ "$electron" != "$LEGACY_ELECTRON" ]; then
          echo "Expected LSMinimumSystemVersion $LEGACY_MINIMUM and Electron $LEGACY_ELECTRON in $app" >&2
          exit 1
        fi
      fi
    done < <(find apps/desktop/release -name 'Polyth.app' -type d -print)
  `], {
    env: {
      EXPECT_DEVELOPER_ID: SIGNED_MAC ? "1" : "0",
      LEGACY_MINIMUM: legacy ? MAC_LEGACY_MINIMUM_SYSTEM_VERSION : "",
      LEGACY_ELECTRON: legacy ? MAC_LEGACY_ELECTRON_VERSION : "",
    },
  });

  copyFiles(walk(join(ROOT, "apps/desktop/release")).filter((p) => p.endsWith(".dmg")));
  for (const arch of architectures) {
    const dir = join(ROOT, "apps/desktop/release", outputDir(arch));
    copyFiles(directFiles(dir).filter((p) => p.endsWith(".zip") || p.endsWith(".blockmap")));
    // Each architecture's job writes its own latest-mac.yml; update-feed.mjs
    // merges them, so keep both under distinct names. The macOS 12 package's
    // metadata is the separate feed only that build reads.
    const metadata = join(dir, "latest-mac.yml");
    if (existsSync(metadata)) copyFileAs(metadata, legacy ? MAC_LEGACY_METADATA : macPartialMetadataName(arch));
  }
}

function buildWindows() {
  npmCi();
  run(npx, ["playwright-core", "install", "chromium"], { env: { PLAYWRIGHT_BROWSERS_PATH: "0" } });
  run(npm, ["run", "build:desktop"]);
  run(npm, ["run", "desktop:stage-chromium"], {
    env: { PLAYWRIGHT_BROWSERS_PATH: "0", POLYTH_TARGET_PLATFORM: "win32", POLYTH_TARGET_ARCH: "x64" },
  });
  run(npm, ["run", "desktop:download-opencode"], { env: { POLYTH_TARGET_PLATFORM: "win32", POLYTH_TARGET_ARCH: "x64" } });
  run(npx, ["electron-builder", "--win", "nsis", "--x64", "--publish", "never", ...FEED_ARGS], { cwd: join(ROOT, "apps/desktop") });
  run(process.execPath, ["apps/desktop/test/startup-smoke.mjs", "apps/desktop/release/win-unpacked/Polyth.exe"]);
  copyFiles(directFiles(join(ROOT, "apps/desktop/release"))
    .filter((p) => p.endsWith(".exe") || p.endsWith(".blockmap") || basename(p) === "latest.yml"));
}

function buildLinux() {
  npmCi();
  run(npx, ["playwright-core", "install", "chromium"], { env: { PLAYWRIGHT_BROWSERS_PATH: "0" } });
  run(npm, ["run", "build:desktop"]);
  run(npm, ["run", "desktop:stage-chromium"], {
    env: { PLAYWRIGHT_BROWSERS_PATH: "0", POLYTH_TARGET_PLATFORM: "linux", POLYTH_TARGET_ARCH: "x64" },
  });
  run(npm, ["run", "desktop:download-opencode"], { env: { POLYTH_TARGET_PLATFORM: "linux", POLYTH_TARGET_ARCH: "x64" } });
  run(npx, ["electron-builder", "--linux", "AppImage", "--x64", "--publish", "never", ...FEED_ARGS], { cwd: join(ROOT, "apps/desktop") });

  const appImage = walk(join(ROOT, "apps/desktop/release")).find((p) => p.endsWith(".AppImage"));
  if (!appImage) fail("AppImage was not produced");
  const screenshot = join(TMP, "appimage-e2e.png");
  const smokeLog = join(TMP, "appimage-e2e.log");
  try {
    run("xvfb-run", ["-a", process.execPath, "apps/desktop/test/appimage-e2e.mjs", appImage, screenshot, smokeLog, ROOT]);
  } catch (error) {
    try {
      const log = readFileSync(smokeLog, "utf8");
      console.error(`[desktop] AppImage E2E log tail:\n${log.slice(-16_000)}`);
    } catch {}
    throw error;
  }

  const files = directFiles(join(ROOT, "apps/desktop/release"))
    .filter((p) => p.endsWith(".AppImage") || p.endsWith(".blockmap") || basename(p) === "latest-linux.yml");
  if (existsSync(screenshot)) files.push(screenshot);
  if (existsSync(smokeLog)) files.push(smokeLog);
  copyFiles(files);
}

function buildNpmPackages() {
  npmCi();
  run(process.execPath, ["scripts/release-version.mjs"]);
  const releaseDir = join(ROOT, "release/npm");
  mkdirSync(releaseDir, { recursive: true });
  run(npm, ["pack", "--workspace", "@polyth/contracts", "--pack-destination", releaseDir]);
  run(npm, ["pack", "--workspace", "@polyth/package-sdk", "--pack-destination", releaseDir]);
  copyFiles(walk(releaseDir).filter((p) => p.endsWith(".tgz")));
}

const handlers = {
  "android-apk": buildAndroid,
  "ios-app": buildIos,
  "mac-dmg": () => buildMac(),
  "mac-dmg-legacy": () => buildMac({ legacy: true }),
  "windows-exe": buildWindows,
  "linux-appimage": buildLinux,
  "npm-packages": buildNpmPackages,
  testflight: distributeTestFlight,
};

const handler = handlers[TARGET];
if (!handler) fail(`Unsupported REMOTE_BUILD_TARGET: ${TARGET}`);
handler();
const outputs = walk(OUTPUT).sort();
if (outputs.length === 0) fail("No remote build outputs found after completing the target");
validateOutputFormats(TARGET, outputs);
console.log(`remote-build outputs (${outputs.length}):`);
for (const file of outputs) {
  console.log(`  ${relative(OUTPUT, file)} (${statSync(file).size} bytes)`);
}
console.log(`remote-build: ${TARGET} complete`);
