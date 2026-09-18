import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  HarnessProvider,
  ModelDescriptor,
  SpaceContext,
  SpaceStorage,
} from "@polyth/contracts";
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

test("harness model visibility keeps raw settings catalog while filtering normal snapshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "polyth-harness-model-visibility-"));
  const space = {
    spaceId: "space-a",
    spaceSlug: "space-a",
    userId: "user-a",
    role: "owner",
    storageDir: root,
  } as SpaceContext;
  const storage: SpaceStorage = {
    root,
    packageDir: (packageId) => join(root, "packages", packageId),
    path: (relative) => join(root, relative),
  };
  const project = { id: "project-a", path: "/project", spaceId: "space-a", name: "Project", createdAt: 1 };
  const models: ModelDescriptor[] = Array.from({ length: 11 }, (_, index) => ({
    providerID: index < 2 ? "anthropic" : "openai",
    modelID: `model-${index}`,
    name: `Model ${index}`,
    connected: true,
  }));

  const harnesses = createHarnessRegistry();
  harnesses.register({
    descriptor: { id: "pi", name: "Pi", integration: "test", priority: 10 },
    async probe() {
      return {
        harnessId: "pi",
        state: "ready",
        installed: true,
        healthy: true,
        authenticated: true,
        checkedAt: 1,
      };
    },
    async discover() {
      return {
        state: "ready",
        authenticated: true,
        catalog: { models, agents: [] },
      };
    },
    async createRuntime() {
      throw new Error("runtime is not used by this test");
    },
  } as HarnessProvider);

  let visibilityState = {
    disabledProviders: ["anthropic"],
    disabledModels: [] as string[],
  };
  const visibility = {
    harnessState: () => visibilityState,
    filterHarness: (input: ModelDescriptor[]) => input.filter((model) =>
      !visibilityState.disabledProviders.includes(model.providerID)
      && !visibilityState.disabledModels.includes(`${model.providerID}/${model.modelID}`)),
    async setHarnessProviderEnabled(_harnessId: string, providerID: string, enabled: boolean) {
      visibilityState = {
        ...visibilityState,
        disabledProviders: enabled
          ? visibilityState.disabledProviders.filter((id) => id !== providerID)
          : [...new Set([...visibilityState.disabledProviders, providerID])],
      };
      return visibilityState;
    },
    async setHarnessModelEnabled(_harnessId: string, key: string, enabled: boolean) {
      visibilityState = {
        ...visibilityState,
        disabledModels: enabled
          ? visibilityState.disabledModels.filter((item) => item !== key)
          : [...new Set([...visibilityState.disabledModels, key])],
      };
      return visibilityState;
    },
  };

  const services = createServerServiceRegistry();
  services.provide(serverServiceKey("harnesses"), harnesses);
  services.provide(serverServiceKey("models.visibility"), visibility);
  const host = {
    pluginId: "harness-runtime",
    services: bindPackageServices(services, "harness-runtime"),
    spaceStorage: () => storage,
    forSpace: () => ({
      projects: {
        list: async () => [project],
        get: async (id: string) => id === project.id ? project : undefined,
      },
      sessions: {},
    }),
  } as unknown as ServerPackageHost;
  const route = harnessRoutes(host);

  const invoke = async (method: "GET" | "POST", path: string, body: unknown = {}) => {
    let status = 0;
    let responseBody: unknown;
    const url = new URL(path, "http://localhost");
    const handled = await route({
      path: url.pathname,
      method,
      url,
      space,
      body: async () => body,
      json(nextStatus: number, nextBody: unknown) {
        status = nextStatus;
        responseBody = nextBody;
      },
    } as RouteRequest);
    return { handled, status, body: responseBody };
  };

  const filtered = await invoke("GET", "/api/harnesses/snapshots?projectId=project-a&harnessId=pi&detail=1");
  assert.equal(filtered.status, 200);
  assert.equal((filtered.body as Array<{ catalog?: { models?: ModelDescriptor[] } }>)[0]?.catalog?.models?.length, 9);

  const raw = await invoke("GET", "/api/harnesses/snapshots?projectId=project-a&harnessId=pi&detail=1&allModels=1");
  assert.equal((raw.body as Array<{ catalog?: { models?: ModelDescriptor[] } }>)[0]?.catalog?.models?.length, 11);

  const initial = await invoke("GET", "/api/harnesses/pi/model-visibility");
  assert.deepEqual(initial.body, {
    ok: true,
    disabledProviders: ["anthropic"],
    disabledModels: [],
  });

  const enabled = await invoke("POST", "/api/harnesses/pi/providers/anthropic/enabled", { enabled: true });
  assert.deepEqual(enabled.body, {
    ok: true,
    disabledProviders: [],
    disabledModels: [],
  });

  const after = await invoke("GET", "/api/harnesses/snapshots?projectId=project-a&harnessId=pi&detail=1");
  assert.equal((after.body as Array<{ catalog?: { models?: ModelDescriptor[] } }>)[0]?.catalog?.models?.length, 11);
});
