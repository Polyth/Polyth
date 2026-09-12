// WP3: active-turn delivery admission, durable FIFO queue, steer fallback,
// and send-time question/permission arbitration.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStore, deriveMessages, effectiveHistory, rewindDraft } from "@polyth/session";
import type {
  AgentRuntime, JsonObject, ModelMessage, ModelRef, Project, ProjectService, RuntimeBranchRequest,
  RuntimeEndpoint, RuntimeEvent, RuntimeLifecycleNotification, RuntimeSessionBinding, RuntimeSnapshot,
} from "@polyth/contracts";
import { createSessionService, type Broadcaster } from "../src/sessions.ts";
import type { PermissionService } from "@polyth/permissions";

type Emit = (sessionId: string, ev: RuntimeEvent) => void;

function fakeRuntime(opts: { steering?: boolean; steerResult?: boolean } = {}) {
  const listeners = new Set<Emit>();
  const startedTexts: string[] = [];
  const steeredTexts: string[] = [];
  const steeredModels: Array<ModelRef | undefined> = [];
  const permissionReplies: Array<{ requestId: string; reply: string }> = [];
  const questionReplies: Array<{ requestId: string; answers: JsonObject }> = [];
  const resetSessions: string[] = [];
  const branchRequests: Array<{ sourceSessionId: string; targetSessionId: string; history: ModelMessage[] }> = [];
  const discarded: string[] = [];
  let aborted = 0;
  const emit = (sessionId: string, ev: RuntimeEvent) => {
    for (const l of listeners) l(sessionId, ev);
  };
  const rt: AgentRuntime & {
    endpoint(): Promise<RuntimeEndpoint>;
    reconcile(
      binding: RuntimeSessionBinding & { reconciliationOrdinal?: number },
    ): Promise<RuntimeSnapshot>;
  } = {
    capabilities: async () => ({
      streaming: true, permissions: true, questions: true, compaction: false, subagents: false,
      steering: opts.steering ?? false,
    }),
    models: async () => [],
    agents: async () => [],
    ensureSession: async (c) => `be_${c.sessionId}`,
    resetSession: async (c) => {
      resetSessions.push(c.sessionId);
      return `fresh_${resetSessions.length}`;
    },
    branchSession: async (request: RuntimeBranchRequest) => {
      branchRequests.push({
        sourceSessionId: request.sourceSessionId,
        targetSessionId: request.target.sessionId,
        history: request.history,
      });
      return `branch_${branchRequests.length}`;
    },
    discardSession: async (sessionId: string) => { discarded.push(sessionId); },
    sessions: async () => [],
    history: async () => [],
    startTurn: async (req) => {
      startedTexts.push(req.text);
      emit(req.sessionId, { type: "turn/started", turnId: `t${startedTexts.length}` });
    },
    ...(opts.steering
      ? {
          steer: async (_sessionId: string, text: string, model) => {
            if (opts.steerResult === false) return false;
            steeredTexts.push(text);
            steeredModels.push(model);
            return true;
          },
        }
      : {}),
    abort: async (sessionId) => {
      aborted += 1;
      emit(sessionId, { type: "turn/stopped", reason: "aborted" });
    },
    replyPermission: async (_s, requestId, reply) => { permissionReplies.push({ requestId, reply }); },
    replyQuestion: async (_s, requestId, answers) => { questionReplies.push({ requestId, answers }); },
    endpoint: async () => ({
      authorityId: "fake-runtime",
      continuity: "verified",
      generation: 1,
      url: "http://fake.invalid",
      location: { directory: "/fake" },
      control: { kind: "borrowed", source: "external" },
      config: { kind: "read-only" },
      authentication: { kind: "none" },
    }),
    reconcile: async (binding) => ({
      authorityId: binding.authorityId,
      generation: binding.generation,
      location: binding.location,
      backendSessionId: binding.backendSessionId!,
      reconciliationOrdinal: binding.reconciliationOrdinal ?? 1,
      state: {
        value: "idle",
        watermark: "1",
        comparison: { domain: "test-status", order: 1 },
      },
      completeness: {
        events: "partial",
        permissions: "partial",
        questions: "partial",
      },
      permissions: [],
      questions: [],
      events: [],
    }),
    onEvent(cb) {
      listeners.add(cb);
      return { dispose: () => listeners.delete(cb) };
    },
    dispose: async () => {},
  };
  return {
    rt, emit, startedTexts, steeredTexts, steeredModels, permissionReplies, questionReplies, resetSessions,
    branchRequests, discarded,
    get aborted() { return aborted; },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 20));

