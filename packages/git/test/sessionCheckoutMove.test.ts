import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { branchRouteHarness, cleanup, gitIn, tempRepo, type FakeSession } from "./routeHarness.ts";

const dirs: string[] = [];
test.after(() => cleanup(dirs));
const head = (root: string) => gitIn(root, "rev-parse", "--abbrev-ref", "HEAD").trim();
const branchExists = (root: string, name: string) => gitIn(root, "branch", "--list", name).trim() !== "";

/** A repo with one linked worktree on `feat/x`, and a chat in it. */
function setup(extra: Partial<FakeSession>[] = [], chatExtra: Partial<FakeSession> = {}) {
  const root = tempRepo(dirs);
  const wt = `${root}-wt`;
  dirs.push(wt);
  gitIn(root, "worktree", "add", "-q", "-b", "feat/x", wt);
  const chat: FakeSession = { id: "s1", projectId: "p1", status: "idle", spaceId: "sp1", worktreePath: wt, branch: "feat/x", ...chatExtra };
  const others = extra.map((row, index) => ({ id: `o${index}`, projectId: "p1", status: "idle", spaceId: "sp1", ...row }) as FakeSession);
  const h = branchRouteHarness(root, [chat, ...others]);
  return { root, wt, chat, h, others };
}

/** A route may answer a typed refusal or throw a coded error; both are returned. */
async function attempt(h: ReturnType<typeof branchRouteHarness>, path: string, payload: Record<string, unknown>, spaceId = "sp1") {
  try {
    const r = await h.post(path, payload, spaceId);
    return { status: r.status, code: r.body.error as string | undefined, body: r.body };
  } catch (error) {
    return { status: 0, code: (error as { code?: string }).code, body: {} as Record<string, unknown> };
  }
}
const preview = (h: ReturnType<typeof branchRouteHarness>, target: unknown, sessionId = "s1") =>
  h.post("/api/git/session-checkout/preview", { sessionId, target });

test("a running or queued chat is refused and previews as blocked", async () => {
  const { h, chat, root } = setup([], { status: "working" });
  const p = await preview(h, { main: true });
  assert.equal((p.body.blocked as { reason: string }).reason, "busy");
  const refused = await attempt(h, "/api/git/session-checkout", { sessionId: "s1", expectedWorkspaceRevision: 0, target: { main: true } });
  assert.equal(refused.status, 409);
  assert.equal(refused.code, "session-busy");
  assert.equal(refused.body.mutationOutcome, "not-started");
  assert.deepEqual(h.rebound, []);
  assert.notEqual(chat.worktreePath, root);
  chat.status = "idle";
  h.queued.add("s1");
  assert.equal(((await preview(h, { main: true })).body.blocked as { reason: string }).reason, "queued");
  assert.equal((await attempt(h, "/api/git/session-checkout", { sessionId: "s1", expectedWorkspaceRevision: 0, target: { main: true } })).code, "session-busy");
});

test("a foreign-Space chat is not-found, exactly like a missing one", async () => {
  const { h } = setup([{ spaceId: "sp-other" }]);
  const body = (id: string) => ({ sessionId: id, expectedWorkspaceRevision: 0, target: { main: true } });
  const foreign = await attempt(h, "/api/git/session-checkout", body("o0"));
  const missing = await attempt(h, "/api/git/session-checkout", body("nope"));
  assert.equal(foreign.code, "not-found");
  assert.deepEqual(foreign, missing);
  const viaPreview = await attempt(h, "/api/git/session-checkout/preview", { sessionId: "o0", target: { main: true } });
  assert.equal(viaPreview.code, "not-found");
  // The same id is fine for its own Space; the caller's Space never sees the foreign chat.
  assert.deepEqual(h.rebound, []);
});

test("a raw path outside the worktree list is refused", async () => {
  const { h, root } = setup();
  const stray = `${root}-stray`;
  const p = await preview(h, { worktreePath: stray });
  assert.equal((p.body.blocked as { reason: string }).reason, "missing-target");
  const r = await attempt(h, "/api/git/session-checkout", { sessionId: "s1", expectedWorkspaceRevision: 0, target: { worktreePath: stray } });
  assert.equal(r.code, "not-found");
  const traversal = await attempt(h, "/api/git/session-checkout", { sessionId: "s1", expectedWorkspaceRevision: 0, target: { worktreePath: `${root}/../` } });
  assert.equal(traversal.code, "not-found");
  assert.deepEqual(h.rebound, []);
});

test("a stale revision is a conflict and nothing moves", async () => {
  const { h, chat, wt } = setup();
  const r = await attempt(h, "/api/git/session-checkout", { sessionId: "s1", expectedWorkspaceRevision: 7, target: { main: true } });
  assert.equal(r.code, "conflict");
  assert.equal(chat.worktreePath, wt);
  assert.deepEqual(h.rebound, []);
});

