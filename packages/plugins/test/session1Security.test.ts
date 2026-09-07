import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AuthPrincipal, RouteRequest, SpaceContext, SpaceRole, SpaceStorage } from "@polyth/contracts";
import { REMOTE_CAPABILITY, principalAllowsRemoteCapability } from "@polyth/contracts";
import { createPluginRegistry } from "../src/managedRegistry.ts";
import { managedPluginRoutes } from "../src/serverEntry.ts";
import { assertDeploymentPackageMutator } from "../src/lifecycleAuth.ts";
import { consumeOauthTx, createOauthTx, oauthRedirectOrigin, assertOauthTxMatchesActive } from "../src/oauthTx.ts";
import { connectionFingerprint } from "../src/connectionFingerprint.ts";
import { grantCapabilities, approveConnectionDefinitions, connectionReviewRequired, assertAuthConnectionGranted } from "../src/grants.ts";
import { publishVersion, treeIntegrity, versionDir } from "../src/versions.ts";
import { isBlockedIp } from "@polyth/outbound";
import { invokePackageRpc } from "../src/packageRpc.ts";
import { memoryOpaqueVault, testSpaceStorage } from "./helpers.ts";
import { setTokenConnection } from "../src/connections.ts";
import { isSupportedInstallSource } from "../src/installSourceContract.ts";
import type { ServerPackageHost } from "../src/serverPackage.ts";
import { createContext } from "@polyth/kernel";

function spaceStorage(root: string): SpaceStorage {
  mkdirSync(root, { recursive: true });
  return {
    root,
    packageDir(id) {
      const dir = join(root, "packages", id);
      mkdirSync(dir, { recursive: true });
      return dir;
    },
    path(relative) {
      if (!relative || relative.includes("\0") || relative.startsWith("/") || relative.split("/").includes("..")) {
        throw Object.assign(new Error("path escapes its space"), { code: "invalid-path" });
      }
      return join(root, ...relative.split("/"));
    },
  };
}

function space(role: SpaceRole, over: Partial<SpaceContext> = {}): SpaceContext {
  return {
    spaceId: "spc_test",
    spaceSlug: "test",
    userId: "usr_1",
    role,
    deployment: "local-trusted",
    storageDir: "/tmp/polyth-space",
    ...over,
  };
}

function writeSandbox(dir: string, over: { version?: string; capabilities?: unknown } = {}): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "polyth-package.json"), JSON.stringify({
    manifestVersion: 1,
    id: "com-example-demo",
    version: over.version ?? "1.0.0",
    display: { name: "Demo", description: "Sandbox demo" },
    runtime: { kind: "sandboxed", ui: { entry: "ui.ts" } },
    contributes: { surfaces: [{ id: "main", title: "Demo" }] },
    capabilities: over.capabilities ?? ["ui.render", "ui.toast"],
  }));
  writeFileSync(join(dir, "ui.ts"), 'import { connectPolyth } from "@polyth/package-sdk";\nawait connectPolyth();\n');
}

function paired(grants: string[] = []): AuthPrincipal {
  return {
    kind: "paired-device",
    deviceId: "dev1",
    deviceEndpointId: "ep1",
    connectionId: "c1",
    transport: "direct",
    grants,
    grantRevision: 1,
  };
}

function requireCapabilityOf(principal: AuthPrincipal) {
  return (capability: string) => {
    if (principal.kind === "anonymous") {
      throw Object.assign(new Error("authentication required"), { code: "unauthorized" });
    }
    if (!principalAllowsRemoteCapability(principal, capability)) {
      throw Object.assign(new Error("not allowed"), { code: "forbidden" });
    }
  };
}

test("deployment package mutations use packages.install, not Space admin", () => {
  assert.equal(REMOTE_CAPABILITY.packagesInstall, "packages.install");
  const local: RouteRequest = {
    req: { headers: {} } as RouteRequest["req"],
    res: {} as RouteRequest["res"],
    url: new URL("http://127.0.0.1/"),
    path: "/",
    method: "POST",
    ingress: { kind: "public-http", listenerId: "local", loopback: true, secure: false },
    principal: { kind: "local-user", trustedLoopback: true },
    space: space("member"),
    requireCapability: requireCapabilityOf({ kind: "local-user", trustedLoopback: true }),
    body: async () => ({}),
    json() {},
  };
  assert.doesNotThrow(() => assertDeploymentPackageMutator(local));
  const adminRemote: RouteRequest = {
    ...local,
    principal: paired([]),
    space: space("admin"),
    requireCapability: requireCapabilityOf(paired([])),
  };
  assert.throws(() => assertDeploymentPackageMutator(adminRemote), /not allowed/);
  const memberRemote: RouteRequest = {
    ...local,
    principal: paired([]),
    space: space("member"),
    requireCapability: requireCapabilityOf(paired([])),
  };
  assert.throws(() => assertDeploymentPackageMutator(memberRemote), /not allowed/);
});

