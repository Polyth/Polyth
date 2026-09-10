import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Project,
  ProjectService,
  RouteHandler,
  SessionService,
  SpaceContext,
  SpaceStorage,
} from "@polyth/contracts";
import { personalCoachSessionRoute } from "../src/sessionRoute.ts";

const ctx: SpaceContext = {
  spaceId: "space-a",
  spaceSlug: "space-a",
  userId: "user",
  role: "owner",
  deployment: "local-trusted",
  storageDir: "/tmp/space-a",
};

async function invoke(route: RouteHandler, input: Record<string, unknown> = {}) {
  let status = 0;
  let value: unknown;
  const handled = await route({
    req: {} as never,
    res: {} as never,
    path: "/api/personal-coach/session",
    method: "POST",
    url: new URL("http://local/api/personal-coach/session"),
    ingress: { kind: "internal", serviceId: "test" },
    principal: { kind: "internal-service", serviceId: "test" },
    space: ctx,
    requireCapability: () => {},
    body: async () => input,
    json: (code, body) => { status = code; value = body; },
  });
  return { handled, status, value };
}

test("Coach session uses the package workspace but exposes only sessionId", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-coach-session-"));
  let createdProjectId = "";
  let appendedSessionId = "";
  const anchor: Project = {
    id: "__polyth_pkg_anchor",
    path: join(root, "packages", "personal-coach", "workspace"),
    name: "personal-coach workspace",
    spaceId: ctx.spaceId,
    createdAt: 1,
  };

  const projects = {
    async ensurePackageWorkspace(input: { spaceId: string; packageId: string; path: string }) {
      assert.equal(input.spaceId, ctx.spaceId);
      assert.equal(input.packageId, "personal-coach");
      assert.equal(input.path, anchor.path);
      return anchor;
    },
  } as unknown as ProjectService;

  const sessions = {
    async create(input: { projectId: string; title?: string }) {
      createdProjectId = input.projectId;
      assert.equal(input.title, "Coach · Today");
      return { id: "coach-session" };
    },
  } as unknown as SessionService;

  const storage: SpaceStorage = {
    root,
    packageDir(packageId) { return join(root, "packages", packageId); },
    path(relative) { return join(root, relative); },
  };

  const route = personalCoachSessionRoute({
    pluginId: "personal-coach",
    projects,
    spaceStorage: () => storage,
    forSpace: () => ({ projects, sessions }),
    events: {
      async append(sessionId, type, data, options) {
        appendedSessionId = sessionId;
        assert.equal(type, "personal-coach/session-created");
        assert.deepEqual(data, { packageId: "personal-coach" });
        assert.equal(options?.producerPlugin, "personal-coach");
        return {} as never;
      },
    },
  });

  const response = await invoke(route);
  assert.equal(response.handled, true);
  assert.equal(response.status, 200);
  assert.deepEqual(response.value, { sessionId: "coach-session" });
  assert.equal(createdProjectId, anchor.id);
  assert.equal(appendedSessionId, "coach-session");
});

test("Coach session title is bounded before session creation", async () => {
  let created = false;
  const root = mkdtempSync(join(tmpdir(), "polyth-coach-session-"));
  const projects = {
    async ensurePackageWorkspace() {
      return {
        id: "anchor",
        path: join(root, "packages", "personal-coach", "workspace"),
        name: "workspace",
        spaceId: ctx.spaceId,
        createdAt: 1,
      } satisfies Project;
    },
  } as unknown as ProjectService;
  const sessions = {
    async create() { created = true; return { id: "never" }; },
  } as unknown as SessionService;
  const storage: SpaceStorage = {
    root,
    packageDir(packageId) { return join(root, "packages", packageId); },
    path(relative) { return join(root, relative); },
  };
  const route = personalCoachSessionRoute({
    pluginId: "personal-coach",
    projects,
    spaceStorage: () => storage,
    forSpace: () => ({ projects, sessions }),
    events: { append: async () => ({} as never) },
  });

  await assert.rejects(
    () => invoke(route, { title: "x".repeat(121) }),
    (cause: Error & { code?: string }) => cause.code === "invalid-input",
  );
  assert.equal(created, false);
});
