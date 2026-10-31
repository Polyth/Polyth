import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  matchRemotePath,
  REMOTE_CAPABILITY,
  type AuthPrincipal,
  type Project,
  type ProjectService,
  type RouteRequest,
  type SessionProjection,
  type SessionService,
  type SpaceContext,
  type SpaceRole,
} from "@polyth/contracts";
import { validateRemoteAccessPolicy } from "../../server/src/remotePolicy.ts";
import { createActionStore } from "../src/actionStore.ts";
import type { RunManager, StartRunInput } from "../src/runManager.ts";
import { CUSTOM_ACTION_REMOTE_ACCESS, customActionRoutes } from "../src/routes.ts";

const allowedRule = (method: string, path: string) =>
  CUSTOM_ACTION_REMOTE_ACCESS.http.find((rule) =>
    (rule.methods as readonly string[]).includes(method) && matchRemotePath(rule.path, path));

test("paired devices need terminal grants: open to read and run, input to author", () => {
  validateRemoteAccessPolicy("custom-action", CUSTOM_ACTION_REMOTE_ACCESS);
  assert.equal(allowedRule("GET", "/api/custom-action/actions")?.capability, REMOTE_CAPABILITY.terminalOpen);
  assert.equal(allowedRule("POST", "/api/custom-action/actions/a1/run")?.capability, REMOTE_CAPABILITY.terminalOpen);
  assert.equal(allowedRule("GET", "/api/custom-action/runs")?.capability, REMOTE_CAPABILITY.terminalOpen);
  assert.equal(allowedRule("GET", "/api/custom-action/runs/r1/output")?.capability, REMOTE_CAPABILITY.terminalOpen);
  assert.equal(allowedRule("POST", "/api/custom-action/runs/r1/stop")?.capability, REMOTE_CAPABILITY.terminalOpen);
  for (const [method, path] of [
    ["POST", "/api/custom-action/actions"],
    ["PUT", "/api/custom-action/actions/a1"],
    ["DELETE", "/api/custom-action/actions/a1"],
    ["PUT", "/api/custom-action/order"],
  ] as const) {
    assert.equal(allowedRule(method, path)?.capability, REMOTE_CAPABILITY.terminalInput, `${method} ${path}`);
  }
  assert.equal(allowedRule("DELETE", "/api/custom-action/runs/r1"), undefined);
});

const projects: Record<string, Project> = {
  p1: { id: "p1", name: "Polyth", path: "/repo/polyth" } as Project,
  p2: { id: "p2", name: "Site", path: "/repo/site" } as Project,
};
const sessions: Record<string, Partial<SessionProjection>> = {
  "s-p1": { id: "s-p1", projectId: "p1", worktreePath: "/worktrees/feature" },
  "s-p2": { id: "s-p2", projectId: "p2" },
  "s-gone": { id: "s-gone", projectId: "p1", worktreePath: "/worktrees/gone", worktreeState: "missing" },
};

function scopedServices(): { projects: ProjectService; sessions: SessionService } {
  return {
    projects: { get: async (id: string) => projects[id] } as unknown as ProjectService,
    sessions: {
      snapshot: async (id: string) => {
        const session = sessions[id];
        if (!session) throw Object.assign(new Error("session not found"), { code: "not-found" });
        return session as SessionProjection;
      },
    } as unknown as SessionService,
  };
}

interface Harness {
  call(method: string, path: string, options?: { body?: Record<string, unknown>; role?: SpaceRole; principal?: AuthPrincipal; deployment?: SpaceContext["deployment"] }): Promise<{ status: number; body: unknown; error?: { code?: string; message: string } }>;
  started: StartRunInput[];
}

