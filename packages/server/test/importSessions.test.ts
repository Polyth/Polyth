// Import half: browse unadopted backend sessions (dedupe + already-
// imported filter + distinct-empty-state total), adopt selected ones through
// the existing backendSessionId seam with session/imported logged first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStore } from "@polyth/session";
import type { AgentRuntime, Project, ProjectService, RuntimeEvent, RuntimeSession } from "@polyth/contracts";
import { createSessionService, type Broadcaster } from "../src/sessions.ts";
import { agentSessionRoutes } from "../src/routes/agentSessions.ts";
import type { PermissionService } from "@polyth/permissions";
import type { RouteRequest } from "../src/http.ts";
import type { SpaceServices } from "../src/spaceScope.ts";
import { fakeSpaceContext } from "./support/spaces.ts";

function fakeRuntime(remote: RuntimeSession[]) {
  const listeners = new Set<(sessionId: string, ev: RuntimeEvent) => void>();
  const ensured: string[] = [];
  const rt: AgentRuntime = {
    capabilities: async () => ({ streaming: true, permissions: false, questions: false, compaction: false, subagents: false }),
    models: async () => [],
    agents: async () => [],
    ensureSession: async (c) => { ensured.push(c.backendSessionId ?? c.sessionId); return `be_${c.sessionId}`; },
    resetSession: async () => "fresh",
    sessions: async () => remote,
    history: async () => [],
    startTurn: async () => {},
    abort: async () => {},
    replyPermission: async () => {},
    replyQuestion: async () => {},
    onEvent(cb) { listeners.add(cb); return { dispose: () => listeners.delete(cb) }; },
    dispose: async () => {},
  };
  return { rt, ensured };
}

function makeService(remote: RuntimeSession[]) {
  const dir = mkdtempSync(join(tmpdir(), "polyth-import-"));
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
  const fake = fakeRuntime(remote);
  const sessions = createSessionService({
    store, projects, permissions, broadcast,
    runtimes: { forProject: async () => fake.rt },
  });
  return { sessions, projects, store, fake };
}

const remote = (id: string, title: string, updatedAt: number): RuntimeSession =>
  ({ id, title, createdAt: updatedAt - 10, updatedAt });

test("startup resumes a legacy partial import without a checkpoint or a history GET", async () => {
  const { sessions, store, fake } = makeService([remote("legacy", "Legacy", 100)]);
  fake.rt.history = async () => [{ role: "user", text: "one" }, { role: "assistant", text: "two" }, { role: "user", text: "three" }];
  try {
    await store.upsertProjection({ id: "legacy-canonical", projectId: "p1", title: "Legacy", backendSessionId: "legacy", status: "idle", createdAt: 1, updatedAt: 1 });
    await store.append("legacy-canonical", "session/imported", { backendSessionId: "legacy" });
    await store.append("legacy-canonical", "user/message", { text: "one" });
    await store.append("legacy-canonical", "assistant/message", { partId: "old-part", text: "two" });
    await assert.rejects(sessions.send("legacy-canonical", { text: "must not enter a partial import" }), { code: "conflict", mutationOutcome: "not-started" });
    await sessions.recoverPendingWork();
    const first = await store.events("legacy-canonical");
    assert.deepEqual(first.filter((event) => event.type === "user/message" || event.type === "assistant/message").map((event) => event.data.text), ["one", "two", "three"]);
    assert.equal((await store.projection("legacy-canonical"))?.historyImport?.state, "complete");
    await sessions.recoverPendingWork();
    assert.deepEqual(await store.events("legacy-canonical"), first);
  } finally { sessions.dispose(); await store.close(); }
});

test("backendSessions lists unadopted only: dedupe, recency sort, honest total", async () => {
  const { sessions } = makeService([
    remote("oc1", "older", 100),
    remote("oc2", "newest", 300),
    remote("oc2", "duplicate row", 300), // adapters may repeat entries
    remote("oc3", "middle", 200),
  ]);

  const r = await sessions.backendSessions!("p1");
  assert.equal(r.total, 3); // deduped
  assert.deepEqual(r.items.map((s) => s.id), ["oc2", "oc3", "oc1"]); // recent first

  await assert.rejects(sessions.backendSessions!("nope"), /project not found/);
});

