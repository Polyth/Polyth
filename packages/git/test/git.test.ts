import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneRepository, createGitService, normalizeRepositoryUrl, pathsUnder } from "../src/index.ts";
import { createManagedWorktrees, isolateBranchName, isolateWorktreePath } from "../src/managedWorktrees.ts";

const git = createGitService();
const dirs: string[] = [];
const REAL_GIT = execFileSync("which", ["git"], { encoding: "utf8" }).trim();

const recordedGit = (opts?: {
  failStatus?: boolean;
  failForce?: boolean;
  failBranchDelete?: boolean;
  raceRemove?: boolean;
  failListAfterRemove?: boolean;
  showRef?: "absent" | "fatal" | "hang";
  timeoutMs?: number;
}) => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-gitwrap-"));
  dirs.push(dir);
  const logFile = join(dir, "argv.log");
  const listCount = join(dir, "worktree-list.count");
  const wrapper = join(dir, "git");
  writeFileSync(wrapper, `#!/bin/sh
{
  printf '%s\\n' "$@"
  echo ---
} >> ${JSON.stringify(logFile)}
${opts?.failStatus ? 'if [ "$1" = status ]; then echo status failed >&2; exit 1; fi' : ""}
${opts?.failForce ? 'for a in "$@"; do if [ "$a" = --force ]; then echo forced remove failed >&2; exit 1; fi; done' : ""}
${opts?.failBranchDelete ? 'if [ "$1" = branch ] && [ "$2" = "-D" ]; then echo cannot delete branch >&2; exit 1; fi' : ""}
${opts?.raceRemove ? `if [ "$1" = worktree ] && [ "$2" = remove ]; then ${JSON.stringify(REAL_GIT)} "$@" >/dev/null 2>&1 || true; echo "fatal: not a working tree" >&2; exit 128; fi` : ""}
${opts?.failListAfterRemove ? `if [ "$1" = worktree ] && [ "$2" = list ]; then
  n=0
  if [ -f ${JSON.stringify(listCount)} ]; then n=$(cat ${JSON.stringify(listCount)}); fi
  n=$((n + 1))
  echo "$n" > ${JSON.stringify(listCount)}
  if [ "$n" -ge 2 ]; then echo "fatal: not a git repository" >&2; exit 128; fi
fi
if [ "$1" = worktree ] && [ "$2" = remove ]; then echo "fatal: cannot remove worktree" >&2; exit 128; fi` : ""}
${opts?.showRef === "absent" ? 'if [ "$1" = show-ref ]; then exit 1; fi' : ""}
${opts?.showRef === "fatal" ? 'if [ "$1" = show-ref ]; then echo "fatal: not a git repository" >&2; exit 128; fi' : ""}
${opts?.showRef === "hang" ? 'if [ "$1" = show-ref ]; then exec sleep 2; fi' : ""}
exec ${JSON.stringify(REAL_GIT)} "$@"
`);
  chmodSync(wrapper, 0o755);
  writeFileSync(logFile, "");
  return {
    git: createGitService({ bin: wrapper, ...(opts?.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) }),
    commands: (): string[][] => readFileSync(logFile, "utf8")
      .split("\n---\n")
      .map((block) => block.split("\n").filter(Boolean))
      .filter((args) => args.length > 0),
  };
};

const removeArgs = (commands: string[][]) =>
  commands.filter((args) => args[0] === "worktree" && args[1] === "remove");

const repo = (withCommit = true): string => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-git-"));
  dirs.push(dir);
  const g = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "Test");
  g("config", "commit.gpgsign", "false");
  if (withCommit) {
    writeFileSync(join(dir, "README.md"), "hello\n");
    g("add", ".");
    g("commit", "-qm", "init");
  }
  return dir;
};

