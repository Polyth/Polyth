import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AgentRuntime,
  HarnessContext,
  HarnessRegistry,
  HarnessSnapshot,
  ModelDescriptor,
  RouteRequest,
  SessionProjection,
  SpaceContext,
} from "@polyth/contracts";
import type { ServerPackageHost } from "@polyth/plugins";
import { runtimeCatalogRoutes } from "../src/serverEntry.ts";

const space: SpaceContext = {
  spaceId: "space-a",
  spaceSlug: "space-a",
  userId: "user-a",
  role: "owner",
  deployment: "local-trusted",
  storageDir: "/data/space-a",
};

test("session model metadata falls back to harness discovery when execution release is unverified", async () => {
  const session = {
    id: "session-a",
    projectId: "project-a",
    spaceId: space.spaceId,
    resolvedHarnessId: "cursor",
    status: "idle",
    model: { providerID: "cursor", modelID: "auto" },
  } as SessionProjection;
  let discoveryContext: HarnessContext | undefined;
  const snapshot: HarnessSnapshot = {
    identity: { id: "cursor", name: "Cursor", integration: "ACP v1" },
    availability: {
      harnessId: "cursor",
      installed: true,
      authenticated: true,
      healthy: true,
      state: "ready",
      checkedAt: 1,
    },
    policy: { enabled: true, priority: 30, autoSelect: false },
    capabilities: {
      streaming: true,
      permissions: true,
      questions: false,
      compaction: false,
      subagents: false,
      resume: false,
    },
    catalog: {
      models: [
        { providerID: "cursor", modelID: "auto", name: "Auto" },
        { providerID: "cursor", modelID: "auto", name: "Auto", context: 999_000 },
        { providerID: "cursor", modelID: "blocked", name: "Blocked", context: 90_000, contextStatus: "conflict" },
        { providerID: "cursor", modelID: "other", name: "Other" },
      ],
      agents: [],
    },
    context: {
      spaceId: space.spaceId,
      projectId: session.projectId,
      cwd: "/workspace",
      revision: "one",
      fetchedAt: 1,
    },
  };
  const registry = {
    snapshots: async (context: HarnessContext) => {
      discoveryContext = context;
      return [snapshot];
    },
    get: () => undefined,
  } as unknown as HarnessRegistry;
  const host = {
    forSpace: () => ({
      sessions: { snapshot: async () => session },
      projects: { get: async () => ({ id: session.projectId, path: "/workspace", name: "Project", createdAt: 1 }) },
    }),
    runtimes: {
      forSession: async () => {
        throw Object.assign(new Error("Previous executor has no verified release receipt"), {
          code: "outcome-unknown",
        });
      },
      forProject: async () => { throw new Error("session route must not use the project runtime"); },
    },
    services: {
      get: (key: { id: string }) => key.id === "polyth.service.harnesses" ? registry : undefined,
    },
  } as unknown as ServerPackageHost;
  let response: { code: number; body: any } | undefined;
  const handled = await runtimeCatalogRoutes(host, async (models) =>
    models.map((model) => model.context === undefined ? { ...model, context: 256_000 } : model))({
    path: "/api/runtime-catalog",
    method: "GET",
    url: new URL("http://polyth.test/api/runtime-catalog?sessionId=session-a"),
    space,
    json: (code, body) => { response = { code, body }; },
  } as RouteRequest);

  assert.equal(handled, true);
  assert.equal(response?.code, 200);
  assert.deepEqual(response?.body.models, [
    {
      providerID: "cursor",
      modelID: "auto",
      name: "Auto",
      context: 999_000,
      harnessId: "cursor",
    },
    {
      providerID: "cursor",
      modelID: "blocked",
      name: "Blocked",
      contextStatus: "conflict",
      harnessId: "cursor",
    },
    {
      providerID: "cursor",
      modelID: "other",
      name: "Other",
      context: 256_000,
      harnessId: "cursor",
    },
  ]);
  assert.deepEqual(response?.body.discovery, { state: "available" });
  assert.equal(response?.body.harnessId, "cursor");
  assert.equal(discoveryContext?.space, space);
  assert.equal(discoveryContext?.sessionId, undefined, "metadata discovery must not reuse the fenced execution state file");
});

