// UX-SHELL-CONSOLIDATION-02 finding 4/5: hard session delete through the
// guarded service path — durable log, projection, and queue are removed in
// one transaction; a running turn is aborted first and its stray turn/stopped
// can never be re-appended to the deleted log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStore } from "@polyth/session";
import type { AgentRuntime, Project, ProjectService, RuntimeEndpoint, RuntimeEvent, SessionProjection } from "@polyth/contracts";
import { createSessionService, type Broadcaster, type RuntimePool } from "../src/sessions.ts";
import type { PermissionService } from "@polyth/permissions";

type Emit = (sessionId: string, ev: RuntimeEvent) => void;

function fakeRuntime() {
  const listeners = new Set<Emit>();
  const aborted: string[] = [];
  const emit = (sessionId: string, ev: RuntimeEvent) => {
    for (const l of listeners) l(sessionId, ev);
  };
  const rt: AgentRuntime = {
    capabilities: async () => ({
      streaming: true, permissions: true, questions: true, compaction: false, subagents: false, steering: false,
    }),
    models: async () => [],
    agents: async () => [],
    ensureSession: async (c) => `be_${c.sessionId}`,
    sessions: async () => [],
    history: async () => [],
    startTurn: async (req) => { emit(req.sessionId, { type: "turn/started", turnId: "t1" }); },
    abort: async (sessionId) => { aborted.push(sessionId); emit(sessionId, { type: "turn/stopped", reason: "aborted" }); },
    replyPermission: async () => {},
    replyQuestion: async () => {},
    onEvent(cb) {
      listeners.add(cb);
      return { dispose: () => listeners.delete(cb) };
    },
    dispose: async () => {},
  };
  return { rt, emit, aborted };
}

const flush = () => new Promise((r) => setTimeout(r, 20));

function makeService(
  fake: ReturnType<typeof fakeRuntime>,
  runtimeFor: (projectId: string, cwd?: string) => Promise<AgentRuntime> = async () => fake.rt,
  cleanupSessionResources?: (info: {
    projection: SessionProjection;
    releaseExecution(cwd: string): Promise<void>;
  }) => Promise<void>,
  runtimePool?: RuntimePool,
) {
  const dir = mkdtempSync(join(tmpdir(), "polyth-delete-"));
  const store = createStore(join(dir, "s.db"));
  const project: Project = { id: "p1", path: dir, name: "p", createdAt: 1 };
  const projects: ProjectService = {
    list: async () => [project],
    get: async (id) => (id === "p1" ? project : undefined),
    add: async () => project,
    create: async () => project,
    remove: async () => {},
  };
  const permissions = {
    evaluate: () => "allow",
    addRule: () => {},
    rules: () => [],
  } as unknown as PermissionService;
  const broadcast: Broadcaster = { event: () => {}, projection: () => {} };
  const sessions = createSessionService({
    store, projects, permissions, broadcast, queue: store,
    runtimes: runtimePool ?? { forProject: runtimeFor },
    ...(cleanupSessionResources ? { cleanupSessionResources } : {}),
  });
  return { sessions, store };
}

test("delete removes projection, events, and queued messages durably", async () => {
  const fake = fakeRuntime();
  const { sessions, store } = makeService(fake);
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await sessions.send(id, { text: "hello" });
  await flush();
  fake.emit(id, { type: "assistant/message", partId: "a1", text: "hi" });
  fake.emit(id, { type: "turn/stopped", reason: "completed" });
  await flush();
  await store.enqueue(id, "queued follow-up", "queue");
  assert.ok((await store.events(id)).length > 0);

  await sessions.delete!(id);

  assert.equal(await store.projection(id), undefined);
  assert.deepEqual(await store.events(id), []);
  assert.deepEqual(await store.queueList(id), []);
  assert.deepEqual(await sessions.list("p1"), []);
});

test("delete of a running session aborts first and leaves no resurrected events", async () => {
  const fake = fakeRuntime();
  const { sessions, store } = makeService(fake);
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await sessions.send(id, { text: "long task" });
  await flush();
  assert.equal((await store.projection(id))?.status, "working");

  await sessions.delete!(id);
  await flush(); // any stray turn/stopped dispatch would land here

  assert.deepEqual(fake.aborted, [id]);
  assert.equal(await store.projection(id), undefined);
  // The abort's turn/stopped must not re-append to the deleted log.
  assert.deepEqual(await store.events(id), []);
});

