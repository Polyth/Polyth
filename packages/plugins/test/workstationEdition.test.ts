// The workstation edition installs nothing from a source and checks no source
// on a timer (docs/security/workstation-edition.md). The standard edition keeps
// the same behavior as before; the edition is read from the environment, so
// each case sets and restores it.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packDirectory } from "@polyth/package-sdk/manifest";
import { EDITION_UNAVAILABLE_CODE } from "@polyth/contracts/edition";
import type { RouteHandler, RouteRequest, SessionEvent, SpaceContext, SpaceStorage } from "@polyth/contracts";
import type { InstalledPluginDto } from "@polyth/contracts";
import { createPluginRegistry } from "../src/managedRegistry.ts";
import { managedPluginRoutes } from "../src/managedPluginRoutes.ts";
import { LOCAL_SOURCE_TICK_MS, runAutoUpdates, runLocalSourceUpdates, startAutoUpdater } from "../src/autoUpdate.ts";
import type { ServerPackageHost } from "../src/serverPackage.ts";

function writePackage(dir: string, version: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "ui.ts"), [
    'import { connectPolyth } from "@polyth/package-sdk";',
    "await connectPolyth();",
  ].join("\n"));
  writeFileSync(join(dir, "polyth-package.json"), JSON.stringify({
    manifestVersion: 2,
    id: "com-example-edition",
    version,
    display: { name: "Edition demo", description: "Installed from an uploaded archive." },
    runtime: { kind: "sandboxed", ui: { entry: "ui.ts" } },
    contributes: { surfaces: [{ id: "main", title: "Edition demo" }] },
    capabilities: ["ui.render"],
  }));
}

const space = () => ({
  spaceId: "spc_edition",
  userId: "user-1",
  role: "owner",
  instanceOwner: true,
}) as unknown as SpaceContext;

function storageFor(root: string): SpaceStorage {
  mkdirSync(root, { recursive: true });
  return {
    root,
    packageDir(id: string) {
      const dir = join(root, "packages", id);
      mkdirSync(dir, { recursive: true });
      return dir;
    },
    path(relative: string) {
      return join(root, ...relative.split("/"));
    },
  } as unknown as SpaceStorage;
}

function hostFor(root: string): ServerPackageHost {
  const spaceStorage = storageFor(root);
  return {
    spaceStorage: () => spaceStorage,
    packageSpaces: () => [{ spaceId: "spc_edition", storage: spaceStorage }],
    events: { append: async (...args: unknown[]) => ({ ...(args as object[]) } as unknown as SessionEvent) },
    sessions: { events: async () => [], snapshot: async () => { throw new Error("unused"); } },
    projects: { get: async () => undefined },
  } as unknown as ServerPackageHost;
}

async function post(handler: RouteHandler, path: string, body: Record<string, unknown>): Promise<unknown> {
  return await call(handler, "POST", path, body);
}

async function call(handler: RouteHandler, method: string, path: string, body: Record<string, unknown>): Promise<unknown> {
  let payload: unknown;
  const handled = await handler({
    req: {},
    res: { writeHead: () => {}, end: () => {} },
    url: new URL(`http://x${path}`),
    path,
    method,
    ingress: { kind: "public-http" },
    principal: { kind: "local-user", userId: "user-1" },
    space: space(),
    requireCapability: () => {},
    body: async () => body,
    json: (_code: number, value: unknown) => { payload = value; },
  } as unknown as RouteRequest);
  assert.equal(handled, true);
  return payload;
}

type AutoUpdaterRegistry = Parameters<typeof runAutoUpdates>[0]["registry"]
  & Parameters<typeof startAutoUpdater>[0]["registry"];

const withEdition = async <T>(edition: string | undefined, run: () => Promise<T>): Promise<T> => {
  const previous = process.env.POLYTH_EDITION;
  if (edition === undefined) delete process.env.POLYTH_EDITION;
  else process.env.POLYTH_EDITION = edition;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.POLYTH_EDITION;
    else process.env.POLYTH_EDITION = previous;
  }
};

/** Fails the test if anything reaches the network during `run`. */
async function withoutNetwork<T>(run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL) => {
    calls.push(String(input));
    throw new Error("the workstation edition must not reach the network");
  }) as typeof fetch;
  try {
    const result = await run();
    assert.deepEqual(calls, [], "no network request");
    return result;
  } finally {
    globalThis.fetch = original;
  }
}

