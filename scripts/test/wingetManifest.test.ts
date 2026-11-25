import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  WINGET_IDENTIFIER,
  WINGET_MANIFEST_VERSION,
  wingetManifests,
  windowsInstallers,
} from "../ci/winget-manifest.mjs";
import { channelOfVersion } from "../ci/update-feed.mjs";

const VERSION = "1.2.357";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex").toUpperCase();

/** A release's asset directory with the Windows installers a build produces. */
const assets = ({ version = VERSION, architectures = ["x64"], workstation = false } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-winget-"));
  for (const architecture of architectures) {
    const name = `Polyth-${version}-win-${architecture}.exe`;
    writeFileSync(join(dir, name), `installer ${architecture}`);
  }
  if (workstation) writeFileSync(join(dir, `Polyth-${version}-win-x64-workstation.exe`), "workstation");
  writeFileSync(join(dir, `Polyth-${version}-linux-x86_64.AppImage`), "appimage");
  writeFileSync(join(dir, "latest.yml"), "version: 1.2.357\n");
  return dir;
};

test("the installer manifest names every Windows installer of the release", () => {
  const dir = assets({ architectures: ["x64", "arm64"], workstation: true });
  const installers = windowsInstallers(dir, VERSION);
  assert.deepEqual(installers.map((installer) => installer.architecture), ["x64", "arm64"]);
  const [version, installer, locale] = wingetManifests({ version: VERSION, releaseDate: "2026-11-23", installers });

  assert.equal(version.name, `${WINGET_IDENTIFIER}.yaml`);
  assert.equal(installer.name, `${WINGET_IDENTIFIER}.installer.yaml`);
  assert.equal(locale.name, `${WINGET_IDENTIFIER}.locale.en-US.yaml`);

  for (const [file, manifest] of [[`Polyth-${VERSION}-win-x64.exe`, installers[0]], [`Polyth-${VERSION}-win-arm64.exe`, installers[1]]]) {
    const url = `https://github.com/Polyth/Polyth/releases/download/v${VERSION}/${file}`;
    assert.ok(installer.text.includes(`InstallerUrl: ${url}`), `${file} has its release URL`);
    assert.ok(installer.text.includes(`InstallerSha256: ${sha256(`installer ${manifest.architecture}`)}`), `${file} has the digest of its bytes`);
    assert.match(installer.text, /^ {2}InstallerSha256: [0-9A-F]{64}$/m);
  }
  // The workstation edition is a different product: it never reaches this manifest.
  assert.ok(!installer.text.includes("workstation"));
  assert.equal(installer.text.match(/^- Architecture:/gm)?.length, 2);
  assert.match(installer.text, /^InstallerType: nullsoft$/m);
  assert.match(installer.text, /^Scope: user$/m);
  assert.match(installer.text, /^ReleaseDate: "2026-11-23"$/m);
  assert.match(installer.text, new RegExp(`^ManifestVersion: ${WINGET_MANIFEST_VERSION.replaceAll(".", "\\.")}$`, "m"));
  assert.match(locale.text, /^ManifestType: defaultLocale$/m);
  assert.match(version.text, /^ManifestType: version$/m);
  // Both the ReleaseNotesUrl and the package identity follow the same repository and version.
  assert.ok(locale.text.includes(`https://github.com/Polyth/Polyth/releases/tag/v${VERSION}`));
  assert.match(locale.text, /^License: Apache-2\.0$/m);
});

test("only stable releases become manifests, and only from a real installer", () => {
  for (const version of ["1.2.357-nightly", "1.2.357-rc.1"]) {
    assert.notEqual(channelOfVersion(version), "stable");
    assert.throws(() => windowsInstallers(assets({ version }), version), /stable releases only/);
  }
  const installers = windowsInstallers(assets(), VERSION);
  assert.throws(
    () => wingetManifests({ version: "1.2.357-nightly", releaseDate: "2026-11-23", installers }),
    /stable releases only/,
  );
  assert.throws(() => wingetManifests({ version: VERSION, releaseDate: "23.11.2026", installers }), /YYYY-MM-DD/);
  assert.throws(() => wingetManifests({ version: VERSION, releaseDate: "2026-02-31", installers }), /real calendar day/);
  assert.throws(() => wingetManifests({ version: VERSION, releaseDate: "2026-11-23", installers: [] }), /No Windows installer/);
  assert.throws(
    () => wingetManifests({ version: VERSION, releaseDate: "2026-11-23", installers: [installers[0], installers[0]] }),
    /more than one installer/,
  );
  assert.throws(
    () => wingetManifests({ version: VERSION, releaseDate: "2026-11-23", installers: [{ ...installers[0], sha256: "abc" }] }),
    /uppercase hex/,
  );
  // A release without a Windows installer is nothing to describe, not an empty manifest.
  const withoutWindows = mkdtempSync(join(tmpdir(), "polyth-winget-"));
  writeFileSync(join(withoutWindows, `Polyth-${VERSION}-linux-x86_64.AppImage`), "appimage");
  assert.deepEqual(windowsInstallers(withoutWindows, VERSION), []);
  // An unknown arch token must fail loudly instead of guessing an Architecture.
  const unknown = mkdtempSync(join(tmpdir(), "polyth-winget-"));
  writeFileSync(join(unknown, `Polyth-${VERSION}-win-mips.exe`), "exe");
  assert.throws(() => windowsInstallers(unknown, VERSION), /No winget Architecture for "mips"/);
});

test("the command writes the three files winget expects into <outDir>/manifests", () => {
  const dir = assets({ architectures: ["x64", "arm64"] });
  const out = mkdtempSync(join(tmpdir(), "polyth-winget-out-"));
  const script = new URL("../ci/winget-manifest.mjs", import.meta.url).pathname;
  const stdout = execFileSync(process.execPath, [script, VERSION, "2026-11-23", dir, out], { encoding: "utf8" });
  assert.match(stdout, new RegExp(`winget: ${WINGET_IDENTIFIER} ${VERSION.replaceAll(".", "\\.")} \\(x64, arm64\\)`));

  const written = ["Polyth.Polyth.yaml", "Polyth.Polyth.installer.yaml", "Polyth.Polyth.locale.en-US.yaml"];
  for (const name of written) {
    const text = readFileSync(join(out, "manifests", name), "utf8");
    assert.match(text, new RegExp(`^PackageVersion: ${VERSION.replaceAll(".", "\\.")}$`, "m"), `${name} declares the version`);
    assert.match(text, /^# Generated by scripts\/ci\/winget-manifest\.mjs/m);
  }
  // A second run over a directory without a Windows installer fails instead of writing nothing.
  const empty = mkdtempSync(join(tmpdir(), "polyth-winget-empty-"));
  assert.throws(
    () => execFileSync(process.execPath, [script, VERSION, "2026-11-23", empty, out], { encoding: "utf8", stdio: "pipe" }),
    /No Polyth-1\.2\.357-win-/,
  );
  // --if-present is what a release job uses: no regular installer is a warning, not a failed release.
  const quiet = execFileSync(process.execPath, [script, "--if-present", VERSION, "2026-11-23", empty, join(out, "optional")], { encoding: "utf8" });
  assert.match(quiet, /::warning::Release 1\.2\.357 carries no regular Windows installer/);
  assert.equal(existsSync(join(out, "optional", "manifests")), false);
});