test("delete of an unknown session is a typed not-found", async () => {
  const fake = fakeRuntime();
  const { sessions } = makeService(fake);
  await assert.rejects(sessions.delete!("nope"), (err: Error & { code?: string }) => {
    assert.equal(err.code, "not-found");
    return true;
  });
});

test("delete removes a session whose persisted runtime identity changed without deleting from the replacement", async () => {
  const fake = fakeRuntime();
  let discarded = 0;
  const previousEndpoint: RuntimeEndpoint = {
    authorityId: "owned:previous", continuity: "verified", generation: 1,
    url: "http://previous.invalid", location: { directory: "/project" },
    control: { kind: "owned", instanceToken: "previous" },
    config: { kind: "read-only" }, authentication: { kind: "none" },
  };
  const replacementEndpoint = { ...previousEndpoint, authorityId: "owned:replacement" };
  fake.rt.endpoint = async () => replacementEndpoint;
  fake.rt.discardSessionOperation = async () => {
    discarded += 1;
    return { kind: "confirmed", value: {} };
  };
  const { sessions, store } = makeService(fake);
  await store.upsertProjection({
    id: "identity-changed", projectId: "p1", backendSessionId: "backend-old",
    runtimeBinding: {
      backendSessionId: "backend-old", authorityId: previousEndpoint.authorityId,
      generation: previousEndpoint.generation, continuity: "verified", protocol: "legacy",
      location: previousEndpoint.location,
    },
    title: "Old", status: "idle", createdAt: 1, updatedAt: 1,
  });

  await sessions.delete!("identity-changed");

  assert.equal(await store.projection("identity-changed"), undefined);
  assert.equal(discarded, 0);
});

test("delete removes a session whose worktree disappeared without constructing a runtime", async () => {
  const fake = fakeRuntime();
  const { sessions, store } = makeService(fake, async () => {
    throw Object.assign(new Error("Runtime workspace/cwd no longer exists"), { code: "unavailable" });
  });
  const id = "missing-worktree";
  const missingWorktree = join(tmpdir(), "polyth-delete-missing-worktree");
  await store.upsertProjection({
    id, projectId: "p1", title: "T", status: "idle", createdAt: 1, updatedAt: 1,
    backendSessionId: "be_missing-worktree",
    worktreePath: missingWorktree,
    worktreeState: "missing",
    runtimeBinding: {
      backendSessionId: "be_missing-worktree",
      authorityId: "owned:missing-worktree",
      generation: 1,
      continuity: "verified",
      protocol: "legacy",
      location: { directory: missingWorktree },
    },
  });

  await sessions.delete!(id);

  assert.equal(await store.projection(id), undefined);
});

test("explicit delete tombstones a rebind-pending session without reconstructing its released runtime", async () => {
  const fake = fakeRuntime();
  let runtimeConstructions = 0;
  let cleanupCalls = 0;
  const { sessions, store } = makeService(
    fake,
    async () => {
      runtimeConstructions += 1;
      throw Object.assign(new Error("Previous executor has no verified release receipt"), {
        code: "runtime-release-unverified",
      });
    },
    async ({ projection }) => {
      cleanupCalls += 1;
      assert.equal(projection.isolation?.state, "rebind-pending");
      // The Git owner observed that this workspace is already absent, so it
      // deliberately does not request a release receipt.
    },
  );
  const id = "rebind-pending-delete";
  const missingWorktree = join(tmpdir(), "polyth-delete-missing-isolation");
  await store.upsertProjection({
    id, projectId: "p1", title: "T", status: "idle", createdAt: 1, updatedAt: 1,
    backendSessionId: "be_rebind-pending-delete",
    worktreePath: missingWorktree,
    branch: "polyth/isolate/delete",
    runtimeBinding: {
      backendSessionId: "be_rebind-pending-delete",
      authorityId: "owned:released-without-receipt",
      generation: 1,
      continuity: "verified",
      protocol: "legacy",
      location: { directory: missingWorktree },
    },
    isolation: {
      kind: "git-worktree",
      worktreePath: missingWorktree,
      worktreeBranch: "polyth/isolate/delete",
      targetBranch: "main",
      targetPath: join(tmpdir(), "polyth-delete-target"),
      originPath: join(tmpdir(), "polyth-delete-target"),
      baseCommit: "base",
      createdAt: "2026-09-13T00:00:00.000Z",
      state: "rebind-pending",
    },
  });

  await sessions.delete!(id);

  assert.equal(cleanupCalls, 1);
  assert.equal(runtimeConstructions, 0, "hard delete must not create a runtime solely to delete it");
  assert.equal(await store.projection(id), undefined);
  assert.ok(await store.deletionTombstone(id), "unknown upstream state remains fenced after canonical deletion");
});

