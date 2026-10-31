import assert from "node:assert/strict";
import { test } from "node:test";
import { vendorScriptInstallCommand } from "@polyth/harness-runtime/installers";
import { createOmpProfile, OMP_INSTALLER } from "../src/serverEntry.ts";

test("OMP installs on Linux, macOS and Windows with its per-user scripts", () => {
  assert.equal(vendorScriptInstallCommand(OMP_INSTALLER, "linux"), "curl -fsSL https://omp.sh/install | sh");
  assert.equal(vendorScriptInstallCommand(OMP_INSTALLER, "darwin"), "curl -fsSL https://omp.sh/install | sh");
  assert.match(vendorScriptInstallCommand(OMP_INSTALLER, "win32") ?? "", /^powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ".*irm 'https:\/\/omp\.sh\/install\.ps1' \| iex"$/);
});

test("the descriptor offers this platform's installer and the POSIX one on SSH hosts", () => {
  const { descriptor } = createOmpProfile();
  assert.equal(descriptor.installCommand, vendorScriptInstallCommand(OMP_INSTALLER, process.platform));
  assert.equal(descriptor.remoteHost?.installCommand, "curl -fsSL https://omp.sh/install | sh");
});
