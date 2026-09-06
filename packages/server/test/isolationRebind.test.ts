import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentRuntime, Project, ProjectService, RuntimeEndpoint, RuntimeEvent } from "@polyth/contracts";
import { createGitService } from "@polyth/git";
import { createIsolationService } from "../../git/src/sessionIntegration.ts";
import { createStore } from "@polyth/session";
import { createSessionService, type Broadcaster } from "../src/sessions.ts";
import type { PermissionService } from "@polyth/permissions";

type Emit = (sessionId: string, ev: RuntimeEvent) => void;

const git = createGitService();
const dirs: string[] = [];
process.on("exit", () => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const runGit = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

const repo = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-iso-srv-"));
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

const endpoint = (cwd: string): RuntimeEndpoint => ({
  authorityId: "owned:iso-test",
  continuity: "verified",
  generation: 1,
  url: "http://127.0.0.1:9",
  location: { directory: cwd },
  control: { kind: "owned", instanceToken: "iso" },
  config: { kind: "read-only" },
  authentication: { kind: "none" },
});

function fakeRuntime() {
  const listeners = new Set<Emit>();
  const rt: AgentRuntime & { resetSession?: AgentRuntime["resetSession"] } = {
    capabilities: async () => ({
      streaming: true, permissions: true, questions: true, compaction: false, subagents: false, steering: false,
    }),
    models: async () => [],
    agents: async () => [],
    ensureSession: async (c) => `be_${c.sessionId}`,
    sessions: async () => [],
    history: async () => [],
    startTurn: async () => {},
    abort: async () => {},
    replyPermission: async () => {},
    replyQuestion: async () => {},
    onEvent(cb) {
      listeners.add(cb);
      return { dispose: () => listeners.delete(cb) };
    },
    dispose: async () => {},
  };
  return { rt };
}

const make = (root: string) => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-iso-db-"));
  dirs.push(dir);
  const store = createStore(join(dir, "s.db"));
  const project: Project = { id: "p1", path: root, name: "p", createdAt: 1 };
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
  const cwds: string[] = [];
  const released: string[] = [];
  const closed: string[] = [];
  const ctrl = {
    failClose: false,
    failRelease: false,
    failCreate: false as string | false,
    failEpoch: false,
  };
  const fake = fakeRuntime();
  const sessions = createSessionService({
    store, projects, permissions, broadcast, queue: store,
    worktrees: { list: (path) => git.worktrees.list(path) },
    closeWorkspaceProcesses: async (cwd) => {
      closed.push(cwd);
      if (ctrl.failClose) throw new Error("close failed");
    },
    releaseRuntime: async (_projectId, cwd) => {
      released.push(cwd);
      if (ctrl.failRelease) throw new Error("release failed");
    },
    runtimes: {
      forProject: async (_projectId, cwd) => {
        if (cwd) cwds.push(cwd);
        if (ctrl.failCreate && cwd && resolve(cwd) === resolve(ctrl.failCreate)) {
          throw new Error("runtime create failed");
        }
        return fake.rt;
      },
    },
  });
  const isolation = createIsolationService({
    git,
    sessions,
    projects,
    append: async () => undefined,
    closeWorkspaceProcesses: async (cwd) => {
      closed.push(cwd);
      if (ctrl.failClose) throw new Error("close failed");
    },
  });
  return { sessions, isolation, cwds, released, closed, ctrl, fake, project };
};