test("owned isolation cleanup receives verified execution release before canonical deletion", async () => {
  const fake = fakeRuntime();
  const order: string[] = [];
  const id = "owned-isolation-delete";
  const worktreePath = join(tmpdir(), "polyth-delete-owned-isolation");
  const binding = {
    canonicalSessionId: id,
    backendSessionId: "be_owned-isolation-delete",
    authorityId: "owned:isolation-delete",
    generation: 4,
    continuity: "verified" as const,
    location: { directory: worktreePath },
  };
  const runtimePool: RuntimePool = {
    forProject: async () => { throw new Error("delete must not construct a runtime"); },
    releaseSessionExecution: async (_projection, actual) => {
      order.push("release");
      assert.deepEqual(actual, binding);
      return { kind: "confirmed", value: binding };
    },
    retireSession: async () => { order.push("retire"); },
  };
  const { sessions, store } = makeService(
    fake,
    async () => { throw new Error("delete must not construct a runtime"); },
    async ({ releaseExecution }) => {
      await releaseExecution(worktreePath);
      order.push("cleanup");
    },
    runtimePool,
  );
  await store.upsertProjection({
    id, projectId: "p1", title: "T", status: "idle", createdAt: 1, updatedAt: 1,
    backendSessionId: binding.backendSessionId,
    worktreePath,
    runtimeBinding: {
      backendSessionId: binding.backendSessionId,
      authorityId: binding.authorityId,
      generation: binding.generation,
      continuity: binding.continuity,
      protocol: "legacy",
      location: binding.location,
    },
    isolation: {
      kind: "git-worktree", worktreePath, worktreeBranch: "polyth/isolate/delete",
      targetBranch: "main", targetPath: "/target", originPath: "/target",
      baseCommit: "base", createdAt: "2026-09-13T00:00:00.000Z", state: "active",
    },
  });

  await sessions.delete!(id);

  assert.deepEqual(order, ["release", "cleanup", "retire"]);
  assert.equal(await store.projection(id), undefined);
});

test("isolation deletion preserves the session when release proof names another authority", async () => {
  const fake = fakeRuntime();
  const id = "isolation-delete-stale-release";
  const worktreePath = join(tmpdir(), "polyth-delete-stale-release");
  const binding = {
    canonicalSessionId: id,
    backendSessionId: "be_isolation-delete-stale-release",
    authorityId: "owned:isolation-delete-current",
    generation: 2,
    continuity: "verified" as const,
    location: { directory: worktreePath },
  };
  let cleanupReached = false;
  const runtimePool: RuntimePool = {
    forProject: async () => { throw new Error("delete must not construct a runtime"); },
    releaseSessionExecution: async () => ({
      kind: "confirmed",
      value: { ...binding, authorityId: "owned:isolation-delete-stale" },
    }),
  };
  const { sessions, store } = makeService(
    fake,
    async () => { throw new Error("delete must not construct a runtime"); },
    async ({ releaseExecution }) => {
      await releaseExecution(worktreePath);
      cleanupReached = true;
    },
    runtimePool,
  );
  await store.upsertProjection({
    id, projectId: "p1", title: "T", status: "idle", createdAt: 1, updatedAt: 1,
    backendSessionId: binding.backendSessionId,
    worktreePath,
    runtimeBinding: {
      backendSessionId: binding.backendSessionId,
      authorityId: binding.authorityId,
      generation: binding.generation,
      continuity: binding.continuity,
      protocol: "legacy",
      location: binding.location,
    },
    isolation: {
      kind: "git-worktree", worktreePath, worktreeBranch: "polyth/isolate/delete",
      targetBranch: "main", targetPath: "/target", originPath: "/target",
      baseCommit: "base", createdAt: "2026-09-13T00:00:00.000Z", state: "active",
    },
  });

  await assert.rejects(
    sessions.delete!(id),
    (error: Error & { code?: string }) => error.code === "stale-evidence",
  );

  assert.equal(cleanupReached, false, "filesystem cleanup cannot follow mismatched release proof");
  assert.ok(await store.projection(id), "canonical history remains when cleanup admission fails");
});
