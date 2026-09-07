import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectService, SessionService, SpaceContext, SpaceStorage } from "@polyth/contracts";
import { packDirectory } from "@polyth/package-sdk/manifest";
import { createPluginRegistry } from "../src/managedRegistry.ts";
import { loadCanonicalManifest } from "../src/canonical.ts";
import { invokePackageRpc } from "../src/packageRpc.ts";
import { grantCapabilities, approveConnectionDefinitions } from "../src/grants.ts";
import { kvGet, kvSet } from "../src/packageKv.ts";
import { setTokenConnection } from "../src/connections.ts";
import { memoryOpaqueVault, testSpaceStorage } from "./helpers.ts";
import { buildSandboxBundle } from "../src/sandboxBundle.ts";
import { stageInstallSource } from "../src/installSources.ts";

const exampleHello = join(import.meta.dirname, "../../../examples/hello-package");
const exampleTracker = join(import.meta.dirname, "../../../examples/tracker-package");

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

function writeSandbox(dir: string, over: {
  id?: string;
  version?: string;
  capabilities?: unknown;
  entry?: boolean;
}): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "polyth-package.json"), JSON.stringify({
    manifestVersion: 1,
    id: over.id ?? "com-example-demo",
    version: over.version ?? "1.0.0",
    display: { name: "Demo", description: "Sandbox demo" },
    runtime: { kind: "sandboxed", ui: { entry: "ui.ts" } },
    contributes: { surfaces: [{ id: "main", title: "Demo" }] },
    capabilities: over.capabilities ?? ["ui.render", "ui.toast"],
  }));
  if (over.entry !== false) {
    writeFileSync(
      join(dir, "ui.ts"),
      'import { connectPolyth } from "@polyth/package-sdk";\nawait connectPolyth();\n',
    );
  } else {
    rmSync(join(dir, "ui.ts"), { force: true });
  }
}

test("canonical loader accepts v1, package.json polyth, and legacy manifests", () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-canonical-"));
  const v1 = join(root, "v1");
  writeSandbox(v1, {});
  assert.equal(loadCanonicalManifest(v1).canonical.id, "com-example-demo");
  assert.equal(loadCanonicalManifest(v1).canonical.runtime?.kind, "sandboxed");

  const pkg = join(root, "pkgjson");
  mkdirSync(pkg);
  writeFileSync(join(pkg, "package.json"), JSON.stringify({
    name: "com-example-frompkg",
    version: "2.0.0",
    description: "From package.json",
    polyth: {
      manifestVersion: 1,
      display: { name: "FromPkg", description: "From package.json" },
      runtime: { kind: "sandboxed" },
    },
  }));
  assert.equal(loadCanonicalManifest(pkg).canonical.id, "com-example-frompkg");
  assert.equal(loadCanonicalManifest(pkg).canonical.version, "2.0.0");

  const legacy = join(root, "legacy");
  mkdirSync(legacy);
  writeFileSync(join(legacy, "polyth-plugin.json"), JSON.stringify({
    id: "legacy.demo",
    name: "Legacy",
    version: "1.2.3",
    trust: "ui-only",
    capabilities: [],
    contributions: [],
  }));
  const loaded = loadCanonicalManifest(legacy);
  assert.equal(loaded.canonical.runtime?.kind, "trusted-local");
  assert.equal(loaded.legacy.id, "legacy.demo");
});