test("keep-move worktree → main → worktree rebinds worktreePath and branch", async () => {
  const { h, chat, root, wt } = setup();
  const p = (await preview(h, { main: true })).body as unknown as { from: { branch: string; isMain: boolean }; to: { branch: string; isMain: boolean; dirtyCount: number }; lastSessionInSource: boolean; expectedWorkspaceRevision: number; blocked?: unknown };
  assert.equal(p.blocked, undefined);
  assert.equal(p.from.branch, "feat/x");
  assert.equal(p.from.isMain, false);
  assert.equal(p.to.branch, "main");
  assert.equal(p.to.isMain, true);
  assert.equal(p.lastSessionInSource, true);
  const toMain = await h.post("/api/git/session-checkout", { sessionId: "s1", expectedWorkspaceRevision: p.expectedWorkspaceRevision, target: { main: true } });
  assert.equal(toMain.status, 200);
  assert.equal(chat.worktreePath, undefined);
  assert.equal(chat.branch, "main");
  assert.equal(head(root), "main", "keep checks nothing out");
  assert.ok(existsSync(wt), "the worktree is only removed when asked");
  assert.ok(h.changed.length > 0);
  const back = await h.post("/api/git/session-checkout", { sessionId: "s1", expectedWorkspaceRevision: 1, target: { worktreePath: wt } });
  assert.equal(back.status, 200);
  assert.equal(chat.worktreePath, wt);
  assert.equal(chat.branch, "feat/x");
  assert.equal((await attempt(h, "/api/git/session-checkout", { sessionId: "s1", expectedWorkspaceRevision: 2, target: { worktreePath: wt } })).code, "conflict", "same checkout");
});

test("removal is refused when the source is dirty or another chat uses it", async () => {
  const dirty = setup();
  writeFileSync(`${dirty.wt}/a.txt`, "changed\n");
  const pv = (await preview(dirty.h, { main: true })).body as { sourceDirtyCount: number };
  assert.equal(pv.sourceDirtyCount, 1);
  const refused = await attempt(dirty.h, "/api/git/session-checkout", { sessionId: "s1", expectedWorkspaceRevision: 0, target: { main: true }, removeSource: { deleteBranch: false } });
  assert.equal(refused.code, "worktree-dirty");
  assert.equal(refused.status, 409);
  assert.deepEqual(dirty.h.rebound, [], "refused before the chat moved");
  assert.ok(existsSync(dirty.wt));

  const shared = setup([{ worktreePath: "PLACEHOLDER", branch: "feat/x" }]);
  shared.others[0]!.worktreePath = shared.wt;
  const pv2 = (await preview(shared.h, { main: true })).body as { lastSessionInSource: boolean };
  assert.equal(pv2.lastSessionInSource, false);
  const conflict = await attempt(shared.h, "/api/git/session-checkout", { sessionId: "s1", expectedWorkspaceRevision: 0, target: { main: true }, removeSource: { deleteBranch: true } });
  assert.equal(conflict.code, "conflict");
  assert.deepEqual(shared.h.rebound, []);
  assert.ok(existsSync(shared.wt));
});

