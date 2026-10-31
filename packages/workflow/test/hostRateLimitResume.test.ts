// Provider rate-limit auto-resume: the workflow verification node follows the
// canonical session resume into its completed report. The canonical session
// service is the framework host seam; workflow owns this integration check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createStore } from "@polyth/session";
import type {
  AgentRuntime, Project, ProjectService, RuntimeEndpoint, RuntimeEvent,
  RuntimeObservation, RuntimeSessionBinding, RuntimeSnapshot,
} from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import { createSessionService, type Broadcaster } from "../../server/src/sessions.ts";
import { createWorkflowRunNode } from "../src/runner.ts";
const flush = () => new Promise((r) => setTimeout(r, 20));

function harness(existingDbPath?: string, options: { compaction?: boolean } = {}) {
  const calls: string[] = [];
  const listeners = new Set<(sessionId: string, ev: RuntimeEvent) => void>();
  const observers = new Set<(sessionId: string, observation: RuntimeObservation) => void>();
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
      streaming: true, permissions: true, questions: true, compaction: options.compaction === true, subagents: false,
    }),
    ...(options.compaction ? { compact: async () => { calls.push("compact"); } } : {}),
    models: async () => [],
    agents: async () => [],
    ensureSession: async (c) => `be_${c.sessionId}`,
    sessions: async () => [],
    history: async () => [],
    startTurn: async (req) => {
      startedTexts.push(req.text);
      calls.push(`start:${req.text}`);
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
    onEvent(cb) { listeners.add(cb); return { dispose: () => { listeners.delete(cb); } }; },
    onObservation(cb) { observers.add(cb); return { dispose: () => { observers.delete(cb); } }; },
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
    projection: (p) => { projections.push(p as unknown as Record<string, unknown>); },
  };
  const sessions = createSessionService({
    store, projects, permissions, broadcast, queue: store,
    runtimes: { forProject: async () => rt },
  });
  const observe = (sessionId: string, event: RuntimeEvent, ordinal: number) => {
    const observation: RuntimeObservation = {
      channel: "sse",
      entityKey: `${event.type}:${"turnId" in event ? event.turnId : "x"}`,
      identity: {
        authorityId: endpoint.authorityId,
        generation: endpoint.generation,
        location: endpoint.location,
        backendSessionId: `be_${sessionId}`,
        artifactKind: "turn",
        entityId: "turnId" in event && event.turnId ? String(event.turnId) : event.type,
        revision: `retry-${Date.now()}-${Math.random()}`,
      },
      reconciliationOrdinal: ordinal,
      events: [event],
    };
    for (const cb of observers) cb(sessionId, observation);
  };
  return { sessions, store, emit, observe, startedTexts, calls, dbPath, endpoint };
}

const LIMIT_STOP: Extract<RuntimeEvent, { type: "turn/stopped" }> = {
  type: "turn/stopped",
  turnId: "t1",
  reason: "error",
  error: "429 rate limit exceeded",
  retry: { scope: "rate", provider: "anthropic", retryAfterSec: 30 },
};

test("workflow verification follows the canonical session resume into its completed report", async () => {
  const h = harness();
  const parent = await h.sessions.create({ projectId: "p1", title: "Workflow parent" });
  let childId = "";
  let waiting = false;
  const controller = new AbortController();
  const result = createWorkflowRunNode(h.sessions)({
    parentSessionId: parent.id, projectId: "p1", workflowId: "workflow", runId: "run",
    node: { id: "verify", role: "Verifier", prompt: "Verify" }, prompt: "Verify the change",
    permissions: "manual", timeoutMs: 2_000, signal: controller.signal,
  }, async (patch) => {
    if (patch.sessionId) childId = patch.sessionId;
    if (patch.activity === "waiting for provider capacity") waiting = true;
  });
  // Attach a handler before a failed assertion can abort the runner.
  void result.catch(() => {});
  const until = async (ready: () => boolean) => {
    const deadline = Date.now() + 1_000;
    while (!ready()) {
      if (Date.now() > deadline) throw new Error("workflow resume condition did not settle");
      await flush();
    }
  };
  try {
    await until(() => h.startedTexts.length === 1);
    h.emit(childId, LIMIT_STOP);
    await until(() => waiting);
    assert.ok((await h.store.projection(childId))?.resume);
    await h.sessions.resumeNow!(childId);
    await flush();
    h.emit(childId, { type: "assistant/message", partId: "report", text: "Verification complete: all checks passed." });
    h.emit(childId, { type: "turn/stopped", reason: "completed" });
    const completed = await result;
    assert.equal(completed.sessionId, childId);
    assert.equal(completed.output, "Verification complete: all checks passed.");
    assert.deepEqual(h.startedTexts, ["Verify the change", "Verify the change"]);
  } finally {
    controller.abort();
    await result.catch(() => {});
    await h.store.close();
  }
});