async function harness(t: { after(fn: () => unknown): void }): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "custom-action-routes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createActionStore({
    storage: (space) => ({
      root: join(root, space.spaceId),
      packageDir(id) {
        const dir = join(root, space.spaceId, "packages", id);
        mkdirSync(dir, { recursive: true });
        return dir;
      },
      path: (relative) => join(root, space.spaceId, relative),
    }),
  });
  const started: StartRunInput[] = [];
  const runs = {
    async start(input: StartRunInput) {
      started.push(input);
      return { run: { id: `r${started.length}`, status: "running" }, joined: false };
    },
    list: () => [],
    output: () => { throw Object.assign(new Error("gone"), { code: "not-found" }); },
    stop: async () => ({}),
    dispose: async () => undefined,
  } as unknown as RunManager;
  const routes = customActionRoutes({ store, runs, forSpace: () => scopedServices() });
  return {
    started,
    async call(method, path, options = {}) {
      const principal = options.principal ?? { kind: "local-user", trustedLoopback: true };
      const grants = principal.kind === "paired-device" ? principal.grants : null;
      let status = 0;
      let body: unknown;
      const rc = {
        path: path.split("?")[0],
        method,
        url: new URL(`http://polyth.test${path}`),
        principal,
        space: {
          spaceId: "space-1", spaceSlug: "space-1", userId: "u1",
          role: options.role ?? "owner",
          deployment: options.deployment ?? "local-trusted",
          storageDir: join(root, "space-1"),
        },
        requireCapability(capability: string) {
          if (grants && !grants.includes(capability)) throw Object.assign(new Error("not allowed"), { code: "forbidden" });
        },
        body: async () => options.body ?? {},
        json(code: number, value: unknown) { status = code; body = value; },
      } as unknown as RouteRequest;
      try {
        const handled = await routes(rc);
        assert.equal(handled, true, `${method} ${path} must be handled`);
        return { status, body };
      } catch (error) {
        const failure = error as Error & { code?: string };
        return { status: 0, body: undefined, error: { ...(failure.code ? { code: failure.code } : {}), message: failure.message } };
      }
    },
  };
}

const create = (h: Harness, body: Record<string, unknown>) =>
  h.call("POST", "/api/custom-action/actions", { body: { name: "Run tests", command: "npm test", ...body } });

test("owners manage actions and learn what they may do", async (t) => {
  const h = await harness(t);
  const created = await create(h, { projectId: "p1" });
  assert.equal(created.status, 200);
  const list = await h.call("GET", "/api/custom-action/actions");
  assert.deepEqual(
    { ...(list.body as Record<string, unknown>), actions: undefined },
    { actions: undefined, canManage: true, canRun: true, canChat: true, blocked: null },
  );
  assert.equal((list.body as { actions: unknown[] }).actions.length, 1);

  const id = (created.body as { action: { id: string } }).action.id;
  const updated = await h.call("PUT", `/api/custom-action/actions/${id}`, { body: { name: "Tests", command: "npm t", projectId: null } });
  assert.equal((updated.body as { action: { projectId: string | null } }).action.projectId, null);
  assert.equal((await h.call("PUT", "/api/custom-action/order", { body: { ids: [id] } })).status, 200);
  assert.equal((await h.call("PUT", "/api/custom-action/order", { body: { ids: "nope" } })).error?.code, "invalid-input");
  assert.equal((await h.call("DELETE", `/api/custom-action/actions/${id}`)).status, 200);
  assert.equal((await h.call("DELETE", `/api/custom-action/actions/${id}`)).error?.code, "not-found");
});

test("an action can only belong to a project of this Space", async (t) => {
  const h = await harness(t);
  assert.equal((await create(h, { projectId: "p-foreign" })).error?.code, "not-found");
  assert.equal((await create(h, { name: "" })).error?.code, "invalid-input");
});

test("viewers and sandboxed deployments cannot author or run commands", async (t) => {
  const h = await harness(t);
  const { action } = (await create(h, {})).body as { action: { id: string } };
  const viewerList = await h.call("GET", "/api/custom-action/actions", { role: "viewer" });
  assert.equal((viewerList.body as { canRun: boolean }).canRun, false);
  assert.match((viewerList.body as { blocked: string }).blocked, /role/);
  assert.equal((await h.call("POST", "/api/custom-action/actions", { role: "viewer", body: { name: "x", command: "ls" } })).error?.code, "forbidden");
  assert.equal((await h.call("POST", `/api/custom-action/actions/${action.id}/run`, { role: "viewer", body: { projectId: "p1" } })).error?.code, "forbidden");
  const hosted = await h.call("GET", "/api/custom-action/actions", { deployment: "multi-tenant-sandboxed" });
  assert.equal((hosted.body as { canManage: boolean }).canManage, false);
  assert.equal((await h.call("POST", `/api/custom-action/actions/${action.id}/run`, { deployment: "multi-tenant-sandboxed", body: { projectId: "p1" } })).error?.code, "forbidden");
  assert.equal(h.started.length, 0);
});

