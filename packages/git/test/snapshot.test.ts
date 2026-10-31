import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitService } from "../src/index.ts";

const git = createGitService();
const run = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }).toString().trim();
function repo(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "polyth-snapshot-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  run(root, "init", "-qb", "main");
  run(root, "config", "user.name", "Test");
  run(root, "config", "user.email", "test@example.com");
  run(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, "file"), "base\n");
  writeFileSync(join(root, "delete"), "delete me\n");
  writeFileSync(join(root, ".gitignore"), "ignored\n");
  run(root, "add", ".");
  run(root, "commit", "-qm", "base");
  return root;
}
function sourceState(root: string) {
  return {
    head: run(root, "rev-parse", "HEAD"),
    index: readFileSync(join(run(root, "rev-parse", "--absolute-git-dir"), "index")),
    staged: run(root, "diff", "--cached", "--binary"),
    unstaged: run(root, "diff", "--binary"),
    untracked: run(root, "ls-files", "--others", "--exclude-standard", "-z"),
  };
}

test("snapshot preserves HEAD and byte-identical index while capturing worktree changes without hooks/signing", async (t) => {
  const root = repo(t);
  writeFileSync(join(root, "file"), "staged\n");
  run(root, "add", "file");
  writeFileSync(join(root, "file"), "unstaged final\n");
  rmSync(join(root, "delete"));
  writeFileSync(join(root, "untracked"), "new\n");
  writeFileSync(join(root, "ignored"), "ignored\n");
  writeFileSync(join(root, "script"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(root, "script"), 0o755);
  symlinkSync("file", join(root, "link"));
  const hooks = join(root, ".git", "hooks");
  for (const name of ["pre-commit", "commit-msg", "post-commit"]) {
    writeFileSync(join(hooks, name), `#!/bin/sh\necho ran > '${root}/hook-ran'\nexit 1\n`, { mode: 0o755 });
  }
  run(root, "config", "commit.gpgsign", "true");
  run(root, "config", "gpg.program", "/does/not/exist");
  const before = sourceState(root);
  const snapshot = await git.snapshotCommit(root, "synthetic snapshot");
  assert.equal(snapshot.created, true);
  assert.notEqual(snapshot.sha, before.head);
  assert.deepEqual(sourceState(root), before);
  assert.equal(existsSync(join(root, "hook-ran")), false);
  assert.equal(run(root, "show", `${snapshot.sha}:file`), "unstaged final");
  assert.equal(run(root, "show", `${snapshot.sha}:untracked`), "new");
  assert.equal(run(root, "show", `${snapshot.sha}:link`), "file");
  const tree = run(root, "ls-tree", snapshot.sha);
  assert.match(tree, /100755 blob .*\tscript/);
  assert.match(tree, /120000 blob .*\tlink/);
  assert.doesNotMatch(tree, /\t(delete|ignored)\n?/);
  assert.equal(run(root, "rev-parse", `${snapshot.sha}^`), before.head);
});

test("failed integration keeps source staging and worktree exactly as before", async (t) => {
  const root = repo(t);
  const source = join(root, "source");
  await git.worktrees.create(root, { branch: "isolated", path: source });
  writeFileSync(join(source, "file"), "staged source\n");
  run(source, "add", "file");
  writeFileSync(join(source, "file"), "source final\n");
  writeFileSync(join(source, "untracked"), "preserve\n");
  writeFileSync(join(root, "file"), "target conflict\n");
  run(root, "add", "file");
  run(root, "commit", "-qm", "target");
  const targetHead = run(root, "rev-parse", "HEAD");
  const before = sourceState(source);
  const snapshot = await git.snapshotCommit(source, "snapshot");
  const integration = join(root, "integration");
  await git.worktrees.addDetached(root, integration, targetHead);
  const merged = await git.mergeSquash(integration, snapshot.sha);
  assert.equal(merged.ok, false);
  assert.deepEqual(sourceState(source), before);
  assert.equal(run(root, "rev-parse", "HEAD"), targetHead);
  assert.equal(readFileSync(join(source, "untracked"), "utf8"), "preserve\n");
});

test("empty snapshot keeps the existing HEAD object and index", async (t) => {
  const root = repo(t);
  const before = sourceState(root);
  assert.deepEqual(await git.snapshotCommit(root, "unused"), { sha: before.head, created: false });
  assert.deepEqual(sourceState(root), before);
});

test("snapshot failure leaves the original index and HEAD unchanged", async (t) => {
  const root = repo(t);
  writeFileSync(join(root, "file"), "dirty\n");
  const before = sourceState(root);
  const wrapper = join(root, "fail-git");
  writeFileSync(wrapper, '#!/bin/sh\ncase "$*" in *commit-tree*) exit 97;; esac\nexec git "$@"\n', { mode: 0o755 });
  // Keep the command wrapper outside the snapshot's relevant untracked files.
  run(root, "config", "core.excludesFile", join(root, ".git", "exclude"));
  writeFileSync(join(root, ".git", "exclude"), "fail-git\n");
  await assert.rejects(createGitService({ bin: wrapper }).snapshotCommit(root, "fails"));
  assert.deepEqual(sourceState(root), before);
});

test("common Git directory is absolute and identical for all linked worktrees", async (t) => {
  const root = repo(t);
  const worktree = join(root, "linked");
  await git.worktrees.create(root, { branch: "linked", path: worktree });
  assert.equal(await git.commonDir(root), join(root, ".git"));
  assert.equal(await git.commonDir(worktree), await git.commonDir(root));
});

test("source fingerprint detects executable changes, newline names, and symlink retargeting without writing index", async (t) => {
  const root = repo(t);
  writeFileSync(join(root, "file"), "dirty\n");
  const beforeIndex = readFileSync(join(root, ".git", "index"));
  const initial = await git.fingerprint(root);
  chmodSync(join(root, "file"), 0o755);
  assert.notEqual(await git.fingerprint(root), initial);
  writeFileSync(join(root, "line\nbreak"), "first\n");
  const newline = await git.fingerprint(root);
  writeFileSync(join(root, "line\nbreak"), "second\n");
  assert.notEqual(await git.fingerprint(root), newline);
  symlinkSync("missing-one", join(root, "link"));
  const link = await git.fingerprint(root);
  rmSync(join(root, "link"));
  symlinkSync("missing-two", join(root, "link"));
  assert.notEqual(await git.fingerprint(root), link);
  assert.deepEqual(readFileSync(join(root, ".git", "index")), beforeIndex);
});
