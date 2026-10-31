import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { HarnessProvider, ModelDescriptor, SpaceContext, SpaceStorage } from "@polyth/contracts";
import {
  bindPackageServices,
  createServerServiceRegistry,
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import { createHarnessRegistry } from "../src/index.ts";
import { harnessRoutes } from "../src/serverEntry.ts";

type RouteRequest = Parameters<NonNullable<ServerPackage["routes"]>>[0];

const provider = (id: string, models: ModelDescriptor[]): HarnessProvider => ({
  descriptor: { id, name: id, integration: "test", priority: 10 },
  async probe() {
    return { harnessId: id, state: "ready", installed: true, healthy: true, authenticated: true, checkedAt: 1 };
  },
  async createRuntime() {
    throw new Error("runtime is not used by this test");
  },
  async discover() {
    return { state: "ready" as const, authenticated: true, catalog: { models, agents: [] } };
  },
} as HarnessProvider);

const roots: string[] = [];
test.after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "polyth-snapshot-visibility-"));
  roots.push(root);
  const harnesses = createHarnessRegistry();
  harnesses.register(provider("opencode", [
    { providerID: "openrouter", modelID: "deepseek", name: "DeepSeek" },
    { providerID: "openrouter", modelID: "hidden", name: "Hidden" },
  ]));
  harnesses.register(provider("cursor", [
    { providerID: "cursor", modelID: "auto", name: "Auto" },
  ]));
  const services = createServerServiceRegistry();
  services.provide(serverServiceKey("harnesses"), harnesses);
  services.provide(serverServiceKey("models.visibility"), {
    filter: (models: ModelDescriptor[]) => models.filter((model) => model.modelID !== "hidden"),
  });
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
  } as unknown as ServerPackageHost;
  const space = {
    spaceId: "space-a",
    spaceSlug: "space-a",
    userId: "user-a",
    role: "owner",
    deployment: "local-trusted",
    storageDir: join(root, "spaces", "space-a"),
  } as SpaceContext;
  return { routes: harnessRoutes(host), space };
}

test("snapshot catalogs drop the account's disabled OpenCode providers and leave other harnesses alone", async () => {
  const { routes, space } = await fixture();
  let reply: { code: number; body: any } | undefined;
  const handled = await routes({
    method: "GET",
    path: "/api/harnesses/snapshots",
    url: new URL("http://polyth.test/api/harnesses/snapshots?detail=1"),
    space,
    principal: { kind: "ui-session" },
    body: async () => ({}),
    json: (code: number, payload: unknown) => { reply = { code, body: payload }; },
  } as unknown as RouteRequest);

  assert.equal(handled, true);
  assert.equal(reply?.code, 200);
  const rows = reply!.body as Array<{ identity: { id: string }; catalog: { models: ModelDescriptor[] } }>;
  const opencode = rows.find((row) => row.identity.id === "opencode");
  const cursor = rows.find((row) => row.identity.id === "cursor");
  assert.deepEqual(opencode?.catalog.models.map((model) => model.modelID), ["deepseek"]);
  assert.deepEqual(cursor?.catalog.models.map((model) => model.modelID), ["auto"]);
});
