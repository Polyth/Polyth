import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expandedCapabilities, type DeclaredCapability } from "../src/capabilities.ts";
import { parsePackageManifestJson, requiredAssets, assertEngineCompatible } from "../src/manifest.ts";

const valid = {
  manifestVersion: 1,
  id: "com-example-hello",
  version: "1.0.0",
  display: { name: "Hello", description: "A hello package" },
  runtime: { kind: "sandboxed", ui: { entry: "ui.js" } },
  contributes: { surfaces: [{ id: "main", title: "Hello" }] },
  capabilities: ["ui.toast", { name: "network.fetch", origins: ["https://api.example.com"] }],
};

test("manifest parsing accepts a headless package and rejects unsafe paths", () => {
  const headless = parsePackageManifestJson(JSON.stringify({
    manifestVersion: 1,
    id: "com-example-headless",
    version: "1.0.0",
    display: { name: "Headless", description: "No UI" },
    capabilities: ["storage.package"],
  }));
  assert.equal(headless.ok, true);
  if (headless.ok) assert.equal(headless.manifest.runtime, undefined);

  const parsed = parsePackageManifestJson(JSON.stringify(valid));
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.manifest.capabilities?.[1]?.constraints?.origins?.[0], "https://api.example.com");
    assert.deepEqual(requiredAssets(parsed.manifest), ["ui.js"]);
  }

  assert.equal(parsePackageManifestJson("{nope").ok, false);
  assert.equal(parsePackageManifestJson(JSON.stringify({ ...valid, manifestVersion: 99 })).ok, false);
  assert.equal(parsePackageManifestJson(JSON.stringify({ ...valid, version: "latest" })).ok, false);
  assert.equal(parsePackageManifestJson(JSON.stringify({ ...valid, id: "UPPER" })).ok, false);
  const unsafe = parsePackageManifestJson(JSON.stringify({
    ...valid,
    runtime: { kind: "sandboxed", ui: { entry: "../secret.js" } },
  }));
  assert.equal(unsafe.ok, false);
  for (const entry of ["/abs.js", "C:/x.js", "foo\\bar.js", "https://x/y.js"]) {
    const result = parsePackageManifestJson(JSON.stringify({
      ...valid,
      runtime: { kind: "sandboxed", ui: { entry } },
    }));
    assert.equal(result.ok, false, entry);
  }
  assert.equal(parsePackageManifestJson(JSON.stringify({
    ...valid,
    capabilities: [{ name: "network.fetch" }],
  })).ok, false);
});

test("connections require origins and must not name host env vars", () => {
  const token = parsePackageManifestJson(JSON.stringify({
    ...valid,
    connections: [{
      id: "demo",
      label: "Demo",
      kind: "token",
      origins: ["https://api.example.com"],
    }],
  }));
  assert.equal(token.ok, true);
  if (token.ok) assert.deepEqual(token.manifest.connections?.[0]?.origins, ["https://api.example.com"]);

  assert.equal(parsePackageManifestJson(JSON.stringify({
    ...valid,
    connections: [{ id: "demo", label: "Demo", kind: "token" }],
  })).ok, false);

  const oauth = parsePackageManifestJson(JSON.stringify({
    ...valid,
    connections: [{
      id: "jira",
      label: "Jira",
      kind: "oauth",
      origins: ["https://api.atlassian.com"],
      oauth: {
        authorizeUrl: "https://auth.atlassian.com/authorize",
        tokenUrl: "https://auth.atlassian.com/oauth/token",
        clientId: "public-client",
      },
    }],
  }));
  assert.equal(oauth.ok, true);
  if (oauth.ok) assert.equal(oauth.manifest.connections?.[0]?.oauth?.clientId, "public-client");

  assert.equal(parsePackageManifestJson(JSON.stringify({
    ...valid,
    connections: [{
      id: "jira",
      label: "Jira",
      kind: "oauth",
      origins: ["https://api.atlassian.com"],
      oauth: {
        authorizeUrl: "https://auth.atlassian.com/authorize",
        tokenUrl: "https://auth.atlassian.com/oauth/token",
        clientIdEnv: "POLYTH_UI_PASSWORD",
      },
    }],
  })).ok, false);

  assert.equal(parsePackageManifestJson(JSON.stringify({
    ...valid,
    connections: [{
      id: "jira",
      label: "Jira",
      kind: "oauth",
      origins: ["https://api.atlassian.com"],
      oauth: {
        authorizeUrl: "https://auth.atlassian.com/authorize",
        tokenUrl: "https://auth.atlassian.com/oauth/token",
        clientId: "public-client",
        clientSecretEnv: "POLYTH_UI_PASSWORD",
      },
    }],
  })).ok, false);
});

