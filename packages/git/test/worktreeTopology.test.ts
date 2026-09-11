import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectService, SessionService } from "@polyth/contracts";
import { createWorktreeTopologyWatch, worktreeTopologyFingerprint } from "../src/worktreeTopology.ts";
import { gitRoutes } from "../src/serverEntry.ts";
import { createGitService, type GitService } from "../src/index.ts";

const dirs: string[] = [];
test.after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const repo = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-topology-"));
  dirs.push(dir);
  const g = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "Test");
  g("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "README.md"), "hello\n");
  g("add", ".");
  g("commit", "-qm", "init");
  return dir;
};

// A worktree created outside Polyth — the agent/shell case — must be
// detectable without a filesystem watcher or a poll of every repository.
test("fingerprint moves when a worktree is added or removed by anyone", async () => {
  const dir = repo();
  const git = createGitService();

  const empty = await worktreeTopologyFingerprint(dir);
  assert.equal(empty, "none", "a repository with no linked worktrees has a stable reading");

  // Created straight through git, exactly as a shell or an agent would.
  const outside = `${dir}-outside`;
  dirs.push(outside);
  execFileSync("git", ["worktree", "add", "-b", "outside", outside, "main"], { cwd: dir, stdio: "pipe" });
  const added = await worktreeTopologyFingerprint(dir);
  assert.notEqual(added, empty, "adding a worktree changes the fingerprint");

  execFileSync("git", ["worktree", "remove", "--force", outside], { cwd: dir, stdio: "pipe" });
  await git.worktrees.prune(dir);
  const removed = await worktreeTopologyFingerprint(dir);
  assert.notEqual(removed, added, "removing a worktree changes it again");
});

test("a linked worktree's own path reads as `none`, never as a rival fingerprint", async () => {
  const dir = repo();
  const linked = `${dir}-linked`;
  dirs.push(linked);
  execFileSync("git", ["worktree", "add", "-b", "linked", linked, "main"], { cwd: dir, stdio: "pipe" });
  // A linked worktree's `.git` is a file. Fingerprinting one would flap
  // against the main checkout's reading and announce phantom changes, so the
  // routes always fingerprint the project checkout.
  assert.equal(await worktreeTopologyFingerprint(linked), "none");
  assert.notEqual(await worktreeTopologyFingerprint(dir), "none");
});

test("the watch reports real changes once, per project, and never on first sight", async () => {
  const a = repo();
  const b = repo();
  const seen: string[] = [];
  const watch = createWorktreeTopologyWatch((projectId) => seen.push(projectId));

  // A server that has never looked has observed nothing to announce.
  await watch.observe("pa", a);
  await watch.observe("pb", b);
  assert.deepEqual(seen, []);

  execFileSync("git", ["worktree", "add", "-b", "x", `${a}-x`, "main"], { cwd: a, stdio: "pipe" });
  dirs.push(`${a}-x`);

  await watch.observe("pa", a);
  assert.deepEqual(seen, ["pa"], "only the project whose repository changed is announced");

  await watch.observe("pa", a);
  assert.deepEqual(seen, ["pa"], "an unchanged topology is not re-announced");

  await watch.observe("pb", b);
  assert.deepEqual(seen, ["pa"], "an untouched project is never announced");
});

test("settle records a change this server made without announcing it twice", async () => {
  const dir = repo();
  const seen: string[] = [];
  const watch = createWorktreeTopologyWatch((projectId) => seen.push(projectId));
  await watch.observe("p1", dir);

  execFileSync("git", ["worktree", "add", "-b", "own", `${dir}-own`, "main"], { cwd: dir, stdio: "pipe" });
  dirs.push(`${dir}-own`);
  // The route announced this change itself and settled the reading.
  await watch.settle("p1", dir);
  await watch.observe("p1", dir);
  assert.deepEqual(seen, [], "the change we made and announced is not announced again");
});

// ---- routes ---------------------------------------------------------------

function routeHarness(opts: { listFails?: boolean } = {}) {
  const changed: string[] = [];
  const git = {
    isRepo: async () => true,
    worktrees: {
      create: async (_root: string, input: { branch: string }) =>
        ({ path: `/repo-worktrees/${input.branch}`, branch: input.branch, head: "abc", isMain: false }),
      list: async () => {
        if (opts.listFails) {
          throw Object.assign(new Error("fatal: not a git repository"), { code: "git-failed" });
        }
        return [];
      },
      remove: async () => ({}),
    },
  } as unknown as GitService;
  const routes = gitRoutes({
    projects: {
      get: async (id: string) => (id.startsWith("p") ? { id, path: `/repo-${id}`, name: id } : undefined),
    } as unknown as ProjectService,
    sessions: { list: async () => [], markWorktreeMissing: async () => undefined } as unknown as SessionService,
    git,
    commitMessage: async () => "",
    worktreesChanged: (projectId) => changed.push(projectId),
  });
  const call = async (path: string, method: "GET" | "POST", payload: Record<string, unknown>) => {
    let status = 0;
    let body: unknown;
    const url = new URL(`http://x${path}`);
    if (method === "GET") for (const [k, v] of Object.entries(payload)) url.searchParams.set(k, String(v));
    let error: unknown;
    try {
      await routes({
        req: {}, res: {},
        space: { userId: "usr_test" },
        url, path, method,
        body: async () => payload,
        json: (code: number, data: unknown) => { status = code; body = data; },
      } as never);
    } catch (cause) { error = cause; }
    return { status, body, error };
  };
  return { call, changed };
}

test("creating a worktree announces its project, and only its project", async () => {
  const h = routeHarness();
  const result = await h.call("/api/worktrees", "POST", { projectId: "p1", branch: "feat/one" });
  assert.equal(result.status, 200);
  assert.deepEqual(h.changed, ["p1"]);
});

test("removing a worktree announces its project", async () => {
  const h = routeHarness();
  const result = await h.call("/api/worktrees/remove", "POST", { projectId: "p2", path: "/repo-worktrees/x" });
  assert.equal(result.status, 200);
  assert.deepEqual(h.changed, ["p2"]);
});

// An unreadable repository and a repository with no worktrees are different
// answers. Flattening the first into the second would quietly tell the user
// their workspaces are gone.
test("a failed worktree listing surfaces as an error, not as an empty topology", async () => {
  const h = routeHarness({ listFails: true });
  const result = await h.call("/api/worktrees", "GET", { projectId: "p1" });
  assert.ok(result.error, "the failure propagates to the route error handler");
  assert.equal(result.status, 0, "no success payload was produced");
  assert.notDeepEqual(result.body, []);
});