test("managed plugin HTTP denies Space admin without deployment authority", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-admin-http-"));
  const trusted = join(root, "trusted");
  writeSandbox(join(trusted, "demo"));
  const registry = createPluginRegistry({ dir: join(root, "installed"), trustedDir: trusted });
  await registry.install("file:demo");
  const handler = managedPluginRoutes(registry, {
    spaceStorage: () => spaceStorage(join(root, "space")),
  } as unknown as ServerPackageHost);
  let captured: { code?: number; body?: unknown } = {};
  const request = (path: string, method: string, principal: AuthPrincipal, role: SpaceRole): RouteRequest => ({
    req: { headers: { host: "127.0.0.1" } } as RouteRequest["req"],
    res: { writeHead() {}, end() {} } as unknown as RouteRequest["res"],
    url: new URL(`http://127.0.0.1${path}`),
    path,
    method,
    ingress: { kind: "public-http", listenerId: "local", loopback: true, secure: false },
    principal,
    space: space(role),
    requireCapability: requireCapabilityOf(principal),
    body: async () => ({}),
    json(code, body) { captured = { code, body }; },
  });
  await assert.rejects(
    () => handler(request("/api/plugins/com-example-demo", "DELETE", paired([]), "admin")),
    /not allowed/,
  );
  await assert.rejects(
    () => handler(request("/api/plugins/com-example-demo/update", "POST", paired([]), "member")),
    /not allowed/,
  );
  captured = {};
  assert.equal(await handler(request("/api/plugins", "GET", { kind: "local-user", trustedLoopback: true }, "member")), true);
  assert.equal(captured.code, 200);
});

test("oauth redirect origin ignores forwarded hosts", () => {
  assert.equal(oauthRedirectOrigin({ hostHeader: "127.0.0.1:4400" }), "http://127.0.0.1:4400");
  assert.throws(() => oauthRedirectOrigin({ hostHeader: "evil.example" }), /local host/);
  assert.throws(() => oauthRedirectOrigin({ hostHeader: "127.0.0.1:4400@evil.example" }), /unavailable|local host/);
  assert.equal(
    oauthRedirectOrigin({ hostHeader: "evil.example", configured: "https://polyth.example" }),
    "https://polyth.example",
  );
});

test("oauth transactions reject wrong Space, expiry, and replay", () => {
  const tx = createOauthTx({
    spaceId: "spc_a",
    packageId: "pkg.one",
    version: "1.0.0",
    integrity: "abc",
    installGeneration: "gen1",
    connectionId: "demo",
    connectionFingerprint: "fp-demo",
    redirectUri: "http://127.0.0.1/api/plugins/oauth/callback",
    verifier: "verifier",
  });
  assert.throws(() => consumeOauthTx({ oauthTxId: tx.oauthTxId, spaceId: "spc_b" }), /invalid/);
  const once = consumeOauthTx({ oauthTxId: tx.oauthTxId, spaceId: "spc_a" });
  assert.equal(once.connectionId, "demo");
  assert.throws(() => consumeOauthTx({ oauthTxId: tx.oauthTxId, spaceId: "spc_a" }), /invalid|already used/);
});

test("connection fingerprint changes require review", () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-fp-"));
  const storage = spaceStorage(join(root, "space"));
  const spec = {
    id: "jira",
    label: "Jira",
    kind: "oauth" as const,
    origins: ["https://api.atlassian.com"],
    oauth: {
      authorizeUrl: "https://auth.atlassian.com/authorize",
      tokenUrl: "https://auth.atlassian.com/oauth/token",
      clientId: "public",
      scopes: ["read:jira"],
    },
  };
  grantCapabilities(storage, "pkg.one", [{ name: "auth.connection" }], "user");
  approveConnectionDefinitions(storage, "pkg.one", [spec], ["jira"]);
  assert.equal(connectionReviewRequired(storage, "pkg.one", [spec]), false);
  const changed = {
    ...spec,
    oauth: { ...spec.oauth, tokenUrl: "https://attacker.example/token" },
  };
  assert.notEqual(connectionFingerprint(spec), connectionFingerprint(changed));
  assert.equal(connectionReviewRequired(storage, "pkg.one", [changed]), true);
  assert.throws(
    () => assertAuthConnectionGranted(storage, "pkg.one", [{ name: "ui.toast" }]),
    /not declared/,
  );
});