test("hello zip installs, requires grants, and enable is per Space", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-hello-"));
  const dataDir = join(root, "data");
  const zip = join(root, "hello.zip");
  writeFileSync(zip, await packDirectory(exampleHello));
  const spaces: SpaceStorage[] = [];
  const slots: string[] = [];
  const reg = createPluginRegistry({
    dir: join(root, "installed"),
    packageSpaces: () => spaces.map((storage, i) => ({ spaceId: `spc_${i}`, storage })),
    slots: {
      add(item) {
        slots.push(item.id);
        return { dispose() { slots.splice(slots.indexOf(item.id), 1); } };
      },
    },
  });
  const installed = await reg.install(zip);
  assert.equal(installed.id, "com-example-hello");
  assert.equal(installed.runtimeKind, "sandboxed");
  assert.equal(installed.enabled, false);
  assert.ok(installed.sandbox?.integrity);

  const storage = testSpaceStorage(join(dataDir, "spaces", "alpha-aaaaaaaa"));
  spaces.push(storage);
  await assert.rejects(() => reg.enable("com-example-hello", storage), /permission approval/);

  const granted = await reg.grant("com-example-hello", ["ui.render", "ui.toast"], storage, "user-1");
  assert.equal(granted.permissions.effective.length, 2);
  const enabled = await reg.enable("com-example-hello", storage);
  assert.equal(enabled.status, "ready");
  assert.equal(enabled.enabled, true);
  assert.ok(slots.some((id) => id.includes("surface")));
  const count = slots.length;
  const storageB = testSpaceStorage(join(dataDir, "spaces", "beta-bbbbbbbb"));
  spaces.push(storageB);
  assert.equal(reg.detail("com-example-hello", storageB).enabled, false);
  await reg.disable("com-example-hello", storage);
  assert.equal(reg.detail("com-example-hello", storage).enabled, false);
  assert.equal(slots.length, 0, "last Space disable disposes process runtime");
  await reg.grant("com-example-hello", ["ui.render", "ui.toast"], storageB, "user-2");
  const again = await reg.enable("com-example-hello", storageB);
  assert.equal(again.enabled, true);
  assert.equal(reg.detail("com-example-hello", storage).enabled, false);
  assert.equal(slots.length, count);
  await reg.remove("com-example-hello", storage);
  assert.deepEqual(reg.list(), []);
  await reg.dispose();
});

test("tracker example needs no issue-tracker types in core and installs beside hello", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-multi-"));
  const helloZip = join(root, "hello.zip");
  const trackerZip = join(root, "tracker.zip");
  writeFileSync(helloZip, await packDirectory(exampleHello));
  writeFileSync(trackerZip, await packDirectory(exampleTracker));
  const reg = createPluginRegistry({ dir: join(root, "installed") });
  await reg.install(helloZip);
  const tracker = await reg.install(trackerZip);
  assert.equal(tracker.id, "com-example-tracker");
  assert.ok(tracker.contributions.some((item) => item.module === "sandbox-action:attach-item"));
  assert.ok(!JSON.stringify(tracker).includes("Jira"));
  assert.ok(!JSON.stringify(tracker).includes("Linear"));
  await reg.dispose();
});

test("update permission expansion waits; same grants proceed; failed update restores; rollback works", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-update-"));
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

  writeSandbox(pkg, { version: "1.1.0", capabilities: ["ui.render", "session.read"] });
  const pending = await reg.update("com-example-demo", { storage });
  assert.ok(pending.permissions.review);
  assert.equal(pending.version, "1.0.0");
  assert.ok(pending.permissions.review?.capabilities.some((item) => item.name === "session.read"));

  const updated = await reg.grant("com-example-demo", ["session.read"], storage);
  assert.equal(updated.previousVersion, "1.0.0");
  assert.ok(updated.permissions.effective.includes("session.read"));
  assert.ok(updated.sandbox?.integrity);
  const newBundle = join(
    reg.installDir("com-example-demo"),
    ".polyth",
    "sandbox",
    `sandbox-${updated.sandbox!.integrity}.js`,
  );
  assert.equal(existsSync(newBundle), true);
  const home = join(root, "installed", "com-example-demo");
  assert.equal(existsSync(join(home, "versions", "1.0.0")), true);
  assert.equal(existsSync(join(home, "versions", "1.1.0", ".polyth", "sandbox", `sandbox-${updated.sandbox!.integrity}.js`)), true);

  writeSandbox(pkg, { version: "1.2.0", capabilities: ["ui.render", "session.read"], entry: false });
  await assert.rejects(() => reg.update("com-example-demo", { storage }), /missing required asset/);
  assert.equal(reg.list().find((item) => item.id === "com-example-demo")?.version, "1.1.0");

  const rolled = await reg.rollback("com-example-demo");
  assert.equal(rolled.version, "1.0.0");
  await reg.dispose();
});