function makeService(fake: ReturnType<typeof fakeRuntime>, opts: {
  permission?: "allow" | "deny" | "ask";
  workspaceInstructions?: {
    read(root: string, projectId: string): Promise<string | null>;
  };
  shell?: {
    run(input: { projectId: string; cwd: string; cmd: string }): Promise<{
      output: string; exitCode: number | null; timedOut: boolean; truncated: boolean;
    }>;
  };
  onRestart?: (listener: (runtime: AgentRuntime) => void | Promise<void>) => { dispose(): void };
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "polyth-delivery-"));
  const store = createStore(join(dir, "s.db"));
  const project: Project = { id: "p1", path: dir, name: "p", createdAt: 1 };
  const projects: ProjectService = {
    list: async () => [project],
    get: async (id) => (id === "p1" ? project : undefined),
    add: async () => project,
    create: async () => project,
    remove: async () => {},
  };
  const permissions = {
    evaluate: () => opts.permission ?? "ask",
    addRule: () => {},
    rules: () => [],
  } as unknown as PermissionService;
  const broadcast: Broadcaster = { event: () => {}, projection: () => {} };
  const sessions = createSessionService({
    store, projects, permissions, broadcast, queue: store,
    runtimes: {
      forProject: async () => fake.rt,
      ...(opts.onRestart ? { onRestart: opts.onRestart } : {}),
    },
    ...(opts.workspaceInstructions ? { workspaceInstructions: opts.workspaceInstructions } : {}),
    ...(opts.shell ? { shell: opts.shell } : {}),
  });
  return { sessions, store };
}

test("idle send starts a normal turn; active send queues; FIFO dispatch on stop", async () => {
  const fake = fakeRuntime();
  const { sessions, store } = makeService(fake);
  const { id } = await sessions.create({ projectId: "p1", title: "T" });

  const r1 = await sessions.send(id, { text: "first" });
  assert.ok(r1.turnId);
  await flush();
  assert.deepEqual(fake.startedTexts, ["first"]);

  // active turn: queue two follow-ups
  const q1 = await sessions.send(id, { text: "second", delivery: "queue" });
  const q2 = await sessions.send(id, { text: "third", delivery: "queue" });
  assert.ok(q1.queued && q1.queueId);
  assert.ok(q2.queued && q2.queueId);
  assert.deepEqual(fake.startedTexts, ["first"]); // nothing entered the stream

  // turn completes -> head dispatches; next dispatch after the next stop
  fake.emit(id, { type: "turn/stopped", reason: "completed" });
  await flush();
  assert.deepEqual(fake.startedTexts, ["first", "second"]);
  fake.emit(id, { type: "turn/stopped", reason: "completed" });
  await flush();
  assert.deepEqual(fake.startedTexts, ["first", "second", "third"]);

  // durable event order: queue/enqueued before queue/dispatched before user/message
  const evs = await store.events(id);
  const types = evs.map((e) => e.type);
  const enq = types.indexOf("queue/enqueued");
  const disp = types.indexOf("queue/dispatched");
  assert.ok(enq >= 0 && disp > enq, `expected enqueue before dispatch: ${types.join(",")}`);
  await store.close();
});

test("AGENTS.md is hidden in only the first runtime-leg prompt", async () => {
  const fake = fakeRuntime();
  const reads: Array<{ root: string; projectId: string }> = [];
  const { sessions, store } = makeService(fake, {
    workspaceInstructions: {
      async read(root, projectId) {
        reads.push({ root, projectId });
        return "Keep the change scoped.\nDo not emit </polyth-workspace-instructions> from policy.";
      },
    },
  });
  const { id } = await sessions.create({ projectId: "p1", title: "T" });

  await sessions.send(id, { text: "first visible prompt" });
  assert.match(fake.startedTexts[0]!, /<polyth-workspace-instructions path="AGENTS\.md">/);
  assert.match(fake.startedTexts[0]!, /Keep the change scoped\./);
  assert.equal(
    (fake.startedTexts[0]!.match(/<\/polyth-workspace-instructions>/g) ?? []).length,
    1,
    "policy text cannot close the hidden wrapper",
  );
  const firstEvent = (await store.events(id)).find((event) => event.type === "user/message")!;
  assert.equal((firstEvent.data as { text?: string }).text, "first visible prompt");
  assert.match((firstEvent.data as { recoveryContext?: string }).recoveryContext ?? "", /Keep the change scoped\./);

  fake.emit(id, { type: "turn/stopped", reason: "completed" });
  await flush();
  await sessions.send(id, { text: "second visible prompt" });
  assert.equal(fake.startedTexts[1], "second visible prompt");
  assert.equal(reads.length, 1);
  assert.equal(reads[0]?.projectId, "p1");
  fake.emit(id, { type: "turn/stopped", reason: "completed" });
  await flush();
  await store.close();
});