process.on("exit", () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test("repository clone URLs accept GitHub/GitLab HTTP and SSH forms only", async () => {
  for (const value of [
    "https://github.com/acme/app.git",
    "http://gitlab.com/acme/app.git",
    "git@github.com:acme/app.git",
    "ssh://git@gitlab.com/acme/app.git",
  ]) assert.equal(normalizeRepositoryUrl(value), value);
  assert.throws(() => normalizeRepositoryUrl("https://github.com/acme/app.git?token=secret"), /URL/);
  assert.throws(() => normalizeRepositoryUrl("https://user:secret@github.com/acme/app.git"), /without credentials/);
  assert.throws(() => normalizeRepositoryUrl("https://example.com/acme/app.git"), /GitHub or GitLab/);
});

test("remote clone quotes the URL and registers the repository folder", async () => {
  const commands: string[] = [];
  const remote = {
    label: "dev@host",
    exec: async (command: string) => {
      commands.push(command);
      if (command.startsWith("test -d")) return { code: 0, stdout: "", stderr: "" };
      if (command.startsWith("test -e")) return { code: 1, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    start: async () => { throw new Error("unused"); },
    forward: async () => { throw new Error("unused"); },
  };
  assert.deepEqual(
    await cloneRepository({ repository: "git@github.com:acme/app.git", parentPath: "/srv/projects" }, remote),
    { path: "/srv/projects/app", name: "app" },
  );
  assert.match(commands[2]!, /git clone -- 'git@github\.com:acme\/app\.git' '\/srv\/projects\/app'/);
});

test("isRepo distinguishes a repo from a plain directory", async () => {
  const dir = repo();
  assert.equal(await git.isRepo(dir), true);
  const plain = mkdtempSync(join(tmpdir(), "polyth-plain-"));
  dirs.push(plain);
  assert.equal(await git.isRepo(plain), false);
});

test("repository identity can be read and changed without touching global config", async () => {
  const dir = repo();
  assert.deepEqual(await git.identity(dir), { name: "Test", email: "t@example.com" });
  await git.setIdentity(dir, { name: "Polyth Bot", email: "polyth@example.invalid" });
  assert.deepEqual(await git.identity(dir), { name: "Polyth Bot", email: "polyth@example.invalid" });
  await assert.rejects(() => git.setIdentity(dir, { name: "", email: "bad" }), /name required/);
});

test("status reports untracked, modified, staged and deleted files", async () => {
  const dir = repo();
  writeFileSync(join(dir, "new.txt"), "fresh\n");
  writeFileSync(join(dir, "README.md"), "changed\n");
  const s1 = await git.status(dir);
  assert.equal(s1.branch, "main");
  assert.equal(s1.clean, false);
  assert.deepEqual(s1.untracked.map((f) => f.path), ["new.txt"]);
  assert.deepEqual(s1.unstaged.map((f) => [f.path, f.status]), [["README.md", "modified"]]);

  await git.stage(dir, ["new.txt", "README.md"]);
  const s2 = await git.status(dir);
  assert.deepEqual(s2.staged.map((f) => f.path).sort(), ["README.md", "new.txt"]);
  assert.equal(s2.untracked.length, 0);

  await git.unstage(dir, ["new.txt"]);
  const s3 = await git.status(dir);
  assert.deepEqual(s3.untracked.map((f) => f.path), ["new.txt"]);

  execFileSync("git", ["rm", "-q", "-f", "README.md"], { cwd: dir });
  const s4 = await git.status(dir);
  assert.equal(s4.staged.some((f) => f.path === "README.md" && f.status === "deleted"), true);
});

test("status works in a repo with no commits yet", async () => {
  const dir = repo(false);
  writeFileSync(join(dir, "a.txt"), "a\n");
  const s = await git.status(dir);
  assert.equal(s.branch, "main");
  assert.deepEqual(s.untracked.map((f) => f.path), ["a.txt"]);
  await git.stage(dir, ["a.txt"]);
  const staged = await git.status(dir);
  assert.deepEqual(staged.staged.map((f) => f.path), ["a.txt"]);
  await git.unstage(dir, ["a.txt"]); // no HEAD: must not throw
  assert.deepEqual((await git.status(dir)).untracked.map((f) => f.path), ["a.txt"]);
  assert.deepEqual(await git.log(dir), []);
});

test("diff returns unstaged, staged and untracked content", async () => {
  const dir = repo();
  writeFileSync(join(dir, "README.md"), "changed\n");
  const unstaged = await git.diff(dir, { path: "README.md" });
  assert.match(unstaged.diff, /-hello/);
  assert.match(unstaged.diff, /\+changed/);

  await git.stage(dir, ["README.md"]);
  assert.equal((await git.diff(dir, { path: "README.md" })).diff.includes("+changed"), false);
  assert.match((await git.diff(dir, { path: "README.md", staged: true })).diff, /\+changed/);

  writeFileSync(join(dir, "brand.txt"), "brand new\n");
  assert.match((await git.diff(dir, { path: "brand.txt" })).diff, /\+brand new/);

  assert.ok((await git.diff(dir)).diff.length >= 0); // whole-repo diff must not throw
});

test("commit returns a sha and log lists it", async () => {
  const dir = repo();
  writeFileSync(join(dir, "f.txt"), "x\n");
  await git.stage(dir, ["f.txt"]);
  const { sha } = await git.commit(dir, "add f");
  assert.match(sha, /^[0-9a-f]{40}$/);
  const log = await git.log(dir, 5);
  assert.equal(log[0]?.subject, "add f");
  assert.equal(log[0]?.sha, sha);
  assert.equal(log[0]?.author, "Test");
  assert.equal((await git.status(dir)).clean, true);
  await assert.rejects(() => git.commit(dir, "   "), /empty/);
});

test("branches, createBranch and checkout", async () => {
  const dir = repo();
  await git.createBranch(dir, "feature/x");
  const b = await git.branches(dir);
  assert.equal(b.current, "main");
  assert.equal(b.branches.some((x) => x.name === "feature/x"), true);
  await git.checkout(dir, "feature/x");
  assert.equal((await git.branches(dir)).current, "feature/x");
});

test("discard reverts tracked edits and removes untracked files", async () => {
  const dir = repo();
  writeFileSync(join(dir, "README.md"), "oops\n");
  writeFileSync(join(dir, "junk.txt"), "junk\n");
  await git.discard(dir, ["README.md", "junk.txt"]);
  const s = await git.status(dir);
  assert.equal(s.clean, true);
});

test("worktree create, list and remove (with branch cleanup)", async () => {
  const dir = repo();
  const created = await git.worktrees.create(dir, { branch: "wt/one" });
  assert.equal(created.branch, "wt/one");
  const list = await git.worktrees.list(dir);
  assert.equal(list.length, 2);
  assert.equal(list[0]?.isMain, true);
  assert.equal(list.some((w) => w.branch === "wt/one"), true);
  dirs.push(created.path);

  await git.worktrees.remove(dir, { path: created.path, deleteBranch: true });
  assert.equal((await git.worktrees.list(dir)).length, 1);
  assert.equal((await git.branches(dir)).branches.some((b) => b.name === "wt/one"), false);
});

test("worktree removal refuses to destroy uncommitted work unless forced", async () => {
  const dir = repo();
  const created = await git.worktrees.create(dir, { branch: "wt/dirty" });
  dirs.push(created.path);
  writeFileSync(join(created.path, "draft.txt"), "not committed\n");

  await assert.rejects(
    () => git.worktrees.remove(dir, { path: created.path }),
    (err: Error & { code?: string; changes?: number }) => {
      assert.equal(err.code, "worktree-dirty");
      assert.equal(err.changes, 1);
      return true;
    },
  );
  assert.equal((await git.worktrees.list(dir)).length, 2, "the dirty worktree survives the refusal");

  await git.worktrees.remove(dir, { path: created.path, force: true });
  assert.equal((await git.worktrees.list(dir)).length, 1);
});

test("clean worktree removal does not pass --force to git", async () => {
  const dir = repo();
  const created = await git.worktrees.create(dir, { branch: "wt/clean" });
  dirs.push(created.path);
  const recorded = recordedGit();
  await recorded.git.worktrees.remove(dir, { path: created.path, deleteBranch: true });
  const removes = removeArgs(recorded.commands());
  assert.equal(removes.length, 1);
  assert.deepEqual(removes[0]!.slice(0, 2), ["worktree", "remove"]);
  assert.equal(removes[0]!.includes("--force"), false);
  assert.equal(existsSync(created.path), false);
  assert.equal((await git.worktrees.list(dir)).some((w) => w.branch === "wt/clean"), false);
});

test("dirty tracked file is refused by git without --force and keeps the branch", async () => {
  const dir = repo();
  const created = await git.worktrees.create(dir, { branch: "wt/tracked" });
  dirs.push(created.path);
  writeFileSync(join(created.path, "README.md"), "edited\n");
  const recorded = recordedGit();
  await assert.rejects(
    () => recorded.git.worktrees.remove(dir, { path: created.path, deleteBranch: true }),
    (err: Error & { code?: string; changes?: number }) => {
      assert.equal(err.code, "worktree-dirty");
      assert.equal(err.changes, 1);
      return true;
    },
  );
  const removes = removeArgs(recorded.commands());
  assert.equal(removes.length, 1);
  assert.equal(removes[0]!.includes("--force"), false);
  assert.equal((await git.worktrees.list(dir)).length, 2);
  assert.equal((await git.branches(dir)).branches.some((b) => b.name === "wt/tracked"), true);
});

test("failed status inspection does not force-delete a dirty worktree", async () => {
  const dir = repo();
  const created = await git.worktrees.create(dir, { branch: "wt/status-fail" });
  dirs.push(created.path);
  writeFileSync(join(created.path, "draft.txt"), "untracked\n");
  const recorded = recordedGit({ failStatus: true });
  await assert.rejects(
    () => recorded.git.worktrees.remove(dir, { path: created.path, deleteBranch: true }),
    (err: Error & { code?: string; changes?: number }) => {
      assert.equal(err.code, "worktree-dirty");
      assert.equal(err.changes, undefined);
      return true;
    },
  );
  const removes = removeArgs(recorded.commands());
  assert.equal(removes.length, 1);
  assert.equal(removes[0]!.includes("--force"), false);
  assert.equal(existsSync(created.path), true);
  assert.equal((await git.worktrees.list(dir)).length, 2);
  assert.equal((await git.branches(dir)).branches.some((b) => b.name === "wt/status-fail"), true);
});

test("explicit force removal uses --force and then deletes the branch", async () => {
  const dir = repo();
  const created = await git.worktrees.create(dir, { branch: "wt/force" });
  dirs.push(created.path);
  writeFileSync(join(created.path, "draft.txt"), "untracked\n");
  const recorded = recordedGit();
  await recorded.git.worktrees.remove(dir, { path: created.path, deleteBranch: true, force: true });
  const removes = removeArgs(recorded.commands());
  assert.equal(removes.length, 1);
  assert.equal(removes[0]!.includes("--force"), true);
  assert.equal((await git.worktrees.list(dir)).length, 1);
  assert.equal((await git.branches(dir)).branches.some((b) => b.name === "wt/force"), false);
});

test("remove reports success when another actor already deleted the worktree", async () => {
  const dir = repo();
  const created = await git.worktrees.create(dir, { branch: "wt/race" });
  dirs.push(created.path);
  const recorded = recordedGit({ raceRemove: true });
  const result = await recorded.git.worktrees.remove(dir, { path: created.path, deleteBranch: true });
  assert.deepEqual(result, {});
  assert.equal((await git.worktrees.list(dir)).length, 1);
  assert.equal((await git.branches(dir)).branches.some((b) => b.name === "wt/race"), false);
});

test("branch delete failure after physical success is reported, not thrown", async () => {
  const dir = repo();
  const created = await git.worktrees.create(dir, { branch: "wt/keep-branch" });
  dirs.push(created.path);
  const recorded = recordedGit({ failBranchDelete: true });
  const result = await recorded.git.worktrees.remove(dir, { path: created.path, deleteBranch: true });
  assert.deepEqual(result, { branchCleanupFailed: true });
  assert.equal((await git.worktrees.list(dir)).some((w) => w.branch === "wt/keep-branch"), false);
  assert.equal((await git.branches(dir)).branches.some((b) => b.name === "wt/keep-branch"), true);
});

test("branch already absent after -D failure is cleanup success", async () => {
  const dir = repo();
  const created = await git.worktrees.create(dir, { branch: "wt/gone-branch" });
  dirs.push(created.path);
  const recorded = recordedGit({ failBranchDelete: true, showRef: "absent" });
  const result = await recorded.git.worktrees.remove(dir, { path: created.path, deleteBranch: true });
  assert.deepEqual(result, {});
  assert.equal((await git.worktrees.list(dir)).some((w) => w.branch === "wt/gone-branch"), false);
});

test("branch verification fatal is cleanup failure, not absence", async () => {
  const dir = repo();
  const created = await git.worktrees.create(dir, { branch: "wt/verify-fatal" });
  dirs.push(created.path);
  const recorded = recordedGit({ failBranchDelete: true, showRef: "fatal" });
  const result = await recorded.git.worktrees.remove(dir, { path: created.path, deleteBranch: true });
  assert.deepEqual(result, { branchCleanupFailed: true });
});

test("branch verification timeout is cleanup failure, not absence", async () => {
  const dir = repo();
  const created = await git.worktrees.create(dir, { branch: "wt/verify-hang" });
  dirs.push(created.path);
  const recorded = recordedGit({ failBranchDelete: true, showRef: "hang", timeoutMs: 200 });
  const result = await recorded.git.worktrees.remove(dir, { path: created.path, deleteBranch: true });
  assert.deepEqual(result, { branchCleanupFailed: true });
});

test("remove failure plus list verification failure does not report success", async () => {
  const dir = repo();
  const created = await git.worktrees.create(dir, { branch: "wt/list-fail" });
  dirs.push(created.path);
  const recorded = recordedGit({ failListAfterRemove: true });
  await assert.rejects(
    () => recorded.git.worktrees.remove(dir, { path: created.path }),
    (err: Error & { code?: string }) => err.code === "git-failed",
  );
  assert.equal(existsSync(created.path), true);
  assert.equal((await git.worktrees.list(dir)).length, 2);
});

test("already-absent worktree with owned branch still deletes that branch", async () => {
  const dir = repo();
  const created = await git.worktrees.create(dir, { branch: "wt/retry-branch" });
  dirs.push(created.path);
  await git.worktrees.remove(dir, { path: created.path });
  assert.equal((await git.branches(dir)).branches.some((b) => b.name === "wt/retry-branch"), true);
  const result = await git.worktrees.remove(dir, {
    path: created.path, deleteBranch: true, ownedBranch: "wt/retry-branch",
  });
  assert.deepEqual(result, {});
  assert.equal((await git.branches(dir)).branches.some((b) => b.name === "wt/retry-branch"), false);
});

test("already-absent worktree without identifiable branch reports branchCleanupFailed", async () => {
  const dir = repo();
  const created = await git.worktrees.create(dir, { branch: "wt/unknown" });
  dirs.push(created.path);
  await git.worktrees.remove(dir, { path: created.path });
  const result = await git.worktrees.remove(dir, { path: created.path, deleteBranch: true });
  assert.deepEqual(result, { branchCleanupFailed: true });
});

test("failed force removal keeps the worktree and its branch", async () => {
  const dir = repo();
  const created = await git.worktrees.create(dir, { branch: "wt/force-fail" });
  dirs.push(created.path);
  writeFileSync(join(created.path, "draft.txt"), "untracked\n");
  const recorded = recordedGit({ failForce: true });
  await assert.rejects(
    () => recorded.git.worktrees.remove(dir, { path: created.path, deleteBranch: true, force: true }),
    (err: Error & { code?: string }) => {
      assert.equal(err.code, "git-failed");
      return true;
    },
  );
  assert.equal((await git.worktrees.list(dir)).length, 2);
  assert.equal((await git.branches(dir)).branches.some((b) => b.name === "wt/force-fail"), true);
});

test("worktree honours an explicit path and an existing branch", async () => {
  const dir = repo();
  await git.createBranch(dir, "existing");
  const target = join(mkdtempSync(join(tmpdir(), "polyth-wt-")), "here");
  dirs.push(target);
  const created = await git.worktrees.create(dir, { branch: "existing", path: target });
  assert.equal(created.path, target);
  mkdirSync(join(target, ".keep"), { recursive: true });
  assert.equal((await git.worktrees.list(dir)).some((w) => w.branch === "existing"), true);
});

test("git errors surface a short message, not a stack of stderr", async () => {
  const dir = repo();
  await assert.rejects(() => git.checkout(dir, "does-not-exist"), (err: Error) => {
    assert.ok(err.message.length < 200);
    assert.ok(!err.message.startsWith("fatal:"));
    return true;
  });
});

test("graph returns parents, refs, merges, and paginates", async () => {
  const dir = repo();
  const g = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "a.txt"), "a\n");
  g("add", "."); g("commit", "-qm", "second");
  g("checkout", "-qb", "feature");
  writeFileSync(join(dir, "b.txt"), "b\n");
  g("add", "."); g("commit", "-qm", "feature work");
  g("checkout", "-q", "main");
  writeFileSync(join(dir, "c.txt"), "c\n");
  g("add", "."); g("commit", "-qm", "main work");
  g("merge", "-q", "--no-ff", "-m", "merge feature", "feature");
  g("tag", "v1");

  const graph = await git.graph(dir);
  assert.equal(graph.length, 5);
  const merge = graph[0]!;
  assert.equal(merge.subject, "merge feature");
  assert.equal(merge.parents.length, 2);
  assert.ok(merge.refs.includes("main"));
  assert.ok(merge.refs.includes("tag: v1"));
  assert.ok(graph.some((c) => c.refs.includes("feature")));
  // every non-root commit's parents resolve to listed shas
  const shas = new Set(graph.map((c) => c.sha));
  for (const c of graph.slice(0, -1)) for (const p of c.parents) assert.ok(shas.has(p));

  const page2 = await git.graph(dir, { limit: 2, skip: 2 });
  assert.equal(page2.length, 2);
  assert.equal(page2[0]!.sha, graph[2]!.sha);
});

test("pathsUnder expands folders from status without touching siblings", async () => {
  const dir = repo();
  const g = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, "src", "a.ts"), "a\n");
  writeFileSync(join(dir, "docs", "d.md"), "d\n");
  writeFileSync(join(dir, "README.md"), "changed\n");
  g("add", "src/a.ts");

  const status = await git.status(dir);
  const src = pathsUnder(status, "src");
  assert.deepEqual(src.staged, ["src/a.ts"]);
  assert.deepEqual(src.untracked, []);
  const docs = pathsUnder(status, "docs");
  assert.deepEqual(docs.untracked, ["docs/d.md"]);
  assert.deepEqual(docs.staged, []);
  const root = pathsUnder(status, "");
  assert.deepEqual(root.unstaged, ["README.md"]);
  assert.equal(root.staged.length + root.untracked.length, 2);
  // a folder that is a name prefix (but not a path prefix) must not match
  const srcx = pathsUnder(status, "sr");
  assert.deepEqual([...srcx.staged, ...srcx.untracked, ...srcx.unstaged], []);
});

