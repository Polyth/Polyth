import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AgentRuntime,
  CanonicalTurnRequest,
  ProjectService,
  RuntimeCapabilities,
  RuntimeCommandDescriptor,
  RuntimeEvent,
  RuntimeObservation,
} from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import { attachmentModality, effectiveAttachmentSupport } from "@polyth/harness-runtime";
import { commandPrecedence } from "@polyth/commands";
import { createStore } from "@polyth/session";
import { parseTurnCommand } from "../src/turnCommand.ts";
import { createSessionService } from "../src/sessions.ts";

const STATIC: RuntimeCapabilities = {
  streaming: true,
  permissions: false,
  questions: false,
  compaction: false,
  subagents: false,
  title: "native",
  attachments: { modalities: { image: "native", file: "unsupported", pdf: "native", audio: "native" } },
  commands: { discovery: "native", invoke: "raw-native-input" },
  contextOccupancy: "unknown",
};

function fixture(overrides?: Partial<AgentRuntime>) {
  const store = createStore(":memory:");
  let patchProjectionCalls = 0;
  const basePatch = store.patchProjection?.bind(store);
  if (basePatch) {
    store.patchProjection = async (sessionId, patch) => {
      patchProjectionCalls++;
      return basePatch(sessionId, patch);
    };
  }
  const listeners = new Set<(sessionId: string, event: RuntimeEvent) => void>();
  const observationListeners = new Set<(sessionId: string, observation: RuntimeObservation) => void>();
  let ensureWiredCount = 0;
  let forProjectCalls = 0;
  let createRuntimeCalls = 0;
  const commands: RuntimeCommandDescriptor[] = [{
    id: "native:fake:review",
    name: "review",
    owner: "native",
    harnessId: "fake",
    invocation: "raw-native-input",
  }];
  const runtime: AgentRuntime = {
    harnessId: "fake",
    capabilities: async () => STATIC,
    commands: async () => commands,
    models: async () => [{
      providerID: "fake",
      modelID: "m",
      name: "m",
      capabilities: ["input:text", "input:image", "input:pdf", "output:text", "toolcall"],
    }],
    agents: async () => [],
    ensureSession: async ({ sessionId }) => {
      createRuntimeCalls++;
      return `native-${sessionId}`;
    },
    sessions: async () => [],
    history: async () => [],
    async startTurn(request) {
      for (const listener of listeners) {
        listener(request.sessionId, { type: "turn/started", turnId: "turn-1" });
        listener(request.sessionId, { type: "turn/stopped", turnId: "turn-1", reason: "completed" });
      }
    },
    abort: async () => {},
    replyPermission: async () => {},
    replyQuestion: async () => {},
    onEvent(listener) {
      listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    },
    onObservation(listener) {
      observationListeners.add(listener);
      return { dispose: () => { observationListeners.delete(listener); } };
    },
    dispose: async () => {},
    ...overrides,
  };
  const projects = {
    get: async (id: string) => id === "p"
      ? { id: "p", name: "p", path: "/tmp", spaceId: "space", createdAt: 0 }
      : undefined,
    list: async () => [],
  } as unknown as ProjectService;
  const sessions = createSessionService({
    store,
    projects,
    runtimes: {
      forProject: async () => {
        forProjectCalls++;
        throw new Error("forProject should not be called in runtimeFeatures hardening tests");
      },
      forSession: async () => {
        ensureWiredCount++;
        return runtime;
      },
    },
    permissions: { evaluate: () => "allow" } as unknown as PermissionService,
    broadcast: { event() {}, projection() {} },
    queue: store,
    harnesses: { staticFeatures: () => STATIC },
  });
  const emit = (sessionId: string, event: RuntimeEvent) => {
    for (const listener of listeners) listener(sessionId, event);
  };
  const emitObservation = async (sessionId: string, event: RuntimeEvent, revision: string) => {
    const projection = await store.projection(sessionId);
    const binding = projection?.runtimeBinding;
    if (!binding) throw new Error("observation test requires a runtime binding");
    const reconciliation = await store.reconciliation(sessionId);
    if (!reconciliation) throw new Error("observation test requires an active reconciliation");
    const observation: RuntimeObservation = {
      channel: "sse",
      entityKey: revision,
      identity: {
        authorityId: binding.authorityId,
        generation: binding.generation,
        location: binding.location,
        backendSessionId: binding.backendSessionId,
        artifactKind: "turn",
        entityId: revision,
        revision,
      },
      reconciliationOrdinal: reconciliation.ordinal,
      events: [event],
    };
    for (const listener of observationListeners) listener(sessionId, observation);
  };
  return {
    store, sessions, runtime, commands, emit, emitObservation,
    ensureWiredCount: () => ensureWiredCount,
    forProjectCalls: () => forProjectCalls,
    createRuntimeCalls: () => createRuntimeCalls,
    patchProjectionCalls: () => patchProjectionCalls,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 30));

