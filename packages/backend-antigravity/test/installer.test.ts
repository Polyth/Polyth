import assert from "node:assert/strict";
import { test } from "node:test";
import type { ServerPackageHost } from "@polyth/plugins";
import { createHarnessRegistry } from "@polyth/harness-runtime";
import { vendorScriptInstallCommand } from "@polyth/harness-runtime/installers";
import registerPackage, { ANTIGRAVITY_INSTALLER, antigravityReleaseSource } from "../src/serverEntry.ts";

test("Antigravity installs on Linux, macOS and Windows with Google's per-user scripts", () => {
  assert.equal(vendorScriptInstallCommand(ANTIGRAVITY_INSTALLER, "linux"), "curl -fsSL https://antigravity.google/cli/install.sh | bash");
  assert.equal(vendorScriptInstallCommand(ANTIGRAVITY_INSTALLER, "darwin"), "curl -fsSL https://antigravity.google/cli/install.sh | bash");
  const windows = vendorScriptInstallCommand(ANTIGRAVITY_INSTALLER, "win32");
  assert.match(windows ?? "", /^powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ".*irm 'https:\/\/antigravity\.google\/cli\/install\.ps1' \| iex"$/);
});

test("the descriptor offers this platform's installer and a release source, still local-only", async () => {
  const registry = createHarnessRegistry();
  const host = { services: { require: () => registry } } as unknown as ServerPackageHost;
  const pkg = registerPackage(host);
  pkg.onEnable();
  try {
    const descriptor = registry.get("antigravity")?.descriptor;
    assert.equal(descriptor?.installCommand, vendorScriptInstallCommand(ANTIGRAVITY_INSTALLER, process.platform));
    assert.deepEqual(descriptor?.releaseSource, antigravityReleaseSource(process.platform, process.arch));
    assert.deepEqual(descriptor?.updateCommand, ["agy", "update"]);
    assert.equal(descriptor?.remoteHost, undefined);
  } finally {
    await pkg.onDisable();
  }
});

test("the release source reads the manifest of this machine's build", () => {
  const manifest = (platform: NodeJS.Platform, arch: string) => {
    const source = antigravityReleaseSource(platform, arch);
    const url = source.kind === "page" ? source.url : "";
    const prefix = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/";
    assert.ok(url.startsWith(prefix), url);
    return url.slice(prefix.length);
  };
  assert.equal(manifest("linux", "x64"), "linux_amd64.json");
  assert.equal(manifest("linux", "arm64"), "linux_arm64.json");
  assert.equal(manifest("darwin", "arm64"), "darwin_arm64.json");
  assert.equal(manifest("darwin", "x64"), "darwin_amd64.json");
  assert.equal(manifest("win32", "x64"), "windows_amd64.json");
  assert.equal(manifest("win32", "arm64"), "windows_arm64.json");
  assert.equal(manifest("freebsd", "x64"), "linux_amd64.json");
});

test("the release pattern takes the version from the manifest JSON", () => {
  const source = antigravityReleaseSource("linux", "x64");
  assert.equal(source.kind, "page");
  if (source.kind !== "page") return;
  // Applied the way the update checker applies it: first capture group.
  const version = (body: string) => new RegExp(source.pattern).exec(body)?.[1];
  // The shape served on 2026-10-25 (linux_amd64.json).
  assert.equal(version(`{
  "version": "1.4.7",
  "url": "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.4.7-5900205422411776/linux-x64/cli_linux_x64.tar.gz",
  "sha512": "beda760587589f5827b0b516c3ec2c5bd5cd2e91eb0e2533807ba1e990a27dcd63aef0191e0b76fb60feab0d16eaa8210fb79842c34dd4809e257e1712edd152"
}`), "1.4.7");
  assert.equal(version("{\"url\":\"https://x/1.9.0-1/cli.tar.gz\",\"version\":\"1.10.2\"}"), "1.10.2");
  assert.equal(version("{\"version\":\"2.0.0-beta.1\"}"), "2.0.0-beta.1");
  assert.equal(version("{\"url\":\"https://x/1.4.7-5900205422411776/cli\"}"), undefined, "never a version from the download URL");
});
