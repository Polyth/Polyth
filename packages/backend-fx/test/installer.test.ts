import assert from "node:assert/strict";
import { test } from "node:test";
import type { AcpProfile } from "@polyth/backend-acp";
import type { ServerPackageHost } from "@polyth/plugins";
import registerPackage, { FX_INSTALL_COMMAND, FX_RELEASE_SOURCE, fxInstallCommand } from "../src/serverEntry.ts";

test("fx installs on Linux and macOS with its per-user script, and not on Windows", () => {
  assert.equal(fxInstallCommand("linux"), "curl -fsSL https://fx.sh/setup.sh | bash");
  assert.equal(fxInstallCommand("darwin"), "curl -fsSL https://fx.sh/setup.sh | bash");
  assert.equal(fxInstallCommand("win32"), undefined);
});

test("the descriptor installs, updates and checks releases, and installs on SSH hosts", async () => {
  let descriptor: AcpProfile["descriptor"] | undefined;
  const registry = { register: (provider: { descriptor: AcpProfile["descriptor"] }) => {
    descriptor = provider.descriptor;
    return { dispose: async () => undefined };
  } };
  const host = { services: { require: () => registry } } as unknown as ServerPackageHost;
  const pkg = registerPackage(host);
  pkg.onEnable();
  try {
    assert.equal(descriptor?.installCommand, fxInstallCommand(process.platform));
    assert.deepEqual(descriptor?.updateCommand, ["fx", "upgrade"]);
    assert.deepEqual(descriptor?.releaseSource, FX_RELEASE_SOURCE);
    assert.equal(descriptor?.remoteHost?.installCommand, FX_INSTALL_COMMAND);
  } finally {
    await pkg.onDisable();
  }
});

test("the release pattern reads releases.fx.sh/latest.txt", () => {
  // Applied the way the update checker applies it: first capture group.
  const version = (body: string) => new RegExp(FX_RELEASE_SOURCE.pattern).exec(body)?.[1];
  assert.equal(version("v0.0.14"), "0.0.14", "the body served on 2026-10-25, no newline");
  assert.equal(version("v0.1.0\n"), "0.1.0");
  assert.equal(version("1.2.3"), "1.2.3");
  assert.equal(version("v1.0.0-rc.1"), "1.0.0-rc.1");
  assert.equal(version("<html>v0.0.14</html>"), undefined, "an error page is not a version");
});
