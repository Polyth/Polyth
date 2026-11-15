// POST /api/worktrees/sessions: the server allocates the linked worktree and
// creates — or starts — the chat in it, so a new chat in a fresh worktree is
// one client request. Keyed like every create: a resend returns the first chat
// and never allocates a second worktree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type {
  CreateSessionInput, ProjectService, SessionProjection, SessionService, StartSessionInput,
} from "@polyth/contracts";
import { accountScopedClientOperationId, sessionIdForCreateOperation } from "@polyth/session/create-operation";
import { isTemporaryWorktreeBranch } from "@polyth/session/worktree-names";
import { gitRoutes } from "../src/serverEntry.ts";
import type { GitService } from "../src/index.ts";
import { isolateBranchName } from "../src/managedWorktrees.ts";

const SPACE = { spaceId: "spc_home", userId: "usr_1" };

function makeHarness(opts: {
  /** The requester's scoped sessions lack `start` (an older host). */
  withoutStart?: boolean;
  /** Git refuses the first N codename branches as taken. */
  collisions?: number;
  /** Projects the requester's Space can see; defaults to p1. */
  visible?: readonly string[];
} = {}) {
  const projections = new Map<string, SessionProjection>();
  const worktrees: Array<{ branch: string; base?: string; newBranchOnly?: boolean }> = [];
  const starts: StartSessionInput[] = [];
  const creates: CreateSessionInput[] = [];
  let collisions = opts.collisions ?? 0;
  let gate: Promise<void> | undefined;
  const git = {
    branches: async () => ({ current: "main", branches: [{ name: "main" }] }),
    worktrees: {
      list: async () => worktrees.map((tree, index) => ({ path: `/wt/${index}`, branch: tree.branch, head: "abc", isMain: false })),
      create: async (_root: string, input: { branch: string; base?: string; newBranchOnly?: boolean }) => {
        if (input.newBranchOnly && collisions > 0) {
          collisions -= 1;
          throw Object.assign(new Error("branch exists"), { code: "conflict" });
        }
        await gate;
        worktrees.push(input);
        return { path: `/wt/${worktrees.length - 1}`, branch: input.branch, head: "abc", isMain: false };
      },
    },
  } as unknown as GitService;
  const row = (input: CreateSessionInput): { id: string } => {
    const id = input.id ?? randomUUID();
    const now = Date.now();
    projections.set(id, {
      id, projectId: input.projectId, title: input.title || "New session", status: "reconciling", createdAt: now, updatedAt: now,
      ...(input.worktreePath ? { worktreePath: input.worktreePath } : {}),
    });
    return { id };
  };
  const scoped = {
    create: async (input: CreateSessionInput) => { creates.push(input); return row(input); },
    ...(opts.withoutStart ? {} : {
      start: async (input: StartSessionInput) => {
        starts.push(input);
        return { ...(projections.has(input.id ?? "") ? { id: input.id! } : row(input)), queueId: input.clientOperationId };
      },
    }),
    snapshot: async (id: string) => {
      const projection = projections.get(id);
      if (!projection) throw Object.assign(new Error("not found"), { code: "not-found" });
      return { ...projection };
    },
  } as unknown as Pick<SessionService, "create" | "start" | "snapshot">;
  const visible = opts.visible ?? ["p1"];
  const project = (id: string) => ({ id, path: "/repo", name: "repo" });
  const routes = gitRoutes({
    // The unscoped registry knows a project the requester's Space does not.
    projects: { get: async (id: string) => (id === "p1" || id === "foreign" ? project(id) : undefined) } as unknown as ProjectService,
    scopedProjects: () => ({ get: async (id: string) => (visible.includes(id) ? project(id) : undefined) }) as never,
    sessions: { list: async () => [] } as unknown as SessionService,
    scopedSessions: () => scoped,
    git,
    commitMessage: async () => "",
  });
  const post = async (body: Record<string, unknown>) => {
    let payload: unknown;
    await routes({
      req: {}, res: {}, space: SPACE,
      url: new URL("http://x/api/worktrees/sessions"),
      path: "/api/worktrees/sessions",
      method: "POST",
      body: async () => body,
      json: (_code: number, data: unknown) => { payload = data; },
    } as never);
    return payload as { id: string; queueId?: string };
  };
  return {
    post, worktrees, starts, creates, projections,
    hold() {
      let release!: () => void;
      gate = new Promise((resolve) => { release = resolve; });
      return () => { gate = undefined; release(); };
    },
  };
}