test("same semver with different contents is rejected and original tree stays", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-immut-"));
  const home = join(root, "pkg");
  const v1 = join(root, "v1");
  const v1b = join(root, "v1b");
  writeSandbox(v1, { version: "1.0.0" });
  writeSandbox(v1b, { version: "1.0.0" });
  writeFileSync(join(v1b, "ui.ts"), "export const changed = true;\n");
  const dest = await publishVersion(home, "1.0.0", v1);
  const original = treeIntegrity(dest);
  await assert.rejects(() => publishVersion(home, "1.0.0", v1b), /different contents/);
  assert.equal(treeIntegrity(versionDir(home, "1.0.0")), original);
  assert.equal(existsSync(join(versionDir(home, "1.0.0"), "ui.ts")), true);
});

test("global update waits for every enabled Space", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-multisp-"));
  const dataDir = join(root, "data");
  const trusted = join(root, "trusted");
  const pkg = join(trusted, "demo");
  writeSandbox(pkg, { version: "1.0.0", capabilities: ["ui.render"] });
  const spaceARoot = join(dataDir, "spaces", "alpha-aaaaaaaa");
  const spaceBRoot = join(dataDir, "spaces", "beta-bbbbbbbb");
  const spaces: SpaceStorage[] = [];
  const storageA = testSpaceStorage(spaceARoot);
  const storageB = testSpaceStorage(spaceBRoot);
  spaces.push(storageA, storageB);
  const reg = createPluginRegistry({
    dir: join(root, "installed"),
    trustedDir: trusted,
    packageSpaces: () => spaces.map((storage, i) => ({ spaceId: `spc_${i}`, storage })),
  });
  await reg.install("file:demo");
  await reg.grant("com-example-demo", ["ui.render"], storageA);
  await reg.enable("com-example-demo", storageA);
  await reg.grant("com-example-demo", ["ui.render"], storageB);
  await reg.enable("com-example-demo", storageB);
  writeSandbox(pkg, { version: "1.1.0", capabilities: ["ui.render", "session.read"] });
  const pending = await reg.update("com-example-demo", { storage: storageA });
  assert.equal(pending.version, "1.0.0");
  assert.equal(pending.update?.version, "1.1.0");
  assert.ok(reg.detail("com-example-demo", storageB).permissions.review?.capabilities
    .some((item) => item.name === "session.read"));
  const partial = await reg.grant("com-example-demo", ["session.read"], storageB);
  assert.equal(partial.version, "1.0.0");
  const activated = await reg.grant("com-example-demo", ["session.read"], storageA);
  assert.equal(activated.version, "1.1.0");
  await reg.dispose();
});

test("blocked IP ranges include CGNAT and unique-local IPv6", () => {
  assert.equal(isBlockedIp("100.64.1.1"), true);
  assert.equal(isBlockedIp("198.18.1.1"), true);
  assert.equal(isBlockedIp("192.0.0.8"), true);
  assert.equal(isBlockedIp("fd12::1"), true);
  assert.equal(isBlockedIp("8.8.8.8"), false);
});

test("createSpaceStorage rejects invalid package ids", () => {
  const storage = testSpaceStorage(mkdtempSync(join(tmpdir(), "polyth-space-id-")));
  assert.throws(() => storage.packageDir("INVALID"), /lowercase/);
});

