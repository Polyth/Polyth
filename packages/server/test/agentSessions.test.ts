import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStore } from "@polyth/session";
import type {
  AgentRuntime,
  Project,
  ProjectService,
  RuntimeEvent,
  SessionDebugDto,
  SessionEvent,
} from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import { createHttpServer } from "../src/http.ts";
import { createSessionService, type Broadcaster } from "../src/sessions.ts";
import {
  agentSessionRoutes,
  type AgentGoalState,
  type AgentGoalService,
} from "../src/routes/agentSessions.ts";
import { passthroughSpaces, testTenancy } from "./support/spaces.ts";

const tenancy = await testTenancy();

type Emit = (sessionId: string, event: RuntimeEvent) => void;

function fakeRuntime() {
  const listeners = new Set<Emit>();
  const ensured: string[] = [];
  const permissionReplies: Array<{ sessionId: string; requestId: string; reply: string }> = [];
  const questionReplies: Array<{ sessionId: string; requestId: string; answers: unknown }> = [];
  const aborted: string[] = [];
  const emit = (sessionId: string, event: RuntimeEvent) => {
    for (const listener of listeners) listener(sessionId, event);
  };
  const runtime: AgentRuntime = {
    capabilities: async () => ({
      streaming: true,
      permissions: true,
      questions: true,
      compaction: false,
      subagents: false,
      steering: false,
    }),
    models: async () => [],
    agents: async () => [],
    ensureSession: async (input) => {
      ensured.push(input.sessionId);
      return `backend_${input.sessionId}`;
    },
    sessions: async () => [],
    history: async () => [],
    startTurn: async (input) => {
      emit(input.sessionId, { type: "turn/started", turnId: `turn_${input.sessionId}` });
    },
    abort: async (sessionId) => {
      aborted.push(sessionId);
      emit(sessionId, { type: "turn/stopped", reason: "aborted" });
    },
    replyPermission: async (sessionId, requestId, reply) => {
      permissionReplies.push({ sessionId, requestId, reply });
    },
    replyQuestion: async (sessionId, requestId, answers) => {
      questionReplies.push({ sessionId, requestId, answers });
    },
    onEvent(callback) {
      listeners.add(callback);
      return { dispose: () => listeners.delete(callback) };
    },
    dispose: async () => {},
  };
  return { runtime, emit, ensured, permissionReplies, questionReplies, aborted };
}

