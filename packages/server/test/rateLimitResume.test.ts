// Provider rate-limit auto-resume: a turn/stopped carrying a retry hint plans
// a resume on the projection + persists it on the terminal event; cancelResume
// clears it; resumeNow re-sends the last user message (optionally on a new
// model, which sticks as the session model).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createStore } from "@polyth/session";
import type {
  AgentRuntime, Project, ProjectService, RuntimeEndpoint, RuntimeEvent,
  RuntimeSessionBinding, RuntimeSnapshot,
} from "@polyth/contracts";
import { createSessionService, type Broadcaster } from "../src/sessions.ts";
import type { PermissionService } from "@polyth/permissions";

const flush = () => new Promise((r) => setTimeout(r, 20));

function harness(existingDbPath?: string) {
  const listeners = new Set<(sessionId: string, ev: RuntimeEvent) => void>();
  const startedTexts: string[] = [];
  const emit = (sessionId: string, ev: RuntimeEvent) => {
    for (const l of listeners) l(sessionId, ev);
  };
  const endpoint: RuntimeEndpoint = {
    authorityId: "fake-runtime",
    continuity: "verified",
    generation: 1,
    url: "http://fake.invalid",
    location: { directory: "/fake" },
    control: { kind: "borrowed", source: "external" },
    config: { kind: "read-only" },
    authentication: { kind: "none" },
  };
  const rt: AgentRuntime & {
    endpoint(): Promise<RuntimeEndpoint>;
    reconcile(b: RuntimeSessionBinding & { reconciliationOrdinal?: number }): Promise<RuntimeSnapshot>;
  } = {
    capabilities: async () => ({
      streaming: true, permissions: true, questions: true, compaction: false, subagents: false,
    }),
    models: async () => [],
    agents: async () => [],
    ensureSession: async (c) => `be_${c.sessionId}`,
    sessions: async () => [],
    history: async () => [],
    startTurn: async (req) => {
      startedTexts.push(req.text);
      emit(req.sessionId, { type: "turn/started", turnId: `t${startedTexts.length}` });
    },
    abort: async (sessionId) => emit(sessionId, { type: "turn/stopped", reason: "aborted" }),
    replyPermission: async () => {},
    replyQuestion: async () => {},
    endpoint: async () => endpoint,
    reconcile: async (binding) => ({
      authorityId: binding.authorityId,
      generation: binding.generation,
      location: binding.location,
      backendSessionId: binding.backendSessionId!,
      reconciliationOrdinal: binding.reconciliationOrdinal ?? 1,
      state: { value: "idle", watermark: "1", comparison: { domain: "test", order: 1 } },
      completeness: { events: "partial", permissions: "partial", questions: "partial" },
      permissions: [],
      questions: [],
      events: [],
    }),
    onEvent(cb) { listeners.add(cb); return { dispose: () => listeners.delete(cb) }; },
    dispose: async () => {},
  };

  const dir = existingDbPath ? dirname(existingDbPath) : mkdtempSync(join(tmpdir(), "polyth-ratelimit-"));
  const dbPath = existingDbPath ?? join(dir, "s.db");
  const store = createStore(dbPath);
  const project: Project = { id: "p1", path: dir, name: "p", createdAt: 1 };
  const projects: ProjectService = {
    list: async () => [project],
    get: async (id) => (id === "p1" ? project : undefined),
    add: async () => project,
    create: async () => project,
    remove: async () => {},
  };
  const permissions = {
    evaluate: () => "ask", addRule: () => {}, rules: () => [],
  } as unknown as PermissionService;
  const projections: Record<string, unknown>[] = [];
  const broadcast: Broadcaster = {
    event: () => {},
    projection: (p) => { projections.push(p as Record<string, unknown>); },
  };
  const sessions = createSessionService({
    store, projects, permissions, broadcast, queue: store,
    runtimes: { forProject: async () => rt },
  });
  return { sessions, store, emit, startedTexts, dbPath };
}

const LIMIT_STOP: Extract<RuntimeEvent, { type: "turn/stopped" }> = {
  type: "turn/stopped",
  turnId: "t1",
  reason: "error",
  error: "429 rate limit exceeded",
  retry: { scope: "rate", provider: "anthropic", retryAfterSec: 30 },
};

