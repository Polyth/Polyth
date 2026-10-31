import test, { afterEach, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import dns from "node:dns/promises";
import https from "node:https";
import type { IncomingMessage } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough, Readable } from "node:stream";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packDirectory } from "@polyth/package-sdk/manifest";
import { createPluginRegistry } from "../src/managedRegistry.ts";
import { stageInstallSource } from "../src/installSources.ts";
import { MAX_INSTALL_BYTES } from "../src/networkBroker.ts";
import registerPlugins, { withInstallAuthority } from "../src/serverEntry.ts";
import { createServerServiceRegistry, serverServiceKey, type ServerPackageHost } from "../src/serverPackage.ts";

const source = "https://github.com/acme/private-package";
let publicStatus = 404;
let publicArchive: Buffer = Buffer.alloc(0);
let publicRequests: string[] = [];

beforeEach(() => {
  publicStatus = 404;
  publicArchive = Buffer.alloc(0);
  publicRequests = [];
  mock.method(childProcess, "spawnSync", () => { throw new Error("checkout must not run"); });
  mock.method(dns, "lookup", (async () => [{ address: "93.184.216.34", family: 4 }]) as unknown as typeof dns.lookup);
  mock.method(https, "request", ((options: https.RequestOptions, callback: (response: IncomingMessage) => void) => {
    publicRequests.push(options.path!);
    const request = Object.assign(new PassThrough(), { setTimeout() { return this; } });
    request.on("finish", () => callback(Object.assign(Readable.from([publicArchive]), {
      statusCode: publicStatus, headers: {},
    }) as IncomingMessage));
    return request;
  }) as unknown as typeof https.request);
  syncBuiltinESMExports();
});

afterEach(() => {
  mock.restoreAll();
  syncBuiltinESMExports();
});

function writePackage(dir: string, version: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "polyth-package.json"), JSON.stringify({
    manifestVersion: 2, id: "com-example-private", version,
    display: { name: "Private package", description: "Authenticated repository fixture." },
    runtime: { kind: "sandboxed" },
    contributes: { commands: [{ id: "hello", name: "hello", description: "Say hello" }] },
  }));
}