test("runtimeFeatures on idle unwired session does not call ensureWired", async () => {
  const { store, sessions, ensureWiredCount, forProjectCalls } = fixture();
  const sessionId = "00000000-0000-4000-8000-000000000001";
  await store.upsertProjection({
    id: sessionId,
    projectId: "p",
    title: "Idle",
    status: "idle",
    resolvedHarnessId: "fake",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const wiredCalls = ensureWiredCount();
  const projectCalls = forProjectCalls();
  const features = await sessions.runtimeFeatures!(sessionId);
  assert.equal(ensureWiredCount(), wiredCalls);
  assert.equal(forProjectCalls(), projectCalls);
  assert.equal(features.capabilities.title, "native");
  assert.deepEqual(features.commands, []);
});

test("100 context and command updates do not create durable rows or patchProjection writes", async () => {
  const { sessions, emit, store, patchProjectionCalls } = fixture();
  const created = await sessions.create({ projectId: "p" });
  await sessions.send(created.id, { text: "wire" });
  await flush();
  const before = (await store.events(created.id)).length;
  const patchesBefore = patchProjectionCalls();
  for (let i = 0; i < 100; i++) {
    emit(created.id, {
      type: "context/updated",
      source: "native",
      updatedAt: Date.now(),
      usedTokens: i,
      limitTokens: 1000,
    });
    emit(created.id, { type: "runtime/commands-changed", commands: [] });
  }
  assert.equal(patchProjectionCalls() - patchesBefore, 0);
  emit(created.id, {
    type: "usage/recorded",
    model: { providerID: "fake", modelID: "m" },
    tokens: { input: 1, output: 1 },
  });
  await flush();
  const after = (await store.events(created.id)).length;
  assert.equal(after - before, 1);
});

test("native command uses descriptor name not spoofed client name", async () => {
  const requests: CanonicalTurnRequest[] = [];
  const { sessions, runtime } = fixture({
    startTurn: async (request) => { requests.push(request); },
  });
  const created = await sessions.create({ projectId: "p" });
  await sessions.send(created.id, {
    text: "/spoofed args",
    command: { id: "native:fake:review", args: "args" },
  });
  assert.equal(requests[0]?.command?.name, "review");
  assert.equal(requests[0]?.text, "/review args");
});

test("malformed command object is rejected by parser", () => {
  assert.throws(() => parseTurnCommand({ id: "" }), (error: Error) => (error as { code?: string }).code === "invalid-input");
  assert.throws(() => parseTurnCommand({ id: "x", owner: "polyth" }), (error: Error) => (error as { code?: string }).code === "invalid-input");
  assert.equal(parseTurnCommand(undefined), undefined);
});

test("attachment support: image native, remote without materialize not emulated", () => {
  const support = effectiveAttachmentSupport(STATIC, ["input:image", "input:pdf"], true, false);
  assert.equal(support.image, "native");
  assert.equal(support.pdf, undefined);
  assert.equal(support.file, undefined);
});

test("output:image capability does not enable image input", () => {
  const support = effectiveAttachmentSupport(
    { ...STATIC, attachments: { modalities: { image: "native" } } },
    ["output:image"],
    false,
    false,
  );
  assert.equal(support.image, undefined);
});

test("attachmentModality classifies browser-context image separately from file", () => {
  assert.equal(attachmentModality({
    kind: "browser-context",
    browserContext: { screenshot: { localPath: "/tmp/x.png", mime: "image/png" } },
  }), "image");
  assert.equal(attachmentModality({ kind: "file", mime: "application/pdf", path: "x.pdf" }), "pdf");
});

test("command precedence prefers project over native", () => {
  const picked = commandPrecedence("go", [
    { name: "go", description: "", prompt: "", scope: "project" },
    { id: "native:x:go", name: "go", owner: "native", harnessId: "x", invocation: "raw-native-input" },
  ]);
  assert.equal((picked as { scope?: string }).scope, "project");
});

test("observation-path context and command updates apply without durable rows", async () => {
  const { sessions, emitObservation, store } = fixture();
  const created = await sessions.create({ projectId: "p" });
  await sessions.send(created.id, { text: "wire" });
  await flush();
  if (!await store.reconciliation(created.id)) await store.startReconciliation(created.id);
  const before = (await store.events(created.id)).length;
  await emitObservation(created.id, {
    type: "context/updated",
    source: "native",
    updatedAt: Date.now(),
    usedTokens: 80,
    limitTokens: 200,
  }, "obs-context-1");
  await emitObservation(created.id, {
    type: "runtime/commands-changed",
    commands: [{
      id: "native:fake:ship",
      name: "ship",
      owner: "native",
      harnessId: "fake",
      invocation: "raw-native-input",
    }],
  }, "obs-commands-1");
  await flush();
  assert.equal((await store.events(created.id)).length, before);
  const projection = await store.projection(created.id);
  assert.equal(projection?.contextWindow, undefined);
  const features = await sessions.runtimeFeatures!(created.id);
  assert.equal(features.contextWindow?.usedTokens, 80);
  assert.equal(features.contextWindow?.limitTokens, 200);
  assert.equal(features.commands[0]?.name, "ship");
});

test("wired command catalog ignores a previous harness generation", async () => {
  const { sessions, emitObservation, store } = fixture();
  const created = await sessions.create({ projectId: "p" });
  await sessions.send(created.id, { text: "wire" });
  await flush();
  if (!await store.reconciliation(created.id)) await store.startReconciliation(created.id);
  await emitObservation(created.id, {
    type: "runtime/commands-changed",
    commands: [{
      id: "native:fake:ship",
      name: "ship",
      owner: "native",
      harnessId: "fake",
      invocation: "raw-native-input",
    }],
  }, "obs-commands-gen");
  await flush();
  const projection = (await store.projection(created.id))!;
  await store.upsertProjection({
    ...projection,
    runtimeBinding: projection.runtimeBinding
      ? { ...projection.runtimeBinding, generation: 99 }
      : projection.runtimeBinding,
  });
  const features = await sessions.runtimeFeatures!(created.id);
  assert.equal(features.commands[0]?.name, "review");
});

test("context telemetry after a generation bump does not relabel the old command catalog", async () => {
  const { sessions, emit, store } = fixture();
  const created = await sessions.create({ projectId: "p" });
  await sessions.send(created.id, { text: "wire" });
  await flush();
  emit(created.id, {
    type: "runtime/commands-changed",
    commands: [{
      id: "native:fake:ship",
      name: "ship",
      owner: "native",
      harnessId: "fake",
      invocation: "raw-native-input",
    }],
  });
  await flush();
  const projection = (await store.projection(created.id))!;
  await store.upsertProjection({
    ...projection,
    runtimeBinding: projection.runtimeBinding
      ? { ...projection.runtimeBinding, generation: 99 }
      : projection.runtimeBinding,
  });
  emit(created.id, {
    type: "context/updated",
    source: "native",
    updatedAt: Date.now(),
    usedTokens: 1,
    limitTokens: 100,
  });
  await flush();
  const features = await sessions.runtimeFeatures!(created.id);
  assert.equal(features.commands[0]?.name, "review");
  assert.equal(features.commands.some((command) => command.name === "ship"), false);
});

test("in-place generation bump without unwire does not overlay stale live occupancy or command revision", async () => {
  const { sessions, emit, store } = fixture();
  const created = await sessions.create({ projectId: "p" });
  await sessions.send(created.id, { text: "wire" });
  await flush();
  emit(created.id, {
    type: "context/updated",
    source: "native",
    updatedAt: Date.now(),
    usedTokens: 42,
    limitTokens: 100,
    fraction: 0.42,
  });
  emit(created.id, {
    type: "runtime/commands-changed",
    commands: [{
      id: "native:fake:ship",
      name: "ship",
      owner: "native",
      harnessId: "fake",
      invocation: "raw-native-input",
    }],
  });
  await flush();
  const live = await sessions.snapshot!(created.id);
  assert.equal(live.contextWindow?.usedTokens, 42);
  assert.equal(live.nativeCommandsRevision, 1);

  const projection = (await store.projection(created.id))!;
  await store.upsertProjection({
    ...projection,
    runtimeBinding: projection.runtimeBinding
      ? { ...projection.runtimeBinding, generation: 99 }
      : projection.runtimeBinding,
  });
  const snapshot = await sessions.snapshot!(created.id);
  assert.equal(snapshot.contextWindow, undefined);
  assert.equal(snapshot.nativeCommandsRevision, undefined);
});

test("restart drops live occupancy overlay even when SQLite still holds stale contextWindow", async () => {
  const f = fixture();
  const created = await f.sessions.create({ projectId: "p" });
  await f.sessions.send(created.id, { text: "wire" });
  f.emit(created.id, {
    type: "context/updated",
    source: "native",
    updatedAt: Date.now(),
    usedTokens: 42,
    limitTokens: 100,
    fraction: 0.42,
  });
  await flush();
  const stale = (await f.store.projection(created.id))!;
  await f.store.upsertProjection({
    ...stale,
    contextWindow: {
      source: "native",
      updatedAt: Date.now(),
      usedTokens: 99,
      limitTokens: 100,
      fraction: 0.99,
    },
  });
  const projects = {
    get: async (id: string) => id === "p"
      ? { id: "p", name: "p", path: "/tmp", spaceId: "space", createdAt: 0 }
      : undefined,
    list: async () => [],
  };
  const restarted = createSessionService({
    store: f.store,
    projects,
    runtimes: { forProject: async () => f.runtime },
    permissions: { evaluate: () => "allow" } as unknown as PermissionService,
    broadcast: { event() {}, projection() {} },
    queue: f.store,
    harnesses: { staticFeatures: () => STATIC },
  });
  const snapshot = await restarted.snapshot!(created.id);
  assert.equal(snapshot.contextWindow, undefined);
  const features = await restarted.runtimeFeatures!(created.id);
  assert.equal(features.contextWindow, undefined);
});

test("unwire clears transient commands, context, and title fallback state", async () => {
  const f = fixture();
  const created = await f.sessions.create({ projectId: "p" });
  await f.sessions.send(created.id, { text: "Implement truthful fallback title", autoTitle: true });
  f.emit(created.id, { type: "turn/stopped", reason: "completed" });
  f.emit(created.id, {
    type: "context/updated",
    source: "native",
    updatedAt: Date.now(),
    usedTokens: 10,
    limitTokens: 100,
  });
  f.emit(created.id, {
    type: "runtime/commands-changed",
    commands: [{
      id: "native:fake:ship",
      name: "ship",
      owner: "native",
      harnessId: "fake",
      invocation: "raw-native-input",
    }],
  });
  await flush();
  await f.sessions.archive!(created.id);
  const features = await f.sessions.runtimeFeatures!(created.id);
  assert.deepEqual(features.commands, []);
  assert.equal(features.contextWindow, undefined);
});

test("send rejects a native command id removed from the refreshed catalog", async () => {
  const f = fixture();
  const created = await f.sessions.create({ projectId: "p" });
  await f.sessions.send(created.id, { text: "wire" });
  f.emit(created.id, { type: "turn/stopped", reason: "completed" });
  await flush();
  f.emit(created.id, {
    type: "runtime/commands-changed",
    commands: [],
  });
  await flush();
  await assert.rejects(
    f.sessions.send(created.id, {
      text: "/review",
      command: { id: "native:fake:review" },
    }),
    (error: Error & { code?: string }) => error.code === "unsupported",
  );
});

// The payload is deliberately model-blind: a session has no "next turn model"
// until the composer picks one, so the server publishes the harness support
// plus the `remote`/`materializeAvailable` policy and the composer intersects
// it with the selected model using the same shared rule. Baking one model's
// answer in here is what made the composer and the send path disagree.
test("runtimeFeatures attachmentSupport is harness-only, with the policy flags to narrow it", async () => {
  const f = fixture({
    models: async () => [
      {
        providerID: "fake",
        modelID: "vision",
        name: "vision",
        capabilities: ["input:text", "input:image", "output:text"],
      },
      {
        providerID: "fake",
        modelID: "text",
        name: "text",
        capabilities: ["input:text", "output:text"],
      },
    ],
  });
  const created = await f.sessions.create({ projectId: "p" });
  await f.sessions.send(created.id, { text: "wire", model: { providerID: "fake", modelID: "text" } });
  f.emit(created.id, { type: "turn/stopped", reason: "completed" });
  await flush();
  const features = await f.sessions.runtimeFeatures!(created.id);
  assert.equal(features.attachmentSupport.image, "native");
  assert.equal(features.attachmentSupport.pdf, "native");
  // Without these the client cannot reproduce the server's own decision.
  assert.equal(features.remote, false);
  assert.equal(typeof features.materializeAvailable, "boolean");
  // The shared rule, applied to the text-only model the turn actually used,
  // is what removes image support — on the client and at admission alike.
  assert.equal(
    "image" in effectiveAttachmentSupport(
      { ...features.capabilities, attachments: { modalities: features.attachmentSupport } },
      ["input:text", "output:text"],
      features.remote,
      features.materializeAvailable,
    ),
    false,
  );
});