test("show returns a per-commit patch and diff can ignore whitespace", async () => {
  const dir = repo();
  writeFileSync(join(dir, "README.md"), "hello world\n");
  await git.stage(dir, ["README.md"]);
  const { sha } = await git.commit(dir, "change greeting");
  const shown = await git.show(dir, sha);
  assert.equal(shown.sha, sha);
  assert.match(shown.diff, /change greeting/);
  assert.match(shown.diff, /\+hello world/);

  writeFileSync(join(dir, "README.md"), "hello    world\n");
  assert.match((await git.diff(dir)).diff, /hello/);
  assert.equal((await git.diff(dir, { ignoreWhitespace: true })).diff.trim(), "");
});

test("stash push, apply, and drop round-trip tracked and untracked files", async () => {
  const dir = repo();
  writeFileSync(join(dir, "README.md"), "stashed edit\n");
  writeFileSync(join(dir, "new.txt"), "untracked\n");
  assert.equal((await git.stashPush(dir, "work in progress")).created, true);
  assert.equal((await git.status(dir)).clean, true);
  const stashes = await git.stashList(dir);
  assert.equal(stashes.length, 1);
  assert.match(stashes[0]!.message, /work in progress/);

  await git.stashApply(dir, stashes[0]!.ref);
  const restored = await git.status(dir);
  assert.equal(restored.unstaged.some((file) => file.path === "README.md"), true);
  assert.equal(restored.untracked.some((file) => file.path === "new.txt"), true);
  await git.stashDrop(dir, stashes[0]!.ref);
  assert.deepEqual(await git.stashList(dir), []);
  await assert.rejects(() => git.stashApply(dir, "--bad"), /invalid stash ref/);
});