test("connection HTTP requires granted auth.connection and a matching fingerprint", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-conn-http-"));
  const storage = spaceStorage(join(root, "space"));
  const spec = {
    id: "demo",
    label: "Demo",
    kind: "token" as const,
    origins: ["https://jsonplaceholder.typicode.com"],
  };
  const manifest = {
    manifestVersion: 1 as const,
    id: "com-example-demo",
    version: "1.0.0",
    display: { name: "Demo", description: "Demo" },
    runtime: { kind: "sandboxed" as const, ui: { entry: "ui.ts" } },
    capabilities: [
      { name: "network.fetch", constraints: { origins: ["https://jsonplaceholder.typicode.com"] } },
      { name: "auth.connection" },
    ],
    connections: [spec],
  };
  const vault = memoryOpaqueVault();
  const deps = {
    space: space("owner", { spaceId: "spc_a" }),
    storage,
    sessions: { snapshot: async () => ({ id: "s", title: "S", status: "idle", spaceId: "spc_a" }) },
    projects: { get: async () => undefined },
    appendEvent: async () => ({}),
    manifest,
    enabled: true,
    secrets: vault,
  };
  grantCapabilities(storage, manifest.id, [{ name: "network.fetch", constraints: { origins: spec.origins } }]);
  await setTokenConnection({ storage, spaceId: "spc_a", vault }, manifest.id, spec, "super-secret-token");
  await assert.rejects(
    () => invokePackageRpc(deps as never, "network.fetch", {
      url: "https://jsonplaceholder.typicode.com/posts/1",
      connectionId: "demo",
    }),
    /not declared|not granted/,
  );
  grantCapabilities(storage, manifest.id, [{ name: "auth.connection" }]);
  await assert.rejects(
    () => invokePackageRpc(deps as never, "network.fetch", {
      url: "https://jsonplaceholder.typicode.com/posts/1",
      connectionId: "demo",
    }),
    /needs review|CAPABILITY_DENIED/,
  );
  grantCapabilities(storage, manifest.id, [{ name: "auth.connection" }], "user");
  approveConnectionDefinitions(storage, manifest.id, [spec], ["demo"]);
  await assert.rejects(
    () => invokePackageRpc(deps as never, "network.fetch", {
      url: "https://api.example.com/leak",
      connectionId: "demo",
    }),
    /not bound|NETWORK_ORIGIN_DENIED/,
  );
});

test("v1 installer sources reject git and npm", () => {
  assert.equal(isSupportedInstallSource("https://example.com/pkg.zip"), true);
  assert.equal(isSupportedInstallSource("zip:https://example.com/pkg.zip"), true);
  assert.equal(isSupportedInstallSource("file:demo"), true);
  assert.equal(isSupportedInstallSource("app.zip"), true);
  assert.equal(isSupportedInstallSource("npm:@scope/name"), false);
  assert.equal(isSupportedInstallSource("git:https://example.com/repo.git"), false);
  assert.equal(isSupportedInstallSource("git+https://example.com/repo.git"), false);
  assert.equal(isSupportedInstallSource("path:/tmp/pkg"), false);
  assert.equal(isSupportedInstallSource("path:/tmp/pkg", true), true);
  const page = readFileSync(new URL("../widgets/PluginsPage.tsx", import.meta.url), "utf8");
  assert.match(page, /isSupportedInstallSource/);
  assert.match(page, /packages\.plugins\.sourceHint/);
  assert.equal(page.includes("npm:"), false);
  assert.equal(page.includes("git:"), false);
  assert.equal(page.includes("installManagedPluginHint"), false);
});

function writeConnectedSandbox(dir: string, over: {
  version: string;
  capabilities: unknown[];
  tokenUrl: string;
  origins?: string[];
}): void {
  writeSandbox(dir, { version: over.version, capabilities: over.capabilities });
  const path = join(dir, "polyth-package.json");
  const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  manifest.connections = [{
    id: "jira",
    label: "Jira",
    kind: "oauth",
    origins: over.origins ?? ["https://api.example.com"],
    oauth: {
      authorizeUrl: "https://auth.example/authorize",
      tokenUrl: over.tokenUrl,
      clientId: "public",
      scopes: ["read"],
    },
  }];
  writeFileSync(path, JSON.stringify(manifest));
}

