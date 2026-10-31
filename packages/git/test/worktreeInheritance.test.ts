import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createGitService } from "../src/index.ts";
import { createManagedWorktrees, isolateBranchName, isolateWorktreePath } from "../src/managedWorktrees.ts";

const git = createGitService();
const dirs: string[] = [];
test.after(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
    rmSync(`${dir}-polyth-isolate`, { recursive: true, force: true });
  }
});

const write = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

/** A repository whose main checkout carries an installed workspace. */
const installedRepo = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "polyth-inherit-")));
  dirs.push(dir);
  const g = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "Test");
  g("config", "commit.gpgsign", "false");
  write(join(dir, ".gitignore"), "node_modules\n*.bin\n");
  write(join(dir, ".worktreeinclude"), "*.bin\nnotes.txt\n");
  write(join(dir, "packages/ws/package.json"), "{\"name\":\"@scope/ws\"}\n");
  g("add", ".");
  g("commit", "-qm", "init");
  write(join(dir, "node_modules/react/package.json"), "{\"name\":\"react\"}\n");
  write(join(dir, "node_modules/react/bin.js"), "#!/usr/bin/env node\n");
  write(join(dir, "node_modules/@scope/real/package.json"), "{}\n");
  symlinkSync("../../packages/ws", join(dir, "node_modules/@scope/ws"));
  mkdirSync(join(dir, "node_modules/.bin"));
  symlinkSync("../react/bin.js", join(dir, "node_modules/.bin/tool"));
  write(join(dir, "node_modules/.package-lock.json"), "{}\n");
  write(join(dir, "packages/ws/node_modules/dep/index.js"), "\n");
  write(join(dir, "secret.bin"), "native\n");
  write(join(dir, "notes.txt"), "untracked but not ignored\n");
  return dir;
};

const sessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

test("an isolate inherits the parent checkout's dependencies as per-entry links", async () => {
  const dir = installedRepo();
  const managed = createManagedWorktrees(git);
  const created = await managed.create({ root: dir, sessionId, targetBranch: "main", targetPath: dir });
  const wt = created.path;

  // The farm is a real directory; only its entries are links.
  assert.equal(lstatSync(join(wt, "node_modules")).isSymbolicLink(), false);
  assert.equal(readlinkSync(join(wt, "node_modules/react")), join(dir, "node_modules/react"));
  assert.equal(lstatSync(join(wt, "node_modules/@scope")).isSymbolicLink(), false);
  assert.equal(readlinkSync(join(wt, "node_modules/@scope/real")), join(dir, "node_modules/@scope/real"));
  // Workspace links resolve to the branch's own sources.
  assert.equal(readlinkSync(join(wt, "node_modules/@scope/ws")), "../../packages/ws");
  assert.equal(realpathSync(join(wt, "node_modules/@scope/ws")), join(wt, "packages/ws"));
  assert.equal(readlinkSync(join(wt, "node_modules/.bin/tool")), "../react/bin.js");
  assert.equal(existsSync(join(wt, "node_modules/.package-lock.json")), false);
  assert.equal(readlinkSync(join(wt, "packages/ws/node_modules/dep")), join(dir, "packages/ws/node_modules/dep"));
  // `.worktreeinclude` links ignored files only.
  assert.equal(readlinkSync(join(wt, "secret.bin")), join(dir, "secret.bin"));
  assert.equal(existsSync(join(wt, "notes.txt")), false);

  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: wt, encoding: "utf8" }), "");
  assert.equal(await git.hasUniqueChanges(wt, created.head), false);

  // Removal deletes the links, never what they point at.
  const removed = await managed.removeOwned(dir, { sessionId, worktreePath: wt, worktreeBranch: created.branch });
  assert.equal(removed.status, "removed");
  assert.equal(existsSync(wt), false);
  assert.equal(readFileSync(join(dir, "node_modules/react/package.json"), "utf8"), "{\"name\":\"react\"}\n");
  assert.equal(existsSync(join(dir, "packages/ws/node_modules/dep/index.js")), true);
  assert.equal(existsSync(join(dir, "secret.bin")), true);
  assert.equal(existsSync(`${dir}-polyth-isolate`), false);
});