function fakeGoals(): AgentGoalService {
  const states = new Map<string, AgentGoalState>();
  return {
    get: (sessionId) => states.get(sessionId) ?? null,
    rehydrate: async (sessionId) => states.get(sessionId) ?? null,
    attach: async (sessionId, input) => {
      const state: AgentGoalState = {
        objective: input.objective,
        status: "active",
        continuations: 0,
        maxContinuations: input.maxContinuations ?? 5,
        tokensUsed: 0,
        budgetTokens: input.budgetTokens ?? 10_000,
        stuckStreak: 0,
        updatedAt: Date.now(),
      };
      states.set(sessionId, state);
      return state;
    },
    pause: async (sessionId) => {
      const state = { ...states.get(sessionId)!, status: "paused" as const };
      states.set(sessionId, state);
      return state;
    },
    resume: async (sessionId) => {
      const state = { ...states.get(sessionId)!, status: "active" as const };
      states.set(sessionId, state);
      return state;
    },
    stop: async (sessionId) => {
      const state = { ...states.get(sessionId)!, status: "stopped" as const };
      states.set(sessionId, state);
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

async function makeApp() {
  const dir = mkdtempSync(join(tmpdir(), "polyth-agent-sessions-"));
  const projectRows: Project[] = [
    { id: "p1", path: join(dir, "one"), name: "One", createdAt: 1 },
    { id: "p2", path: join(dir, "two"), name: "Two", createdAt: 2 },
  ];
  const projects: ProjectService = {
    list: async () => projectRows,
    get: async (id) => projectRows.find((project) => project.id === id),
    add: async () => projectRows[0]!,
    create: async () => projectRows[0]!,
    remove: async () => {},
  };
  const store = createStore(join(dir, "sessions.db"));
  const runtime = fakeRuntime();
  const permissions = {
    evaluate: () => "ask",
    addRule: () => {},
    rules: () => [],
  } as unknown as PermissionService;
  const broadcast: Broadcaster = { event: () => {}, projection: () => {} };
  const pool = { forProject: async () => runtime.runtime };
  const sessions = createSessionService({
    store,
    projects,
    permissions,
    runtimes: pool,
    broadcast,
    queue: store,
    org: store,
  });
  const goals = fakeGoals();
  const server = createHttpServer({
    spaces: tenancy.gateway,
    runtimes: pool,
    capabilities: () => ["polyth.sessions", "polyth.goals"],
    webDist: dir,
    version: "test",
    routes: [agentSessionRoutes({
      spaces: passthroughSpaces({ sessions, projects }),
      store,
      capabilities: () => ["polyth.sessions", "polyth.goals"],
      goals: () => goals,
      version: "test",
    })],
  });
  server.listen(0);
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  return {
    base: `http://127.0.0.1:${port}`,
    sessions,
    runtime,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await store.close();
    },
  };
}

async function jsonFetch<T>(
  base: string,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${base}${path}`, init);
  return { status: response.status, body: await response.json() as T };
}

const jsonRequest = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: body === undefined ? undefined : { "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

test("agent inventory discovers projects and recent cross-project session activity", async () => {
  const app = await makeApp();
  try {
    const first = await app.sessions.create({ projectId: "p1", title: "First" });
    await app.sessions.send(first.id, { text: "hello" });
    await settle();
    app.runtime.emit(first.id, { type: "assistant/message", partId: "a1", text: "hi" });
    app.runtime.emit(first.id, { type: "turn/stopped", reason: "completed" });
    await settle();

    const archived = await app.sessions.create({ projectId: "p2", title: "Archived" });
    await app.sessions.archive(archived.id);

    const inventory = await jsonFetch<{
      projects: Array<{ project: Project; sessionCount: number }>;
      sessions: Array<{
        session: { id: string; status: string };
        project: Project;
        recentEvents: SessionEvent[];
        eventCount: number;
      }>;
      total: number;
    }>(app.base, "/api/agent/sessions?archived=include&recentEvents=2");
    assert.equal(inventory.status, 200);
    assert.equal(inventory.body.total, 2);
    assert.deepEqual(
      new Set(inventory.body.projects.map((row) => row.project.id)),
      new Set(["p1", "p2"]),
    );
    assert.ok(inventory.body.projects.every((row) => row.sessionCount === 1));
    const firstRow = inventory.body.sessions.find((row) => row.session.id === first.id)!;
    assert.equal(firstRow.project.name, "One");
    assert.ok(firstRow.eventCount >= 5);
    assert.ok(firstRow.recentEvents.length <= 2);

    const activeOnly = await jsonFetch<{ sessions: Array<{ session: { id: string } }>; total: number }>(
      app.base,
      "/api/agent/sessions?archived=exclude",
    );
    assert.equal(activeOnly.body.total, 1);
    assert.equal(activeOnly.body.sessions[0]!.session.id, first.id);

    const projects = await jsonFetch<{ projects: Array<{ project: Project }> }>(
      app.base,
      "/api/agent/projects",
    );
    assert.deepEqual(new Set(projects.body.projects.map((row) => row.project.id)), new Set(["p1", "p2"]));
  } finally {
    await app.close();
  }
});

test("agent detail exposes messages, paged events, state, errors, and runtime diagnostics", async () => {
  const app = await makeApp();
  try {
    const ref = await app.sessions.create({ projectId: "p1", title: "Debug me" });
    await app.sessions.send(ref.id, { text: "investigate" });
    await settle();
    app.runtime.emit(ref.id, { type: "tool/error", callId: "c1", tool: "shell", error: "boom" });
    app.runtime.emit(ref.id, { type: "assistant/message", partId: "a1", text: "found it" });
    app.runtime.emit(ref.id, { type: "turn/stopped", reason: "error", error: "runtime failed" });
    await settle();

    const detail = await jsonFetch<{
      messages: Array<{ role: string; parts: Array<{ type: string; text?: string }> }>;
      events: SessionEvent[];
      state: SessionDebugDto;
      eventWindow: { total: number; returned: number; truncatedBeforeSeq?: number };
      links: Record<string, string>;
    }>(app.base, `/api/agent/sessions/${ref.id}?eventLimit=2`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.events.length, 2);
    assert.ok(detail.body.eventWindow.total > detail.body.eventWindow.returned);
    assert.ok(detail.body.eventWindow.truncatedBeforeSeq);
    assert.equal(detail.body.messages[0]!.role, "user");
    assert.ok(detail.body.messages.some((message) =>
      message.parts.some((part) => part.type === "text" && part.text === "found it")));
    assert.equal(detail.body.state.status, "failed");
    assert.equal(detail.body.state.runtime.attached, true);
    assert.ok(detail.body.state.recentErrors.some((error) => error.message === "boom"));
    assert.match(detail.body.links.debug, new RegExp(`${ref.id}/debug$`));

    const page = await jsonFetch<{
      events: SessionEvent[];
      hasMore: boolean;
      nextAfterSeq: number;
    }>(app.base, `/api/agent/sessions/${ref.id}/events?limit=2`);
    assert.equal(page.body.events.length, 2);
    assert.equal(page.body.hasMore, true);
    const next = await jsonFetch<{ events: SessionEvent[] }>(
      app.base,
      `/api/agent/sessions/${ref.id}/events?afterSeq=${page.body.nextAfterSeq}&limit=100`,
    );
    assert.ok(next.body.events.every((event) => event.seq > page.body.nextAfterSeq));

    const debug = await jsonFetch<{
      debug: SessionDebugDto;
      server: { version: string; capabilities: string[] };
    }>(app.base, `/api/agent/sessions/${ref.id}/debug`);
    assert.equal(debug.body.debug.latestSeq, detail.body.state.latestSeq);
    assert.equal(debug.body.server.version, "test");
    assert.ok(debug.body.server.capabilities.includes("polyth.sessions"));
  } finally {
    await app.close();
  }
});

test("agent mutations cover create/send, queue, lifecycle, metadata, goals, and delete", async () => {
  const app = await makeApp();
  try {
    const created = await jsonFetch<{
      session: { id: string; title: string };
      sendResult: { turnId: string };
    }>(app.base, "/api/agent/sessions", jsonRequest("POST", {
      projectId: "p1",
      title: "Agent-created",
      message: "start work",
    }));
    assert.equal(created.status, 201);
    const id = created.body.session.id;
    assert.ok(created.body.sendResult.turnId);
    await settle();

    const queued = await jsonFetch<{ sendResult: { queued: boolean; queueId: string } }>(
      app.base,
      `/api/agent/sessions/${id}/messages`,
      jsonRequest("POST", { text: "follow up", delivery: "queue" }),
    );
    assert.equal(queued.body.sendResult.queued, true);
    const queue = await jsonFetch<{ items: Array<{ id: string; text: string }> }>(
      app.base,
      `/api/agent/sessions/${id}/queue`,
    );
    assert.deepEqual(queue.body.items.map((item) => item.text), ["follow up"]);

    const renamed = await jsonFetch<{ session: { title: string } }>(
      app.base,
      `/api/agent/sessions/${id}`,
      jsonRequest("PATCH", { title: "Renamed by agent", pinned: { position: 0 } }),
    );
    assert.equal(renamed.body.session.title, "Renamed by agent");

    const goal = await jsonFetch<AgentGoalState>(
      app.base,
      `/api/agent/sessions/${id}/goal`,
      jsonRequest("POST", { objective: "Ship the change", maxContinuations: 3 }),
    );
    assert.equal(goal.body.objective, "Ship the change");
    const paused = await jsonFetch<AgentGoalState>(
      app.base,
      `/api/agent/sessions/${id}/goal/pause`,
      jsonRequest("POST"),
    );
    assert.equal(paused.body.status, "paused");

    const archived = await jsonFetch<{ session: { status: string } }>(
      app.base,
      `/api/agent/sessions/${id}/archive`,
      jsonRequest("POST"),
    );
    assert.equal(archived.body.session.status, "archived");
    const restored = await jsonFetch<{ session: { status: string } }>(
      app.base,
      `/api/agent/sessions/${id}/unarchive`,
      jsonRequest("POST"),
    );
    assert.equal(restored.body.session.status, "idle");

    const cancelled = await jsonFetch<{ ok: boolean }>(
      app.base,
      `/api/agent/sessions/${id}/cancel`,
      jsonRequest("POST"),
    );
    assert.equal(cancelled.body.ok, true);

    const deleted = await jsonFetch<{ ok: boolean; sessionId: string }>(
      app.base,
      `/api/agent/sessions/${id}`,
      jsonRequest("DELETE"),
    );
    assert.deepEqual(deleted.body, { ok: true, sessionId: id });
    const missing = await jsonFetch<{ error: string }>(
      app.base,
      `/api/agent/sessions/${id}`,
    );
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, "not-found");
  } finally {
    await app.close();
  }
});

test("agent permission and question replies use the canonical session service", async () => {
  const app = await makeApp();
  try {
    const ref = await app.sessions.create({ projectId: "p1", title: "Needs input" });
    app.runtime.emit(ref.id, {
      type: "permission/requested",
      requestId: "perm-1",
      permission: "edit",
      patterns: ["git status"],
    });
    app.runtime.emit(ref.id, {
      type: "question/asked",
      requestId: "question-1",
      questions: [{ id: "choice", prompt: "Proceed?", type: "single" }],
    });
    await settle();

    const before = await jsonFetch<{ debug: SessionDebugDto }>(
      app.base,
      `/api/agent/sessions/${ref.id}/debug`,
    );
    assert.deepEqual(before.body.debug.pending.permissions, ["perm-1"]);
    assert.deepEqual(before.body.debug.pending.questions, ["question-1"]);

    const permission = await jsonFetch<{ ok: boolean }>(
      app.base,
      `/api/agent/sessions/${ref.id}/permissions/perm-1`,
      jsonRequest("POST", { reply: "once" }),
    );
    assert.equal(permission.body.ok, true);
    const question = await jsonFetch<{ ok: boolean }>(
      app.base,
      `/api/agent/sessions/${ref.id}/questions/question-1`,
      jsonRequest("POST", { answers: { choice: "yes" } }),
    );
    assert.equal(question.body.ok, true);
    assert.deepEqual(app.runtime.permissionReplies, [{
      sessionId: ref.id,
      requestId: "perm-1",
      reply: "once",
    }]);
    assert.equal(app.runtime.questionReplies.length, 1);

    const after = await jsonFetch<{ debug: SessionDebugDto }>(
      app.base,
      `/api/agent/sessions/${ref.id}/debug`,
    );
    assert.deepEqual(after.body.debug.pending.permissions, []);
    assert.deepEqual(after.body.debug.pending.questions, []);
  } finally {
    await app.close();
  }
});

test("cancel reattaches a persisted working session after a server restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-agent-cancel-restart-"));
  const store = createStore(join(dir, "sessions.db"));
  const project: Project = { id: "p1", path: dir, name: "One", createdAt: 1 };
  const projects: ProjectService = {
    list: async () => [project],
    get: async (id) => id === project.id ? project : undefined,
    add: async () => project,
    create: async () => project,
    remove: async () => {},
  };
  await store.upsertProjection({
    id: "persisted-working",
    projectId: project.id,
    title: "Persisted",
    status: "working",
    backendSessionId: "backend-existing",
    createdAt: 1,
    updatedAt: 2,
  });
  const runtime = fakeRuntime();
  const sessions = createSessionService({
    store,
    projects,
    permissions: {
      evaluate: () => "ask",
      addRule: () => {},
      rules: () => [],
    } as unknown as PermissionService,
    runtimes: { forProject: async () => runtime.runtime },
    broadcast: { event: () => {}, projection: () => {} },
  });

  await sessions.abort("persisted-working");
  await settle();

  assert.deepEqual(runtime.ensured, ["persisted-working"]);
  assert.deepEqual(runtime.aborted, ["persisted-working"]);
  assert.equal((await store.projection("persisted-working"))?.status, "idle");
  assert.equal(
    (await store.events("persisted-working")).filter((event) => event.type === "turn/stopped").length,
    1,
  );
  await store.close();
});