test("fetch, pull, and push synchronize an explicit remote", async () => {
  const dir = repo();
  const bare = mkdtempSync(join(tmpdir(), "polyth-remote-"));
  dirs.push(bare);
  execFileSync("git", ["init", "--bare", "-q"], { cwd: bare });
  const g = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  g("remote", "add", "origin", bare);
  g("push", "-qu", "origin", "main");
  execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: bare });

  const peerParent = mkdtempSync(join(tmpdir(), "polyth-peer-"));
  dirs.push(peerParent);
  const peer = join(peerParent, "repo");
  execFileSync("git", ["clone", "-q", bare, peer]);
  const pg = (...args: string[]) => execFileSync("git", args, { cwd: peer, stdio: "pipe" });
  pg("config", "user.email", "t@example.com");
  pg("config", "user.name", "Peer");
  pg("config", "commit.gpgsign", "false");
  writeFileSync(join(peer, "peer.txt"), "from peer\n");
  pg("add", ".");
  pg("commit", "-qm", "peer change");
  pg("push", "-q");

  await git.fetch(dir, "origin");
  assert.equal((await git.status(dir)).behind, 1);
  await git.pull(dir, "origin");
  assert.equal((await git.status(dir)).behind, 0);
  writeFileSync(join(dir, "local.txt"), "from local\n");
  await git.stage(dir, ["local.txt"]);
  await git.commit(dir, "local change");
  await git.push(dir, "origin");
  assert.equal((await git.status(dir)).ahead, 0);
  await assert.rejects(() => git.fetch(dir, "--upload-pack=evil"), /invalid remote/);
});

