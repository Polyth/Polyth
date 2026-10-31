// Active-turn delivery admission, durable FIFO queue, steer fallback,
// and send-time question/permission arbitration.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStore, deriveMessages, effectiveHistory, rewindDraft } from "@polyth/session";
import type {
  AgentRuntime, JsonObject, ModelMessage, ModelRef, Project, ProjectService, RuntimeBranchRequest,
  RuntimeEndpoint, RuntimeEvent, RuntimeLifecycleNotification, RuntimeSessionBinding, RuntimeSnapshot,
} from "@polyth/contracts";
import { createSessionService, type Broadcaster, type MemoryRuntimeService } from "../src/sessions.ts";
import type { PermissionService } from "@polyth/permissions";

type Emit = (sessionId: string, ev: RuntimeEvent) => void;

function fakeRuntime(opts: { steering?: boolean; steerResult?: boolean; nativeCommands?: boolean; harnessId?: string } = {}) {
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
    ...(opts.harnessId ? { harnessId: opts.harnessId } : {}),
    capabilities: async () => ({
      streaming: true, permissions: true, questions: true, compaction: false, subagents: false,
      steering: opts.steering ?? false,
      ...(opts.nativeCommands ? { commands: { discovery: "native" as const, invoke: "raw-native-input" as const } } : {}),
    }),
    ...(opts.nativeCommands ? {
      commands: async () => [{
        id: "native:fake:compact",
        name: "compact",
        owner: "native" as const,
        harnessId: "fake",
        invocation: "raw-native-input" as const,
      }],
    } : {}),
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
  workspaceInstructionsEnabled?: boolean;
  purposeContext?: Parameters<typeof createSessionService>[0]["purposeContext"];
  shell?: {
    run(input: { projectId: string; cwd: string; cmd: string }): Promise<{
      output: string; exitCode: number | null; timedOut: boolean; truncated: boolean;
    }>;
  };
  onRestart?: (listener: (runtime: AgentRuntime) => void | Promise<void>) => { dispose(): void };
  modelCatalogStale?: Parameters<typeof createSessionService>[0]["modelCatalogStale"];
  memory?: MemoryRuntimeService;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "polyth-delivery-"));
  const store = createStore(join(dir, "s.db"));
  // Memory recall is scoped to a Space; only memory tests need one.
  const project: Project = { id: "p1", path: dir, name: "p", createdAt: 1, ...(opts.memory ? { spaceId: "space" } : {}) };
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
    ...(opts.purposeContext ? { purposeContext: opts.purposeContext } : {}),
    ...(opts.workspaceInstructionsEnabled !== undefined
      ? { workspaceInstructionsEnabled: async () => opts.workspaceInstructionsEnabled! }
      : {}),
    ...(opts.shell ? { shell: opts.shell } : {}),
    ...(opts.modelCatalogStale ? { modelCatalogStale: opts.modelCatalogStale } : {}),
    ...(opts.memory ? { memory: opts.memory } : {}),
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

test("hidden repeated prompt stays hidden through durable queue dispatch", async () => {
  const fake = fakeRuntime();
  const { sessions, store } = makeService(fake);
  const { id } = await sessions.create({ projectId: "p1", title: "Hidden retry" });

  await sessions.send(id, { text: "first" });
  await flush();
  const queued = await sessions.send(id, {
    text: "first",
    delivery: "queue",
    hiddenUserMessage: true,
  });
  assert.equal(queued.queued, true);
  assert.equal((await store.queueList(id))[0]?.hiddenUserMessage, true);

  fake.emit(id, { type: "turn/stopped", reason: "completed" });
  await flush();

  assert.deepEqual(fake.startedTexts, ["first", "first"]);
  const users = (await store.events(id)).filter((event) => event.type === "user/message");
  assert.equal(users.length, 2);
  assert.equal((users[0]!.data as { hiddenUserMessage?: boolean }).hiddenUserMessage, undefined);
  assert.equal((users[1]!.data as { hiddenUserMessage?: boolean }).hiddenUserMessage, true);
  await store.close();
});