test("connection-only update requires explicit fingerprint approval", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-conn-only-"));
  const trusted = join(root, "trusted");
  const pkg = join(trusted, "demo");
  writeConnectedSandbox(pkg, {
    version: "1.0.0",
    capabilities: ["ui.render", "auth.connection"],
    tokenUrl: "https://auth.example/token",
  });
  const storage = spaceStorage(join(root, "space"));
  const reg = createPluginRegistry({
    dir: join(root, "installed"),
    trustedDir: trusted,
    packageSpaces: () => [{ spaceId: "spc_a", storage }],
  });
  await reg.install("file:demo");
  await reg.grant("com-example-demo", ["ui.render", "auth.connection"], storage, "user", ["jira"]);
  await reg.enable("com-example-demo", storage);
  writeConnectedSandbox(pkg, {
    version: "1.1.0",
    capabilities: ["ui.render", "auth.connection"],
    tokenUrl: "https://attacker.example/token",
  });
  const pending = await reg.update("com-example-demo", { storage });
  assert.equal(pending.version, "1.0.0");
  assert.equal(pending.update?.version, "1.1.0");
  assert.ok(pending.permissions.review);
  assert.equal((pending.permissions.review?.capabilities ?? []).length, 0);
  assert.equal(pending.permissions.review?.connections[0]?.id, "jira");
  assert.equal(pending.permissions.review?.connections[0]?.current?.tokenUrl, "https://auth.example/token");
  assert.equal(pending.permissions.review?.connections[0]?.next.tokenUrl, "https://attacker.example/token");
  const still = await reg.grant("com-example-demo", ["ui.render"], storage);
  assert.equal(still.version, "1.0.0");
  const activated = await reg.grant("com-example-demo", [], storage, "user", ["jira"]);
  assert.equal(activated.version, "1.1.0");
  assert.equal(activated.update, undefined);
  await reg.dispose();
});

test("granting a new capability does not approve a changed OAuth token URL", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-conn-cap-"));
  const trusted = join(root, "trusted");
  const pkg = join(trusted, "demo");
  writeConnectedSandbox(pkg, {
    version: "1.0.0",
    capabilities: ["ui.render", "auth.connection"],
    tokenUrl: "https://auth.example/token",
  });
  const storage = spaceStorage(join(root, "space"));
  const reg = createPluginRegistry({
    dir: join(root, "installed"),
    trustedDir: trusted,
    packageSpaces: () => [{ spaceId: "spc_a", storage }],
  });
  await reg.install("file:demo");
  await reg.grant("com-example-demo", ["ui.render", "auth.connection"], storage, "user", ["jira"]);
  await reg.enable("com-example-demo", storage);
  writeConnectedSandbox(pkg, {
    version: "1.1.0",
    capabilities: ["ui.render", "auth.connection", "session.read"],
    tokenUrl: "https://attacker.example/token",
  });
  const pending = await reg.update("com-example-demo", { storage });
  assert.equal(pending.version, "1.0.0");
  const capsOnly = await reg.grant("com-example-demo", ["session.read"], storage);
  assert.equal(capsOnly.version, "1.0.0");
  assert.equal(capsOnly.permissions.review?.connections[0]?.next.tokenUrl, "https://attacker.example/token");
  const activated = await reg.grant("com-example-demo", [], storage, "user", ["jira"]);
  assert.equal(activated.version, "1.1.0");
  await reg.dispose();
});

test("origin expansion requires connection security review", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-origin-"));
  const trusted = join(root, "trusted");
  const pkg = join(trusted, "demo");
  writeConnectedSandbox(pkg, {
    version: "1.0.0",
    capabilities: ["ui.render", "auth.connection"],
    tokenUrl: "https://auth.example/token",
    origins: ["https://api.example.com"],
  });
  const storage = spaceStorage(join(root, "space"));
  const reg = createPluginRegistry({
    dir: join(root, "installed"),
    trustedDir: trusted,
    packageSpaces: () => [{ spaceId: "spc_a", storage }],
  });
  await reg.install("file:demo");
  await reg.grant("com-example-demo", ["ui.render", "auth.connection"], storage, "user", ["jira"]);
  await reg.enable("com-example-demo", storage);
  writeConnectedSandbox(pkg, {
    version: "1.1.0",
    capabilities: ["ui.render", "auth.connection"],
    tokenUrl: "https://auth.example/token",
    origins: ["https://api.example.com", "https://other.example"],
  });
  const pending = await reg.update("com-example-demo", { storage });
  assert.equal(pending.version, "1.0.0");
  assert.ok(pending.permissions.review?.connections[0]?.next.origins.includes("https://other.example"));
  await reg.dispose();
});