test("installation and updates use authenticated archives and keep the original source", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-private-install-"));
  const calls: string[] = [];
  let archive: Buffer;
  const registry = createPluginRegistry({
    dir: join(root, "installed"),
    downloadRepository: async (value, maxBytes) => {
      calls.push(value);
      assert.equal(publicRequests.length, calls.length, "public acquisition precedes each authenticated request");
      assert.equal(maxBytes, MAX_INSTALL_BYTES);
      return archive;
    },
  });
  try {
    const pkg = join(root, "package");
    writePackage(pkg, "1.0.0");
    archive = await packDirectory(pkg);
    const installed = await registry.install(source);
    assert.equal(installed.id, "com-example-private");
    assert.equal(installed.version, "1.0.0");
    assert.equal(installed.source, source);
    writePackage(pkg, "1.1.0");
    archive = await packDirectory(pkg);
    const updated = await registry.update(installed.id);
    assert.equal(updated.version, "1.1.0");
    assert.equal(updated.previousVersion, "1.0.0");
    assert.equal(updated.source, source);
    assert.deepEqual(calls, [source, source]);
    assert.deepEqual(readdirSync(join(root, "installed", ".staging")), []);
  } finally {
    await registry.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a successful public repository archive skips authenticated acquisition", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-public-install-"));
  try {
    const pkg = join(root, "package");
    writePackage(pkg, "1.0.0");
    publicArchive = await packDirectory(pkg);
    publicStatus = 200;
    const staged = await stageInstallSource({
      source, staging: join(root, "staging"),
      downloadRepository: async () => { throw new Error("authentication must not run"); },
    });
    assert.equal(staged.trustedLocal, false);
    assert.deepEqual(publicRequests, ["/acme/private-package/zip/HEAD"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const status of [403, 500, 200]) {
  test(`a public ${status === 200 ? "invalid ZIP" : `HTTP ${status}`} never starts authenticated acquisition`, async () => {
    const root = mkdtempSync(join(tmpdir(), "polyth-public-failure-"));
    publicStatus = status;
    publicArchive = Buffer.from("invalid archive");
    let authenticated = false;
    try {
      await assert.rejects(() => stageInstallSource({
        source, staging: root,
        downloadRepository: async () => { authenticated = true; throw new Error("authentication must not run"); },
      }), status === 200 ? /zip|archive/i : new RegExp(`HTTP ${status}`));
      assert.equal(authenticated, false);
      assert.equal(publicRequests.length, 1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("an authenticated archive cannot bypass the download size ceiling", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-private-limit-"));
  try {
    await assert.rejects(() => stageInstallSource({
      source, staging: root,
      downloadRepository: async () => Buffer.alloc(MAX_INSTALL_BYTES + 1),
    }), /too large/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an authenticated failure is propagated after the missing public archive without retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-private-denied-"));
  const denied = new Error("Authenticated repository access denied");
  try {
    await assert.rejects(() => stageInstallSource({
      source, staging: root, downloadRepository: async () => { throw denied; },
    }), error => error === denied);
    assert.deepEqual(publicRequests, ["/acme/private-package/zip/HEAD"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a missing public archive retains checkout fallback when the provider returns no archive", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-missing-install-"));
  const commands: string[] = [];
  mock.method(childProcess, "spawnSync", ((command: string) => {
    commands.push(command);
    return { status: 1 };
  }) as unknown as typeof childProcess.spawnSync);
  syncBuiltinESMExports();
  try {
    await assert.rejects(() => stageInstallSource({
      source, staging: root, downloadRepository: async () => null,
    }), /Repository archive not found \(HTTP 404\)/);
    assert.deepEqual(commands, ["gh", "git", "git"]);
    assert.equal(publicRequests.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("authenticated downloads retain the trusted-local runtime restriction", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-private-trust-"));
  const pkg = join(root, "package");
  mkdirSync(pkg);
  writeFileSync(join(pkg, "server.ts"), "export default () => ({});\n");
  writeFileSync(join(pkg, "polyth-package.json"), JSON.stringify({
    manifestVersion: 2, id: "com-example-trusted", version: "1.0.0",
    display: { name: "Native package", description: "Requires trusted installation." },
    runtime: { kind: "trusted-local", server: "server.ts" },
  }));
  const archive = await packDirectory(pkg);
  const registry = createPluginRegistry({ dir: join(root, "installed"), downloadRepository: async () => archive });
  try {
    await assert.rejects(() => registry.install(source), /trusted local source/);
    assert.equal(registry.has("com-example-trusted"), false);
  } finally {
    await registry.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the plugins package resolves GitHub acquisition lazily through its service", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-private-service-"));
  const services = createServerServiceRegistry();
  services.provide(serverServiceKey("plugins.config"), {});
  const host = { storageDir: root, services, packageSpaces: () => [], routes: { add: () => ({ dispose() {} }) }, broadcast: {} } as unknown as ServerPackageHost;
  const pkg = registerPlugins(host);
  await pkg.onEnable?.();
  let calls = 0;
  // Provider registration happens after plugin enable to exercise late binding.
  services.provide(serverServiceKey("github"), { downloadArchive: async (value: string, maxBytes: number) => {
    calls++;
    assert.equal(value, source);
    assert.equal(maxBytes, MAX_INSTALL_BYTES);
    throw new Error("late provider reached");
  } });
  try {
    const registry = services.require<ReturnType<typeof createPluginRegistry>>(serverServiceKey("plugins.managed"));
    // The host's gh login is the instance owner's: anyone else, or no install
    // context at all, is refused before the provider runs.
    await assert.rejects(() => withInstallAuthority(false, () => registry.install(source)), { code: "forbidden" });
    await assert.rejects(() => registry.install(source), { code: "forbidden" });
    assert.equal(calls, 0);
    await assert.rejects(() => withInstallAuthority(true, () => registry.install(source)), /late provider reached/);
    assert.equal(calls, 1);
  } finally {
    await pkg.onDisable?.();
    rmSync(root, { recursive: true, force: true });
  }
});
