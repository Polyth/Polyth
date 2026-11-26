import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyGitRefusal, createGitService } from "../src/index.ts";
import { branchRouteHarness, cleanup, gitIn, tempRepo } from "./routeHarness.ts";

const dirs: string[] = [];
test.after(() => cleanup(dirs));

test("classifyGitRefusal matches both git phrasings of a branch in use", () => {
  for (const text of [
    "fatal: 'feat/x' is already used by worktree at '/w/wt-feat-x'",
    "fatal: 'feat/x' is already checked out at '/w/wt-feat-x'",
  ]) {
    const refusal = classifyGitRefusal(text);
    assert.equal(refusal?.code, "branch-in-use");
    assert.equal(refusal?.branch, "feat/x");
    assert.equal(refusal?.worktreePath, "/w/wt-feat-x");
  }
});

test("classifyGitRefusal reads the dirty files (at most five) and leaves unknown stderr alone", () => {
  const files = ["a", "b", "c", "d", "e", "f", "g"];
  const dirty = classifyGitRefusal(
    `error: Your local changes to the following files would be overwritten by checkout:\n${files.map((f) => `\t${f}`).join("\n")}\nPlease commit your changes or stash them before you switch branches.\nAborting`,
  );
  assert.equal(dirty?.code, "worktree-dirty");
  assert.equal(dirty?.count, 7);
  assert.deepEqual(dirty?.files, ["a", "b", "c", "d", "e"]);
  assert.equal(classifyGitRefusal("fatal: unable to access 'https://x/': Could not resolve host"), null);
  assert.equal(classifyGitRefusal("fatal: a branch named 'x' already exists")?.code, "branch-exists");
  assert.equal(classifyGitRefusal("error: pathspec 'nope' did not match any file(s) known to git")?.code, "branch-not-found");
});

test("checking out a branch that a linked worktree holds is a typed branch-in-use refusal", async () => {
  const root = tempRepo(dirs);
  const git = createGitService();
  const linked = `${root}-wt-feat`;
  dirs.push(linked);
  gitIn(root, "worktree", "add", "-b", "feat", linked, "main");
  await assert.rejects(git.checkout(root, "feat"), (error: Record<string, unknown>) => {
    assert.equal(error.code, "branch-in-use");
    assert.equal(error.branch, "feat");
    assert.equal(error.worktreePath, linked);
    return true;
  });
});

test("a create over an existing name and a checkout of a missing branch are typed refusals", async () => {
  const root = tempRepo(dirs);
  const git = createGitService();
  await assert.rejects(git.createBranch(root, "main"), { code: "branch-exists" });
  await assert.rejects(git.checkout(root, "no-such-branch"), { code: "branch-not-found" });
});

test("a checkout that would overwrite local work is worktree-dirty with its files", async () => {
  const root = tempRepo(dirs);
  const git = createGitService();
  gitIn(root, "checkout", "-q", "-b", "other");
  writeFileSync(join(root, "a.txt"), "other\n");
  gitIn(root, "commit", "-qam", "other change");
  gitIn(root, "checkout", "-q", "main");
  writeFileSync(join(root, "a.txt"), "local edit\n");
  await assert.rejects(git.checkout(root, "other"), (error: Record<string, unknown>) => {
    assert.equal(error.code, "worktree-dirty");
    assert.deepEqual(error.files, ["a.txt"]);
    assert.equal(error.count, 1);
    return true;
  });
  assert.equal(gitIn(root, "rev-parse", "--abbrev-ref", "HEAD").trim(), "main", "nothing changed");
});

test("the route names the worktree and its chats for branch-in-use, only from this Space", async () => {
  const root = tempRepo(dirs);
  const linked = `${root}-wt-feat`;
  dirs.push(linked);
  gitIn(root, "worktree", "add", "-b", "feat", linked, "main");
  const h = branchRouteHarness(root, [
    { id: "old", projectId: "p1", status: "idle", spaceId: "sp1", worktreePath: linked, updatedAt: 1 },
    { id: "new", projectId: "p1", status: "idle", spaceId: "sp1", worktreePath: linked, updatedAt: 2 },
    { id: "foreign", projectId: "p1", status: "idle", spaceId: "sp-other", worktreePath: linked, updatedAt: 3 },
  ]);
  const refused = await h.post("/api/git/checkout", { projectId: "p1", name: "feat" });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "branch-in-use");
  assert.equal(refused.body.mutationOutcome, "not-started");
  assert.deepEqual(refused.body.refusal, {
    branch: "feat", worktreePath: linked, worktreeLabel: `${root.split("/").pop()}-wt-feat`, sessionIds: ["new", "old"],
  });
});
