import test from "node:test";
import assert from "node:assert/strict";
import type { SpaceContext } from "@polyth/contracts";
import { handoffRoutes } from "../src/serverEntry.ts";
import { createBundleService } from "../src/bundles.ts";
import { createContextSourceRegistry } from "../src/index.ts";
import type { RouteRequest } from "../../server/src/http.ts";

const space = (spaceId: string): SpaceContext => ({
  spaceId,
  spaceSlug: spaceId,
  userId: "user-1",
  role: "owner",
  deployment: "local-trusted",
  storageDir: `/tmp/${spaceId}`,
});

test("handoff import for a session in another Space returns not-found and appends nothing", async () => {
  const appendCalls: string[] = [];
  const homeSessionId = "11111111-1111-4111-8111-111111111111";
  const workSessionId = "22222222-2222-4222-8222-222222222222";
  const registry = createContextSourceRegistry();
  const bundles = createBundleService({ registry, warnTokenThreshold: 80_000 });
  const host = {
    forSpace: (ctx: SpaceContext) => ({
      projects: {
        get: async (id: string) => (id === "proj-1" ? { id: "proj-1" } : null),
      },
      sessions: {
        snapshot: async (sessionId: string) => {
          if (ctx.spaceId === "home-space" && sessionId === homeSessionId) {
            return { id: homeSessionId, projectId: "proj-1", status: "idle" };
          }
          if (ctx.spaceId === "work-space" && sessionId === workSessionId) {
            return { id: workSessionId, projectId: "proj-1", status: "idle" };
          }
          throw Object.assign(new Error("session not found"), { code: "not-found" });
        },
      },
    }),
    spaceStorage: () => ({
      path: (p: string) => p,
      packageDir: () => "/tmp/pkg",
    }),
    events: {
      append: async (sessionId: string) => {
        appendCalls.push(sessionId);
        return { sessionId, seq: 1, type: "handoff/result-imported", data: {}, v: 1, id: "e1", time: 1 };
      },
    },
  };

  const routes = handoffRoutes({ host: host as never, registry, bundles, warnTokenThreshold: 80_000 });
  let status = 0;
  let payload: unknown;
  const rc = {
    path: "/api/handoff/imports",
    method: "POST",
    url: new URL("http://x/api/handoff/imports"),
    space: space("work-space"),
    body: async () => ({
      sessionId: homeSessionId,
      provenance: {
        sourceKind: "chat-workspace",
        provider: "ChatGPT",
        profileName: "Personal",
      },
      textHash: "abc123",
    }),
    json: (code: number, body: unknown) => { status = code; payload = body; },
  } as unknown as RouteRequest;

  const handled = await routes(rc);
  assert.equal(handled, true);
  assert.equal(status, 404);
  assert.deepEqual(payload, { error: "not-found", message: "session not found" });
  assert.deepEqual(appendCalls, []);
});
