import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  HarnessContext,
  HarnessRegistry,
  HarnessSnapshot,
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
      models: [{ providerID: "cursor", modelID: "auto", name: "Auto" }],
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
  const handled = await runtimeCatalogRoutes(host)({
    path: "/api/runtime-catalog",
    method: "GET",
    url: new URL("http://polyth.test/api/runtime-catalog?sessionId=session-a"),
    space,
    json: (code, body) => { response = { code, body }; },
  } as RouteRequest);

  assert.equal(handled, true);
  assert.equal(response?.code, 200);
  assert.deepEqual(response?.body.models, [{
    providerID: "cursor",
    modelID: "auto",
    name: "Auto",
    harnessId: "cursor",
  }]);
  assert.deepEqual(response?.body.discovery, { state: "available" });
  assert.equal(response?.body.harnessId, "cursor");
  assert.equal(discoveryContext?.space, space);
  assert.equal(discoveryContext?.sessionId, undefined, "metadata discovery must not reuse the fenced execution state file");
});
