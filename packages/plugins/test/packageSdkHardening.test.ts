import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packDirectory } from "@polyth/package-sdk/manifest";
import { createPluginRegistry } from "../src/managedRegistry.ts";
import { connectionAuthorization, setTokenConnection } from "../src/connections.ts";
import { createOauthTx, consumeOauthTx } from "../src/oauthTx.ts";
import { writeSpaceEnabled } from "../src/spaceEnabled.ts";
import { grantCapabilities } from "../src/grants.ts";
import { memoryOpaqueVault, testSpaceStorage } from "./helpers.ts";

function writeSandbox(dir: string, over: {
  id?: string;
  version?: string;
  capabilities?: unknown;
  runtimeKind?: "sandboxed" | "trusted-local";
  connections?: unknown;
}): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "polyth-package.json"), JSON.stringify({
    manifestVersion: 1,
    id: over.id ?? "com-example-demo",
    version: over.version ?? "1.0.0",
    display: { name: "Demo", description: "Sandbox demo" },
    runtime: { kind: over.runtimeKind ?? "sandboxed", ui: { entry: "ui.ts" } },
    contributes: { surfaces: [{ id: "main", title: "Demo" }] },
    capabilities: over.capabilities ?? ["ui.render"],
    ...(over.connections ? { connections: over.connections } : {}),
  }));
  writeFileSync(
    join(dir, "ui.ts"),
    over.runtimeKind === "trusted-local"
      ? "export const modules = {};\n"
      : 'import { connectPolyth } from "@polyth/package-sdk";\nawait connectPolyth();\n',
  );
}

const tokenSpec = {
  id: "jira",
  label: "Jira",
  kind: "token" as const,
  origins: ["https://api.example.com"],
};

const oauthSpec = {
  id: "jira",
  label: "Jira",
  kind: "oauth" as const,
  origins: ["https://api.example.com"],
  oauth: {
    authorizeUrl: "https://auth.example/authorize",
    tokenUrl: "https://auth.example/token",
    clientId: "public",
    scopes: ["read"],
  },
};

test("candidate capabilities never leak into active requested or effective grants", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-cap-leak-"));
  const trusted = join(root, "trusted");
  const pkg = join(trusted, "demo");
  writeSandbox(pkg, { version: "1.0.0", capabilities: ["ui.render"] });
  const storageA = testSpaceStorage(join(root, "space-a"));
  const storageB = testSpaceStorage(join(root, "space-b"));
  const reg = createPluginRegistry({
    dir: join(root, "installed"),
    trustedDir: trusted,
    packageSpaces: () => [
      { spaceId: "spc_a", storage: storageA },
      { spaceId: "spc_b", storage: storageB },
    ],
  });
  await reg.install("file:demo");
  await reg.grant("com-example-demo", ["ui.render"], storageA);
  await reg.enable("com-example-demo", storageA);
  await reg.grant("com-example-demo", ["ui.render"], storageB);
  await reg.enable("com-example-demo", storageB);
  writeSandbox(pkg, { version: "1.1.0", capabilities: ["ui.render", "clipboard.write"] });
  const pending = await reg.update("com-example-demo", { storage: storageA });
  assert.equal(pending.version, "1.0.0");
  await reg.grant("com-example-demo", ["ui.render", "clipboard.write"], storageB);

  const spaceB = reg.detail("com-example-demo", storageB);
  assert.equal(spaceB.version, "1.0.0");
  assert.equal(spaceB.permissions.requested.some((item) => item.name === "clipboard.write"), false);
  assert.equal(spaceB.permissions.effective.includes("clipboard.write"), false);
  assert.equal(spaceB.permissions.review, undefined);

  const spaceA = reg.detail("com-example-demo", storageA);
  assert.ok(spaceA.permissions.review?.capabilities.some((item) => item.name === "clipboard.write"));
  assert.equal(spaceA.permissions.requested.some((item) => item.name === "clipboard.write"), false);

  await reg.grant("com-example-demo", ["ui.render", "clipboard.write"], storageA);
  const activated = reg.detail("com-example-demo", storageB);
  assert.equal(activated.version, "1.1.0");
  assert.equal(activated.permissions.requested.some((item) => item.name === "clipboard.write"), true);
  assert.equal(activated.permissions.effective.includes("clipboard.write"), true);
  await reg.dispose();
});

