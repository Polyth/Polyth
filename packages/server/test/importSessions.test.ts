// F14 import half: browse unadopted backend sessions (dedupe + already-
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
import { controlRoutes } from "../src/routes/control.ts";
import type { PermissionService } from "@polyth/permissions";
import type { RouteRequest } from "../src/http.ts";

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
  return { sessions, store, fake };
}

const remote = (id: string, title: string, updatedAt: number): RuntimeSession =>
  ({ id, title, createdAt: updatedAt - 10, updatedAt });

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

test("control routes: browse + import with input validation", async () => {
  const { sessions } = makeService([remote("oc9", "via route", 50)]);
  const routes = controlRoutes(sessions);
  const call = async (method: string, path: string, body: Record<string, unknown> = {}) => {
    let status = 0;
    let payload: unknown;
    const rc = {
      req: {}, res: {},
      url: new URL(`http://x${path}`),
      path: new URL(`http://x${path}`).pathname, method,
      body: async () => body,
      json: (code: number, b: unknown) => { status = code; payload = b; },
    } as unknown as RouteRequest;
    const handled = await routes(rc);
    return { handled, status, payload };
  };

  const list = await call("GET", "/api/control/backend-sessions?projectId=p1");
  assert.equal(list.status, 200);
  assert.deepEqual((list.payload as { items: RuntimeSession[] }).items.map((s) => s.id), ["oc9"]);

  await assert.rejects(call("GET", "/api/control/backend-sessions"), /projectId required/);
  await assert.rejects(call("POST", "/api/control/backend-sessions/import", { projectId: "p1", ids: [] }), /ids required/);
  await assert.rejects(
    call("POST", "/api/control/backend-sessions/import", { projectId: "p1", ids: Array.from({ length: 201 }, (_, i) => `x${i}`) }),
    /at most 200/,
  );

  const imported = await call("POST", "/api/control/backend-sessions/import", { projectId: "p1", ids: ["oc9"] });
  assert.equal(imported.status, 200);
  assert.equal((imported.payload as Array<{ backendSessionId: string }>)[0]!.backendSessionId, "oc9");
});
