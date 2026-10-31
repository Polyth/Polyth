import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  HARNESS_PERSON_DEFAULTS_SERVICE,
  type HarnessDescriptor,
  type HarnessPersonDefaults,
  type HarnessProvider,
  type SpaceContext,
  type SpaceStorage,
} from "@polyth/contracts";
import {
  bindPackageServices,
  createServerServiceRegistry,
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import { createCapabilityContributionRegistry } from "../src/contextualCapabilities.ts";
import { createHarnessRegistry } from "../src/index.ts";
import registerPackage, { harnessRoutes } from "../src/serverEntry.ts";

type RouteRequest = Parameters<NonNullable<ServerPackage["routes"]>>[0];

const provider = (descriptor: Partial<HarnessDescriptor> & { id: string }): HarnessProvider => ({
  descriptor: { name: descriptor.id, integration: "test", priority: 10, ...descriptor },
  async probe() {
    return { harnessId: descriptor.id, state: "ready", installed: true, healthy: true, authenticated: true, checkedAt: 1 };
  },
  async createRuntime() {
    throw new Error("runtime is not used by this test");
  },
} as HarnessProvider);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "polyth-person-default-"));
  const harnesses = createHarnessRegistry();
  harnesses.register(provider({ id: "claude" }));
  harnesses.register(provider({ id: "claude-ida", accountOwnerUserId: "u-ida", autoSelect: false }));
  harnesses.register(provider({ id: "claude-team", accountAllowedSpaceIds: ["work"] }));
  const services = createServerServiceRegistry();
  services.provide(serverServiceKey("harnesses"), harnesses);
  services.provide(serverServiceKey("harness.capabilities"), createCapabilityContributionRegistry());
  const spaceStorage = (ctx: SpaceContext): SpaceStorage => ({
    root: join(root, "spaces", ctx.spaceId),
    packageDir: (packageId) => join(root, "spaces", ctx.spaceId, "packages", packageId),
    path: (relative) => join(root, "spaces", ctx.spaceId, relative),
  });
  const host = {
    pluginId: "harness-runtime",
    services: bindPackageServices(services, "harness-runtime"),
    spaceStorage,
    forSpace: () => ({ projects: { list: async () => [], get: async () => undefined }, sessions: {} }),
    people: {
      storage: (userId: string, packageId: string) => {
        assert.equal(packageId, "harness-runtime");
        const dir = join(root, "people", userId, "packages", packageId);
        return { root: dir, path: (relative: string) => join(dir, relative) };
      },
    },
  } as unknown as ServerPackageHost;
  const ctx = (userId: string, spaceId: string, extra: Record<string, unknown> = {}) =>
    ({ userId, spaceId, spaceSlug: spaceId, role: "member", storageDir: join(root, "spaces", spaceId), ...extra }) as SpaceContext;
  const routes = harnessRoutes(host);
  const call = async (space: SpaceContext, method: "GET" | "PUT", body: Record<string, unknown> = {}) => {
    let reply: { code: number; body: any } | undefined;
    await routes({
      method,
      path: "/api/harnesses/default",
      url: new URL("http://polyth.test/api/harnesses/default"),
      space,
      principal: { kind: "ui-session" },
      body: async () => body,
      json: (code: number, payload: unknown) => { reply = { code, body: payload }; },
    } as unknown as RouteRequest);
    return reply!;
  };
  return { root, host, services, ctx, call };
}

test("a person's default harness is their own, Space-checked at write and at use", async () => {
  const f = await fixture();
  const ida = f.ctx("u-ida", "home");
  const bob = f.ctx("u-bob", "home");

  assert.deepEqual((await f.call(ida, "GET")).body, { harnessId: null, usable: false });
  assert.deepEqual((await f.call(ida, "PUT", { harnessId: "claude-ida" })).body, { harnessId: "claude-ida", usable: true });
  // Stored with the person, outside every Space.
  assert.deepEqual(JSON.parse(await readFile(join(f.root, "people", "u-ida", "packages", "harness-runtime", "default-harness.json"), "utf8")), { harnessId: "claude-ida" });
  // Another person never sees it, and cannot choose someone's private login.
  assert.deepEqual((await f.call(bob, "GET")).body, { harnessId: null, usable: false });
  await assert.rejects(f.call(bob, "PUT", { harnessId: "claude-ida" }), { code: "not-found" });
  // A shared login limited to another Space, one off the person's account
  // limits and an unknown one are refused at write time.
  await assert.rejects(f.call(bob, "PUT", { harnessId: "claude-team" }), { code: "not-found" });
  await assert.rejects(f.call(f.ctx("u-bob", "home", { allowedHarnesses: ["codex"] }), "PUT", { harnessId: "claude" }), { code: "not-found" });
  await assert.rejects(f.call(bob, "PUT", { harnessId: "nope" }), { code: "not-found" });
  await assert.rejects(f.call(bob, "PUT", { harnessId: "../x" }), { code: "invalid-input" });
  await assert.rejects(f.call(bob, "PUT", {}), { code: "invalid-input" });
  assert.deepEqual((await f.call(f.ctx("u-bob", "work"), "PUT", { harnessId: "claude-team" })).body, { harnessId: "claude-team", usable: true });
  // At use time the same choice is ignored where it is not usable.
  assert.deepEqual((await f.call(bob, "GET")).body, { harnessId: "claude-team", usable: false });
  // System work has no person to store a default for.
  await assert.rejects(f.call(f.ctx("system:polyth-runtime", "home"), "PUT", { harnessId: "claude" }), { code: "unsupported" });
  assert.deepEqual((await f.call(ida, "PUT", { harnessId: null })).body, { harnessId: null, usable: false });
});

test("the session facade reads only a usable default, only while the package is enabled", async () => {
  const f = await fixture();
  const pkg = registerPackage(f.host);
  const service = f.services.require(serverServiceKey<HarnessPersonDefaults>(HARNESS_PERSON_DEFAULTS_SERVICE));
  await f.call(f.ctx("u-bob", "work"), "PUT", { harnessId: "claude-team" });
  assert.equal(await service.usableDefault(f.ctx("u-bob", "work")), undefined, "disabled package pins nothing");
  await pkg.onEnable?.();
  assert.equal(await service.usableDefault(f.ctx("u-bob", "work")), "claude-team");
  assert.equal(await service.usableDefault(f.ctx("u-bob", "home")), undefined, "foreign Space");
  assert.equal(await service.usableDefault(f.ctx("u-ida", "work")), undefined, "foreign person");
  assert.equal(await service.usableDefault(f.ctx("u-bob", "work", { allowedHarnesses: ["claude"] })), undefined, "account limits");
  // Turned off in the Space's harness preferences: ignored.
  await mkdir(join(f.root, "spaces", "work", "harnesses"), { recursive: true });
  await writeFile(join(f.root, "spaces", "work", "harnesses", "preferences.json"), JSON.stringify({ "claude-team": { enabled: false, priority: 1 } }));
  assert.equal(await service.usableDefault(f.ctx("u-bob", "work")), undefined, "disabled in the Space");
  await pkg.onDisable?.();
});