test("remote zip cannot self-elevate to trusted-local; trusted file: may", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-trust-"));
  const trusted = join(root, "trusted");
  const remote = join(root, "remote");
  writeSandbox(remote, { runtimeKind: "trusted-local", version: "1.0.0" });
  const zip = join(root, "remote.zip");
  writeFileSync(zip, await packDirectory(remote));
  const storage = testSpaceStorage(join(root, "space"));
  const reg = createPluginRegistry({
    dir: join(root, "installed"),
    trustedDir: trusted,
    packageSpaces: () => [{ spaceId: "spc_a", storage }],
  });
  await assert.rejects(() => reg.install(zip), /trusted-local runtime requires a trusted local source/);

  const local = join(trusted, "demo");
  writeSandbox(local, { runtimeKind: "trusted-local", version: "1.0.0" });
  const installed = await reg.install("file:demo");
  assert.equal(installed.runtimeKind, "trusted-local");

  const sandboxed = join(root, "sandboxed");
  mkdirSync(sandboxed, { recursive: true });
  writeFileSync(join(sandboxed, "polyth-package.json"), JSON.stringify({
    manifestVersion: 1,
    id: "com-example-sand",
    version: "1.0.0",
    display: { name: "Sand", description: "Remote sandbox" },
    runtime: { kind: "sandboxed", ui: { entry: "ui.ts" } },
    contributes: { surfaces: [{ id: "main", title: "Sand" }] },
    capabilities: ["ui.render"],
  }));
  writeFileSync(join(sandboxed, "ui.ts"), "void 0;\n");
  const sandZip = join(root, "sand.zip");
  writeFileSync(sandZip, await packDirectory(sandboxed));
  const ok = await reg.install(sandZip);
  assert.equal(ok.id, "com-example-sand");
  assert.equal(ok.runtimeKind, "sandboxed");
  await reg.dispose();
});

test("missing active pointer does not promote a staged candidate", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-active-ptr-"));
  const trusted = join(root, "trusted");
  const pkg = join(trusted, "demo");
  writeSandbox(pkg, { version: "1.0.0", capabilities: ["ui.render"] });
  const storage = testSpaceStorage(join(root, "space"));
  const opts = {
    dir: join(root, "installed"),
    trustedDir: trusted,
    packageSpaces: () => [{ spaceId: "spc_a", storage }],
  };
  let reg = createPluginRegistry(opts);
  await reg.install("file:demo");
  await reg.grant("com-example-demo", ["ui.render"], storage);
  await reg.enable("com-example-demo", storage);
  writeSandbox(pkg, { version: "1.1.0", capabilities: ["ui.render", "clipboard.write"] });
  const pending = await reg.update("com-example-demo", { storage });
  assert.equal(pending.version, "1.0.0");
  assert.equal(pending.update?.version, "1.1.0");
  unlinkSync(join(root, "installed", "com-example-demo", "active"));
  await reg.dispose();
  reg = createPluginRegistry(opts);
  const row = reg.list(storage)[0]!;
  assert.equal(row.status, "error");
  assert.notEqual(row.version, "1.1.0");
  assert.match(row.lastError ?? "", /active version pointer/);
  await reg.dispose();
});

test("disabled Space does not block global activation", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-disabled-block-"));
  const trusted = join(root, "trusted");
  const pkg = join(trusted, "demo");
  writeSandbox(pkg, { version: "1.0.0", capabilities: ["ui.render"] });
  const storageA = testSpaceStorage(join(root, "a"));
  const storageB = testSpaceStorage(join(root, "b"));
  const reg = createPluginRegistry({
    dir: join(root, "installed"),
    trustedDir: trusted,
    packageSpaces: () => [
      { spaceId: "spc_a", storage: storageA },
      { spaceId: "spc_b", storage: storageB },
    ],
  });
  await reg.install("file:demo");
  await reg.grant("com-example-demo", ["ui.render"], storageA);
  await reg.enable("com-example-demo", storageA);
  writeSandbox(pkg, { version: "1.1.0", capabilities: ["ui.render"] });
  const updated = await reg.update("com-example-demo", { storage: storageB });
  assert.equal(updated.version, "1.1.0");
  await reg.dispose();
});

test("enable rolls back runtime when Space enabled-state write fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-enable-boom-"));
  const trusted = join(root, "trusted");
  const pkg = join(trusted, "demo");
  writeSandbox(pkg, { version: "1.0.0", capabilities: ["ui.render"] });
  const storage = testSpaceStorage(join(root, "space"));
  const reg = createPluginRegistry({
    dir: join(root, "installed"),
    trustedDir: trusted,
    packageSpaces: () => [{ spaceId: "spc_a", storage }],
    writeEnabled: () => {
      throw new Error("disk full");
    },
  });
  await reg.install("file:demo");
  await reg.grant("com-example-demo", ["ui.render"], storage);
  await assert.rejects(() => reg.enable("com-example-demo", storage), /disk full/);
  assert.equal(reg.detail("com-example-demo", storage).enabled, false);
  assert.equal(reg.scopeState("com-example-demo"), null);
  await reg.dispose();
});