test("merge into project root rebinds runtime cwd to the repository", async () => {
  const root = repo();
  const { isolation, sessions, cwds } = make(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const session = await sessions.snapshot(created.id);
  writeFileSync(join(session.isolation!.worktreePath, "root.txt"), "r\n");
  const merged = await isolation.mergeBack(created.id);
  assert.equal(merged.ok, true);
  assert.equal(merged.finalized, true);
  const after = await sessions.snapshot(created.id);
  assert.equal(after.id, created.id);
  assert.equal(after.worktreePath, undefined);
  assert.equal(after.branch, "main");
  assert.equal(after.isolation, undefined);
  assert.equal(runGit(root, "rev-parse", "--abbrev-ref", "HEAD"), "main");
  assert.equal(readFileSync(join(root, "root.txt"), "utf8"), "r\n");
  assert.equal(resolve(cwds.at(-1)!), resolve(root));
});

test("merge into another worktree rebinds runtime cwd to that checkout", async () => {
  const root = repo();
  runGit(root, "branch", "feature");
  const featureWt = mkdtempSync(join(tmpdir(), "polyth-iso-feat-"));
  dirs.push(featureWt);
  rmSync(featureWt, { recursive: true, force: true });
  await git.worktrees.create(root, { branch: "feature", path: featureWt });
  const { isolation, sessions, cwds } = make(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1", targetBranch: "feature" });
  const isolated = await sessions.snapshot(created.id);
  writeFileSync(join(isolated.isolation!.worktreePath, "feat.txt"), "f\n");
  const merged = await isolation.mergeBack(created.id);
  assert.equal(merged.finalized, true);
  const after = await sessions.snapshot(created.id);
  assert.equal(after.worktreePath, resolve(featureWt));
  assert.equal(after.branch, "feature");
  assert.equal(runGit(root, "rev-parse", "--abbrev-ref", "HEAD"), "main");
  assert.equal(runGit(featureWt, "rev-parse", "--abbrev-ref", "HEAD"), "feature");
  assert.equal(readFileSync(join(featureWt, "feat.txt"), "utf8"), "f\n");
  assert.equal(existsSync(isolated.isolation!.worktreePath), false);
  assert.equal(resolve(cwds.at(-1)!), resolve(featureWt));
});

test("runtime release failure keeps the isolated workspace", async () => {
  const root = repo();
  const { isolation, sessions, ctrl } = make(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const wt = (await sessions.snapshot(created.id)).isolation!.worktreePath;
  writeFileSync(join(wt, "stay.txt"), "s\n");
  ctrl.failRelease = true;
  const result = await isolation.mergeBack(created.id);
  assert.equal(result.ok, true);
  assert.equal(result.finalized, false);
  const pending = await sessions.snapshot(created.id);
  assert.equal(pending.isolation?.rebound, false);
  assert.equal(pending.worktreePath, wt);
  assert.equal(existsSync(wt), true);
  ctrl.failRelease = false;
  const recovered = await isolation.recoverSession(await sessions.snapshot(created.id));
  assert.equal(recovered.isolation, undefined);
  assert.equal(existsSync(wt), false);
  assert.equal(recovered.worktreePath, undefined);
  assert.equal(recovered.branch, "main");
});

test("target runtime creation failure does not mark rebound", async () => {
  const root = repo();
  const { isolation, sessions, ctrl } = make(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const wt = (await sessions.snapshot(created.id)).isolation!.worktreePath;
  writeFileSync(join(wt, "stay.txt"), "s\n");
  ctrl.failCreate = root;
  const result = await isolation.mergeBack(created.id);
  assert.equal(result.ok, true);
  assert.equal(result.finalized, false);
  const pending = await sessions.snapshot(created.id);
  assert.notEqual(pending.isolation?.rebound, true);
  assert.equal(existsSync(wt), true);
  ctrl.failCreate = false;
  const recovered = await isolation.recoverSession(await sessions.snapshot(created.id));
  assert.equal(recovered.isolation, undefined);
  assert.equal(existsSync(wt), false);
});

test("runtime epoch failure leaves source recoverable", async () => {
  const root = repo();
  const { isolation, sessions, fake } = make(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const wt = (await sessions.snapshot(created.id)).isolation!.worktreePath;
  writeFileSync(join(wt, "epoch.txt"), "e\n");
  fake.rt.endpoint = async () => endpoint(root);
  fake.rt.resetSession = async () => {
    throw new Error("epoch failed");
  };
  const result = await isolation.mergeBack(created.id);
  assert.equal(result.ok, true);
  assert.equal(result.finalized, false);
  const pending = await sessions.snapshot(created.id);
  assert.notEqual(pending.isolation?.rebound, true);
  assert.equal(existsSync(wt), true);
  fake.rt.endpoint = undefined;
  fake.rt.resetSession = undefined;
  const recovered = await isolation.recoverSession(await sessions.snapshot(created.id));
  assert.equal(recovered.isolation, undefined);
  assert.equal(existsSync(wt), false);
  assert.equal(recovered.id, created.id);
  assert.equal(recovered.branch, "main");
});