test("incompatible engine, duplicate id, and missing assets are rejected", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-reject-"));
  const trusted = join(root, "trusted");
  const pkg = join(trusted, "demo");
  writeSandbox(pkg, {});
  const manifest = JSON.parse(readFileSync(join(pkg, "polyth-package.json"), "utf8")) as {
    engines?: { polyth: string };
  };
  manifest.engines = { polyth: ">=9.0.0" };
  writeFileSync(join(pkg, "polyth-package.json"), JSON.stringify(manifest));
  const reg = createPluginRegistry({ dir: join(root, "installed"), trustedDir: trusted, hostVersion: "0.1.0" });
  await assert.rejects(() => reg.install("file:demo"), /requires Polyth/);

  writeSandbox(pkg, {});
  await reg.install("file:demo");
  await assert.rejects(() => reg.install("file:demo"), /already installed/);
  await reg.dispose();
});

test("package RPC is capability gated, Space-scoped, and ignores payload identities", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-rpc-"));
  const spaceA = spaceStorage(join(root, "a"));
  const spaceB = spaceStorage(join(root, "b"));
  const manifest = loadCanonicalManifest(exampleHello).canonical;
  const deps = {
    space: { spaceId: "spc_a", userId: "usr_a" } as SpaceContext,
    storage: spaceA,
    sessions: {
      snapshot: async (id: string) => {
        if (id !== "ses_a") throw Object.assign(new Error("missing"), { code: "not-found" });
        return { id, title: "A", status: "idle", spaceId: "spc_a" };
      },
    } as unknown as SessionService,
    projects: {
      get: async (id: string) => id === "prj_a" ? { id, name: "Alpha", spaceId: "spc_a" } : undefined,
    } as unknown as ProjectService,
    appendEvent: async () => ({}),
    manifest: {
      ...manifest,
      capabilities: [
        ...(manifest.capabilities ?? []),
        { name: "storage.package" as const },
        { name: "network.fetch" as const, constraints: { origins: ["https://jsonplaceholder.typicode.com"] } },
        { name: "attachments.create" as const },
        { name: "session.read" as const },
      ],
    },
    enabled: true,
    sessionId: "ses_a",
    projectId: "prj_a",
  };

  await assert.rejects(() => invokePackageRpc(deps, "storage.set", { key: "k", value: "v" }), /not granted|not declared/);
  grantCapabilities(spaceA, manifest.id, [
    { name: "storage.package" as const },
    { name: "network.fetch" as const, constraints: { origins: ["https://jsonplaceholder.typicode.com"] } },
    { name: "attachments.create" as const },
    { name: "session.read" },
    { name: "ui.render" },
    { name: "ui.toast" },
  ]);
  await invokePackageRpc(deps, "storage.set", { key: "note", value: "alpha" });
  assert.equal(kvGet(spaceA, manifest.id, "note"), "alpha");
  assert.equal(kvGet(spaceB, manifest.id, "note"), null);

  await assert.rejects(
    () => invokePackageRpc(deps, "network.fetch", { url: "https://evil.example/x" }),
    /not declared|NETWORK_ORIGIN_DENIED/,
  );

  const session = await invokePackageRpc(deps, "session.read", { sessionId: "ses_other" });
  assert.deepEqual(session, { id: "ses_a", title: "A", busy: false });
  assert.equal(
    await invokePackageRpc({ ...deps, space: { spaceId: "spc_b", userId: "usr_b" } as SpaceContext }, "session.read", {}),
    null,
  );

  kvSet(spaceB, manifest.id, "note", "beta");
  assert.equal(kvGet(spaceA, manifest.id, "note"), "alpha");
  assert.equal(kvGet(spaceB, manifest.id, "note"), "beta");

  await assert.rejects(
    () => invokePackageRpc({ ...deps, enabled: false }, "storage.get", { key: "note" }),
    /disabled/i,
  );
});

