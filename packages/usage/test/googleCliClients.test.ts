import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { clientFromSource, findInstalledGoogleClient } from "../src/providers/googleCliClients.ts";

const ID = "123-fake.apps.googleusercontent.com";
const SECRET = "fake-client-secret";

test("reads the client a CLI assigns to its named constants and ignores other Google clients", () => {
  const bundle = [
    `var CLOUD_SDK_CLIENT_ID = "999-other.apps.googleusercontent.com";`,
    `var OAUTH_CLIENT_ID = "${ID}";`,
    `var OAUTH_CLIENT_SECRET = "${SECRET}";`,
  ].join("\n");
  assert.deepEqual(clientFromSource(bundle, "gemini"), { id: ID, secret: SECRET });
  assert.deepEqual(clientFromSource(`const GEMINI_CLIENT_ID = '${ID}';\nconst GEMINI_CLIENT_SECRET = '${SECRET}';`, "gemini"), { id: ID, secret: SECRET });
  assert.deepEqual(
    clientFromSource(`export const ANTIGRAVITY_CLIENT_ID = "${ID}";\nexport const ANTIGRAVITY_CLIENT_SECRET = "${SECRET}";`, "antigravity"),
    { id: ID, secret: SECRET },
  );
  assert.equal(clientFromSource(bundle, "antigravity"), null);
  assert.equal(clientFromSource(`var OAUTH_CLIENT_ID = "${ID}";`, "gemini"), null, "an id without its secret is no client");
  assert.equal(clientFromSource(`var OAUTH_CLIENT_ID = "not-google";\nvar OAUTH_CLIENT_SECRET = "${SECRET}";`, "gemini"), null);
});

test("finds Gemini CLI through the gemini launcher on PATH and plugins in OpenCode's cache", () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-google-cli-"));
  try {
    const pkg = join(root, "prefix", "lib", "node_modules", "@google", "gemini-cli");
    mkdirSync(join(pkg, "bundle"), { recursive: true });
    writeFileSync(join(pkg, "bundle", "gemini.js"), "import './chunk-A.js';\n");
    writeFileSync(join(pkg, "bundle", "chunk-A.js"), `var OAUTH_CLIENT_ID = "${ID}";\nvar OAUTH_CLIENT_SECRET = "${SECRET}";\n`);
    const bin = join(root, "prefix", "bin");
    mkdirSync(bin, { recursive: true });
    symlinkSync(join(pkg, "bundle", "gemini.js"), join(bin, "gemini"));
    const home = join(root, "home");
    const plugin = join(home, ".cache", "opencode", "node_modules", "opencode-antigravity-auth", "dist", "src");
    mkdirSync(plugin, { recursive: true });
    writeFileSync(join(plugin, "constants.js"), `export const ANTIGRAVITY_CLIENT_ID = "456-agy.apps.googleusercontent.com";\nexport const ANTIGRAVITY_CLIENT_SECRET = "agy-plugin-secret";\n`);

    const search = { env: { PATH: bin }, home, platform: "linux" as const };
    assert.deepEqual(findInstalledGoogleClient("gemini", search), { id: ID, secret: SECRET });
    assert.deepEqual(findInstalledGoogleClient("antigravity", search), { id: "456-agy.apps.googleusercontent.com", secret: "agy-plugin-secret" });
    assert.equal(findInstalledGoogleClient("antigravity", { env: { PATH: bin }, home: join(root, "empty"), platform: "linux" }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