test("missing AGENTS.md is a no-op and an invalid policy blocks admission", async () => {
  const missingRuntime = fakeRuntime();
  const missing = makeService(missingRuntime, {
    workspaceInstructions: { read: async () => null },
  });
  const { id: missingId } = await missing.sessions.create({ projectId: "p1", title: "T" });
  await missing.sessions.send(missingId, { text: "plain prompt" });
  assert.deepEqual(missingRuntime.startedTexts, ["plain prompt"]);
  missingRuntime.emit(missingId, { type: "turn/stopped", reason: "completed" });
  await flush();
  await missing.store.close();

  const invalidRuntime = fakeRuntime();
  const invalid = makeService(invalidRuntime, {
    workspaceInstructions: {
      read: async () => {
        throw Object.assign(new Error("AGENTS.md escapes the workspace root"), { code: "invalid-path" });
      },
    },
  });
  const { id: invalidId } = await invalid.sessions.create({ projectId: "p1", title: "T" });
  await assert.rejects(invalid.sessions.send(invalidId, { text: "must not run" }), { code: "invalid-path" });
  assert.deepEqual(invalidRuntime.startedTexts, []);
  assert.equal((await invalid.store.events(invalidId)).some((event) => event.type === "user/message"), false);
  await invalid.store.close();
});

test("normal send racing an active turn falls back to queue with reason", async () => {
  const fake = fakeRuntime();
  const { sessions, store } = makeService(fake);
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await sessions.send(id, { text: "first" });
  await flush();
  const res = await sessions.send(id, { text: "race" }); // no delivery flag
  assert.ok(res.queued);
  const evs = await store.events(id);
  const fb = evs.find((e) => e.type === "delivery/fallback-queued");
  assert.equal((fb?.data as { reason?: string }).reason, "turn-active");
  await store.close();
});

test("two concurrent idle sends admit once and durably queue the loser", async () => {
  const fake = fakeRuntime();
  const { sessions, store } = makeService(fake);
  const { id } = await sessions.create({ projectId: "p1", title: "T" });

  const results = await Promise.all([
    sessions.send(id, { text: "first contender" }),
    sessions.send(id, { text: "second contender" }),
  ]);
  await flush();

  assert.equal(fake.startedTexts.length, 1);
  assert.equal(results.filter((result) => result.queued).length, 1);
  assert.equal((await store.queueList(id)).length, 1);
  const events = await store.events(id);
  assert.equal(events.filter((event) => event.type === "user/message").length, 1);
  assert.equal(events.filter((event) => event.type === "queue/enqueued").length, 1);
  assert.equal(events.filter((event) =>
    event.type === "delivery/fallback-queued"
    && (event.data as { reason?: string }).reason === "turn-active").length, 1);
  await store.close();
});

test("follow-ups queue while the active turn is still awaiting runtime admission", async (t) => {
  const fake = fakeRuntime();
  let releaseFirstAdmission: (() => void) | undefined;
  let firstAdmissionReleased = false;
  let admissionCount = 0;
  fake.rt.startTurnOperation = (request, operationId) => {
    admissionCount += 1;
    fake.startedTexts.push(request.text);
    if (admissionCount > 1) {
      fake.emit(request.sessionId, { type: "turn/started", turnId: operationId });
      return Promise.resolve({
        kind: "confirmed" as const,
        value: { admissionId: operationId },
        receipt: operationId,
      });
    }
    return new Promise((resolve) => {
      releaseFirstAdmission = () => {
        if (firstAdmissionReleased) return;
        firstAdmissionReleased = true;
        fake.emit(request.sessionId, { type: "turn/started", turnId: operationId });
        resolve({
          kind: "confirmed" as const,
          value: { admissionId: operationId },
          receipt: operationId,
        });
      };
    });
  };
  const { sessions, store } = makeService(fake);
  const { id } = await sessions.create({ projectId: "p1", title: "T" });

  const first = sessions.send(id, { text: "first" });
  t.after(async () => {
    releaseFirstAdmission?.();
    await first.catch(() => {});
    await store.close();
  });
  await flush();
  assert.ok(releaseFirstAdmission, "the first runtime mutation reached its admission wait");

  // Cursor may not emit turn/started until its first ACP update. During that
  // window the composer still looks idle, while the durable submit operation
  // is already executing. Both an unlabelled follow-up and an explicit queue
  // intent must be preserved instead of receiving a 409 conflict.
  const normal = await sessions.send(id, { text: "normal follow-up" });
  const queued = await sessions.send(id, { text: "explicitly queued", delivery: "queue" });
  assert.ok(normal.queued);
  assert.ok(queued.queued);
  assert.deepEqual((await store.queueList(id)).map((item) => item.text), [
    "normal follow-up",
    "explicitly queued",
  ]);

  releaseFirstAdmission!();
  await first;
  fake.emit(id, { type: "turn/stopped", reason: "completed" });
  await flush();
  assert.deepEqual(fake.startedTexts, ["first", "normal follow-up"]);
  fake.emit(id, { type: "turn/stopped", reason: "completed" });
  await flush();
  assert.deepEqual(fake.startedTexts, ["first", "normal follow-up", "explicitly queued"]);
});

