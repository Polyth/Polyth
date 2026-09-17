import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { openControlPlane } from "@polyth/control-plane";
import {
  createCanonicalProviderNetwork,
  createCanonicalProviderSecrets,
} from "../src/providerHost.ts";

test("provider secrets use opaque references and remain outside public metadata", async t => {
  const directory = mkdtempSync(join(tmpdir(), "polyth-provider-secrets-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const secrets = createCanonicalProviderSecrets(directory);
  const reference = await secrets.put("identity-provider:github", "super-secret-value");
  assert.match(reference, /^provider\.[a-f0-9-]{36}$/);
  assert.equal(reference.includes("super-secret-value"), false);
  assert.equal(await secrets.get(reference), "super-secret-value");

  const metadata = readFileSync(join(directory, "identity-provider-secrets", "secure-safe.json"), "utf8");
  assert.equal(metadata.includes("super-secret-value"), false);
  await secrets.delete(reference);
  await assert.rejects(secrets.get(reference), { code: "unavailable" });
});

test("provider network rejects host escape and loopback before opening a socket", async t => {
  const directory = mkdtempSync(join(tmpdir(), "polyth-provider-network-"));
  const control = openControlPlane({ directory });
  t.after(() => {
    control.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const network = createCanonicalProviderNetwork(control);

  await assert.rejects(
    network.request("github", "https://github.com", { url: "https://attacker.invalid/token" }),
    { code: "forbidden" },
  );
  await assert.rejects(
    network.request("gitlab", "https://127.0.0.1", { url: "https://127.0.0.1/oauth/token" }),
    { code: "forbidden" },
  );
});