test("aborted idle turn admits the next queued message without an abort flag reset", { timeout: 5000 }, async () => {
  const fake = fakeRuntime();
  const { sessions, store } = makeService(fake);
  const { id } = await sessions.create({ projectId: "p1", title: "Abort then queue" });
  await sessions.send(id, { text: "first" });
  await sessions.abort(id);
  assert.equal((await store.projection(id))?.status, "idle");
  assert.equal((await store.events(id)).findLast((event) => event.type === "turn/stopped")?.data.reason, "aborted");

  const queued = await store.enqueue(id, "next", "queue");
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
  const patchProjection = store.patchProjection.bind(store);
  store.patchProjection = async (...args) => {
    const result = await patchProjection(...args);
    if (result?.id === id && result.status === "working") resolveStarted();
    return result;
  };
  await sessions.queueEdit(id, queued.item.id, "next");
  await started;
  assert.deepEqual(fake.startedTexts, ["first", "next"]);
  assert.deepEqual(await store.queueList(id), []);
  // Join the runtime callback's session lock without scheduling another stop.
  await assert.rejects(sessions.queueEditStart(id, queued.item.id), { code: "conflict" });
  await store.close();
});

test("session purpose persists, survives fork, and supplies hidden context on every turn", async () => {
  const fake = fakeRuntime();
  const { sessions, store } = makeService(fake, {
    purposeContext: (session) => `Artifact for ${session.purpose}: ${session.id}`,
  });
  const { id } = await sessions.create({ projectId: "p1", purpose: "playground" });
  assert.equal((await store.projection(id))?.purpose, "playground");
  assert.equal((await store.events(id)).find((event) => event.type === "session/created")?.data.purpose, "playground");
  for (const text of ["create a bunny", "make it blue"]) {
    await sessions.send(id, { text });
    assert.match(fake.startedTexts.at(-1)!, new RegExp(`Artifact for playground: ${id}`));
    const event = (await store.events(id)).filter((event) => event.type === "user/message").at(-1)!;
    assert.equal(event.data.text, text);
    assert.match(String(event.data.recoveryContext), new RegExp(id));
    fake.emit(id, { type: "turn/stopped", reason: "completed" });
    await flush();
  }
  const fork = await sessions.fork(id);
  assert.equal((await store.projection(fork.id))?.purpose, "playground");
  const ordinary = await sessions.create({ projectId: "p1" });
  await sessions.send(ordinary.id, { text: "ordinary chat" });
  assert.equal(fake.startedTexts.at(-1), "ordinary chat");
  fake.emit(ordinary.id, { type: "turn/stopped", reason: "completed" });
  await flush();
  await store.close();
});