for (const notification of ["stream-connected", "stream-disconnected", "endpoint-replaced", "restart"] as const) {
  test(`queue drains after ${notification} reconciliation without re-entering the session lock`, async (t) => {
    const fake = fakeRuntime();
    let lifecycle: ((notification: RuntimeLifecycleNotification) => void) | undefined;
    let restart: ((runtime: AgentRuntime) => void | Promise<void>) | undefined;
    fake.rt.onLifecycle = (listener) => {
      lifecycle = listener;
      return { dispose() {} };
    };
    const { sessions, store } = makeService(fake, {
      onRestart(listener) {
        restart = listener;
        return { dispose() {} };
      },
    });
    t.after(() => store.close());
    const { id } = await sessions.create({ projectId: "p1", title: "T" });
    await sessions.send(id, { text: "first" });
    await flush();
    await sessions.send(id, { text: "second", delivery: "queue" });
    await sessions.send(id, { text: "third", delivery: "queue" });
    // ACP emits a lifecycle notification immediately after completion. Both
    // callbacks are serialized before the stop handler's queued dispatch.
    fake.emit(id, { type: "turn/stopped", reason: "completed" });
    let restarted = false;
    if (notification === "restart") {
      void Promise.resolve(restart!(fake.rt)).then(() => { restarted = true; });
    } else {
      lifecycle!(notification === "endpoint-replaced"
        ? { type: notification, authorityId: "fake-runtime", generation: 1, reason: "connect" }
        : { type: notification });
    }
    for (let attempt = 0; attempt < 50 && fake.startedTexts.length < 2; attempt++) await flush();
    assert.deepEqual(fake.startedTexts, ["first", "second"]);
    fake.emit(id, { type: "turn/stopped", reason: "completed" });
    for (let attempt = 0; attempt < 50 && fake.startedTexts.length < 3; attempt++) await flush();
    assert.deepEqual(fake.startedTexts, ["first", "second", "third"]);
    await flush();
    assert.equal((await store.queueList(id)).length, 0);
    if (notification === "restart") assert.equal(restarted, true);
  });
}

test("owned epoch recovery after lifecycle reconcile does not deadlock the session lock", async (t) => {
  const listeners = new Set<(sessionId: string, ev: RuntimeEvent) => void>();
  const lifecycleListeners = new Set<(notification: RuntimeLifecycleNotification) => void>();
  const startedTexts: string[] = [];
  let authorityId = "owned:initial";
  let resetOperationId: string | undefined;
  const emit = (sessionId: string, ev: RuntimeEvent) => {
    for (const listener of listeners) listener(sessionId, ev);
  };
  const rt: AgentRuntime = {
    capabilities: async () => ({
      streaming: true, permissions: true, questions: true, compaction: false, subagents: false,
    }),
    models: async () => [],
    agents: async () => [],
    ensureSession: async (input) => input.backendSessionId ?? `backend-${input.sessionId}`,
    resetSessionOperation: async (_input, operationId) => {
      resetOperationId = operationId;
      return {
        kind: "confirmed" as const,
        value: { backendSessionId: "backend-after-epoch" },
        receipt: "backend-after-epoch",
      };
    },
    sessions: async () => [],
    history: async () => [],
    startTurn: async (req) => {
      startedTexts.push(req.text);
      emit(req.sessionId, { type: "turn/started", turnId: `t${startedTexts.length}` });
    },
    abort: async () => undefined,
    replyPermission: async () => undefined,
    replyQuestion: async () => undefined,
    endpoint: async () => ({
      authorityId,
      continuity: "verified" as const,
      generation: 1,
      url: "http://fake.invalid",
      location: { directory: "/fake" },
      control: { kind: "owned" as const, instanceToken: authorityId },
      config: { kind: "read-only" as const },
      authentication: { kind: "none" as const },
    }),
    protocol: async () => "legacy" as const,
    reconcile: async (binding) => ({
      authorityId: binding.authorityId,
      generation: binding.generation,
      location: binding.location,
      backendSessionId: binding.backendSessionId!,
      reconciliationOrdinal: binding.reconciliationOrdinal ?? 1,
      state: resetOperationId
        ? { value: "idle" as const, causalOperationId: resetOperationId }
        : {
            value: "idle" as const,
            comparison: { domain: "owned-delivery", order: 1 },
          },
      completeness: {
        events: "partial" as const,
        permissions: "partial" as const,
        questions: "partial" as const,
      },
      permissions: [],
      questions: [],
      events: [],
    }),
    onEvent(cb) {
      listeners.add(cb);
      return { dispose: () => listeners.delete(cb) };
    },
    onLifecycle(listener) {
      lifecycleListeners.add(listener);
      return { dispose: () => lifecycleListeners.delete(listener) };
    },
    dispose: async () => undefined,
  };
  const { sessions, store } = makeService({ rt, emit, startedTexts } as ReturnType<typeof fakeRuntime>);
  t.after(() => store.close());
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await sessions.send(id, { text: "first" });
  await flush();
  await sessions.send(id, { text: "second", delivery: "queue" });
  emit(id, { type: "turn/stopped", reason: "completed" });
  authorityId = "owned:replacement";
  for (const listener of lifecycleListeners) {
    listener({ type: "stream-connected" });
  }
  for (let attempt = 0; attempt < 100 && startedTexts.length < 2; attempt++) await flush();
  assert.equal(startedTexts[0], "first");
  assert.match(startedTexts[1] ?? "", /second/);
  assert.match(startedTexts[1] ?? "", /<polyth-runtime-epoch-recovery/);
  assert.equal((await store.projection(id))?.status, "working");
  assert.equal((await store.projection(id))?.runtimeBinding?.epoch, 1);
  assert.equal(
    (await store.events(id)).filter((event) => event.type === "runtime/epoch-replaced").length,
    1,
  );
});

