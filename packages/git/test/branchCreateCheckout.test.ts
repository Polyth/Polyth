import test from "node:test";
import assert from "node:assert/strict";
import { createGitService } from "../src/index.ts";
import { branchRouteHarness, cleanup, gitIn, tempRepo } from "./routeHarness.ts";

const dirs: string[] = [];
test.after(() => cleanup(dirs));
const head = (root: string) => gitIn(root, "rev-parse", "--abbrev-ref", "HEAD").trim();
const hasBranch = (root: string, name: string) => gitIn(root, "branch", "--list", name).trim() !== "";

test("create-only leaves HEAD; create-and-switch moves it in one call", async () => {
  const root = tempRepo(dirs);
  const git = createGitService();
  await git.createBranch(root, "only");
  assert.equal(head(root), "main");
  await git.createBranch(root, "both", undefined, { checkout: true });
  assert.equal(head(root), "both");
});

test("an invalid name is refused before git runs and creates nothing", async () => {
  const root = tempRepo(dirs);
  const git = createGitService();
  for (const name of ["bad name", "a..b", "-x", "", "x.lock"]) {
    await assert.rejects(git.createBranch(root, name, undefined, { checkout: true }), { code: "invalid-branch-name" }, name);
  }
  assert.equal(head(root), "main");
});

test("an existing name with checkout is branch-exists and HEAD stays", async () => {
  const root = tempRepo(dirs);
  const git = createGitService();
  gitIn(root, "branch", "taken");
  await assert.rejects(git.createBranch(root, "taken", undefined, { checkout: true }), { code: "branch-exists" });
  assert.equal(head(root), "main");
});

test("POST /api/git/branch with checkout switches, announces and answers {ok, branch}", async () => {
  const root = tempRepo(dirs);
  const h = branchRouteHarness(root, []);
  const created = await h.post("/api/git/branch", { projectId: "p1", name: "feat/new", checkout: true });
  assert.equal(created.status, 200);
  assert.deepEqual(created.body, { ok: true, branch: "feat/new" });
  assert.equal(head(root), "feat/new");
  assert.deepEqual(h.changed, ["p1"]);
  const plain = await h.post("/api/git/branch", { projectId: "p1", name: "plain" });
  assert.equal(plain.status, 200);
  assert.equal(hasBranch(root, "plain"), true);
  assert.equal(head(root), "feat/new");
  assert.deepEqual(h.changed, ["p1"], "create-only changes no checkout, so it announces nothing");
});

test("route answers invalid names as a typed 400 not-started refusal", async () => {
  const root = tempRepo(dirs);
  const h = branchRouteHarness(root, []);
  const bad = await h.post("/api/git/branch", { projectId: "p1", name: "bad name", checkout: true });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, "invalid-branch-name");
  assert.equal(bad.body.mutationOutcome, "not-started");
});