test("uninstall deletes Secure Safe keys using canonical Space id, not folder basename", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-uninstall-sid-"));
  const trusted = join(root, "trusted");
  const pkg = join(trusted, "demo");
  writeSandbox(pkg, {
    capabilities: ["ui.render", "auth.connection"],
    connections: [tokenSpec],
  });
  const storage = testSpaceStorage(join(root, "my-space-abc123"));
  const vault = memoryOpaqueVault();
  const reg = createPluginRegistry({
    dir: join(root, "installed"),
    trustedDir: trusted,
    secrets: vault,
    packageSpaces: () => [{ spaceId: "spc_abc123", storage }],
  });
  await reg.install("file:demo");
  await setTokenConnection(
    { storage, spaceId: "spc_abc123", vault },
    "com-example-demo",
    tokenSpec,
    "super-secret-token",
  );
  assert.ok(vault.getOpaque("pkgconn:spc_abc123:com-example-demo:jira"));
  assert.equal(await reg.remove("com-example-demo"), true);
  assert.equal(vault.getOpaque("pkgconn:spc_abc123:com-example-demo:jira"), null);
  assert.equal(vault.getOpaque("pkgconn:my-space-abc123:com-example-demo:jira"), null);
  const pub = join(storage.path("packages/com-example-demo"), "connections.json");
  try {
    const raw = JSON.parse(readFileSync(pub, "utf8")) as Record<string, unknown>;
    assert.deepEqual(raw, {});
  } catch (cause) {
    assert.equal((cause as NodeJS.ErrnoException).code, "ENOENT");
  }
  await reg.dispose();
});

test("in-flight refresh cannot recreate a secret after uninstall", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-refresh-race-"));
  const trusted = join(root, "trusted");
  const pkg = join(trusted, "demo");
  writeSandbox(pkg, {
    capabilities: ["ui.render", "auth.connection"],
    connections: [oauthSpec],
  });
  const storage = testSpaceStorage(join(root, "space"));
  const vault = memoryOpaqueVault();
  const key = "pkgconn:spc_a:com-example-demo:jira";
  const reg = createPluginRegistry({
    dir: join(root, "installed"),
    trustedDir: trusted,
    secrets: vault,
    packageSpaces: () => [{ spaceId: "spc_a", storage }],
  });
  await reg.install("file:demo");
  await reg.grant("com-example-demo", ["ui.render", "auth.connection"], storage, "user", ["jira"]);
  vault.putOpaque(key, JSON.stringify({ accessToken: "old", refreshToken: "refresh-me" }));
  writeFileSync(join(storage.path("packages/com-example-demo"), "connections.json"), JSON.stringify({
    jira: { status: "connected", expiresAt: Date.now() - 10_000 },
  }));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const refreshing = connectionAuthorization({
    storage,
    spaceId: "spc_a",
    vault,
    oauthHttp: async () => {
      markStarted();
      await gate;
      return { status: 200, body: JSON.stringify({ access_token: "new-token" }), headers: {} };
    },
  }, "com-example-demo", oauthSpec);
  await started;
  const removing = reg.remove("com-example-demo");
  release();
  await Promise.all([refreshing, removing]);
  assert.equal(vault.getOpaque(key), null);
  await reg.dispose();
});

test("startup migrates legacy layout before activation", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-migrate-boot-"));
  const trusted = join(root, "trusted");
  const pkg = join(trusted, "demo");
  writeSandbox(pkg, { version: "1.0.0", capabilities: ["ui.render"] });
  const storage = testSpaceStorage(join(root, "space"));
  const installed = join(root, "installed");
  const home = join(installed, "com-example-demo");
  mkdirSync(home, { recursive: true });
  writeSandbox(home, { version: "1.0.0", capabilities: ["ui.render"] });
  writeFileSync(join(installed, "registry.json"), JSON.stringify([{
    id: "com-example-demo",
    source: "file:demo",
    installationId: "legacy-1",
  }]));
  writeSpaceEnabled(storage, "com-example-demo", true);
  grantCapabilities(storage, "com-example-demo", [{ name: "ui.render" }]);
  const activations: string[] = [];
  const reg = createPluginRegistry({
    dir: installed,
    trustedDir: trusted,
    packageSpaces: () => [{ spaceId: "spc_a", storage }],
    slots: {
      add(item) {
        activations.push(item.id);
        return { dispose() {} };
      },
    },
  });
  await reg.enable("com-example-demo", storage);
  assert.equal(reg.detail("com-example-demo", storage).version, "1.0.0");
  assert.equal(readFileSync(join(home, "active"), "utf8").trim(), "1.0.0");
  assert.equal(reg.scopeState("com-example-demo") != null, true);
  assert.ok(activations.length > 0);
  await reg.dispose();
});

test("oauth transactions are bounded to one live tx per connection", () => {
  const first = createOauthTx({
    spaceId: "spc_a",
    packageId: "pkg.one",
    version: "1.0.0",
    integrity: "aaa",
    installGeneration: "g1",
    connectionId: "jira",
    connectionFingerprint: "fp",
    redirectUri: "http://127.0.0.1/api/plugins/oauth/callback",
    verifier: "one",
  });
  const second = createOauthTx({
    spaceId: "spc_a",
    packageId: "pkg.one",
    version: "1.0.0",
    integrity: "aaa",
    installGeneration: "g1",
    connectionId: "jira",
    connectionFingerprint: "fp",
    redirectUri: "http://127.0.0.1/api/plugins/oauth/callback",
    verifier: "two",
  });
  assert.throws(() => consumeOauthTx({ oauthTxId: first.oauthTxId, spaceId: "spc_a" }), /invalid/);
  const live = consumeOauthTx({ oauthTxId: second.oauthTxId, spaceId: "spc_a" });
  assert.equal(live.verifier, "two");
});
