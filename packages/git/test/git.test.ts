import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitService } from "../src/index.ts";

const git = createGitService();
const dirs: string[] = [];

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

test("isRepo distinguishes a repo from a plain directory", async () => {
  const dir = repo();
  assert.equal(await git.isRepo(dir), true);
  const plain = mkdtempSync(join(tmpdir(), "polyth-plain-"));
  dirs.push(plain);
  assert.equal(await git.isRepo(plain), false);
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