test("an already reserved queue row cannot be copied through the composer edit/steer path", async (t) => {
  const fake = fakeRuntime();
  const { sessions, store } = makeService(fake);
  t.after(() => store.close());
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await flush();
  const item = await store.enqueue(id, "reserved", "queue");
  const reservation = await store.reserveQueueHead({ sessionId: id });
  assert.equal(reservation.kind, "reserved");
  await assert.rejects(sessions.queueEditStart!(id, item.id), { code: "conflict" });
  await assert.rejects(sessions.queueSendNow!(id, item.id, item.text), { code: "conflict" });
  assert.equal((await store.events(id)).some((event) => event.type === "queue/removed"), false);
  if (reservation.kind !== "reserved") return;
  await store.claimOperation(reservation.reservation.operation.operationId);
  await store.settleOperation(reservation.reservation.operation.operationId, { kind: "unknown" });
  await assert.rejects(sessions.queueEditStart!(id, item.id), { code: "conflict" });
  assert.equal((await store.queueList(id)).length, 1);
  assert.deepEqual(fake.startedTexts, []);
});

test("steer persists user intent before I/O and records confirmed delivery afterward", async () => {
  const fake = fakeRuntime({ steering: true });
  const { sessions, store } = makeService(fake);
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await sessions.send(id, { text: "start" });
  await flush();
  const res = await sessions.send(id, { text: "go left", delivery: "steer" });
  assert.ok(res.turnId);
  assert.deepEqual(fake.steeredTexts, ["go left"]);
  const evs = await store.events(id);
  const types = evs.map((e) => e.type);
  const steered = types.indexOf("delivery/steered");
  const um = types.lastIndexOf("user/message");
  assert.ok(um >= 0 && steered > um);
  await store.close();
});

test("steer applies its selected model instead of retaining the active model", async () => {
  const fake = fakeRuntime({ steering: true });
  const { sessions, store } = makeService(fake);
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await sessions.send(id, { text: "start" });
  await flush();

  await sessions.send(id, {
    text: "continue here",
    delivery: "steer",
    model: { providerID: "command-code", modelID: "gpt-5.6-terra", variant: "xhigh" },
  });

  assert.deepEqual(fake.steeredModels, [{
    providerID: "command-code", modelID: "gpt-5.6-terra", variant: "xhigh",
  }]);
  assert.deepEqual((await store.projection(id))?.model, {
    providerID: "command-code", modelID: "gpt-5.6-terra", variant: "xhigh",
  });
  await store.close();
});

test("unsupported/rejected steer falls back to queue", async () => {
  // runtime without steering capability
  const noCap = fakeRuntime({ steering: false });
  const a = makeService(noCap);
  const s1 = await a.sessions.create({ projectId: "p1", title: "T" });
  await a.sessions.send(s1.id, { text: "start" });
  await flush();
  const r1 = await a.sessions.send(s1.id, { text: "steer me", delivery: "steer" });
  assert.ok(r1.queued);
  let evs = await a.store.events(s1.id);
  assert.equal(
    (evs.find((e) => e.type === "delivery/fallback-queued")?.data as { reason?: string }).reason,
    "steer-unsupported",
  );
  await a.store.close();

  // runtime that claims steering but rejects the call
  const rejects = fakeRuntime({ steering: true, steerResult: false });
  const b = makeService(rejects);
  const s2 = await b.sessions.create({ projectId: "p1", title: "T" });
  await b.sessions.send(s2.id, { text: "start" });
  await flush();
  const r2 = await b.sessions.send(s2.id, { text: "steer me", delivery: "steer" });
  assert.ok(r2.queued);
  evs = await b.store.events(s2.id);
  assert.equal(
    (evs.find((e) => e.type === "delivery/fallback-queued")?.data as { reason?: string }).reason,
    "steer-rejected",
  );
  // The rejected steer remains as durable user intent; later queue admission
  // reuses its owning event rather than creating a duplicate model message.
  const userMsgs = evs.filter((e) => e.type === "user/message");
  assert.equal(userMsgs.length, 2);
  await b.store.close();
});

