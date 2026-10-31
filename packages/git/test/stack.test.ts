import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitService } from "../src/index.ts";
import { applyRepoStack, loadRepoStacks, previewRepoStack, pushRepoStackBranch, resolveRepoStackInput, saveRepoStacks, withRepoStackStorageLock, type RepoStack } from "../src/stack.ts";

const git = createGitService();
const roots: string[] = [];
process.on("exit", () => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function repo(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `polyth-stack-${label}-`));
  roots.push(root);
  const run = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  run("init", "-q", "-b", "main");
  run("config", "user.name", "Polyth Test"); run("config", "user.email", "test@example.invalid");
  writeFileSync(join(root, "README.md"), "base\n"); run("add", "."); run("commit", "-qm", "base");
  return root;
}

function commit(root: string, branch: string, file: string, text: string): string {
  const run = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  run("checkout", "-q", branch); writeFileSync(join(root, file), text); run("add", file); run("commit", "-qm", `${branch} change`);
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

async function stackFixture() {
  const root = repo("fixture");
  const run = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  const main = await git.revParse(root, "main");
  run("branch", "feature/db", "main");
  const db = commit(root, "feature/db", "db.txt", "db\n");
  run("branch", "feature/api", "feature/db");
  const api = commit(root, "feature/api", "api.txt", "api\n");
  run("checkout", "-q", "main");
  const stack: RepoStack = { id: "stack", projectId: "project", repositoryId: "repo", baseBranch: "main", entries: [
    { branch: "feature/db", baseBranch: "main", baseSha: main, headSha: db },
    { branch: "feature/api", baseBranch: "feature/db", baseSha: db, headSha: api },
  ] };
  return { root, stack, main, db, api, run };
}

test("restack rewrites a two-level stack without duplicating parent commits", async () => {
  const fixture = await stackFixture();
  const { root, stack, run } = fixture;
  const updatedMain = commit(root, "main", "README.md", "updated base\n");
  const preview = await previewRepoStack(git, root, stack);
  assert.equal(preview.entries.length, 2);
  assert.deepEqual(preview.warnings, [], "an updated base is a normal reason to restack");
  assert.equal(preview.entries[0]?.expectedOntoSha, updatedMain);
  const result = await applyRepoStack(git, root, stack, preview);
  assert.deepEqual(result.outcomes.map((item) => item.ok), [true, true], JSON.stringify(result.outcomes));
  const parent = await git.revParse(root, "feature/db");
  const child = await git.revParse(root, "feature/api");
  assert.equal(await git.isAncestor(root, updatedMain, parent), true);
  assert.equal(await git.isAncestor(root, parent, child), true);
  assert.equal(Number(execFileSync("git", ["rev-list", "--count", `${updatedMain}..${child}`], { cwd: root, encoding: "utf8" }).trim()), 2);
  run("checkout", "-q", "main");
});

test("partial restack reports first receipt, preserves conflicted original, and cleans scratch worktree", async () => {
  const fixture = await stackFixture();
  const { root, stack, run } = fixture;
  const before = await Promise.all(stack.entries.map((entry) => git.revParse(root, entry.branch)));
  commit(root, "main", "api.txt", "conflicting base\n");
  const preview = await previewRepoStack(git, root, stack);
  const result = await applyRepoStack(git, root, stack, preview);
  assert.equal(result.outcomes[0]?.ok, true, JSON.stringify(result.outcomes));
  assert.equal(result.outcomes[1]?.ok, false);
  assert.equal(await git.revParse(root, stack.entries[1]!.branch), before[1]);
  assert.equal((await git.worktrees.list(root)).filter((item) => !item.isMain).length, 0);
  run("checkout", "-q", "main");
});

test("stale preview rejects before any branch mutation", async () => {
  const fixture = await stackFixture();
  const { root, stack } = fixture;
  const preview = await previewRepoStack(git, root, stack);
  commit(root, "main", "README.md", "moved\n");
  await assert.rejects(() => applyRepoStack(git, root, stack, preview), { code: "conflict" });
  assert.equal(await git.revParse(root, stack.entries[0]!.branch), stack.entries[0]!.headSha);
});

test("posted preview cannot omit or reorder canonical entries", async () => {
  const fixture = await stackFixture();
  const preview = await previewRepoStack(git, fixture.root, fixture.stack);
  await assert.rejects(() => applyRepoStack(git, fixture.root, fixture.stack, { ...preview, entries: [preview.entries[1]!] }), { code: "conflict" });
  await assert.rejects(() => applyRepoStack(git, fixture.root, fixture.stack, { ...preview, entries: preview.entries.map((entry) => ({ ...entry, branch: "foreign" })) }), { code: "conflict" });
});

test("checked-out branch is rejected without changing refs", async () => {
  const fixture = await stackFixture();
  const { root, stack, run } = fixture;
  run("checkout", "-q", "feature/db");
  const preview = await previewRepoStack(git, root, stack);
  const result = await applyRepoStack(git, root, stack, preview);
  assert.equal(result.outcomes[0]?.ok, false);
  assert.equal(result.outcomes[0]?.reason, "branch is checked out; refusing ref update");
  run("checkout", "-q", "main");
});

test("bare remote force-with-lease accepts current and rejects stale remote SHA", async () => {
  const root = repo("remote");
  const bare = mkdtempSync(join(tmpdir(), "polyth-stack-bare-")); roots.push(bare);
  execFileSync("git", ["init", "--bare", "-q", bare], { cwd: root });
  execFileSync("git", ["remote", "add", "origin", bare], { cwd: root });
  execFileSync("git", ["push", "-q", "origin", "main:main"], { cwd: root });
  const other = mkdtempSync(join(tmpdir(), "polyth-stack-other-")); roots.push(other);
  execFileSync("git", ["clone", "-q", "-b", "main", bare, other]);
  execFileSync("git", ["config", "user.name", "Other"], { cwd: other }); execFileSync("git", ["config", "user.email", "other@example.invalid"], { cwd: other });
  writeFileSync(join(other, "remote.txt"), "remote\n"); execFileSync("git", ["add", "."], { cwd: other }); execFileSync("git", ["commit", "-qm", "remote move"], { cwd: other }); execFileSync("git", ["push", "-q", "origin", "HEAD:main"], { cwd: other });
  const old = execFileSync("git", ["rev-parse", "HEAD~1"], { cwd: other, encoding: "utf8" }).trim();
  const local = await git.revParse(root, "main");
  await assert.rejects(() => pushRepoStackBranch(git, root, { branch: "main", remote: "origin", expectedRemoteSha: old, expectedLocalSha: local }), /rejected|failed/i);
  const remoteSha = execFileSync("git", ["--git-dir", bare, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim();
  const result = await pushRepoStackBranch(git, root, { branch: "main", remote: "origin", expectedRemoteSha: remoteSha, expectedLocalSha: local });
  assert.equal(result.newSha, local);
});

test("corrupt stack storage is not treated as empty", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "polyth-stack-storage-")); roots.push(storageRoot);
  const storage = { root: storageRoot, packageDir: (id: string) => join(storageRoot, "packages", id), path: (relative: string) => join(storageRoot, relative) };
  const path = join(storageRoot, "packages", "git", "stacks.json");
  execFileSync("mkdir", ["-p", join(storageRoot, "packages", "git")]); writeFileSync(path, "{bad");
  await assert.rejects(() => loadRepoStacks(storage), /Unexpected token|Expected property|corrupt/i);
  assert.equal(readFileSync(path, "utf8"), "{bad");
});