test("push publishes a branch that has no upstream and sets tracking", async () => {
  const dir = repo();
  const bare = mkdtempSync(join(tmpdir(), "polyth-remote-"));
  dirs.push(bare);
  execFileSync("git", ["init", "--bare", "-q"], { cwd: bare });
  const g = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  g("remote", "add", "origin", bare);
  g("checkout", "-q", "-b", "feature/no-upstream");
  writeFileSync(join(dir, "feature.txt"), "new work\n");
  g("add", ".");
  g("commit", "-qm", "feature work");

  await git.push(dir, "origin");

  const tracking = execFileSync(
    "git",
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    { cwd: dir, stdio: "pipe" },
  ).toString().trim();
  assert.equal(tracking, "origin/feature/no-upstream");
  assert.equal((await git.status(dir)).ahead, 0);
});

test("pull reports divergent histories as a resolvable conflict", async () => {
  const dir = repo();
  const bare = mkdtempSync(join(tmpdir(), "polyth-remote-"));
  const peerParent = mkdtempSync(join(tmpdir(), "polyth-peer-"));
  dirs.push(bare, peerParent);
  execFileSync("git", ["init", "--bare", "-q"], { cwd: bare });
  const g = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  g("remote", "add", "origin", bare);
  g("push", "-qu", "origin", "main");
  execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: bare });
  const peer = join(peerParent, "repo");
  execFileSync("git", ["clone", "-q", bare, peer]);
  const pg = (...args: string[]) => execFileSync("git", args, { cwd: peer, stdio: "pipe" });
  pg("config", "user.email", "t@example.com");
  pg("config", "user.name", "Peer");

  writeFileSync(join(dir, "local.txt"), "local\n");
  g("add", "."); g("commit", "-qm", "local change");
  writeFileSync(join(peer, "remote.txt"), "remote\n");
  pg("add", "."); pg("commit", "-qm", "remote change"); pg("push", "-q");

  await assert.rejects(() => git.pull(dir), (error: Error & { code?: string }) => {
    assert.equal(error.code, "conflict");
    assert.match(error.message, /cannot fast-forward/);
    return true;
  });
});