test("session purpose rejects malformed and non-string values before creation", async () => {
  const { sessions, store } = makeService(fakeRuntime());
  for (const purpose of ["", "Playground", "../playground", "x".repeat(41), null, true, ["playground"]]) {
    await assert.rejects(sessions.create({ projectId: "p1", purpose: purpose as string }), { code: "invalid-input" });
  }
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
    workspaceInstructionsEnabled: true,
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

test("AGENTS.md is delivered again once after a native compaction", async () => {
  const fake = fakeRuntime();
  let reads = 0;
  const { sessions, store } = makeService(fake, {
    workspaceInstructions: {
      async read() {
        reads += 1;
        return "Keep the change scoped.";
      },
    },
    workspaceInstructionsEnabled: true,
  });
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  const userMessages = async () =>
    (await store.events(id)).filter((event) => event.type === "user/message");

  await sessions.send(id, { text: "first" });
  fake.emit(id, { type: "turn/stopped", reason: "completed" });
  await flush();

  // The harness summarized its context; the first-turn instructions may be gone.
  fake.emit(id, { type: "session/compacted" });
  await flush();
  const compactedSeq = (await store.events(id)).findLast((event) => event.type === "session/compacted")!.seq;

  await sessions.send(id, { text: "after compaction" });
  assert.match(fake.startedTexts[1]!, /<polyth-workspace-instructions path="AGENTS\.md">/);
  const restored = (await userMessages())[1]!;
  assert.equal(restored.data.text, "after compaction");
  assert.match(String(restored.data.recoveryContext), /Keep the change scoped\./);
  assert.deepEqual(restored.data.compactionRecovery, {
    compactionSeq: compactedSeq,
    workspaceInstructionsRestored: true,
  });
  fake.emit(id, { type: "turn/stopped", reason: "completed" });
  await flush();

  // Restored once: the next turn is plain again.
  await sessions.send(id, { text: "later" });
  assert.equal(fake.startedTexts[2], "later");
  assert.equal(reads, 2);
  fake.emit(id, { type: "turn/stopped", reason: "completed" });
  await flush();
  await store.close();
});

test("a native command runs as its exact input and leaves first-prompt context to the next turn", async () => {
  // Without a harness id the session has no runtime leg (the legacy path).
  for (const harnessId of [undefined, "fake"]) {
    const fake = fakeRuntime({ nativeCommands: true, ...(harnessId ? { harnessId } : {}) });
    const intents: string[] = [];
    const { sessions, store } = makeService(fake, {
      workspaceInstructions: { read: async () => "Keep the change scoped." },
      workspaceInstructionsEnabled: true,
      memory: {
        recall: (_scope, input) => {
          intents.push(input.intent);
          return {
            status: "selected",
            modelVisibleText: "<polyth-project-memory>\nUse the durable seam.\n</polyth-project-memory>",
            selected: [],
            omittedCount: 0,
            estimate: { bytes: 64, estimated: true },
            dataRevision: "1",
            settingsRevision: "1",
            generation: "g1",
            digest: "d1",
            reasons: [],
          };
        },
        checkFence: () => true,
      },
    });
    const { id } = await sessions.create({ projectId: "p1", title: "T" });
    assert.equal(Boolean((await store.projection(id))?.runtimeLeg), Boolean(harnessId));
    await store.append(id, "package/context", {
      packageId: "workflow",
      sourceId: "run:r1",
      title: "Workflow result",
      text: "Reviewer found no blocking issues.",
    });

    await sessions.send(id, { text: "/compact", command: { id: "native:fake:compact" } });
    assert.equal(fake.startedTexts[0], "/compact", "a harness runs a command only when the prompt starts with it");
    const commandMessage = (await store.events(id)).find((event) => event.type === "user/message")!;
    assert.equal(commandMessage.data.recoveryContext, undefined);
    assert.deepEqual(intents, [], "no memory recall rides with a native command");
    fake.emit(id, { type: "turn/stopped", reason: "completed" });
    await flush();
    if (harnessId) assert.equal((await store.projection(id))?.runtimeLeg?.bootstrap, "empty", "the leg still owes its first prompt");

    await sessions.send(id, { text: "continue" });
    const next = fake.startedTexts[1]!;
    assert.match(next, /<polyth-workspace-instructions path="AGENTS\.md">/);
    assert.match(next, /<polyth-package-context>[\s\S]*Reviewer found no blocking issues\./);
    assert.match(next, /\n\ncontinue\n\n<polyth-project-memory>/);
    assert.deepEqual(intents, ["continue"]);
    fake.emit(id, { type: "turn/stopped", reason: "completed" });
    await flush();
    if (harnessId) assert.equal((await store.projection(id))?.runtimeLeg?.bootstrap, "native-resume");

    await sessions.send(id, { text: "later" });
    assert.match(fake.startedTexts[2]!, /^later\n\n<polyth-project-memory>/, "the owed context is delivered once");
    fake.emit(id, { type: "turn/stopped", reason: "completed" });
    await flush();
    await store.close();
  }
});

test("a native command after a runtime epoch replacement leaves the recovery to the next turn", async () => {
  const fake = fakeRuntime({ nativeCommands: true });
  const { sessions, store } = makeService(fake);
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await sessions.send(id, { text: "Plan the keyboard fix" });
  fake.emit(id, { type: "turn/stopped", reason: "completed" });
  await flush();
  const marker = await store.append(id, "runtime/epoch-replaced", {
    old: { authorityId: "fake-runtime", generation: 1, epoch: 0 },
    new: { authorityId: "fake-runtime", generation: 2, epoch: 1 },
    reason: "owned runtime authority changed; restoring confirmed canonical history",
  });

  await sessions.send(id, { text: "/compact", command: { id: "native:fake:compact" } });
  assert.equal(fake.startedTexts[1], "/compact");
  fake.emit(id, { type: "turn/stopped", reason: "completed" });
  await flush();

  await sessions.send(id, { text: "continue" });
  assert.match(fake.startedTexts[2]!, /^<polyth-runtime-epoch-recovery epoch="1" marker-seq="\d+">/);
  assert.match(fake.startedTexts[2]!, /Plan the keyboard fix/);
  assert.match(fake.startedTexts[2]!, /\n\ncontinue$/);
  const restored = (await store.events(id)).filter((event) => event.type === "user/message").at(-1)!;
  assert.deepEqual(restored.data.runtimeEpochRecovery, { epoch: 1, markerSeq: marker.seq });
  fake.emit(id, { type: "turn/stopped", reason: "completed" });
  await flush();
  await store.close();
});

test("a refused or retired model marks the shared model catalog stale", async () => {
  const fake = fakeRuntime();
  fake.rt.harnessId = "opencode";
  fake.rt.models = async () => [{ providerID: "openai", modelID: "current", name: "Current" }];
  const signals: unknown[] = [];
  const { sessions, store } = makeService(fake, { modelCatalogStale: (signal) => { signals.push(signal); } });
  const { id } = await sessions.create({ projectId: "p1", title: "T" });

  // Preflight: the picker offered a model the runtime no longer lists.
  await assert.rejects(
    sessions.send(id, { text: "hi", model: { providerID: "openai", modelID: "retired" } }),
    { code: "invalid-model" },
  );
  assert.deepEqual(signals, [{ harnessId: "opencode", projectId: "p1", reason: "preflight-invalid-model" }]);

  // Runtime: the provider refused the model mid-turn.
  await sessions.send(id, { text: "hi", model: { providerID: "openai", modelID: "current" } });
  const resolvedHarnessId = (await store.projection(id))?.resolvedHarnessId;
  fake.emit(id, { type: "turn/stopped", reason: "error", error: "model not found", code: "model-unavailable" });
  await flush();
  assert.deepEqual(signals.at(-1), {
    ...(resolvedHarnessId ? { harnessId: resolvedHarnessId } : {}),
    projectId: "p1",
    reason: "turn-model-unavailable",
  });
  const stop = (await store.events(id)).findLast((event) => event.type === "turn/stopped")!;
  assert.equal(stop.data.code, "model-unavailable");

  // Ordinary failures say nothing about the catalog.
  const before = signals.length;
  await sessions.send(id, { text: "again" });
  fake.emit(id, { type: "turn/stopped", reason: "error", error: "network" });
  await flush();
  assert.equal(signals.length, before);
  await store.close();
});

test("workspace AGENTS.md injection is opt-in and disabled by default", async () => {
  const fake = fakeRuntime();
  let reads = 0;
  const { sessions, store } = makeService(fake, {
    workspaceInstructions: {
      async read() {
        reads += 1;
        return "This must stay disabled until the setting is enabled.";
      },
    },
  });
  const { id } = await sessions.create({ projectId: "p1", title: "T" });

  await sessions.send(id, { text: "plain prompt" });
  assert.equal(fake.startedTexts[0], "plain prompt");
  assert.equal(reads, 0);
  fake.emit(id, { type: "turn/stopped", reason: "completed" });
  await flush();
  await store.close();
});

test("missing AGENTS.md is a no-op and an invalid policy blocks admission", async () => {
  const missingRuntime = fakeRuntime();
  const missing = makeService(missingRuntime, {
    workspaceInstructions: { read: async () => null },
    workspaceInstructionsEnabled: true,
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
    workspaceInstructionsEnabled: true,
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

test("a turn stop ingested by reconciliation releases the turn and drains the queue", async (t) => {
  const fake = fakeRuntime();
  let lifecycle: ((notification: RuntimeLifecycleNotification) => void) | undefined;
  fake.rt.onLifecycle = (listener) => {
    lifecycle = listener;
    return { dispose() {} };
  };
  // The quiet-turn check reconciles while the provider finishes: the snapshot
  // carries the native stop and the live copy is fenced as stale evidence, so
  // the live turn/stopped handler never runs for this turn.
  let snapshotStop = false;
  const reconcile = fake.rt.reconcile;
  fake.rt.reconcile = async (binding) => {
    const snapshot = await reconcile(binding);
    return snapshotStop
      ? {
          ...snapshot,
          events: [{
            entityKey: "turn:t1",
            revision: "stopped",
            events: [{ type: "turn/stopped", turnId: "t1", reason: "completed" }],
          }],
        }
      : snapshot;
  };
  const { sessions, store } = makeService(fake);
  t.after(() => store.close());
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await sessions.send(id, { text: "first" });
  await flush();
  const queued = await sessions.send(id, { text: "second" });
  assert.equal(queued.queued, true);

  snapshotStop = true;
  lifecycle!({ type: "stream-connected" });
  for (let attempt = 0; attempt < 50 && fake.startedTexts.length < 2; attempt++) await flush();
  assert.deepEqual(fake.startedTexts, ["first", "second"]);
  const stops = (await store.events(id)).filter((event) => event.type === "turn/stopped");
  assert.deepEqual(stops.map((event) => event.data.turnId), ["t1"]);
  assert.equal((await store.queueList(id)).length, 0);
});

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
  const { item } = await store.enqueue(id, "reserved", "queue");
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

test("steer on a runtime without steering support falls back to stop+send", async () => {
  const noCap = fakeRuntime({ steering: false });
  const a = makeService(noCap);
  const s1 = await a.sessions.create({ projectId: "p1", title: "T" });
  await a.sessions.send(s1.id, { text: "start" });
  await flush();
  const r1 = await a.sessions.send(s1.id, { text: "steer me", delivery: "steer" });
  assert.ok(r1.queued);
  await flush();
  // no native steer/queue-and-wait: the active turn is aborted and the text
  // dispatches next, same as an explicit interrupt send
  assert.equal(noCap.aborted, 1);
  assert.deepEqual(noCap.startedTexts, ["start", "steer me"]);
  await a.store.close();
});

test("rejected steer falls back to queue", async () => {
  // runtime that claims steering but rejects the call
  const rejects = fakeRuntime({ steering: true, steerResult: false });
  const b = makeService(rejects);
  const s2 = await b.sessions.create({ projectId: "p1", title: "T" });
  await b.sessions.send(s2.id, { text: "start" });
  await flush();
  const r2 = await b.sessions.send(s2.id, { text: "steer me", delivery: "steer" });
  assert.ok(r2.queued);
  const evs = await b.store.events(s2.id);
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
  const queued = await sessions.send(id, { text: "already queued", delivery: "queue" });
  assert.equal(queued.interrupting, undefined, "a queue send never stops the running turn");
  const res = await sessions.send(id, { text: "urgent", delivery: "interrupt" });
  assert.ok(res.queued);
  assert.equal(res.interrupting, true);
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
  await sessions2.activate!(sessionId); // session open triggers dispatch
  await flush();
  assert.deepEqual(fake2.startedTexts, ["q-a"]);
  fake2.emit(sessionId, { type: "turn/stopped", reason: "completed" });
  await flush();
  assert.deepEqual(fake2.startedTexts, ["q-a", "q-b"]);
  await store2.close();
});

test("prepared queue reservation resumes once after service restart", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-prepared-queue-"));
  const dbPath = join(dir, "s.db");
  const project: Project = { id: "p1", path: dir, name: "p", createdAt: 1 };
  const projects: ProjectService = {
    list: async () => [project], get: async () => project,
    add: async () => project, create: async () => project, remove: async () => {},
  };
  const permissions = { evaluate: () => "ask", addRule: () => {}, rules: () => [] } as unknown as PermissionService;
  const broadcast: Broadcaster = { event: () => {}, projection: () => {} };
  const store = createStore(dbPath);
  const first = fakeRuntime();
  const sessions = createSessionService({
    store, projects, permissions, broadcast, queue: store,
    runtimes: { forProject: async () => first.rt },
  });
  const { id } = await sessions.create({ projectId: "p1", title: "Prepared queue" });
  await flush();
  const { item } = await store.enqueue(id, "q-a", "queue");
  await store.enqueue(id, "q-b", "queue");
  const reservation = await store.reserveQueueHead({ sessionId: id });
  assert.equal(reservation.kind, "reserved");
  if (reservation.kind !== "reserved") throw new Error("missing reservation");
  const operationId = reservation.reservation.operation.operationId;
  assert.equal((await store.operation(operationId))?.state, "prepared");
  assert.equal((await store.events(id)).some(event => event.type === "mutation/claimed"
    && event.data.operationId === operationId), false);
  sessions.dispose();
  await store.close();

  const reopened = createStore(dbPath);
  const second = fakeRuntime();
  const resumed = createSessionService({
    store: reopened, projects, permissions, broadcast, queue: reopened,
    runtimes: { forProject: async () => second.rt },
  });
  t.after(async () => {
    resumed.dispose();
    await reopened.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await resumed.activate!(id);
  for (let attempt = 0; attempt < 50 && second.startedTexts.length === 0; attempt++) await flush();
  assert.deepEqual(second.startedTexts, ["q-a"],
    "a never-claimed durable queue reservation must not deadlock its own reconciliation");
  assert.equal((await reopened.operation(operationId))?.state, "confirmed");
  assert.equal((await reopened.queueList(id)).some(row => row.id === item.id), false);
  assert.equal((await reopened.events(id)).filter(event => event.type === "mutation/claimed"
    && event.data.operationId === operationId).length, 1);
  second.emit(id, { type: "turn/stopped", reason: "completed" });
  for (let attempt = 0; attempt < 50 && second.startedTexts.length < 2; attempt++) await flush();
  assert.deepEqual(second.startedTexts, ["q-a", "q-b"]);
});

for (const scenario of [
  "prepared turn submission without a queue reservation",
  "prepared non-queue operation",
  "prepared reservation for a different turn mutation",
  "prepared queue reservation with another unresolved operation",
  "executing queue reservation",
  "unknown queue reservation",
  "prepared queue reservation with unknown runtime",
  "prepared queue reservation with running runtime",
] as const) test(`${scenario} keeps delivery fenced`, async (t) => {
  const first = fakeRuntime();
  const { sessions, store } = makeService(first);
  let resumed = sessions;
  let directory: string | undefined;
  t.after(async () => {
    resumed.dispose();
    await store.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });
  const { id } = await sessions.create({ projectId: "p1", title: scenario });
  await flush();
  const current = await sessions.snapshot(id);
  const path = current.workspace?.repositories[0]?.path;
  assert.ok(path);
  directory = path;
  const project: Project = { id: "p1", path, name: "p", createdAt: 1 };
  const projects: ProjectService = {
    list: async () => [project], get: async () => project,
    add: async () => project, create: async () => project, remove: async () => {},
  };
  const { item } = await store.enqueue(id, "queued intent", "queue");
  const { item: tail } = await store.enqueue(id, "later intent", "queue");
  const unreserved = scenario === "prepared turn submission without a queue reservation"
    || scenario === "prepared non-queue operation";
  let operationId: string;
  if (unreserved) {
    const prepared = await store.prepareOperation({
      sessionId: id,
      mutationKind: scenario === "prepared non-queue operation" ? "session-reset" : "turn-submit",
      intentEvent: scenario === "prepared non-queue operation"
        ? { type: "session/reset-intended", data: { reason: "test" }, ignorable: true }
        : { type: "user/message", data: { text: "unreserved intent" } },
    });
    operationId = prepared.operation.operationId;
    assert.equal(await store.queueReservation(operationId), undefined);
  } else {
    const reservation = await store.reserveQueueHead({
      sessionId: id,
      mutationKind: scenario === "prepared reservation for a different turn mutation" ? "turn-steer" : "turn-submit",
    });
    assert.equal(reservation.kind, "reserved");
    if (reservation.kind !== "reserved") throw new Error("missing reservation");
    operationId = reservation.reservation.operation.operationId;
  }
  if (scenario === "prepared queue reservation with another unresolved operation") {
    await store.prepareOperation({
      sessionId: id,
      mutationKind: "session-reset",
      intentEvent: { type: "session/reset-intended", data: { reason: "test" }, ignorable: true },
    });
  }
  if (scenario === "executing queue reservation" || scenario === "unknown queue reservation") {
    await store.claimOperation(operationId);
    if (scenario === "unknown queue reservation") {
      await store.settleOperation(operationId, { kind: "unknown", message: "lost runtime acknowledgement" });
    }
  }
  const operations = await store.operations(id);
  const claims = (await store.events(id)).filter(event => event.type === "mutation/claimed"
    && event.data.operationId === operationId).length;
  sessions.dispose();

  const second = fakeRuntime();
  const reconcile = second.rt.reconcile;
  if (scenario === "prepared queue reservation with unknown runtime"
    || scenario === "prepared queue reservation with running runtime") {
    second.rt.reconcile = async (binding) => {
      const snapshot = await reconcile(binding);
      return {
        ...snapshot,
        state: { ...snapshot.state, value: scenario.endsWith("unknown runtime") ? "unknown" : "running" },
      };
    };
  }
  resumed = createSessionService({
    store, projects, queue: store,
    permissions: { evaluate: () => "ask", addRule: () => {}, rules: () => [] } as unknown as PermissionService,
    broadcast: { event: () => {}, projection: () => {} },
    runtimes: { forProject: async () => second.rt },
  });
  await resumed.activate!(id);
  await flush();
  assert.deepEqual(second.startedTexts, []);
  assert.equal((await store.projection(id))?.status, "unknown");
  assert.equal((await store.reconciliation(id))?.state, "blocked");
  assert.deepEqual((await store.operations(id)).map(operation => [operation.operationId, operation.state]),
    operations.map(operation => [operation.operationId, operation.state]));
  assert.equal(Boolean(await store.queueReservation(operationId)), !unreserved);
  assert.deepEqual((await store.queueList(id)).map(row => row.id), [item.id, tail.id]);
  assert.equal((await store.events(id)).filter(event => event.type === "mutation/claimed"
    && event.data.operationId === operationId).length, claims);
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

test("rewind stays soft during a running turn, supports redo, and branches before replacement", async () => {
  const fake = fakeRuntime();
  const { sessions, store } = makeService(fake);
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await sessions.send(id, { text: "first" });
  await flush();
  const runningTarget = (await store.events(id)).find((event) => event.type === "user/message")!;
  const runningMarker = await sessions.rewind!(id, runningTarget.seq);
  assert.equal(runningMarker.type, "session/rewound");
  assert.equal(fake.aborted, 0, "pressing Revert must not stop the active turn");
  await sessions.clearRewind!(id);
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

test("an answered question is a rewind point; declined and mirrored ones are not", async () => {
  const fake = fakeRuntime();
  const { sessions, store } = makeService(fake);
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await sessions.send(id, { text: "plan it" });
  await flush();
  fake.emit(id, { type: "assistant/message", partId: "a1", text: "One question first." });
  fake.emit(id, { type: "question/asked", requestId: "que_db", questions: [{ id: "db", prompt: "Which database?" }] });
  await flush();
  await sessions.replyQuestion(id, "que_db", { db: "Postgres" });
  fake.emit(id, { type: "question/asked", requestId: "que_skip", questions: [{ prompt: "Anything else?" }] });
  await flush();
  await sessions.replyQuestion(id, "que_skip", { __reject: true });
  fake.emit(id, { type: "assistant/message", partId: "a2", text: "Using Postgres." });
  await flush();

  const events = await store.events(id);
  const answerOf = (requestId: string) => events.find((event) =>
    event.type === "question/answered" && (event.data as { requestId?: string }).requestId === requestId)!;
  await assert.rejects(() => sessions.rewind!(id, answerOf("que_skip").seq), /user message or a question answer/);

  const answered = answerOf("que_db");
  const marker = await sessions.rewind!(id, answered.seq);
  assert.equal(marker.type, "session/rewound");
  assert.equal(fake.aborted, 0, "Revert of an answer is soft like a prompt revert");
  const eff = effectiveHistory(await store.events(id));
  assert.ok(eff.events.some((event) => event.type === "question/asked"), "the question stays");
  assert.equal(eff.events.some((event) => event.seq >= answered.seq), false, "the answer onward is cut");
  await sessions.clearRewind!(id);

  // A subagent's question mirrored into this parent was answered for the child.
  await store.append(id, "question/asked", {
    requestId: "que_child",
    questions: [{ prompt: "Child asks" }],
    sourceSessionId: "child-session",
  }, { ignorable: true });
  const mirrorAnswer = await store.append(id, "question/answered", {
    requestId: "que_child",
    answers: { q1: "ok" },
  }, { ignorable: true });
  await assert.rejects(() => sessions.rewind!(id, mirrorAnswer.seq), /user message or a question answer/);
  await store.close();
});

test("submitting a running-turn rewind interrupts only at send and drops late stale output", async () => {
  const fake = fakeRuntime();
  const { sessions, store } = makeService(fake);
  const { id } = await sessions.create({ projectId: "p1", title: "T" });

  await sessions.send(id, { text: "keep" });
  await flush();
  fake.emit(id, { type: "assistant/message", partId: "a1", text: "kept answer" });
  fake.emit(id, { type: "turn/stopped", reason: "completed" });
  await flush();

  await sessions.send(id, { text: "replace me" });
  await flush();
  fake.emit(id, { type: "assistant/message", partId: "a2", text: "work before click" });
  await flush();
  const target = (await store.events(id)).filter((event) => event.type === "user/message")[1]!;
  const marker = await sessions.rewind!(id, target.seq);
  assert.equal(fake.aborted, 0, "the soft marker must leave the turn running");

  // Output arriving after the click remains recoverable by Restore, but it is
  // not effective history for the eventual replacement branch.
  fake.emit(id, { type: "assistant/message", partId: "a2", text: " and after click" });
  await flush();
  assert.deepEqual(deriveMessages(await store.events(id)), [
    { role: "user", parts: [{ type: "text", text: "keep" }] },
    { role: "assistant", parts: [{ type: "text", text: "kept answer" }] },
  ]);

  // Even a stale client requesting queue delivery is promoted to the safe
  // commit path: enqueue, abort, confirmed stop, branch, then admission.
  const submitted = await sessions.send(id, { text: "replacement", delivery: "queue" });
  assert.equal(submitted.queued, true);
  await flush();
  assert.equal(fake.aborted, 1);
  assert.deepEqual(fake.branchRequests[0]?.history, [
    { role: "user", parts: [{ type: "text", text: "keep" }] },
    { role: "assistant", parts: [{ type: "text", text: "kept answer" }] },
  ]);
  assert.deepEqual(fake.startedTexts, ["keep", "replace me", "replacement"]);
  assert.deepEqual(await sessions.queueList!(id), []);

  const events = await store.events(id);
  const clear = events.findLast((event) =>
    event.type === "session/rewind-cleared"
    && (event.data as { rewindSeq?: number; replaced?: boolean }).rewindSeq === marker.seq);
  const replacement = events.findLast((event) =>
    event.type === "user/message" && (event.data as { text?: string }).text === "replacement");
  assert.equal((clear?.data as { replaced?: boolean } | undefined)?.replaced, true);
  assert.ok(clear && replacement && clear.seq < replacement.seq);
  assert.deepEqual(deriveMessages(events).map((message) => message.parts[0]), [
    { type: "text", text: "keep" },
    { type: "text", text: "kept answer" },
    { type: "text", text: "replacement" },
  ]);
  await store.close();
});

test("composer shell runs the person's command without a confirmation and appends call before result", async () => {
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
  const result = await sessions.runShell!(id, "git status --short");
  assert.equal(result.status, "completed");
  assert.equal(result.requestId, undefined);
  assert.deepEqual(commands, ["git status --short"]);
  const events = await store.events(id);
  assert.equal(events.some((event) => event.type === "permission/requested"), false);
  const types = events.map((event) => event.type);
  const callIndex = types.indexOf("tool/call");
  const resultIndex = types.indexOf("tool/result");
  assert.ok(callIndex >= 0 && resultIndex > callIndex);
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
