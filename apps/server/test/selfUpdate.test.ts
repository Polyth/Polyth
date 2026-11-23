import test from "node:test";
import assert from "node:assert/strict";
import { homebrewPrefix, npmChannelSpec, npmInstallArgs, restartingService, selfUpdater } from "../src/selfUpdate.ts";

test("a systemd service counts only when this process is in Polyth's own unit", () => {
  const unit = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/polyth.service\n";
  assert.equal(restartingService({ env: { INVOCATION_ID: "x" }, platform: "linux", cgroup: unit }), "polyth.service");
  assert.equal(restartingService({
    env: { INVOCATION_ID: "x" },
    platform: "linux",
    cgroup: "0::/user.slice/user-1000.slice/user@1000.service/app.slice/homebrew.polyth.service\n",
  }), "homebrew.polyth.service");
  // A shell in a terminal that systemd runs as a service inherits INVOCATION_ID.
  assert.equal(restartingService({
    env: { INVOCATION_ID: "x" },
    platform: "linux",
    cgroup: "0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-gnome-terminal.scope\n",
  }), null);
  assert.equal(restartingService({ env: {}, platform: "linux", cgroup: unit }), null);
});

test("launchd: Polyth's service and brew services, not a terminal", () => {
  assert.equal(restartingService({ env: { XPC_SERVICE_NAME: "homebrew.mxcl.polyth" }, platform: "darwin" }), "homebrew.mxcl.polyth");
  assert.equal(restartingService({ env: { XPC_SERVICE_NAME: "app.polyth.server" }, platform: "darwin" }), "app.polyth.server");
  assert.equal(restartingService({ env: { XPC_SERVICE_NAME: "0" }, platform: "darwin" }), null);
  assert.equal(restartingService({ env: { POLYTH_SUPERVISED: "1" }, platform: "darwin" }), "POLYTH_SUPERVISED");
});

test("Homebrew prefix from the keg the server runs from", () => {
  assert.equal(homebrewPrefix("/opt/homebrew/Cellar/polyth/1.2.10/libexec"), "/opt/homebrew");
  assert.equal(homebrewPrefix("/home/linuxbrew/.linuxbrew/Cellar/polyth/1.2.10/libexec"), "/home/linuxbrew/.linuxbrew");
  assert.equal(homebrewPrefix("/usr/lib/node_modules/polyth"), null);
});

test("npm installs in place: globally or into the install's prefix", () => {
  assert.deepEqual(npmInstallArgs({ global: true, prefix: "/usr/lib" }, "1.2.11"),
    ["install", "--global", "polyth@1.2.11", "--no-audit", "--no-fund"]);
  assert.deepEqual(npmInstallArgs({ global: false, prefix: "/srv/polyth" }, "1.2.11"),
    ["install", "--prefix", "/srv/polyth", "polyth@1.2.11", "--no-audit", "--no-fund"]);
  assert.equal(npmChannelSpec("1.2.10"), "polyth@latest");
  assert.equal(npmChannelSpec("1.2.10-nightly"), "polyth@nightly");
});

test("installs other than npm and Homebrew offer no updater", () => {
  assert.equal(selfUpdater({ kind: "docker" }).updater, undefined);
  assert.match(selfUpdater({ kind: "archive", root: "/opt/polyth" }).unavailable ?? "", /polyth update/);
  assert.equal(selfUpdater({ kind: "checkout", root: "/src" }).updater, undefined);
  assert.equal(selfUpdater({ kind: "homebrew", root: "/opt/homebrew/Cellar/polyth/1.2.10/libexec" }).updater?.kind, "homebrew");
});