test("snapshotCommit captures untracked files and respects gitignore", async () => {
  const dir = repo();
  writeFileSync(join(dir, "tracked.txt"), "keep\n");
  writeFileSync(join(dir, ".gitignore"), "noise.log\n");
  writeFileSync(join(dir, "noise.log"), "ignore-me\n");
  const snap = await git.snapshotCommit(dir, "polyth snapshot", { name: "Test", email: "t@example.com" });
  assert.equal(snap.created, true);
  const show = execFileSync("git", ["show", "--stat", "--format=", snap.sha], { cwd: dir, encoding: "utf8" });
  assert.match(show, /tracked\.txt/);
  assert.doesNotMatch(show, /noise\.log/);
  const fp1 = await git.fingerprint(dir);
  writeFileSync(join(dir, "tracked.txt"), "keep2\n");
  const fp2 = await git.fingerprint(dir);
  assert.notEqual(fp1, fp2);
});

test("snapshotCommit preserves HEAD and index while bypassing hooks and signing", async () => {
  const dir = repo();
  const g = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" }).toString();
  writeFileSync(join(dir, "mixed.txt"), "base\n");
  writeFileSync(join(dir, "delete-me.txt"), "delete\n");
  writeFileSync(join(dir, "script.sh"), "#!/bin/sh\nexit 0\n");
  g("add", ".");
  g("commit", "-qm", "fixture");

  writeFileSync(join(dir, "mixed.txt"), "staged\n");
  g("add", "mixed.txt");
  writeFileSync(join(dir, "mixed.txt"), "working\n");
  rmSync(join(dir, "delete-me.txt"));
  writeFileSync(join(dir, "untracked.txt"), "new\n");
  writeFileSync(join(dir, ".gitignore"), "ignored.txt\n");
  writeFileSync(join(dir, "ignored.txt"), "ignore\n");
  chmodSync(join(dir, "script.sh"), 0o755);
  symlinkSync("mixed.txt", join(dir, "link-to-mixed"));

  const gitDir = g("rev-parse", "--git-dir").trim();
  const indexPathRaw = g("rev-parse", "--git-path", "index").trim();
  const indexPath = indexPathRaw.startsWith("/") ? indexPathRaw : join(dir, indexPathRaw);
  const hooks = join(dir, gitDir, "hooks");
  const hookSentinel = join(dir, "hook-ran");
  for (const name of ["pre-commit", "commit-msg"]) {
    const hook = join(hooks, name);
    writeFileSync(hook, `#!/bin/sh\ntouch ${JSON.stringify(hookSentinel)}\nexit 1\n`);
    chmodSync(hook, 0o755);
  }
  g("config", "commit.gpgsign", "true");

  const beforeHead = g("rev-parse", "HEAD").trim();
  const beforeIndex = readFileSync(indexPath);
  const beforeStatus = g("status", "--porcelain=v1", "-uall");
  const beforeStaged = g("diff", "--cached", "--binary");
  const beforeUnstaged = g("diff", "--binary");
  const snapshot = await git.snapshotCommit(dir, "internal snapshot", { name: "Polyth", email: "polyth@local" });

  assert.equal(g("rev-parse", "HEAD").trim(), beforeHead);
  assert.deepEqual(readFileSync(indexPath), beforeIndex);
  assert.equal(g("status", "--porcelain=v1", "-uall"), beforeStatus);
  assert.equal(g("diff", "--cached", "--binary"), beforeStaged);
  assert.equal(g("diff", "--binary"), beforeUnstaged);
  assert.equal(existsSync(hookSentinel), false);
  assert.equal(g("show", `${snapshot.sha}:mixed.txt`), "working\n");
  assert.throws(() => g("cat-file", "-e", `${snapshot.sha}:delete-me.txt`));
  assert.equal(g("show", `${snapshot.sha}:untracked.txt`), "new\n");
  assert.throws(() => g("cat-file", "-e", `${snapshot.sha}:ignored.txt`));
  assert.match(g("ls-tree", snapshot.sha, "script.sh"), /^100755 /);
  assert.match(g("ls-tree", snapshot.sha, "link-to-mixed"), /^120000 /);
});