test("a nested isolate links to real locations instead of stacking links", async () => {
  const dir = installedRepo();
  const managed = createManagedWorktrees(git);
  const parent = await managed.create({ root: dir, sessionId, targetBranch: "main", targetPath: dir });
  const childId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
  const child = await managed.create({ root: dir, sessionId: childId, targetBranch: parent.branch, targetPath: parent.path, nested: true });
  assert.equal(readlinkSync(join(child.path, "node_modules/react")), join(dir, "node_modules/react"));
  assert.equal(realpathSync(join(child.path, "node_modules/@scope/ws")), join(child.path, "packages/ws"));
  assert.equal(readlinkSync(join(child.path, "secret.bin")), join(dir, "secret.bin"));
});

test("a directory-only ignore rule still inherits dependency folders", async () => {
  const dir = installedRepo();
  // `node_modules/` is the usual spelling; it matches only paths Git knows are
  // directories, and the folders do not exist in the fresh worktree yet.
  write(join(dir, ".gitignore"), "node_modules/\n*.bin\n");
  execFileSync("git", ["commit", "-qam", "directory-only rule"], { cwd: dir });
  const created = await createManagedWorktrees(git).create({ root: dir, sessionId, targetBranch: "main", targetPath: dir });
  assert.equal(readlinkSync(join(created.path, "node_modules/react")), join(dir, "node_modules/react"));
  assert.equal(readlinkSync(join(created.path, "packages/ws/node_modules/dep")), join(dir, "packages/ws/node_modules/dep"));
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: created.path, encoding: "utf8" }), "");
});

test("dependency folders are inherited only where the branch ignores them", async () => {
  const dir = installedRepo();
  write(join(dir, ".gitignore"), "*.bin\n");
  execFileSync("git", ["add", ".gitignore"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "track deps"], { cwd: dir });
  const created = await createManagedWorktrees(git).create({ root: dir, sessionId, targetBranch: "main", targetPath: dir });
  // node_modules is not ignored on this branch: linking it would be a change.
  assert.equal(existsSync(join(created.path, "node_modules")), false);
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: created.path, encoding: "utf8" }), "");
});

test("recovery releases a stale planned receipt whose create left nothing behind", async () => {
  const dir = installedRepo();
  const managed = createManagedWorktrees(git);
  const receipts = join(dir, ".git/polyth/creation-receipts");
  mkdirSync(receipts, { recursive: true });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  const plan = (id: string) => {
    const path = isolateWorktreePath(dir, id);
    const file = join(receipts, `isolate-${id.replaceAll("-", "")}-${path.split("/").at(-1)}.json`);
    writeFileSync(file, JSON.stringify({
      version: 1, phase: "planned", kind: "isolate", root: dir, path, sessionId: id,
      expectedHead: head, nonce: "cccccccc-dddd-4eee-8fff-000000000000", branch: isolateBranchName(id),
    }));
    return file;
  };
  const stale = plan("11111111-2222-4333-8444-555555555555");
  const old = new Date(Date.now() - 2 * 60 * 60_000);
  utimesSync(stale, old, old);
  const fresh = plan("66666666-7777-4888-8999-aaaaaaaaaaaa");
  const branchHeld = plan("99999999-8888-4777-8666-555555555555");
  utimesSync(branchHeld, old, old);
  execFileSync("git", ["branch", isolateBranchName("99999999-8888-4777-8666-555555555555")], { cwd: dir });

  assert.equal(await managed.recoverCreations(dir), 1);
  assert.equal(existsSync(stale), false);
  // A create may still be running, and a surviving branch is not ours to judge.
  assert.equal(existsSync(fresh), true);
  assert.equal(existsSync(branchHeld), true);
});
