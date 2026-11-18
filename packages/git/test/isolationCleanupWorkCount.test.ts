// Work counts on the merge/cleanup path at production size. A package's
// `projects.get` and whole-installation `sessions.list()` are synchronous
// chains through the governed host (control-plane SQL per call), so a scan
// that repeats them per session row holds the server's event loop for
// seconds. These tests count calls instead of timing them.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { CreateSessionInput, JsonObject, SessionEvent, SessionIsolation, SessionProjection, SessionRef } from "@polyth/contracts";
import { createGitService } from "../src/index.ts";
import { createIsolationService, type IsolationSessionApi } from "../src/sessionIntegration.ts";

const git = createGitService();
const dirs: string[] = [];
process.on("exit", () => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const repo = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-iso-count-"));
  dirs.push(dir);
  const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  run("init", "-q", "-b", "main");
  run("config", "user.email", "t@example.com");
  run("config", "user.name", "Test");
  run("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "README.md"), "hello\n");
  run("add", ".");
  run("commit", "-qm", "init");
  return dir;
};

const clone = (isolation: SessionIsolation | undefined): SessionIsolation | undefined =>
  isolation ? JSON.parse(JSON.stringify(isolation)) as SessionIsolation : undefined;

const PROJECTS = 16;
const SESSIONS = 3_300;

interface Counts { projectGets: number; allLists: number; projectLists: number; maxSyncRun: number }

/** In-memory sessions + projects with call counters. `projects.get` resolves
 *  synchronously inside, like the governed package proxy. */
const fixture = () => {
  const root = repo();
  const projectIds = Array.from({ length: PROJECTS }, (_, i) => `p${i}`);
  const pathOf = (id: string) => id === "p0" ? root : join(root, "..", `other-project-${id}`);
  const projections = new Map<string, SessionProjection>();
  const events: SessionEvent[] = [];
  const counts: Counts = { projectGets: 0, allLists: 0, projectLists: 0, maxSyncRun: 0 };
  // Longest run of `projects.get` calls with no macrotask turn in between:
  // a proxy for how long the event loop is held by one scan.
  let run = 0;
  let turnPending = false;
  const noteCall = () => {
    run += 1;
    counts.maxSyncRun = Math.max(counts.maxSyncRun, run);
    if (!turnPending) {
      turnPending = true;
      setImmediate(() => { run = 0; turnPending = false; });
    }
  };
  for (let i = 0; i < SESSIONS; i++) {
    const id = randomUUID();
    projections.set(id, {
      id,
      projectId: projectIds[i % PROJECTS]!,
      title: `Session ${i}`,
      status: "idle",
      createdAt: i,
      updatedAt: i,
    });
  }
  const copy = (projection: SessionProjection): SessionProjection => ({ ...projection, isolation: clone(projection.isolation) });
  const sessions: IsolationSessionApi = {
    async create(input: CreateSessionInput): Promise<SessionRef> {
      const id = input.id ?? randomUUID();
      projections.set(id, {
        id,
        projectId: input.projectId,
        title: input.title || "New session",
        status: "idle",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ...(input.worktreePath ? { worktreePath: input.worktreePath, worktreeState: "ready" as const } : {}),
        ...(input.isolation ? { isolation: clone(input.isolation) } : {}),
      });
      return { id };
    },
    async snapshot(sessionId) {
      const projection = projections.get(sessionId);
      if (!projection) throw Object.assign(new Error("not found"), { code: "not-found" });
      return copy(projection);
    },
    async list(projectId) {
      if (projectId) counts.projectLists += 1;
      else counts.allLists += 1;
      return [...projections.values()].filter((row) => !projectId || row.projectId === projectId).map(copy);
    },
    async send() { return {}; },
    async patchIsolation(sessionId, isolation) {
      const current = projections.get(sessionId);
      if (!current) throw Object.assign(new Error("not found"), { code: "not-found" });
      const next: SessionProjection = { ...current, updatedAt: Date.now() };
      if (isolation) next.isolation = clone(isolation);
      else delete next.isolation;
      projections.set(sessionId, next);
      return copy(next);
    },
    async rebindWorkspace(sessionId, input) {
      const current = projections.get(sessionId);
      if (!current) throw Object.assign(new Error("not found"), { code: "not-found" });
      const next: SessionProjection = { ...current, updatedAt: Date.now() };
      if (input.workspace) next.workspace = { ...input.workspace, revision: (current.workspace?.revision ?? 0) + 1 };
      if (input.worktreePath === null) {
        delete next.worktreePath;
        delete next.worktreeState;
      } else if (typeof input.worktreePath === "string") {
        next.worktreePath = input.worktreePath;
        next.worktreeState = "ready";
      }
      if (input.branch) next.branch = input.branch;
      if (input.isolation === null) delete next.isolation;
      else if (input.isolation) next.isolation = clone(input.isolation);
      projections.set(sessionId, next);
      return copy(next);
    },
  };
  const isolation = createIsolationService({
    git,
    sessions,
    projects: {
      get: async (id) => {
        counts.projectGets += 1;
        noteCall();
        return projectIds.includes(id) ? { id, path: pathOf(id) } : undefined;
      },
      list: async () => projectIds.map((id) => ({ id, path: pathOf(id) })),
    },
    append: async (sessionId, type, data: JsonObject) => {
      events.push({ id: randomUUID(), sessionId, seq: events.length + 1, time: Date.now(), type, data, v: 1 });
    },
    readEvents: async () => [...events],
    closeWorkspaceProcesses: async () => {},
  });
  const reset = () => {
    counts.projectGets = 0;
    counts.allLists = 0;
    counts.projectLists = 0;
    counts.maxSyncRun = 0;
  };
  return { root, isolation, sessions, projections, counts, reset };
};

test("merge cleanup resolves each project once per dependents scan at production size", async () => {
  const f = fixture();
  const created = await f.isolation.createIsolatedSession({ projectId: "p0" });
  const session = await f.sessions.snapshot(created.id);
  const worktree = session.isolation!.worktreePath;
  writeFileSync(join(worktree, "feature.ts"), "export const n = 1;\n");
  // A completed child that ran in the checkout: cleanup rebinds it and the
  // dependents re-check after that must see it at its new path.
  const child = await f.sessions.create({ projectId: "p0", worktreePath: worktree, title: "child" });
  f.projections.set(child.id, { ...f.projections.get(child.id)!, parentId: created.id });
  f.reset();

  const result = await f.isolation.mergeBack(created.id);
  assert.equal(result.ok, true);
  assert.equal(result.finalized, true);
  assert.equal(result.session.isolation, undefined);
  assert.equal(resolve((await f.sessions.snapshot(child.id)).worktreePath ?? ""), resolve(f.root));

  console.log(`[work-count] merge+cleanup over ${SESSIONS} sessions in ${PROJECTS} projects: ${JSON.stringify(f.counts)}`);
  // Cleanup takes two dependents scans (one inside the child relocation,
  // one after it); each may resolve every project once, plus a handful of
  // single-project reads on the merge path itself.
  assert.ok(f.counts.projectGets <= 2 * PROJECTS + 16, `projects.get ran ${f.counts.projectGets} times`);
  // The relocation listing feeds its dependents scan; the re-check after the
  // rebind takes a fresh listing.
  assert.ok(f.counts.allLists <= 2, `sessions.list() ran ${f.counts.allLists} times`);
});

test("a dependents scan never resolves one project per session row", async () => {
  const f = fixture();
  const created = await f.isolation.createIsolatedSession({ projectId: "p0" });
  const current = f.projections.get(created.id)!;
  // A cleanup that stopped half way: the status card re-checks dependents.
  f.projections.set(created.id, { ...current, isolation: { ...clone(current.isolation)!, state: "cleanup-pending" } as SessionIsolation });
  f.reset();
  const status = await f.isolation.getStatus(created.id);
  assert.equal(status.isolation?.state, "cleanup-pending");
  console.log(`[work-count] status over ${SESSIONS} sessions in ${PROJECTS} projects: ${JSON.stringify(f.counts)}`);
  assert.ok(f.counts.projectGets <= PROJECTS + 8, `projects.get ran ${f.counts.projectGets} times`);
  assert.ok(f.counts.maxSyncRun <= PROJECTS + 8, `one uninterrupted run of ${f.counts.maxSyncRun} project reads`);
});