test("commonDir resolves the same absolute Git directory from a linked worktree", async () => {
  const dir = repo();
  const linked = mkdtempSync(join(tmpdir(), "polyth-common-dir-"));
  dirs.push(linked);
  rmSync(linked, { recursive: true, force: true });
  await git.worktrees.create(dir, { branch: "linked", path: linked, base: "HEAD" });
  const fromRoot = await git.commonDir(dir);
  const fromLinked = await git.commonDir(linked);
  assert.equal(fromLinked, fromRoot);
  assert.equal(fromRoot.startsWith("/"), true);
  assert.equal(fromRoot.includes("--absolute-git-common-dir"), false);
});

test("managed isolation creation rolls back when ownership establishment fails", async () => {
  const dir = repo();
  const sessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const path = isolateWorktreePath(dir, sessionId);
  let created = false;
  const failing = {
    ...git,
    worktrees: {
      ...git.worktrees,
      async create(root: string, input: { branch: string; path: string; base?: string }) {
        const result = await git.worktrees.create(root, input);
        created = true;
        return result;
      },
    },
    async revParse(root: string, rev: string) {
      if (created && root === path && rev === "HEAD") throw new Error("injected rev-parse failure");
      return git.revParse(root, rev);
    },
  } satisfies typeof git;
  await assert.rejects(() => createManagedWorktrees(failing).create({
    root: dir,
    sessionId,
    targetBranch: "main",
    targetPath: dir,
  }), /injected rev-parse failure/);
  assert.equal(existsSync(path), false);
  assert.throws(() => execFileSync("git", ["show-ref", "--verify", `refs/heads/${isolateBranchName(sessionId)}`], { cwd: dir }));
});