test("ordered move → remove → switch lets the target take the freed branch", async () => {
  const { h, chat, root, wt } = setup();
  const r = await h.post("/api/git/session-checkout", {
    sessionId: "s1", expectedWorkspaceRevision: 0, target: { main: true },
    branch: { kind: "switch", name: "feat/x" }, removeSource: { deleteBranch: false },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.branchError, undefined);
  assert.deepEqual(r.body.removed, { path: wt, branchDeleted: false });
  assert.equal(existsSync(wt), false);
  assert.equal(head(root), "feat/x");
  assert.equal(chat.worktreePath, undefined);
  assert.equal(chat.branch, "feat/x");
});

test("removal deletes an owned, merged branch only when asked; switching to it is refused up front", async () => {
  const a = setup();
  const r = await a.h.post("/api/git/session-checkout", { sessionId: "s1", expectedWorkspaceRevision: 0, target: { main: true }, removeSource: { deleteBranch: true } });
  assert.deepEqual(r.body.removed, { path: a.wt, branchDeleted: true });
  assert.equal(branchExists(a.root, "feat/x"), false);

  const b = setup();
  const clash = await attempt(b.h, "/api/git/session-checkout", { sessionId: "s1", expectedWorkspaceRevision: 0, target: { main: true }, branch: { kind: "switch", name: "feat/x" }, removeSource: { deleteBranch: true } });
  assert.equal(clash.code, "invalid-input");
  assert.deepEqual(b.h.rebound, []);

  const unmerged = setup();
  writeFileSync(`${unmerged.wt}/b.txt`, "b\n");
  gitIn(unmerged.wt, "add", ".");
  gitIn(unmerged.wt, "commit", "-qm", "ahead");
  const kept = await unmerged.h.post("/api/git/session-checkout", { sessionId: "s1", expectedWorkspaceRevision: 0, target: { main: true }, removeSource: { deleteBranch: true } });
  assert.deepEqual(kept.body.removed, { path: unmerged.wt, branchDeleted: false });
  assert.equal(branchExists(unmerged.root, "feat/x"), true, "unmerged branches survive");
});

test("a branch failure after the move is reported and the chat stays moved", async () => {
  const { h, chat, root } = setup();
  const missing = await h.post("/api/git/session-checkout", { sessionId: "s1", expectedWorkspaceRevision: 0, target: { main: true }, branch: { kind: "switch", name: "nope" } });
  assert.equal(missing.status, 200);
  assert.equal((missing.body.branchError as { code: string }).code, "branch-not-found");
  assert.equal(chat.worktreePath, undefined, "moved, never rolled back");
  assert.equal(head(root), "main");
  // feat/x is still checked out in the source worktree: Git refuses with branch-in-use.
  const second = setup();
  const refused = await second.h.post("/api/git/session-checkout", { sessionId: "s1", expectedWorkspaceRevision: 0, target: { main: true }, branch: { kind: "switch", name: "feat/x" } });
  assert.equal(refused.status, 200);
  assert.equal((refused.body.branchError as { code: string }).code, "branch-in-use");
  assert.equal(second.chat.worktreePath, undefined);
  assert.equal(head(second.root), "main");
});

test("create-and-switch runs in the target and a dirty target refuses the switch, not the move", async () => {
  const { h, chat, root } = setup();
  const ok = await h.post("/api/git/session-checkout", { sessionId: "s1", expectedWorkspaceRevision: 0, target: { main: true }, branch: { kind: "create", name: "fresh" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.branchError, undefined);
  assert.equal(head(root), "fresh");
  assert.equal(chat.branch, "fresh");
  const d = setup();
  gitIn(d.root, "checkout", "-q", "-b", "other");
  writeFileSync(`${d.root}/a.txt`, "other\n");
  gitIn(d.root, "commit", "-qam", "diverge");
  gitIn(d.root, "checkout", "-q", "main");
  writeFileSync(`${d.root}/a.txt`, "dirty\n");
  const refused = await d.h.post("/api/git/session-checkout", { sessionId: "s1", expectedWorkspaceRevision: 0, target: { main: true }, branch: { kind: "switch", name: "other" } });
  assert.equal(refused.status, 200);
  assert.equal(refused.body.branchError !== undefined, true);
  assert.equal(d.chat.worktreePath, undefined);
  assert.equal(head(d.root), "main");
});

test("isolated and delegated chats are blocked", async () => {
  const iso = setup([], { isolation: { kind: "git-worktree", worktreePath: "/x" } });
  assert.equal(((await preview(iso.h, { main: true })).body.blocked as { reason: string }).reason, "isolated");
  const child = setup([{ parentId: "s1" }], { });
  const grandchild = await attempt(child.h, "/api/git/session-checkout", { sessionId: "o0", expectedWorkspaceRevision: 0, target: { worktreePath: child.wt } });
  assert.equal(grandchild.code, "conflict", "a delegated child never moves on its own");
});

test("finished children stay put; running or isolated children block", async () => {
  const done = setup([{ parentId: "s1", status: "idle" }, { parentId: "s1", status: "archived" }]);
  assert.equal((await preview(done.h, { main: true })).body.blocked, undefined);
  const moved = await done.h.post("/api/git/session-checkout", { sessionId: "s1", expectedWorkspaceRevision: 0, target: { main: true } });
  assert.equal(moved.status, 200);
  assert.equal(done.others[0]!.worktreePath, undefined, "the child is left where it is");
  const running = setup([{ parentId: "s1", status: "working" }]);
  assert.equal(((await preview(running.h, { main: true })).body.blocked as { reason: string }).reason, "delegated");
  const iso = setup([{ parentId: "s1", status: "idle" }]);
  iso.others[0]!.isolation = { kind: "git-worktree", worktreePath: "/elsewhere", targetPath: iso.wt } as never;
  assert.equal(((await preview(iso.h, { main: true })).body.blocked as { reason: string }).reason, "delegated");
});

test("a view-only shared chat cannot be moved, and previews only with view access", async () => {
  const viewOnly = setup([], { sharing: { access: "view" } });
  const p = await preview(viewOnly.h, { main: true });
  assert.equal(p.status, 200);
  const refused = await attempt(viewOnly.h, "/api/git/session-checkout", { sessionId: "s1", expectedWorkspaceRevision: 0, target: { main: true } });
  assert.equal(refused.code, "forbidden");
  assert.deepEqual(viewOnly.h.rebound, []);
  const collaborator = setup([], { sharing: { access: "collaborate" } });
  assert.equal((await attempt(collaborator.h, "/api/git/session-checkout", { sessionId: "s1", expectedWorkspaceRevision: 0, target: { main: true } })).code, "forbidden");
  const manager = setup([], { sharing: { access: "manage" } });
  assert.equal((await manager.h.post("/api/git/session-checkout", { sessionId: "s1", expectedWorkspaceRevision: 0, target: { main: true } })).status, 200);
  const foreign = setup([], { spaceId: "sp-other" });
  assert.equal((await attempt(foreign.h, "/api/git/session-checkout/preview", { sessionId: "s1", target: { main: true } })).code, "not-found");
});