test("importBackendSessions adopts ONLY the selected ids and logs session/imported first", async () => {
  const { sessions, store, fake } = makeService([
    remote("oc1", "keep out", 100),
    remote("oc2", "bring in", 300),
  ]);

  const imported = await sessions.importBackendSessions!("p1", ["oc2", "does-not-exist"]);
  assert.equal(imported.length, 1);
  assert.equal(imported[0]!.backendSessionId, "oc2");
  assert.equal(imported[0]!.title, "bring in");
  assert.deepEqual(fake.ensured, ["oc2"]);

  // the durable log explains the adoption before any UI sees the session
  const events = await store.events(imported[0]!.id);
  assert.equal(events[0]!.type, "session/imported");
  assert.equal(events[0]!.data.backendSessionId, "oc2");

  // adopted sessions disappear from the browse list; total stays honest
  const after = await sessions.backendSessions!("p1");
  assert.deepEqual(after.items.map((s) => s.id), ["oc1"]);
  assert.equal(after.total, 2);

  // re-importing an adopted id is a no-op, not a duplicate
  assert.equal((await sessions.importBackendSessions!("p1", ["oc2"])).length, 0);
  assert.equal((await sessions.list("p1")).length, 1);
});

test("sync remains the bulk adopt-everything path", async () => {
  const { sessions } = makeService([remote("a", "A", 1), remote("b", "B", 2)]);
  const all = await sessions.sync("p1");
  assert.equal(all.length, 2);
  assert.equal((await sessions.backendSessions!("p1")).items.length, 0);
});

test("partial concurrent imports resume their committed prefix without transcript duplication", async () => {
  const { sessions, store, fake } = makeService([remote("partial", "Partial", 100)]);
  fake.rt.history = async () => Array.from({ length: 250 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `message ${i}` }));
  const append = store.appendBatch!.bind(store);
  let batches = 0;
  store.appendBatch = async (...args) => {
    if (args[1][0]?.data.partId === "import_100" && ++batches === 1) throw Object.assign(new Error("fixture disk full"), { code: "SQLITE_FULL" });
    return append(...args);
  };
  try {
    const attempts = await Promise.allSettled([
      sessions.importBackendSessions!("p1", ["partial"]), sessions.importBackendSessions!("p1", ["partial"]),
    ]);
    assert.equal(attempts.filter((a) => a.status === "rejected").length, 1);
    const rows = await store.projections("p1");
    assert.equal(rows.length, 1);
    const id = rows[0]!.id;
    assert.equal(rows[0]!.historyImport?.state, "failed");
    assert.equal(rows[0]!.historyImport?.count, 100);
    await Promise.all([sessions.activate!(id), sessions.activate!(id)]);
    const history = await store.events(id);
    const messages = history.filter((event) => event.type === "user/message" || event.type === "assistant/message");
    assert.equal(messages.length, 250);
    assert.equal(new Set(messages.map((event) => event.data.partId)).size, 250);
    history.forEach((event, i) => assert.equal(event.seq, i + 1));
    assert.equal((await store.projection(id))?.historyImport?.state, "complete");
    assert.equal(history.filter((e) => e.type === "session/history-imported").length, 1);
  } finally { sessions.dispose(); await store.close(); }
});

test("agent routes: browse + import with input validation", async () => {
  const { sessions, projects, store } = makeService([remote("oc9", "via route", 50)]);
  const space = fakeSpaceContext();
  const routes = agentSessionRoutes({
    spaces: () => ({ sessions, projects } as unknown as SpaceServices),
    store,
  });
  const call = async (method: string, path: string, body: Record<string, unknown> = {}) => {
    let status = 0;
    let payload: unknown;
    const rc = {
      req: {}, res: {}, space,
      url: new URL(`http://x${path}`),
      path: new URL(`http://x${path}`).pathname, method,
      body: async () => body,
      json: (code: number, b: unknown) => { status = code; payload = b; },
    } as unknown as RouteRequest;
    const handled = await routes(rc);
    return { handled, status, payload };
  };

  const list = await call("GET", "/api/agent/backend-sessions?projectId=p1");
  assert.equal(list.status, 200);
  assert.deepEqual((list.payload as { items: RuntimeSession[] }).items.map((s) => s.id), ["oc9"]);

  await assert.rejects(call("GET", "/api/agent/backend-sessions"), /projectId is required/);
  await assert.rejects(call("POST", "/api/agent/backend-sessions/import", { projectId: "p1", ids: [] }), /ids must be a non-empty array/);
  await assert.rejects(
    call("POST", "/api/agent/backend-sessions/import", { projectId: "p1", ids: Array.from({ length: 201 }, (_, i) => `x${i}`) }),
    /at most 200/,
  );

  const imported = await call("POST", "/api/agent/backend-sessions/import", { projectId: "p1", ids: ["oc9"] });
  assert.equal(imported.status, 200);
  assert.equal((imported.payload as Array<{ backendSessionId: string }>)[0]!.backendSessionId, "oc9");
});