test("throwing create adopts and rolls back an exact clean managed resource", async () => {
  const dir = repo();
  const sessionId = "dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb";
  const path = isolateWorktreePath(dir, sessionId);
  const failing = {
    ...git,
    worktrees: {
      ...git.worktrees,
      async create(root: string, input: { branch: string; path: string; base?: string }) {
        await git.worktrees.create(root, input);
        throw new Error("injected failure after git created the worktree");
      },
    },
  } satisfies typeof git;

  await assert.rejects(() => createManagedWorktrees(failing).create({
    root: dir,
    sessionId,
    targetBranch: "main",
    targetPath: dir,
  }), /injected failure/);
  assert.equal(existsSync(path), false);
  assert.equal(await createManagedWorktrees(git).recoverCreations(dir), 0);
  assert.throws(() => execFileSync("git", ["show-ref", "--verify", `refs/heads/${isolateBranchName(sessionId)}`], { cwd: dir }));
});

test("durable creation receipt recovers when rollback itself fails", async () => {
  const dir = repo();
  const sessionId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
  const path = isolateWorktreePath(dir, sessionId);
  let created = false;
  let createdGitDirReads = 0;
  const failing = {
    ...git,
    worktrees: {
      ...git.worktrees,
      async create(root: string, input: { branch: string; path: string; base?: string }) {
        const result = await git.worktrees.create(root, input);
        created = true;
        return result;
      },
      async remove() { throw new Error("injected rollback failure"); },
    },
    async gitDir(root: string) {
      if (created && root === path && ++createdGitDirReads > 1) throw new Error("injected marker failure");
      return git.gitDir(root);
    },
  } satisfies typeof git;
  await assert.rejects(() => createManagedWorktrees(failing).create({
    root: dir,
    sessionId,
    targetBranch: "main",
    targetPath: dir,
  }), /creation and rollback failed/);
  assert.equal(existsSync(path), true);
  assert.equal(await createManagedWorktrees(git).recoverCreations(dir), 1);
  assert.equal(existsSync(path), false);
  assert.throws(() => execFileSync("git", ["show-ref", "--verify", `refs/heads/${isolateBranchName(sessionId)}`], { cwd: dir }));
});

test("detached integration creation rolls back when marker writing fails", async () => {
  const dir = repo();
  let integrationPath = "";
  let integrationGitDirReads = 0;
  const failing = {
    ...git,
    worktrees: {
      ...git.worktrees,
      async addDetached(root: string, path: string, ref: string) {
        integrationPath = path;
        return git.worktrees.addDetached(root, path, ref);
      },
    },
    async gitDir(root: string) {
      if (root === integrationPath && ++integrationGitDirReads > 1) throw new Error("injected integration marker failure");
      return git.gitDir(root);
    },
  } satisfies typeof git;
  await assert.rejects(() => createManagedWorktrees(failing).createIntegrationWorkspace({
    root: dir,
    sessionId: "cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa",
    startPoint: "HEAD",
  }), /injected integration marker failure/);
  assert.equal(existsSync(integrationPath), false);
  assert.equal((await git.worktrees.list(dir)).some((item) => item.path === integrationPath), false);
});

test("fingerprint is content-sensitive without reading files in Node", async () => {
  const dir = repo();
  writeFileSync(join(dir, "foo.ts"), "const n = 1;\n");
  const g = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  g("add", "."); g("commit", "-qm", "add foo");
  writeFileSync(join(dir, "foo.ts"), "const n = 2;\n");
  const fp1 = await git.fingerprint(dir);
  writeFileSync(join(dir, "foo.ts"), "const n = 3;\n");
  const fp2 = await git.fingerprint(dir);
  assert.notEqual(fp1, fp2);
  writeFileSync(join(dir, "blob.bin"), Buffer.alloc(4 * 1024 * 1024, 7));
  const started = Date.now();
  const fp3 = await git.fingerprint(dir);
  assert.ok(Date.now() - started < 5000);
  writeFileSync(join(dir, "blob.bin"), Buffer.alloc(4 * 1024 * 1024, 8));
  const fp4 = await git.fingerprint(dir);
  assert.notEqual(fp3, fp4);
  writeFileSync(join(dir, "same.txt"), "aaaa\n");
  const fp5 = await git.fingerprint(dir);
  writeFileSync(join(dir, "same.txt"), "bbbb\n");
  const fp6 = await git.fingerprint(dir);
  assert.notEqual(fp5, fp6);
  rmSync(join(dir, "foo.ts"));
  const fp7 = await git.fingerprint(dir);
  assert.notEqual(fp6, fp7);
  writeFileSync(join(dir, "renamed.ts"), "const n = 3;\n");
  const fp8 = await git.fingerprint(dir);
  assert.notEqual(fp7, fp8);
  const fn = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(fn, /hash-object/);
  assert.doesNotMatch(fn, /readFileSync/);
  assert.doesNotMatch(fn, /fingerprint[\s\S]*await stat\(/);
});

test("isAncestor reports commit ancestry", async () => {
  const dir = repo();
  const first = await git.revParse(dir, "HEAD");
  writeFileSync(join(dir, "next.txt"), "n\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-qm", "next"], { cwd: dir, stdio: "pipe" });
  const second = await git.revParse(dir, "HEAD");
  assert.equal(await git.isAncestor(dir, first, second), true);
  assert.equal(await git.isAncestor(dir, second, first), false);
});
