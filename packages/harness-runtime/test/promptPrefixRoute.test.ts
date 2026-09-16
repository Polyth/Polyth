import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  HarnessRegistry,
  Project,
  RouteRequest,
  SessionProjection,
  SpaceContext,
} from "@polyth/contracts";
import {
  createServerServiceRegistry,
  serverServiceKey,
  type ServerPackageHost,
} from "@polyth/plugins";
import { createCapabilityContributionRegistry } from "../src/contextualCapabilities.ts";
import { harnessRoutes } from "../src/serverEntry.ts";

const space: SpaceContext = {
  spaceId: "space-a",
  spaceSlug: "space-a",
  userId: "user-a",
  role: "owner",
  deployment: "local-trusted",
  storageDir: "/tmp/polyth-space-a",
};

const projects: Project[] = [
  { id: "p1", name: "One", path: "/projects/one", spaceId: space.spaceId, createdAt: 1 },
  { id: "p2", name: "Two", path: "/projects/two", spaceId: space.spaceId, createdAt: 1 },
];

const sessions = new Map<string, SessionProjection>([
  ["s1", { id: "s1", projectId: "p1", title: "One", status: "idle", createdAt: 1, updatedAt: 1, worktreePath: "/projects/one-wt" }],
  ["s2", { id: "s2", projectId: "p2", title: "Two", status: "idle", createdAt: 1, updatedAt: 1 }],
]);

function host(): ServerPackageHost {
  const services = createServerServiceRegistry();
  services.provide(serverServiceKey<HarnessRegistry>("harnesses"), {} as HarnessRegistry);
  const capabilities = createCapabilityContributionRegistry();
  capabilities.register("example", {
    descriptor: {
      id: "example.policy",
      kind: "instruction",
      owner: "example",
      scope: "project",
      projectId: "p1",
      revision: "declared-v1",
      title: "Policy",
      text: "PRIVATE PREFIX BODY MUST NOT LEAK",
    },
  });
  services.provide(serverServiceKey("harness.capabilities"), capabilities);

  return {
    services,
    spaceStorage: () => ({ path: (value: string) => `/tmp/${value}` }),
    forSpace(ctx: SpaceContext) {
      assert.equal(ctx.spaceId, space.spaceId);
      return {
        projects: {
          async list() { return projects; },
          async get(id: string) { return projects.find((project) => project.id === id); },
        },
        sessions: {
          async snapshot(id: string) {
            const session = sessions.get(id);
            if (!session) throw Object.assign(new Error("not found"), { code: "not-found" });
            return session;
          },
        },
      };
    },
  } as unknown as ServerPackageHost;
}

async function request(url: string): Promise<unknown> {
  let payload: unknown;
  const handled = await harnessRoutes(host())({
    path: "/api/harnesses/prompt-prefix-diagnostics",
    method: "GET",
    url: new URL(url),
    space,
    json(_status: number, body: unknown) { payload = body; },
  } as unknown as RouteRequest);
  assert.equal(handled, true);
  return payload;
}

test("prompt prefix route resolves the requested session/project context without leaking content", async () => {
  const payload = await request("http://localhost/api/harnesses/prompt-prefix-diagnostics?projectId=p1&sessionId=s1") as {
    identity: string;
    contributorCount: number;
    contributors: Array<{ id: string; revision: string }>;
  };

  assert.match(payload.identity, /^[0-9a-f]{16}$/);
  assert.equal(payload.contributorCount, 1);
  assert.equal(payload.contributors[0]?.id, "example.policy");
  assert.doesNotMatch(JSON.stringify(payload), /PRIVATE PREFIX BODY MUST NOT LEAK/);
  assert.doesNotMatch(JSON.stringify(payload), /one-wt/);
});

test("prompt prefix route rejects a session/project mismatch", async () => {
  await assert.rejects(
    () => request("http://localhost/api/harnesses/prompt-prefix-diagnostics?projectId=p1&sessionId=s2"),
    (error: unknown) => (error as { code?: string }).code === "invalid-input",
  );
});