test("serialized CRUD preserves parallel stack additions", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "polyth-stack-crud-")); roots.push(storageRoot);
  const storage = { root: storageRoot, packageDir: (id: string) => join(storageRoot, "packages", id), path: (relative: string) => join(storageRoot, relative) };
  await Promise.all(["one", "two", "three"].map((id) => withRepoStackStorageLock({ ...storage }, async () => {
    const current = await loadRepoStacks(storage);
    await saveRepoStacks(storage, [...current, { id, projectId: "p", repositoryId: "r", baseBranch: "main", entries: [] }]);
  })));
  assert.deepEqual((await loadRepoStacks(storage)).map((stack) => stack.id).sort(), ["one", "three", "two"]);
});

test("branch entry input resolves immutable IDs from its scoped repository", async () => {
  const { root, stack, main, db } = await stackFixture();
  const project = { id: "project", name: "Project", path: root, createdAt: 1, repositories: [{ id: "repo", alias: "app", path: root }], primaryRepositoryId: "repo" };
  commit(root, "main", "README.md", "advanced before registering stack\n");
  const created = await resolveRepoStackInput(git, root, project, { ...stack, entries: [{ branch: "feature/db", baseBranch: "main", title: "Database" }] });
  assert.deepEqual(created.entries[0], { branch: "feature/db", baseBranch: "main", title: "Database", headSha: db, baseSha: main });
  await assert.rejects(() => resolveRepoStackInput(git, root, project, { ...stack, entries: [{ branch: "--help", baseBranch: "main" }] }), { code: "invalid-input" });
  await assert.rejects(() => resolveRepoStackInput(git, root, project, { ...stack, entries: [{ branch: "feature/db", baseBranch: "main", headSha: main }] }), { code: "conflict" });
});

test("a non-current base ref moving after preview rejects without rewriting branches", async () => {
  const { root, stack, run, db } = await stackFixture();
  run("branch", "preview-base", "main");
  stack.baseBranch = "preview-base";
  stack.entries[0]!.baseBranch = "preview-base";
  const preview = await previewRepoStack(git, root, stack);
  run("update-ref", "refs/heads/preview-base", db);
  await assert.rejects(() => applyRepoStack(git, root, stack, preview), { code: "conflict" });
  assert.equal(await git.revParse(root, "feature/db"), db);
});

test("scratch cleanup failure retains published receipts and stops the restack", async () => {
  const { root, stack } = await stackFixture();
  commit(root, "main", "README.md", "updated for cleanup failure\n");
  let leftover = "";
  const failing = { ...git, worktrees: { ...git.worktrees, remove: async (_root: string, input: { path: string }) => {
    leftover = input.path;
    throw new Error("simulated cleanup failure");
  } } };
  const result = await applyRepoStack(failing, root, stack, await previewRepoStack(git, root, stack));
  assert.equal(result.partial, true);
  assert.equal(result.outcomes.length, 1);
  assert.equal(result.outcomes[0]?.ok, true);
  assert.equal(result.outcomes[0]?.newSha, await git.revParse(root, "feature/db"));
  assert.ok(result.outcomes[0]?.receipt);
  assert.match(result.outcomes[0]?.cleanupError ?? "", /simulated cleanup failure/);
  if (leftover) await git.worktrees.remove(root, { path: leftover, force: true, deleteBranch: true, ownedBranch: "polyth/restack/stack/feature-db" });
});