test("a rate-limit stop plans a resume on the projection and the terminal event", async () => {
  const h = harness();
  const { id } = await h.sessions.create({ projectId: "p1", title: "T" });
  await h.sessions.send(id, { text: "keep going" });
  await flush();

  h.emit(id, LIMIT_STOP);
  await flush();

  const proj = await h.store.projection(id);
  assert.equal(proj?.status, "failed");
  assert.ok(proj?.resume, "projection.resume should be set");
  assert.equal(proj!.resume!.scope, "rate");
  assert.equal(proj!.resume!.attempt, 1);
  assert.ok(proj!.resume!.resumeAt > Date.now());

  const stop = (await h.store.events(id)).findLast((e) => e.type === "turn/stopped");
  const retry = (stop!.data as { retry?: { resumeAt?: number; attempt?: number } }).retry;
  assert.equal(retry?.attempt, 1);
  assert.ok((retry?.resumeAt ?? 0) > Date.now());
  await h.store.close();
});

test("cancelResume clears the plan and records turn/resume-cancelled", async () => {
  const h = harness();
  const { id } = await h.sessions.create({ projectId: "p1", title: "T" });
  await h.sessions.send(id, { text: "keep going" });
  await flush();
  h.emit(id, LIMIT_STOP);
  await flush();

  await h.sessions.cancelResume!(id);

  const proj = await h.store.projection(id);
  assert.equal(proj?.resume, undefined);
  assert.equal(proj?.status, "failed");
  const cancelled = (await h.store.events(id)).find((e) => e.type === "turn/resume-cancelled");
  assert.equal((cancelled!.data as { reason?: string }).reason, "user");
  await h.store.close();
});

test("resumeNow re-sends the last user message and switches the session model", async () => {
  const h = harness();
  const { id } = await h.sessions.create({ projectId: "p1", title: "T" });
  await h.sessions.send(id, { text: "keep going" });
  await flush();
  h.emit(id, LIMIT_STOP);
  await flush();

  await h.sessions.resumeNow!(id, { providerID: "openai", modelID: "gpt-5" });
  await flush();

  assert.deepEqual(h.startedTexts, ["keep going", "keep going"]);
  const proj = await h.store.projection(id);
  assert.equal(proj?.resume, undefined);
  assert.deepEqual(proj?.model, { providerID: "openai", modelID: "gpt-5" });
  const um = (await h.store.events(id)).filter((e) => e.type === "user/message");
  assert.equal(um.length, 2);
  assert.equal((um[1]!.data as { autoResume?: boolean }).autoResume, true);
  await h.store.close();
});

test("resumeNow with no pending resume rejects", async () => {
  const h = harness();
  const { id } = await h.sessions.create({ projectId: "p1", title: "T" });
  await h.sessions.send(id, { text: "hi" });
  await flush();
  await assert.rejects(() => h.sessions.resumeNow!(id), /no pending resume|no-resume/);
  await h.store.close();
});

test("a non-limit error stop leaves no resume plan", async () => {
  const h = harness();
  const { id } = await h.sessions.create({ projectId: "p1", title: "T" });
  await h.sessions.send(id, { text: "hi" });
  await flush();
  h.emit(id, { type: "turn/stopped", turnId: "t1", reason: "error", error: "boom" });
  await flush();
  const proj = await h.store.projection(id);
  assert.equal(proj?.status, "failed");
  assert.equal(proj?.resume, undefined);
  await h.store.close();
});

test("server restart repairs a pending resume that lacks its terminal event", async () => {
  const first = harness();
  const { id } = await first.sessions.create({ projectId: "p1", title: "T" });
  await first.sessions.send(id, { text: "keep going" });
  await flush();

  const events = await first.store.events(id);
  const user = events.findLast((event) => event.type === "user/message");
  assert.ok(user);
  const projection = await first.store.projection(id);
  assert.ok(projection);
  const resumeAt = Date.now() + 50;
  await first.store.upsertProjection({
    ...projection,
    status: "idle",
    resume: {
      scope: "rate",
      provider: "anthropic",
      retryAfterSec: 60,
      resumeAt,
      attempt: 1,
      userMessageSeq: user.seq,
    },
  });
  await first.store.close();

  const second = harness(first.dbPath);
  await new Promise((resolve) => setTimeout(resolve, 200));

  const repaired = await second.store.events(id);
  const stop = repaired.findLast((event) => event.type === "turn/stopped");
  assert.ok(stop, "restart should append the missing terminal event");
  const retry = (stop.data as { retry?: { resumeAt?: number; attempt?: number } }).retry;
  assert.equal(retry?.attempt, 1);
  assert.equal(retry?.resumeAt, resumeAt);
  assert.deepEqual(second.startedTexts, ["keep going"]);
  const messages = repaired.filter((event) => event.type === "user/message");
  assert.equal((messages.at(-1)?.data as { autoResume?: boolean }).autoResume, true);
  assert.equal((await second.store.projection(id))?.resume, undefined);
  await second.store.close();
});
