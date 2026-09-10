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
import { createCoachStore } from "../src/index.ts";
import type { PersonalCoachService } from "../src/service.ts";
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

const unusedReview = () => { throw new Error("proposal review is unused by session route tests"); };
const unusedReviewAsync = async () => { throw new Error("proposal review is unused by session route tests"); };
const unusedReset = () => { throw new Error("reset is unused by session route tests"); };

test("Coach session prepares scoped capabilities and injects model-visible bounded package context", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-coach-session-"));
  const coachStore = createCoachStore(join(root, "coach.db"));
  coachStore.createGoal({ title: "Ship Coach", priority: 3 });
  let createdProjectId = "";
  let preparedProjectId = "";
  let appended: {
    sessionId: string;
    type: string;
    data: Record<string, unknown>;
    opts?: { ignorable?: boolean; producerPlugin?: string };
  } | undefined;
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
      assert.equal(preparedProjectId, input.projectId, "capabilities must be registered before session materialization");
      assert.equal(input.title, "Coach · Today");
      return { id: "coach-session" };
    },
  } as unknown as SessionService;

  const storage: SpaceStorage = {
    root,
    packageDir(packageId) { return join(root, "packages", packageId); },
    path(relative) { return join(root, relative); },
  };
  const coach = {
    forSpace: () => coachStore,
    proposalReviewForSpace: unusedReview,
    forWorkspaceProject: async () => coachStore,
    proposalReviewForWorkspaceProject: unusedReviewAsync,
    resetForSpace: unusedReset,
    close: () => {},
  } satisfies PersonalCoachService;

  const route = personalCoachSessionRoute({
    pluginId: "personal-coach",
    projects,
    spaceStorage: () => storage,
    forSpace: () => ({ projects, sessions }),
    events: {
      async append(sessionId, type, data, opts) {
        appended = { sessionId, type, data, opts };
        return {} as never;
      },
    },
  }, {
    coach,
    ensureCapabilities: (space, projectId, store) => {
      assert.equal(space.spaceId, ctx.spaceId);
      assert.equal(store, coachStore);
      preparedProjectId = projectId;
    },
  });

  const response = await invoke(route);
  assert.equal(response.handled, true);
  assert.equal(response.status, 200);
  assert.deepEqual(response.value, { sessionId: "coach-session" });
  assert.equal(createdProjectId, anchor.id);
  assert.equal(appended?.sessionId, "coach-session");
  assert.equal(appended?.type, "package/context");
  assert.equal(appended?.data.packageId, "personal-coach");
  assert.notEqual(appended?.opts?.ignorable, true, "package/context must survive deriveMessages filtering");
  assert.equal(appended?.opts?.producerPlugin, "personal-coach");
  const snapshot = JSON.parse(String(appended?.data.text)) as { activeGoals: Array<{ title: string }> };
  assert.equal(snapshot.activeGoals[0]?.title, "Ship Coach");
  coachStore.close();
});

test("Coach session title is bounded before session creation", async () => {
  let created = false;
  const root = mkdtempSync(join(tmpdir(), "polyth-coach-session-"));
  const store = createCoachStore(join(root, "coach.db"));
  const projects = {
    async ensurePackageWorkspace() {
      return {
        id: "__polyth_pkg_anchor",
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
  const coach = {
    forSpace: () => store,
    proposalReviewForSpace: unusedReview,
    forWorkspaceProject: async () => store,
    proposalReviewForWorkspaceProject: unusedReviewAsync,
    resetForSpace: unusedReset,
    close: () => {},
  } satisfies PersonalCoachService;
  const route = personalCoachSessionRoute({
    pluginId: "personal-coach",
    projects,
    spaceStorage: () => storage,
    forSpace: () => ({ projects, sessions }),
    events: { append: async () => ({} as never) },
  }, {
    coach,
    ensureCapabilities: () => {},
  });

  await assert.rejects(
    () => invoke(route, { title: "x".repeat(121) }),
    (cause: Error & { code?: string }) => cause.code === "invalid-input",
  );
  assert.equal(created, false);
  store.close();
});