test("connections never leak secrets across packages or Spaces", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-conn-"));
  const spaceA = spaceStorage(join(root, "a"));
  const spaceB = spaceStorage(join(root, "b"));
  const vaultA = memoryOpaqueVault();
  const vaultB = memoryOpaqueVault();
  const spec = { id: "demo", label: "Demo", kind: "token" as const, origins: ["https://api.example.com"] };
  const scopeA = { storage: spaceA, spaceId: "spc_a", vault: vaultA };
  const scopeB = { storage: spaceB, spaceId: "spc_b", vault: vaultB };
  const publicDto = await setTokenConnection(scopeA, "pkg.one", spec, "super-secret-token");
  assert.equal(publicDto.status, "connected");
  assert.equal(JSON.stringify(publicDto).includes("super-secret-token"), false);
  assert.equal((await setTokenConnection(scopeB, "pkg.one", spec, "other-token")).status, "connected");
  const rawA = JSON.parse(readFileSync(join(spaceA.path("packages/pkg.one"), "connections.json"), "utf8"));
  const rawB = JSON.parse(readFileSync(join(spaceB.path("packages/pkg.one"), "connections.json"), "utf8"));
  assert.equal(rawA.demo.accessToken, undefined);
  assert.equal(rawB.demo.accessToken, undefined);
  assert.ok(vaultA.getOpaque("pkgconn:spc_a:pkg.one:demo")?.includes("super-secret-token"));
  assert.ok(vaultB.getOpaque("pkgconn:spc_b:pkg.one:demo")?.includes("other-token"));
  assert.equal(existsSync(join(spaceA.path("packages/pkg.one"), "connection-secrets.json")), false);
});

test("package RPC never accepts connection tokens from sandbox JS", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-auth-rpc-"));
  const storage = spaceStorage(join(root, "space"));
  const manifest = {
    ...loadCanonicalManifest(exampleHello).canonical,
    capabilities: [{ name: "auth.connection" }],
    connections: [{ id: "demo", label: "Demo", kind: "token" as const, origins: ["https://api.example.com"] }],
  };
  grantCapabilities(storage, manifest.id, [{ name: "auth.connection" }]);
  const deps = {
    space: { spaceId: "spc_a", userId: "usr_a" },
    storage,
    sessions: { snapshot: async () => ({ id: "s", title: "S", status: "idle", spaceId: "spc_a" }) },
    projects: { get: async () => undefined },
    appendEvent: async () => ({}),
    manifest,
    enabled: true,
  };
  await assert.rejects(
    () => invokePackageRpc(deps as never, "auth.connect", { id: "demo", token: "super-secret-token" }),
    /host/i,
  );
  await assert.rejects(
    () => invokePackageRpc(deps as never, "auth.oauthComplete", {
      id: "demo",
      code: "stolen",
      state: "x",
      redirectUri: "https://example.com",
    }),
    /unknown method/i,
  );
});

test("connection credentials are bound to declared origins", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-conn-origin-"));
  const storage = spaceStorage(join(root, "space"));
  const spec = {
    id: "demo",
    label: "Demo",
    kind: "token" as const,
    origins: ["https://jsonplaceholder.typicode.com"],
  };
  const manifest = {
    ...loadCanonicalManifest(exampleHello).canonical,
    capabilities: [
      { name: "auth.connection" as const },
      { name: "network.fetch" as const, constraints: { origins: ["https://jsonplaceholder.typicode.com", "https://api.example.com"] } },
    ],
    connections: [spec],
  };
  grantCapabilities(storage, manifest.id, manifest.capabilities);
  approveConnectionDefinitions(storage, manifest.id, manifest.connections ?? [], (manifest.connections ?? []).map((item) => item.id));
  await setTokenConnection({
    storage,
    spaceId: "spc_a",
    vault: memoryOpaqueVault(),
  }, manifest.id, spec, "super-secret-token");
  const deps = {
    space: { spaceId: "spc_a", userId: "usr_a" },
    storage,
    sessions: { snapshot: async () => ({ id: "s", title: "S", status: "idle", spaceId: "spc_a" }) },
    projects: { get: async () => undefined },
    appendEvent: async () => ({}),
    manifest,
    enabled: true,
  };
  await assert.rejects(
    () => invokePackageRpc(deps as never, "network.fetch", {
      url: "https://api.example.com/leak",
      connectionId: "demo",
    }),
    /not bound|NETWORK_ORIGIN_DENIED/,
  );
});