test("interrupt aborts the active turn and its message dispatches first", async () => {
  const fake = fakeRuntime();
  const { sessions } = makeService(fake);
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await sessions.send(id, { text: "long job" });
  await flush();
  await sessions.send(id, { text: "already queued", delivery: "queue" });
  const res = await sessions.send(id, { text: "urgent", delivery: "interrupt" });
  assert.ok(res.queued);
  await flush();
  assert.equal(fake.aborted, 1);
  // abort triggered dispatch: urgent runs before the earlier queued item
  assert.deepEqual(fake.startedTexts, ["long job", "urgent"]);
});

test("dismissPending rejects open questions and denies open permissions before send", async () => {
  const fake = fakeRuntime();
  const { sessions, store } = makeService(fake);
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await sessions.send(id, { text: "start" });
  await flush();
  fake.emit(id, { type: "permission/requested", requestId: "per_1", permission: "fs/write", patterns: ["*"] });
  fake.emit(id, { type: "question/asked", requestId: "que_1", questions: [{ prompt: "pick" }] });
  await flush();

  await sessions.send(id, { text: "never mind, do this", delivery: "queue", dismissPending: true });
  await flush();

  assert.deepEqual(fake.permissionReplies.filter((p) => p.requestId === "per_1").map((p) => p.reply), ["reject"]);
  assert.equal(fake.questionReplies.some((q) => q.requestId === "que_1"), true);

  const evs = await store.events(id);
  const types = evs.map((e) => e.type);
  // resolution events precede the queue event atomically
  const resolved = types.indexOf("permission/resolved");
  const answered = types.indexOf("question/answered");
  const enq = types.lastIndexOf("queue/enqueued");
  assert.ok(resolved >= 0 && resolved < enq);
  assert.ok(answered >= 0 && answered < enq);
  await store.close();
});

test("missing runtime questions expire instead of blocking replies or queued sends", async () => {
  const fake = fakeRuntime();
  fake.rt.replyQuestionOperation = async (_sessionId, requestId, _answers, _operationId) => ({
    kind: "rejected",
    code: "http-404",
    message: `Question request not found: ${requestId}`,
  });
  const { sessions, store } = makeService(fake);
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await sessions.send(id, { text: "start" });
  await flush();

  fake.emit(id, { type: "question/asked", requestId: "stale-answer", questions: [{ prompt: "pick" }] });
  await flush();
  await sessions.replyQuestion(id, "stale-answer", { choice: "yes" });

  fake.emit(id, { type: "question/asked", requestId: "stale-send", questions: [{ prompt: "pick" }] });
  await flush();
  const sent = await sessions.send(id, { text: "continue", delivery: "queue", dismissPending: true });

  assert.ok(sent.queued);
  const events = await store.events(id);
  assert.deepEqual(events.filter((event) => event.type === "question/expired")
    .map((event) => (event.data as { requestId?: string }).requestId), ["stale-answer", "stale-send"]);
  await store.close();
});

test("queue order survives service restart and dispatches after reopen", async () => {
  const fake = fakeRuntime();
  const dir = mkdtempSync(join(tmpdir(), "polyth-restart-"));
  const dbPath = join(dir, "s.db");
  const project: Project = { id: "p1", path: dir, name: "p", createdAt: 1 };
  const projects: ProjectService = {
    list: async () => [project], get: async () => project,
    add: async () => project, create: async () => project, remove: async () => {},
  };
  const permissions = { evaluate: () => "ask", addRule: () => {}, rules: () => [] } as unknown as PermissionService;
  const broadcast: Broadcaster = { event: () => {}, projection: () => {} };

  let sessionId = "";
  {
    const store = createStore(dbPath);
    const sessions = createSessionService({
      store, projects, permissions, broadcast, queue: store,
      runtimes: { forProject: async () => fake.rt },
    });
    const ref = await sessions.create({ projectId: "p1", title: "T" });
    sessionId = ref.id;
    await sessions.send(sessionId, { text: "turn" });
    await flush();
    await sessions.send(sessionId, { text: "q-a", delivery: "queue" });
    await sessions.send(sessionId, { text: "q-b", delivery: "queue" });
    await store.close();
  }
  // restart: new store + service over the same DB; opening the session drains FIFO
  const fake2 = fakeRuntime();
  const store2 = createStore(dbPath);
  const sessions2 = createSessionService({
    store: store2, projects, permissions, broadcast, queue: store2,
    runtimes: { forProject: async () => fake2.rt },
  });
  const queued = await sessions2.queueList!(sessionId);
  assert.deepEqual(queued.map((q) => q.text), ["q-a", "q-b"]);
  await sessions2.events(sessionId, 0); // session open triggers dispatch
  await flush();
  assert.deepEqual(fake2.startedTexts, ["q-a"]);
  fake2.emit(sessionId, { type: "turn/stopped", reason: "completed" });
  await flush();
  assert.deepEqual(fake2.startedTexts, ["q-a", "q-b"]);
  await store2.close();
});

