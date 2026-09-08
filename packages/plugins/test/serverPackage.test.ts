import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bindPackageServices,
  createServerServiceRegistry,
  discoverServerPackages,
  loadServerPackage,
  serverServiceKey,
  type ServerPackageHost,
} from "../src/serverPackage.ts";

const packagesFixture = (): string => mkdtempSync(join(tmpdir(), "polyth-server-packages-"));

const writePackage = (
  packagesDir: string,
  dirName: string,
  manifest: Record<string, unknown>,
  entrySource?: string,
): string => {
  const dir = join(packagesDir, dirName);
  mkdirSync(dir, { recursive: true });
  const polyth = manifest.polyth as Record<string, unknown> | undefined;
  const withDescriptor = polyth?.serverEntry !== undefined && polyth.descriptor === undefined
    ? {
        ...manifest,
        polyth: {
          ...polyth,
          descriptor: {
            name: dirName,
            description: `${dirName} test package`,
            core: false,
            enabled: true,
            hasSettings: false,
          },
        },
      }
    : manifest;
  writeFileSync(join(dir, "package.json"), JSON.stringify(withDescriptor));
  if (entrySource !== undefined) writeFileSync(join(dir, "server.mjs"), entrySource);
  return dir;
};

const hostStub = (overrides: Record<string, unknown> = {}): ServerPackageHost => ({
  pluginId: "test",
  storageDir: "/tmp",
  routes: { add: () => ({ dispose() {} }) },
  ...overrides,
}) as unknown as ServerPackageHost;

test("discovery collects only packages with a polyth.serverEntry marker, sorted by id", async () => {
  const packagesDir = packagesFixture();
  writePackage(packagesDir, "zeta", {
    name: "@polyth/zeta",
    polyth: { serverEntry: "./server.mjs" },
  }, "export default () => ({})");
  writePackage(packagesDir, "alpha", {
    name: "@polyth/alpha",
    polyth: { serverEntry: "./server.mjs" },
  }, "export default () => ({})");
  writePackage(packagesDir, "unmarked", { name: "@polyth/unmarked" });
  mkdirSync(join(packagesDir, "no-manifest"));
  writeFileSync(join(packagesDir, "stray-file"), "not a package");

  const discovered = await discoverServerPackages(packagesDir);
  assert.deepEqual(discovered.map((d) => d.id), ["alpha", "zeta"]);
  assert.deepEqual(discovered.map((d) => d.packageName), ["@polyth/alpha", "@polyth/zeta"]);
  assert.equal(discovered[0]!.entryPath, "./server.mjs");
  assert.equal(discovered[0]!.descriptor.name, "alpha");
});

test("discovery rejects marked infrastructure packages and invalid entry paths", async () => {
  const infraDir = packagesFixture();
  writePackage(infraDir, "server", {
    name: "@polyth/server",
    polyth: { serverEntry: "./server.mjs" },
  });
  await assert.rejects(() => discoverServerPackages(infraDir), /infrastructure package "server"/);

  const escapeDir = packagesFixture();
  writePackage(escapeDir, "escapee", {
    name: "@polyth/escapee",
    polyth: { serverEntry: "../outside.mjs" },
  });
  await assert.rejects(() => discoverServerPackages(escapeDir), /relative path without/);
});

test("discovery of a missing packages directory is empty, never a crash", async () => {
  assert.deepEqual(await discoverServerPackages("/nonexistent/packages-dir"), []);
});

test("loader runs registerPackage with the host and returns the server package", async () => {
  const packagesDir = packagesFixture();
  writePackage(packagesDir, "feature", {
    name: "@polyth/feature",
    polyth: { serverEntry: "./server.mjs" },
  }, `
    export default (host) => ({
      routes: async (request) => request.path === "/api/feature/" + host.pluginId,
      onEnable() {},
      onDisable() {},
    });
  `);

  const [discovered] = await discoverServerPackages(packagesDir);
  const pkg = await loadServerPackage(discovered!, hostStub({ pluginId: "feature" }));
  assert.equal(typeof pkg.routes, "function");
  assert.equal(typeof pkg.onEnable, "function");
  assert.equal(await pkg.routes!({ path: "/api/feature/feature" } as never), true);
  assert.equal(await pkg.routes!({ path: "/api/other" } as never), false);
});

test("loader rejects entries that escape the package directory via symlink", async () => {
  const packagesDir = packagesFixture();
  const outside = join(packagesDir, "outside.mjs");
  writeFileSync(outside, "export default () => ({})");
  const dir = writePackage(packagesDir, "sneaky", {
    name: "@polyth/sneaky",
    polyth: { serverEntry: "./server.mjs" },
  });
  symlinkSync(outside, join(dir, "server.mjs"));

  const [discovered] = await discoverServerPackages(packagesDir);
  await assert.rejects(
    () => loadServerPackage(discovered!, hostStub()),
    /escapes its package directory/,
  );
});

test("loader rejects entries without a default factory or with a bad return shape", async () => {
  const packagesDir = packagesFixture();
  writePackage(packagesDir, "no-default", {
    name: "@polyth/no-default",
    polyth: { serverEntry: "./server.mjs" },
  }, "export const nothing = true;");
  writePackage(packagesDir, "bad-shape", {
    name: "@polyth/bad-shape",
    polyth: { serverEntry: "./server.mjs" },
  }, "export default () => ({ routes: 42 });");

  const discovered = await discoverServerPackages(packagesDir);
  const byId = new Map(discovered.map((d) => [d.id, d]));
  await assert.rejects(
    () => loadServerPackage(byId.get("no-default")!, hostStub()),
    /must default-export a registerPackage/,
  );
  await assert.rejects(
    () => loadServerPackage(byId.get("bad-shape")!, hostStub()),
    /non-function "routes"/,
  );
});

test("service registry provides once, resolves by key id, and reports missing services", () => {
  const services = createServerServiceRegistry();
  const key = serverServiceKey<{ ping(): string }>("git");
  services.provide(key, { ping: () => "pong" });

  // A separately created key with the same name resolves the same service.
  assert.equal(services.require(serverServiceKey<{ ping(): string }>("git")).ping(), "pong");
  assert.equal(services.get(serverServiceKey("missing")), undefined);
  assert.throws(() => services.require(serverServiceKey("missing")), /not provided/);
  assert.throws(() => services.provide(key, { ping: () => "again" }), /already provided/);
  assert.deepEqual(services.ids(), ["polyth.service.git"]);
});

test("bindPackageServices forces capability owner to the package id", () => {
  const registered: Array<{ owner: string; descriptorOwner: string }> = [];
  const registry = {
    register(owner: string, contribution: { descriptor: { owner: string } }) {
      registered.push({ owner, descriptorOwner: contribution.descriptor.owner });
      return { dispose() {} };
    },
    list: () => [],
    resolve: () => [],
    executor: (_id?: string) => undefined,
  };
  const services = createServerServiceRegistry();
  services.provide(serverServiceKey("harness.capabilities"), registry);
  bindPackageServices(services, "example-feature")
    .require(serverServiceKey<typeof registry>("harness.capabilities"))
    .register("polyth", { descriptor: { owner: "polyth" } });
  assert.deepEqual(registered, [{ owner: "example-feature", descriptorOwner: "example-feature" }]);
  assert.equal(
    bindPackageServices(services, "example-feature")
      .require(serverServiceKey<typeof registry>("harness.capabilities"))
      .executor("other.tool"),
    undefined,
  );
});