test("attachments.create and session.appendContext use distinct event types", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-ctx-"));
  const storage = spaceStorage(join(root, "space"));
  const events: Array<{ type: string }> = [];
  const manifest = {
    ...loadCanonicalManifest(exampleHello).canonical,
    capabilities: [
      { name: "attachments.create" as const },
      { name: "session.appendContext" as const },
    ],
  };
  grantCapabilities(storage, manifest.id, manifest.capabilities);
  const deps = {
    space: { spaceId: "spc_a", userId: "usr_a" },
    storage,
    sessions: { snapshot: async () => ({ id: "ses_a", title: "A", status: "idle", spaceId: "spc_a" }) },
    projects: { get: async () => undefined },
    appendEvent: async (_id: string, type: string) => {
      events.push({ type });
      return {};
    },
    manifest,
    enabled: true,
    sessionId: "ses_a",
  };
  await invokePackageRpc(deps as never, "attachments.create", { title: "Item", text: "one" });
  await invokePackageRpc(deps as never, "session.appendContext", { text: "two" });
  assert.deepEqual(events.map((item) => item.type), ["package/attached", "package/context"]);
});

test("sandbox bundle refuses filesystem escapes including symlinks", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-confine-"));
  const pkg = join(root, "pkg");
  writeSandbox(pkg, {});
  writeFileSync(join(root, "secret.ts"), "export const leaked = 1;\n");
  writeFileSync(join(pkg, "ui.ts"), 'import "../secret.ts";\n');
  await assert.rejects(
    () => buildSandboxBundle({
      installDir: pkg,
      entryPath: "ui.ts",
      outDir: join(pkg, ".polyth", "sandbox"),
    }),
    /escapes the package/,
  );
  symlinkSync(join(root, "secret.ts"), join(pkg, "linked.ts"));
  writeFileSync(join(pkg, "ui.ts"), 'import "./linked.ts";\n');
  await assert.rejects(
    () => buildSandboxBundle({
      installDir: pkg,
      entryPath: "ui.ts",
      outDir: join(pkg, ".polyth", "sandbox"),
    }),
    /escapes the package/,
  );
});

test("installer rejects private HTTPS destinations", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-install-ssrf-"));
  await assert.rejects(
    () => stageInstallSource({
      source: "https://127.0.0.1/plugin.zip",
      staging: join(root, "staging"),
    }),
    /private|blocked|loopback/,
  );
  await assert.rejects(
    () => stageInstallSource({
      source: "zip:https://169.254.169.254/latest/meta-data",
      staging: join(root, "staging2"),
    }),
    /private|blocked/,
  );
});

test("uninstall sweeps package data from every Space", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-sweep-"));
  const dataDir = join(root, "data");
  const spaces: SpaceStorage[] = [
    testSpaceStorage(join(dataDir, "spaces", "spc_a")),
    testSpaceStorage(join(dataDir, "spaces", "spc_b")),
  ];
  const keep = join(spaces[0]!.root, "packages", "other-pkg");
  const gone = spaces[0]!.packageDir("com-example-hello");
  const goneB = spaces[1]!.packageDir("com-example-hello");
  mkdirSync(keep, { recursive: true });
  mkdirSync(gone, { recursive: true });
  mkdirSync(goneB, { recursive: true });
  writeFileSync(join(gone, "kv.json"), "{}");
  const reg = createPluginRegistry({
    dir: join(root, "installed"),
    packageSpaces: () => spaces.map((storage, i) => ({ spaceId: `spc_${i}`, storage })),
    trustedDir: join(root, "trusted"),
  });
  mkdirSync(join(root, "trusted", "demo"), { recursive: true });
  writeSandbox(join(root, "trusted", "demo"), { id: "com-example-hello" });
  await reg.install("file:demo");
  await reg.remove("com-example-hello");
  assert.equal(existsSync(gone), false);
  assert.equal(existsSync(goneB), false);
  assert.equal(existsSync(keep), true);
});