test("engine compatibility is explicit", () => {
  const parsed = parsePackageManifestJson(JSON.stringify({
    ...valid,
    engines: { polyth: ">=0.1.0" },
  }));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.doesNotThrow(() => assertEngineCompatible(parsed.manifest, "0.1.0"));
  assert.throws(() => assertEngineCompatible(parsed.manifest, "0.0.1"), /requires Polyth/);
});

test("capability expansion does not inherit new access", () => {
  const current: DeclaredCapability[] = [
    { name: "network.fetch", constraints: { origins: ["https://api.example.com"] } },
    { name: "ui.toast" },
  ];
  const same = expandedCapabilities(current, current);
  assert.deepEqual(same, []);
  const extra = expandedCapabilities(current, [
    ...current,
    { name: "session.read" },
  ]);
  assert.deepEqual(extra.map((item) => item.name), ["session.read"]);
  const broaderOrigin = expandedCapabilities(current, [
    { name: "network.fetch", constraints: { origins: ["https://api.example.com", "https://other.example"] } },
  ]);
  assert.deepEqual(broaderOrigin[0]?.constraints?.origins, ["https://other.example"]);
});

test("reference packages parse as sandboxed v1 manifests", () => {
  for (const name of ["hello-package", "api-package", "tracker-package"]) {
    const raw = readFileSync(join(import.meta.dirname, `../../../examples/${name}/polyth-package.json`), "utf8");
    const parsed = parsePackageManifestJson(raw);
    assert.equal(parsed.ok, true, name);
    if (!parsed.ok) continue;
    assert.equal(parsed.manifest.runtime?.kind, "sandboxed");
    for (const asset of requiredAssets(parsed.manifest)) {
      assert.ok(asset.endsWith(".ts"));
    }
  }
});

test("v1 rejects custom sandbox UI, widgets, settings pages, and unsafe icons", () => {
  assert.equal(parsePackageManifestJson(JSON.stringify({
    ...valid,
    runtime: { kind: "sandboxed", ui: { mode: "custom", entry: "ui.js" } },
  })).ok, false);
  assert.equal(parsePackageManifestJson(JSON.stringify({
    ...valid,
    contributes: {
      surfaces: [{ id: "main", title: "Hello" }],
      widgets: [{
        id: "w",
        module: "m",
        title: "W",
        description: "W",
        kind: "widget",
        defaultSlot: "workspace.main",
        supportedSlots: ["workspace.main"],
      }],
    },
  })).ok, false);
  assert.equal(parsePackageManifestJson(JSON.stringify({
    ...valid,
    contributes: { surfaces: [{ id: "main", title: "Hello" }], settings: { hasPage: true } },
  })).ok, false);
  assert.equal(parsePackageManifestJson(JSON.stringify({
    ...valid,
    display: { ...valid.display, icon: "https://evil.example/x.png" },
  })).ok, false);
  assert.equal(parsePackageManifestJson(JSON.stringify({
    ...valid,
    display: { ...valid.display, icon: "<img src=x>" },
  })).ok, false);
});