test("rollback is blocked when an enabled Space lacks the target capability", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-rb-multi-"));
  const dataDir = join(root, "data");
  const trusted = join(root, "trusted");
  const pkg = join(trusted, "demo");
  writeSandbox(pkg, { version: "1.0.0", capabilities: ["ui.render", "session.read"] });
  const spaces: SpaceStorage[] = [];
  const storageA = testSpaceStorage(join(dataDir, "spaces", "alpha-aaaaaaaa"));
  const storageB = testSpaceStorage(join(dataDir, "spaces", "beta-bbbbbbbb"));
  spaces.push(storageA, storageB);
  const reg = createPluginRegistry({
    dir: join(root, "installed"),
    trustedDir: trusted,
    packageSpaces: () => spaces.map((storage, i) => ({ spaceId: `spc_${i}`, storage })),
  });
  await reg.install("file:demo");
  await reg.grant("com-example-demo", ["ui.render", "session.read"], storageA);
  await reg.grant("com-example-demo", ["ui.render", "session.read"], storageB);
  await reg.enable("com-example-demo", storageA);
  await reg.enable("com-example-demo", storageB);
  writeSandbox(pkg, { version: "1.1.0", capabilities: ["ui.render"] });
  const updated = await reg.update("com-example-demo", { storage: storageA });
  assert.equal(updated.version, "1.1.0");
  writeFileSync(join(storageB.root, "packages", "com-example-demo", "grants.json"), JSON.stringify({
    grants: [{ name: "ui.render", grantedAt: Date.now() }],
    connectionFingerprints: {},
  }));
  const rolled = await reg.rollback("com-example-demo", "1.0.0", storageA);
  assert.equal(rolled.version, "1.1.0");
  assert.equal(rolled.update?.version, "1.0.0");
  await reg.dispose();
});

test("rollback is blocked when the target connection fingerprint is unapproved", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-rb-fp-"));
  const trusted = join(root, "trusted");
  const pkg = join(trusted, "demo");
  writeConnectedSandbox(pkg, {
    version: "1.0.0",
    capabilities: ["ui.render", "auth.connection"],
    tokenUrl: "https://auth.example/token",
  });
  const storage = spaceStorage(join(root, "space"));
  const reg = createPluginRegistry({
    dir: join(root, "installed"),
    trustedDir: trusted,
    packageSpaces: () => [{ spaceId: "spc_a", storage }],
  });
  await reg.install("file:demo");
  await reg.grant("com-example-demo", ["ui.render", "auth.connection"], storage, "user", ["jira"]);
  await reg.enable("com-example-demo", storage);
  writeConnectedSandbox(pkg, {
    version: "1.1.0",
    capabilities: ["ui.render", "auth.connection"],
    tokenUrl: "https://auth.example/token-v2",
  });
  const updated = await reg.update("com-example-demo", { storage });
  assert.equal(updated.version, "1.0.0");
  await reg.grant("com-example-demo", [], storage, "user", ["jira"]);
  assert.equal(reg.detail("com-example-demo", storage).version, "1.1.0");
  const rolled = await reg.rollback("com-example-demo", "1.0.0", storage);
  assert.equal(rolled.version, "1.1.0");
  assert.equal(rolled.update?.version, "1.0.0");
  await reg.dispose();
});

test("compatible rollback activates when every enabled Space matches", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-rb-ok-"));
  const trusted = join(root, "trusted");
  const pkg = join(trusted, "demo");
  writeSandbox(pkg, { version: "1.0.0", capabilities: ["ui.render"] });
  const storage = spaceStorage(join(root, "space"));
  const reg = createPluginRegistry({
    dir: join(root, "installed"),
    trustedDir: trusted,
    packageSpaces: () => [{ spaceId: "spc_a", storage }],
  });
  await reg.install("file:demo");
  await reg.grant("com-example-demo", ["ui.render"], storage);
  await reg.enable("com-example-demo", storage);
  writeSandbox(pkg, { version: "1.1.0", capabilities: ["ui.render"] });
  const updated = await reg.update("com-example-demo", { storage });
  assert.equal(updated.version, "1.1.0");
  const rolled = await reg.rollback("com-example-demo", undefined, storage);
  assert.equal(rolled.version, "1.0.0");
  await reg.dispose();
});

