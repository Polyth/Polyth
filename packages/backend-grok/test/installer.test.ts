import assert from "node:assert/strict";
import { test } from "node:test";
import { vendorScriptInstallCommand } from "@polyth/harness-runtime/installers";
import { createGrokProfile, GROK_INSTALLER } from "../src/serverEntry.ts";

test("Grok installs on Linux, macOS and Windows with xAI's per-user scripts", () => {
  assert.equal(vendorScriptInstallCommand(GROK_INSTALLER, "linux"), "curl -fsSL https://x.ai/cli/install.sh | bash");
  assert.equal(vendorScriptInstallCommand(GROK_INSTALLER, "darwin"), "curl -fsSL https://x.ai/cli/install.sh | bash");
  assert.match(vendorScriptInstallCommand(GROK_INSTALLER, "win32") ?? "", /^powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ".*irm 'https:\/\/x\.ai\/cli\/install\.ps1' \| iex"$/);
});

test("the descriptor offers this platform's installer and the POSIX one on SSH hosts", () => {
  const { descriptor } = createGrokProfile();
  assert.equal(descriptor.installCommand, vendorScriptInstallCommand(GROK_INSTALLER, process.platform));
  assert.equal(descriptor.remoteHost?.installCommand, "curl -fsSL https://x.ai/cli/install.sh | bash");
});
