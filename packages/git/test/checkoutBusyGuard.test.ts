import test from "node:test";
import assert from "node:assert/strict";
import { branchRouteHarness, cleanup, gitIn, tempRepo, type FakeSession } from "./routeHarness.ts";

const dirs: string[] = [];
test.after(() => cleanup(dirs));
const head = (root: string) => gitIn(root, "rev-parse", "--abbrev-ref", "HEAD").trim();
const chat = (id: string, status: string, extra: Partial<FakeSession> = {}): FakeSession =>
  ({ id, projectId: "p1", status, spaceId: "sp1", ...extra });

test("a running chat in the checkout blocks checkout and create-and-switch with session-busy", async () => {
  const root = tempRepo(dirs);
  gitIn(root, "branch", "other");
  const h = branchRouteHarness(root, [chat("s-run", "working"), chat("s-idle", "idle")]);
  const refused = await h.post("/api/git/checkout", { projectId: "p1", name: "other", sessionId: "s-run" });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "session-busy");
  assert.equal(refused.body.mutationOutcome, "not-started");
  assert.deepEqual((refused.body.refusal as { sessionIds: string[] }).sessionIds, ["s-run"]);
  assert.equal(head(root), "main", "no chat is exempt, not even the viewed one");
  const create = await h.post("/api/git/branch", { projectId: "p1", name: "n", checkout: true });
  assert.equal(create.body.error, "session-busy");
  assert.equal(gitIn(root, "branch", "--list", "n").trim(), "");
  assert.deepEqual(h.changed, []);
});

test("idle, archived and foreign-Space chats never block", async () => {
  const root = tempRepo(dirs);
  gitIn(root, "branch", "other");
  const h = branchRouteHarness(root, [
    chat("a", "archived"), chat("b", "idle"), chat("c", "working", { spaceId: "sp-other" }),
    chat("d", "working", { worktreePath: `${root}-elsewhere` }),
  ]);
  const ok = await h.post("/api/git/checkout", { projectId: "p1", name: "other" });
  assert.equal(ok.status, 200);
  assert.equal(head(root), "other");
});

test("a dormant chat whose owned runtime was replaced does not block; an unsettled one does", async () => {
  const root = tempRepo(dirs);
  gitIn(root, "branch", "other");
  // Owned epoch-pending: the Navigator shows "reconnects on use"; no process can write.
  const dormant = branchRouteHarness(root, [chat("s-old", "epoch-pending", { runtimeControl: "owned" })]);
  assert.equal((await dormant.post("/api/git/checkout", { projectId: "p1", name: "other" })).status, 200);
  assert.equal(head(root), "other");
  for (const status of ["epoch-pending", "unknown", "reconciling", "waiting"]) {
    const h = branchRouteHarness(root, [chat("s-uncertain", status, status === "epoch-pending" ? { runtimeControl: "borrowed" } : {})]);
    const refused = await h.post("/api/git/checkout", { projectId: "p1", name: "main" });
    assert.equal(refused.body.error, "session-busy", status);
  }
  assert.equal(head(root), "other");
});

test("creating without switching is not guarded", async () => {
  const root = tempRepo(dirs);
  const h = branchRouteHarness(root, [chat("s-run", "working")]);
  assert.equal((await h.post("/api/git/branch", { projectId: "p1", name: "x" })).status, 200);
});