test("last Space disable disposes process runtime and restart stays inactive", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-last-space-"));
  const dataDir = join(root, "data");
  const trusted = join(root, "trusted");
  const pkg = join(trusted, "demo");
  writeSandbox(pkg, { version: "1.0.0", capabilities: ["ui.render"] });
  const spaces: SpaceStorage[] = [];
  const storageA = testSpaceStorage(join(dataDir, "spaces", "alpha-aaaaaaaa"));
  const storageB = testSpaceStorage(join(dataDir, "spaces", "beta-bbbbbbbb"));
  spaces.push(storageA, storageB);
  const opts = {
    dir: join(root, "installed"),
    trustedDir: trusted,
    packageSpaces: () => spaces.map((storage, i) => ({ spaceId: `spc_${i}`, storage })),
  };
  let reg = createPluginRegistry(opts);
  await reg.install("file:demo");
  await reg.grant("com-example-demo", ["ui.render"], storageA);
  await reg.grant("com-example-demo", ["ui.render"], storageB);
  await reg.enable("com-example-demo", storageA);
  assert.ok(reg.scopeState("com-example-demo"));
  await reg.enable("com-example-demo", storageB);
  const contributions = reg.scopeState("com-example-demo")?.contributions;
  await reg.disable("com-example-demo", storageA);
  assert.ok(reg.scopeState("com-example-demo"), "process stays while another Space is enabled");
  assert.equal(reg.scopeState("com-example-demo")?.contributions, contributions);
  await reg.disable("com-example-demo", storageB);
  assert.equal(reg.scopeState("com-example-demo"), null);
  await reg.dispose();
  reg = createPluginRegistry(opts);
  assert.equal(reg.list()[0]?.enabled, false);
  assert.equal(reg.scopeState("com-example-demo"), null);
  await reg.enable("com-example-demo", storageB);
  assert.ok(reg.scopeState("com-example-demo"));
  await reg.dispose();
});

test("oauth callback rejects a transaction after version or install generation change", () => {
  const base = {
    packageId: "pkg.one",
    version: "1.0.0",
    integrity: "aaa",
    installGeneration: "gen-1",
    connectionId: "jira",
    connectionFingerprint: "fp-jira",
  };
  const tx = createOauthTx({
    spaceId: "spc_a",
    ...base,
    redirectUri: "http://127.0.0.1/api/plugins/oauth/callback",
    verifier: "verifier",
  });
  assert.doesNotThrow(() => assertOauthTxMatchesActive(tx, base));
  assert.throws(
    () => assertOauthTxMatchesActive(tx, { ...base, version: "2.0.0" }),
    /retry required/,
  );
  assert.throws(
    () => assertOauthTxMatchesActive(tx, { ...base, integrity: "bbb" }),
    /retry required/,
  );
  assert.throws(
    () => assertOauthTxMatchesActive(tx, { ...base, installGeneration: "gen-2" }),
    /retry required/,
  );
});

test("failed version activation restores the previous healthy version", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-act-fail-"));
  const trusted = join(root, "trusted");
  const pkg = join(trusted, "boom");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "polyth-plugin.json"), JSON.stringify({
    id: "com-example-boom",
    name: "Boom",
    version: "1.0.0",
    trust: "workspace",
    entries: { server: "server.mjs" },
  }));
  writeFileSync(join(pkg, "server.mjs"), `
    export default (host) => ({
      manifest: { id: host.pluginId, version: "1.0.0", trust: "workspace" },
      setup() {},
    });
  `);
  const kernel = createContext("test-root");
  const routes = { add: () => ({ dispose() {} }) };
  const storage = testSpaceStorage(join(root, "space"));
  const reg = createPluginRegistry({
    dir: join(root, "installed"),
    trustedDir: trusted,
    root: kernel,
    routes,
    packageSpaces: () => [{ spaceId: "spc_boom", storage }],
  });
  await reg.install("file:boom");
  await reg.enable("com-example-boom", storage);
  assert.equal(reg.scopeState("com-example-boom") != null, true);
  writeFileSync(join(pkg, "polyth-plugin.json"), JSON.stringify({
    id: "com-example-boom",
    name: "Boom",
    version: "1.1.0",
    trust: "workspace",
    entries: { server: "server.mjs" },
  }));
  writeFileSync(join(pkg, "server.mjs"), `throw new Error("cannot start");\n`);
  await assert.rejects(() => reg.update("com-example-boom"), /cannot start/);
  assert.equal(reg.list()[0]?.version, "1.0.0");
  assert.equal(reg.scopeState("com-example-boom") != null, true);
  await reg.dispose();
  await kernel.dispose();
});

