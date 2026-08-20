// WP5: session rename/organize, idempotent archive/restore, attention badges
// derived from events, bulk ops with partial failures, project PATCH.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStore } from "@polyth/session";
import type { AgentRuntime, Project, ProjectService, RuntimeEvent } from "@polyth/contracts";
import { createSessionService, type Broadcaster } from "../src/sessions.ts";
import { createProjectService } from "../src/projects.ts";
import type { PermissionService } from "@polyth/permissions";

function fakeRuntime(): AgentRuntime {
  const listeners = new Set<(sessionId: string, ev: RuntimeEvent) => void>();
  return {
    capabilities: async () => ({ streaming: true, permissions: true, questions: true, compaction: false, subagents: false }),
    models: async () => [],
    agents: async () => [],
    ensureSession: async (c) => `be_${c.sessionId}`,
    sessions: async () => [],
    history: async () => [],
    startTurn: async (req) => { for (const l of listeners) l(req.sessionId, { type: "turn/started", turnId: "t1" }); },
    abort: async () => {},
    replyPermission: async () => {},
    replyQuestion: async () => {},
    onEvent(cb) { listeners.add(cb); return { dispose: () => listeners.delete(cb) }; },
    dispose: async () => {},
  };
}

function makeService() {
  const dir = mkdtempSync(join(tmpdir(), "polyth-orgsvc-"));
  const store = createStore(join(dir, "s.db"));
  const project: Project = { id: "p1", path: dir, name: "p", createdAt: 1 };
  const projects: ProjectService = {
    list: async () => [project],
    get: async (id) => (id === "p1" ? project : undefined),
    add: async () => project,
    create: async () => project,
    remove: async () => {},
  };
  const permissions = { evaluate: () => "ask", addRule: () => {}, rules: () => [] } as unknown as PermissionService;
  const broadcast: Broadcaster = { event: () => {}, projection: () => {} };
  const sessions = createSessionService({
    store, projects, permissions, broadcast, queue: store, org: store,
    runtimes: { forProject: async () => fakeRuntime() },
  });
  return { sessions, store, dir };
}

test("rename validates and appends session/metadata-changed before projection", async () => {
  const { sessions, store } = makeService();
  const { id } = await sessions.create({ projectId: "p1", title: "Old" });

  await sessions.rename!(id, "  New title  ");
  const snap = await sessions.snapshot(id);
  assert.equal(snap.title, "New title");
  const evs = await store.events(id);
  const meta = evs.find((e) => e.type === "session/metadata-changed");
  assert.ok(meta, "metadata event must be in the durable log");
  assert.equal((meta!.data as { title?: string }).title, "New title");

  await assert.rejects(() => sessions.rename!(id, "   "), /title required/);
  await assert.rejects(() => sessions.rename!("nope", "x"), /not found/);
});

test("organize assigns folders/labels; unknown or cross-project folder rejected", async () => {
  const { sessions, store } = makeService();
  const { id } = await sessions.create({ projectId: "p1", title: "S" });
  const folder = await store.folderCreate("p1", "Inbox");
  const foreign = await store.folderCreate("p2", "Elsewhere");

  await sessions.organize!(id, { folderId: folder.id, labelIds: ["l1", "l2"] });
  let snap = await sessions.snapshot(id);
  assert.equal(snap.folderId, folder.id);
  assert.deepEqual(snap.labelIds, ["l1", "l2"]);

  await assert.rejects(() => sessions.organize!(id, { folderId: foreign.id }), /not found in this project/);
  await assert.rejects(() => sessions.organize!(id, { folderId: "ghost" }), /not found in this project/);

  await sessions.organize!(id, { folderId: null });
  snap = await sessions.snapshot(id);
  assert.equal(snap.folderId, undefined);
  assert.deepEqual(snap.labelIds, ["l1", "l2"]); // untouched by folder-only patch
});

test("archive/restore are idempotent: repeats do not append duplicate events", async () => {
  const { sessions, store } = makeService();
  const { id } = await sessions.create({ projectId: "p1", title: "S" });

  await sessions.archive(id);
  await sessions.archive(id);
  await sessions.archive(id);
  assert.equal((await store.events(id)).filter((e) => e.type === "session/archived").length, 1);
  assert.equal((await sessions.snapshot(id)).status, "archived");

  await sessions.restore(id);
  await sessions.restore(id);
  assert.equal((await store.events(id)).filter((e) => e.type === "session/restored").length, 1);
  assert.equal((await sessions.snapshot(id)).status, "idle");
});

test("list derives attention badges from unresolved request events", async () => {
  const { sessions, store } = makeService();
  const { id } = await sessions.create({ projectId: "p1", title: "S" });
  await store.append(id, "permission/requested", { requestId: "pm1" });
  await store.append(id, "question/asked", { requestId: "q1" });
  await store.append(id, "question/asked", { requestId: "q2" });
  await store.append(id, "question/answered", { requestId: "q1" });

  const listed = await sessions.list("p1");
  const s = listed.find((x) => x.id === id)!;
  assert.deepEqual(s.attention, { questions: 1, permissions: 1, unread: 0 });
});

test("bulk semantics: mixed ids report partial failures without aborting", async () => {
  const { sessions } = makeService();
  const a = await sessions.create({ projectId: "p1", title: "A" });
  const b = await sessions.create({ projectId: "p1", title: "B" });

  // Simulates the /api/sessions/bulk loop: valid ids succeed, ghosts report codes.
  const ids = [a.id, "ghost", b.id];
  const result = { succeeded: [] as string[], failed: [] as Array<{ id: string; code: string }> };
  for (const sid of ids) {
    try {
      await sessions.archive(sid);
      result.succeeded.push(sid);
    } catch (err) {
      result.failed.push({ id: sid, code: (err as { code?: string }).code ?? "internal" });
    }
  }
  assert.deepEqual(result.succeeded, [a.id, b.id]);
  assert.deepEqual(result.failed, [{ id: "ghost", code: "not-found" }]);
});

test("project PATCH updates metadata and merges defaults; bad values rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-proj-"));
  const projects = createProjectService(dir);
  const p = await projects.add(dir, "orig");

  const upd = await projects.update!(p.id, { name: "renamed", color: "#a1b2c3", icon: "🚀" });
  assert.equal(upd.name, "renamed");
  assert.equal(upd.color, "#a1b2c3");

  await projects.update!(p.id, { defaults: { agent: "build" } });
  const merged = await projects.update!(p.id, { defaults: { groupingMode: "folders" } });
  assert.deepEqual(merged.defaults, { agent: "build", groupingMode: "folders" });

  await assert.rejects(() => projects.update!(p.id, { color: "red" }), /hex/);
  await assert.rejects(() => projects.update!(p.id, { name: "" }), /name required/);
  await assert.rejects(() => projects.update!("ghost", { name: "x" }), /not found/);

  // persisted across a reload
  const reloaded = createProjectService(dir);
  assert.equal((await reloaded.get(p.id))!.name, "renamed");
});
