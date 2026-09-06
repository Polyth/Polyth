import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneRepository, createGitService, normalizeRepositoryUrl, pathsUnder } from "../src/index.ts";

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

test("fingerprint hashes untracked size/mtime instead of file bytes", async () => {
  const dir = repo();
  const big = join(dir, "blob.bin");
  writeFileSync(big, Buffer.alloc(4 * 1024 * 1024, 7));
  const started = Date.now();
  const fp1 = await git.fingerprint(dir);
  assert.ok(Date.now() - started < 3000);
  writeFileSync(big, Buffer.alloc(4 * 1024 * 1024 + 64, 8));
  const fp2 = await git.fingerprint(dir);
  assert.notEqual(fp1, fp2);
  const fn = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(fn, /await stat\(/);
  assert.doesNotMatch(fn, /readFileSync/);
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