test("a paired device's grants decide what the UI may offer", async (t) => {
  const h = await harness(t);
  const { action } = (await create(h, { mode: "chat" })).body as { action: { id: string } };
  const device: AuthPrincipal = {
    kind: "paired-device",
    deviceId: "phone",
    grants: [REMOTE_CAPABILITY.terminalOpen],
  } as unknown as AuthPrincipal;
  const list = await h.call("GET", "/api/custom-action/actions", { principal: device });
  assert.deepEqual(
    { canManage: (list.body as { canManage: boolean }).canManage, canRun: (list.body as { canRun: boolean }).canRun, canChat: (list.body as { canChat: boolean }).canChat },
    { canManage: false, canRun: true, canChat: false },
  );
  assert.equal((await h.call("POST", "/api/custom-action/actions", { principal: device, body: { name: "x", command: "rm -rf ~" } })).error?.code, "forbidden");
  // Running a chat action also needs the session grants.
  assert.equal((await h.call("POST", `/api/custom-action/actions/${action.id}/run`, { principal: device, body: { projectId: "p1" } })).error?.code, "forbidden");
  assert.equal(h.started.length, 0);
});

test("runs resolve their checkout from the Space-scoped project and session", async (t) => {
  const h = await harness(t);
  const { action } = (await create(h, {})).body as { action: { id: string } };
  const run = (body: Record<string, unknown>) => h.call("POST", `/api/custom-action/actions/${action.id}/run`, { body });

  assert.equal((await run({ projectId: "p1" })).status, 200);
  assert.equal(h.started.at(-1)!.cwd, "/repo/polyth");
  assert.equal(h.started.at(-1)!.sessionId, null);

  await run({ projectId: "p1", sessionId: "s-p1" });
  assert.equal(h.started.at(-1)!.cwd, "/worktrees/feature", "a run launched from a chat uses its worktree");
  assert.equal(h.started.at(-1)!.sessionId, "s-p1");

  await run({ projectId: "p1", sessionId: "s-p2" });
  assert.equal(h.started.at(-1)!.cwd, "/repo/polyth", "a chat from another project is not the run's context");
  assert.equal(h.started.at(-1)!.sessionId, null);

  assert.equal((await run({ projectId: "p1", sessionId: "s-gone" })).error?.code, "not-found");
  assert.equal((await run({ projectId: "p1", sessionId: "s-foreign" })).error?.code, "not-found");
  assert.equal((await run({ projectId: "p-foreign" })).error?.code, "not-found");
  assert.equal((await run({})).error?.code, "invalid-input");
  assert.equal((await h.call("POST", "/api/custom-action/actions/missing/run", { body: { projectId: "p1" } })).error?.code, "not-found");
  assert.equal(h.started.length, 3);
});

test("project-scoped actions refuse other projects and Terminal actions stay client-side", async (t) => {
  const h = await harness(t);
  const scoped = ((await create(h, { projectId: "p1" })).body as { action: { id: string } }).action;
  const terminal = ((await create(h, { mode: "terminal" })).body as { action: { id: string } }).action;
  assert.equal((await h.call("POST", `/api/custom-action/actions/${scoped.id}/run`, { body: { projectId: "p2" } })).error?.code, "not-found");
  assert.equal((await h.call("POST", `/api/custom-action/actions/${terminal.id}/run`, { body: { projectId: "p1" } })).error?.code, "invalid-input");
  assert.equal(h.started.length, 0);
});

test("unrelated paths fall through", async (t) => {
  const h = await harness(t);
  const routes = customActionRoutes({
    store: createActionStore({ storage: () => { throw new Error("unused"); } }),
    runs: {} as RunManager,
    forSpace: () => scopedServices(),
  });
  assert.equal(await routes({ path: "/api/terminals", method: "GET" } as RouteRequest), false);
  assert.equal(await routes({ path: "/api/custom-actionx", method: "GET" } as RouteRequest), false);
  assert.ok(h);
});