const START = { firstTurn: { text: "hello" } };

test("a new-worktree start allocates one codename worktree and starts the chat in it with the account-scoped turn key", async () => {
  const h = makeHarness();
  const key = randomUUID();
  const reply = await h.post({ projectId: "p1", target: { kind: "new-worktree", base: "main" }, title: "T", start: START, clientOperationId: key });
  assert.equal(h.worktrees.length, 1);
  assert.equal(isTemporaryWorktreeBranch(h.worktrees[0]!.branch), true);
  assert.equal(h.worktrees[0]!.base, "main");
  assert.equal(h.worktrees[0]!.newBranchOnly, true);
  assert.equal(h.creates.length, 0);
  assert.equal(h.starts.length, 1);
  const started = h.starts[0]!;
  assert.equal(started.id, sessionIdForCreateOperation(key, SPACE));
  assert.equal(started.worktreePath, "/wt/0");
  assert.equal(started.title, "T");
  assert.deepEqual(started.start, START);
  assert.equal(started.clientOperationId, accountScopedClientOperationId(key, SPACE.userId));
  assert.deepEqual(reply, { id: started.id, queueId: started.clientOperationId });
});

test("a resend with the same key allocates nothing and starts the existing chat again in its worktree", async () => {
  const h = makeHarness();
  const body = { projectId: "p1", target: { kind: "new-worktree" }, start: START, clientOperationId: randomUUID() };
  const first = await h.post(body);
  const again = await h.post(body);
  assert.deepEqual(again, first);
  assert.equal(h.worktrees.length, 1);
  assert.equal(h.starts.length, 2);
  assert.equal(h.starts[1]!.id, first.id);
  assert.equal(h.starts[1]!.worktreePath, "/wt/0");
  assert.equal(h.starts[1]!.clientOperationId, h.starts[0]!.clientOperationId);
});

test("a resend that overtakes the in-flight original waits for it", async () => {
  const h = makeHarness();
  const body = { projectId: "p1", target: { kind: "new-worktree" }, start: START, clientOperationId: randomUUID() };
  const release = h.hold();
  const original = h.post(body);
  const resend = h.post(body);
  await new Promise((resolve) => setTimeout(resolve, 10));
  release();
  assert.deepEqual(await resend, await original);
  assert.equal(h.worktrees.length, 1);
});

test("a codename Git reports as taken is replaced by another one", async () => {
  const h = makeHarness({ collisions: 2 });
  await h.post({ projectId: "p1", target: { kind: "new-worktree" }, clientOperationId: randomUUID() });
  assert.equal(h.worktrees.length, 1);
});

test("a branch target opens that branch's worktree and refuses a managed isolation branch", async () => {
  const h = makeHarness();
  await h.post({ projectId: "p1", target: { kind: "branch", branch: "feature/x", base: "main" }, start: START, clientOperationId: randomUUID() });
  assert.deepEqual(h.worktrees, [{ branch: "feature/x", base: "main" }]);
  await assert.rejects(
    h.post({ projectId: "p1", target: { kind: "branch", branch: isolateBranchName(randomUUID()) } }),
    (error: { code?: string }) => error.code === "invalid-input",
  );
  await assert.rejects(
    h.post({ projectId: "p1", target: { kind: "elsewhere" } }),
    (error: { code?: string }) => error.code === "invalid-input",
  );
  assert.equal(h.worktrees.length, 1);
});

test("a project outside the requester's Space is not found and touches no checkout", async () => {
  const h = makeHarness();
  await assert.rejects(
    h.post({ projectId: "foreign", target: { kind: "new-worktree" }, start: START, clientOperationId: randomUUID() }),
    (error: { code?: string; message?: string }) => error.code === "not-found" && error.message === "unknown project",
  );
  assert.equal(h.worktrees.length, 0);
  assert.equal(h.starts.length, 0);
});

test("a host without start only creates, so the reply tells the client to send the first turn itself", async () => {
  const h = makeHarness({ withoutStart: true });
  const reply = await h.post({ projectId: "p1", target: { kind: "new-worktree" }, start: START, clientOperationId: randomUUID() });
  assert.equal(h.creates.length, 1);
  assert.equal(h.creates[0]!.worktreePath, "/wt/0");
  assert.deepEqual(reply, { id: h.creates[0]!.id });
});