test("workstation: POST /api/plugins/install refuses a source before any download", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-edition-install-"));
  try {
    const registry = createPluginRegistry({ dir: join(root, "installed") });
    const routes = managedPluginRoutes(registry, hostFor(join(root, "data")));
    await withEdition("workstation", () => withoutNetwork(async () => {
      await assert.rejects(
        () => post(routes, "/api/plugins/install", { source: "https://github.com/acme/example-package" }),
        (error: Error & { code?: string }) => {
          assert.equal(error.code, EDITION_UNAVAILABLE_CODE);
          assert.equal((error as { status?: number }).status, 403);
          return true;
        },
      );
      assert.equal(registry.list().length, 0, "nothing was installed");
    }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("standard: the same install request still installs as before", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-standard-install-"));
  try {
    const source = join(root, "src");
    writePackage(source, "1.0.0");
    const archive = await packDirectory(source);
    const registry = createPluginRegistry({ dir: join(root, "installed") });
    const routes = managedPluginRoutes(registry, hostFor(join(root, "data")));
    const installed = await withEdition(undefined, () => post(routes, "/api/plugins/install", {
      archive: archive.toString("base64"),
      filename: "edition.zip",
    })) as Record<string, unknown>;
    assert.equal(installed.id, "com-example-edition");
    assert.equal(installed.version, "1.0.0");
    assert.equal(registry.list().length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workstation: check-updates and the per-package update and check-update routes are refused", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-edition-updates-"));
  try {
    const registry = createPluginRegistry({ dir: join(root, "installed") });
    const routes = managedPluginRoutes(registry, hostFor(join(root, "data")));
    await withEdition("workstation", () => withoutNetwork(async () => {
      for (const path of [
        "/api/plugins/check-updates",
        "/api/plugins/com-example-edition/update",
        "/api/plugins/com-example-edition/check-update",
      ]) {
        await assert.rejects(() => post(routes, path, {}), (error: Error & { code?: string }) => {
          assert.equal(error.code, EDITION_UNAVAILABLE_CODE, path);
          return true;
        });
      }
    }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workstation: disabling and removing a package that is already present keeps working", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-edition-lifecycle-"));
  try {
    const source = join(root, "src");
    writePackage(source, "1.0.0");
    const archive = await packDirectory(source);
    const registry = createPluginRegistry({ dir: join(root, "installed") });
    await registry.installArchive(archive, "edition.zip");
    const host = hostFor(join(root, "data"));
    const storage = host.spaceStorage(space());
    const routes = managedPluginRoutes(registry, host);
    await withEdition("workstation", () => withoutNetwork(async () => {
      await post(routes, "/api/plugins/com-example-edition/disable", {});
      assert.equal(registry.isEnabled("com-example-edition", storage), false);
      await call(routes, "DELETE", "/api/plugins/com-example-edition", {});
      assert.equal(registry.list(storage).length, 0);
    }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workstation: the auto-update timer schedules nothing and checks no source", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const checked: string[] = [];
  const registry = {
    list: () => [{ id: "one", autoUpdate: true, updatable: true }],
    changedLocalSources: () => ["one"],
    checkUpdate: async (id: string) => {
      checked.push(id);
      return { id, updateCheck: { checkedAt: 0, available: true } } as unknown as InstalledPluginDto;
    },
    update: async (id: string) => ({ id, updateCheck: { checkedAt: 0, available: true } }) as unknown as InstalledPluginDto,
  } as unknown as AutoUpdaterRegistry;
  const applied: string[] = [];
  await withEdition("workstation", async () => {
    const updater = startAutoUpdater({ registry, apply: async (id: string) => { applied.push(id); } });
    t.mock.timers.tick(2 * 60 * 1000);
    t.mock.timers.tick(LOCAL_SOURCE_TICK_MS * 30);
    for (let i = 0; i < 5; i += 1) await new Promise((done) => setImmediate(done));
    updater.dispose();
    assert.deepEqual(checked, [], "no check on the timer");
    assert.equal(applied.length, 0);
    assert.deepEqual(await runAutoUpdates({ registry, apply: async (id: string) => { applied.push(id); } }), []);
    assert.deepEqual(await runLocalSourceUpdates({ registry, apply: async (id: string) => { applied.push(id); } }), []);
  });
  assert.deepEqual(checked, [], "not even a local-source pass runs");
});

test("standard: the auto-update pass still checks each opted-in package", async () => {
  const checked: string[] = [];
  let changed = ["one", "two"];
  const registry = {
    list: () => [{ id: "one", autoUpdate: true, updatable: true }, { id: "two", autoUpdate: true, updatable: true }],
    changedLocalSources: () => changed,
    checkUpdate: async (id: string) => {
      checked.push(id);
      changed = [];
      return { id, updateCheck: { checkedAt: 0, available: false } } as unknown as InstalledPluginDto;
    },
    update: async (id: string) => ({ id }) as unknown as InstalledPluginDto,
  } as unknown as AutoUpdaterRegistry;
  const updated = await withEdition(undefined, () => runAutoUpdates({ registry, apply: async () => {} }));
  assert.deepEqual(checked, ["one", "two"]);
  assert.deepEqual(updated, []);
  changed = ["one", "two"];
  assert.deepEqual(await runLocalSourceUpdates({ registry, apply: async () => {} }), []);
  assert.deepEqual(checked, ["one", "two", "one", "two"]);
});