test("queue edit and reorder persist into dispatch while remove stays session-scoped", async () => {
  const fake = fakeRuntime();
  const { sessions, store } = makeService(fake);
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await sessions.send(id, { text: "turn" });
  await flush();
  const a = await sessions.send(id, { text: "a", delivery: "queue" });
  const b = await sessions.send(id, { text: "b", delivery: "queue" });
  const c = await sessions.send(id, { text: "c", delivery: "queue" });
  const edited = await sessions.queueEdit!(id, a.queueId!, "  a edited  ");
  assert.equal(edited.text, "a edited");
  await assert.rejects(() => sessions.queueEdit!(id, a.queueId!, "  "), /required/);
  await assert.rejects(() => sessions.queueReorder!(id, [a.queueId!]), /permutation/);
  const reordered = await sessions.queueReorder!(id, [b.queueId!, a.queueId!, c.queueId!]);
  assert.deepEqual(reordered.map((i) => i.text), ["b", "a edited", "c"]);
  await sessions.queueRemove!(id, c.queueId!);
  assert.deepEqual((await sessions.queueList!(id)).map((i) => i.text), ["b", "a edited"]);
  await assert.rejects(() => sessions.queueRemove!(id, "nope"), /not found/);
  const editEvent = (await store.events(id)).find((event) => event.type === "queue/edited");
  assert.deepEqual(editEvent?.data, { queueId: a.queueId!, text: "a edited" });

  fake.emit(id, { type: "turn/stopped", reason: "completed" });
  await flush();
  assert.deepEqual(fake.startedTexts, ["turn", "b"]);
  fake.emit(id, { type: "turn/stopped", reason: "completed" });
  await flush();
  assert.deepEqual(fake.startedTexts, ["turn", "b", "a edited"]);
});

test("reserving a queued message keeps it from dispatching until its composer edit finishes", async () => {
  const fake = fakeRuntime();
  const { sessions, store } = makeService(fake);
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await sessions.send(id, { text: "turn" });
  await flush();
  const queued = await sessions.send(id, { text: "edit me", delivery: "queue" });
  await sessions.send(id, { text: "after me", delivery: "queue" });

  const reserved = await sessions.queueEditStart!(id, queued.queueId!);
  assert.equal(reserved.text, "edit me");
  await assert.rejects(
    () => sessions.queueEditStart!(id, queued.queueId!),
    /already being edited/,
  );
  fake.emit(id, { type: "turn/stopped", reason: "completed" });
  await flush();
  assert.deepEqual(fake.startedTexts, ["turn"], "the held queue head does not disappear into dispatch");

  await sessions.queueEdit!(id, queued.queueId!, "edited in composer");
  await flush();
  assert.deepEqual(fake.startedTexts, ["turn", "edited in composer"]);
  await store.close();
});

test("sending an edited queue item now interrupts the active turn", async () => {
  const fake = fakeRuntime();
  const { sessions, store } = makeService(fake);
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await sessions.send(id, { text: "turn" });
  await flush();
  const queued = await sessions.send(id, { text: "queued", delivery: "queue" });
  await sessions.queueEditStart!(id, queued.queueId!);

  await sessions.queueSendNow!(id, queued.queueId!, "edited and urgent");
  await flush();

  assert.equal(fake.aborted, 1);
  assert.deepEqual(fake.startedTexts, ["turn", "edited and urgent"]);
  assert.deepEqual(await sessions.queueList!(id), []);
  await store.close();
});