test("OpenCode catalogs hide the account's disabled providers; other harnesses keep their provider ids", async () => {
  const runtimeModels: Record<string, ModelDescriptor[]> = {
    "session-opencode": [
      { providerID: "openrouter", modelID: "deepseek", name: "DeepSeek" },
      { providerID: "openrouter", modelID: "hidden", name: "Hidden" },
      { providerID: "opencode", modelID: "free", name: "Free" },
    ],
    "session-cursor": [
      { providerID: "cursor", modelID: "auto", name: "Auto" },
    ],
  };
  const sessions: Record<string, SessionProjection> = Object.fromEntries(
    Object.keys(runtimeModels).map((id) => [id, {
      id,
      projectId: "project-a",
      spaceId: space.spaceId,
      resolvedHarnessId: id === "session-cursor" ? "cursor" : "opencode",
      status: "idle",
      model: { providerID: "openrouter", modelID: "deepseek" },
    } as SessionProjection]),
  );
  const filterUsers: Array<string | undefined> = [];
  const host = {
    forSpace: () => ({
      sessions: { snapshot: async (id: string) => sessions[id] },
      projects: { get: async () => ({ id: "project-a", path: "/workspace", name: "Project", createdAt: 1 }) },
    }),
    runtimes: {
      forSession: async (session: SessionProjection) => ({
        harnessId: session.resolvedHarnessId,
        models: async () => runtimeModels[session.id]!,
        agents: async () => [],
        capabilities: async () => undefined,
      }) as unknown as AgentRuntime,
    },
    services: {
      get: (key: { id: string }) => key.id === "polyth.service.models.visibility" ? {
        filter: (models: ModelDescriptor[], opts?: { userId?: string }) => {
          filterUsers.push(opts?.userId);
          return models.filter((model) => model.providerID !== "openrouter" || model.modelID !== "hidden");
        },
      } : undefined,
    },
  } as unknown as ServerPackageHost;
  const call = async (sessionId: string) => {
    let response: { code: number; body: any } | undefined;
    const handled = await runtimeCatalogRoutes(host)({
      path: "/api/runtime-catalog",
      method: "GET",
      url: new URL(`http://polyth.test/api/runtime-catalog?sessionId=${sessionId}`),
      space,
      json: (code, body) => { response = { code, body }; },
    } as RouteRequest);
    assert.equal(handled, true);
    assert.equal(response?.code, 200);
    return response!.body as { models: ModelDescriptor[]; discovery: { state: string }; nativeDefault: boolean };
  };

  const opencode = await call("session-opencode");
  assert.deepEqual(opencode.models.map((model) => model.modelID), ["deepseek", "free"]);
  assert.deepEqual(opencode.discovery, { state: "available" });
  assert.equal(opencode.nativeDefault, false);

  const cursor = await call("session-cursor");
  assert.deepEqual(cursor.models.map((model) => model.modelID), ["auto"], "a disabled OpenCode provider id must not hide another harness's models");
  assert.deepEqual(filterUsers, [space.userId], "only the OpenCode catalog consults the account's provider filter");
});

test("a fully hidden OpenCode catalog is empty, not a native default", async () => {
  const session = {
    id: "session-a",
    projectId: "project-a",
    spaceId: space.spaceId,
    resolvedHarnessId: "opencode",
    status: "idle",
    model: { providerID: "openrouter", modelID: "deepseek" },
  } as SessionProjection;
  const host = {
    forSpace: () => ({
      sessions: { snapshot: async () => session },
      projects: { get: async () => ({ id: "project-a", path: "/workspace", name: "Project", createdAt: 1 }) },
    }),
    runtimes: {
      forSession: async () => ({
        harnessId: "opencode",
        models: async () => [{ providerID: "openrouter", modelID: "deepseek", name: "DeepSeek" }],
        agents: async () => [],
        capabilities: async () => undefined,
      }) as unknown as AgentRuntime,
    },
    services: {
      get: (key: { id: string }) => key.id === "polyth.service.models.visibility" ? {
        filter: () => [],
      } : undefined,
    },
  } as unknown as ServerPackageHost;
  let response: { code: number; body: any } | undefined;
  await runtimeCatalogRoutes(host)({
    path: "/api/runtime-catalog",
    method: "GET",
    url: new URL("http://polyth.test/api/runtime-catalog?sessionId=session-a"),
    space,
    json: (code, body) => { response = { code, body }; },
  } as RouteRequest);
  assert.deepEqual(response?.body.models, []);
  assert.deepEqual(response?.body.discovery, {
    state: "empty",
    code: "models-hidden",
  });
  assert.equal(response?.body.nativeDefault, false, "hiding every provider is not the engine owning a hidden native model");
});

test("a runtime that reports no models carries a structured runtime-empty cause", async () => {
  const session = {
    id: "session-empty",
    projectId: "project-a",
    spaceId: space.spaceId,
    resolvedHarnessId: "pi",
    status: "working",
    model: { providerID: "native", modelID: "auto" },
  } as SessionProjection;
  const host = {
    forSpace: () => ({
      sessions: { snapshot: async () => session },
      projects: { get: async () => ({ id: "project-a", path: "/workspace", name: "Project", createdAt: 1 }) },
    }),
    runtimes: {
      forSession: async () => ({
        harnessId: "pi",
        models: async () => [],
        agents: async () => [],
        capabilities: async () => undefined,
      }) as unknown as AgentRuntime,
    },
    services: { get: () => undefined },
  } as unknown as ServerPackageHost;
  let response: { code: number; body: any } | undefined;
  await runtimeCatalogRoutes(host)({
    path: "/api/runtime-catalog",
    method: "GET",
    url: new URL("http://polyth.test/api/runtime-catalog?sessionId=session-empty"),
    space,
    json: (code, body) => { response = { code, body }; },
  } as RouteRequest);
  assert.equal(response?.code, 200);
  assert.deepEqual(response?.body.models, []);
  assert.equal(response?.body.nativeDefault, true);
  assert.deepEqual(response?.body.discovery, {
    state: "empty",
    code: "runtime-empty",
  });
});