test("rewind rejects running turns, supports redo, and branches backend before replacement", async () => {
  const fake = fakeRuntime();
  const { sessions, store } = makeService(fake);
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await sessions.send(id, { text: "first" });
  await flush();
  await assert.rejects(() => sessions.rewind!(id, 2), /while a turn is running/);
  fake.emit(id, { type: "assistant/message", partId: "a1", text: "one" });
  fake.emit(id, { type: "turn/stopped", reason: "completed" });
  await flush();

  await sessions.send(id, { text: "second" });
  await flush();
  fake.emit(id, { type: "assistant/message", partId: "a2", text: "two" });
  fake.emit(id, { type: "turn/stopped", reason: "completed" });
  await flush();
  const before = await store.events(id);
  const second = before.filter((event) => event.type === "user/message")[1]!;

  const marker = await sessions.rewind!(id, second.seq);
  assert.equal(marker.type, "session/rewound");
  // new markers never duplicate prompt text; the draft derives from replay
  assert.equal("restoredText" in (marker.data as Record<string, unknown>), false);
  assert.deepEqual(rewindDraft(await store.events(id)), { text: "second", attachments: [] });
  const hidden = effectiveHistory(await store.events(id)).hidden;
  assert.equal((hidden.find((event) => event.type === "user/message")?.data as { text?: string }).text, "second");
  const restored = await sessions.clearRewind!(id);
  assert.equal(restored.type, "session/rewind-cleared");

  await sessions.rewind!(id, second.seq);
  await sessions.send(id, { text: "replacement" });
  await flush();
  // the replacement backend is an exact-history BRANCH (never an empty reset)
  assert.deepEqual(fake.resetSessions, []);
  assert.equal(fake.branchRequests.length, 1);
  assert.equal(fake.branchRequests[0]!.sourceSessionId, id);
  assert.equal(fake.branchRequests[0]!.targetSessionId, id);
  assert.deepEqual(fake.branchRequests[0]!.history, [
    { role: "user", parts: [{ type: "text", text: "first" }] },
    { role: "assistant", parts: [{ type: "text", text: "one" }] },
  ]);
  assert.equal((await store.projection(id))?.backendSessionId, "branch_1");
  assert.equal((await store.projection(id))?.runtimeBinding?.historyBaseline, "copied");
  const after = await store.events(id);
  const replacement = after.findLast(
    (event) => event.type === "user/message" && (event.data as { text?: string }).text === "replacement",
  )!;
  const clear = after.findLast(
    (event) => event.type === "session/rewind-cleared" && (event.data as { replaced?: boolean }).replaced === true,
  )!;
  assert.ok(clear.seq < replacement.seq);
  assert.deepEqual(deriveMessages(after).map((m) => m.parts[0]), [
    { type: "text", text: "first" },
    { type: "text", text: "one" },
    { type: "text", text: "replacement" },
  ]);
  await store.close();
});

test("composer shell waits for shell-family permission then appends call before result", async () => {
  const fake = fakeRuntime();
  const commands: string[] = [];
  const { sessions, store } = makeService(fake, {
    permission: "ask",
    shell: {
      run: async (input) => {
        commands.push(input.cmd);
        return { output: "clean\n", exitCode: 0, timedOut: false, truncated: false };
      },
    },
  });
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  const pending = await sessions.runShell!(id, "git status --short");
  assert.equal(pending.status, "pending");
  assert.ok(pending.requestId);
  assert.deepEqual(commands, []);
  let events = await store.events(id);
  const request = events.find((event) => event.type === "permission/requested")!;
  assert.equal((request.data as { permission?: string }).permission, "shell");
  assert.equal(request.producerPlugin, "composer-shell");
  assert.equal(events.some((event) => event.type === "tool/call"), false);

  await sessions.replyPermission(id, pending.requestId!, "once");
  assert.deepEqual(commands, ["git status --short"]);
  events = await store.events(id);
  const types = events.map((event) => event.type);
  const resolvedIndex = types.indexOf("permission/resolved");
  const callIndex = types.indexOf("tool/call");
  const resultIndex = types.indexOf("tool/result");
  assert.ok(callIndex >= 0 && resultIndex > callIndex && resolvedIndex > resultIndex);
  assert.equal(events[callIndex]!.producerPlugin, "composer-shell");
  assert.equal(events[resultIndex]!.producerPlugin, "composer-shell");
  const modelMessages = deriveMessages(events);
  assert.equal(
    modelMessages.some((message) => message.parts.some((part) => part.type === "tool-result" && part.output === "clean\n")),
    true,
  );
  assert.equal((await sessions.snapshot(id)).status, "idle");
  await store.close();
});

test("composer shell honors deny rules without executing", async () => {
  const fake = fakeRuntime();
  let runs = 0;
  const { sessions, store } = makeService(fake, {
    permission: "deny",
    shell: {
      run: async () => {
        runs += 1;
        return { output: "", exitCode: 0, timedOut: false, truncated: false };
      },
    },
  });
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  const result = await sessions.runShell!(id, "rm -rf build");
  assert.equal(result.status, "rejected");
  assert.equal(runs, 0);
  const events = await store.events(id);
  assert.deepEqual(events.slice(-2).map((event) => event.type), ["tool/call", "tool/result"]);
  assert.match(String((events.at(-1)!.data as { output?: string }).output), /rejected/);
  await store.close();
});
