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

function fixture(overrides?: Partial<AgentRuntime>, pool?: {
  idleSessionRuntimes?: Partial<import("../src/sessions.ts").IdleSessionRuntimePolicy>;
  retireSession?: (sessionId: string) => Promise<void>;
  isSessionScoped?: (sessionId: string) => boolean;
}) {
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
      ...(pool?.retireSession ? { retireSession: pool.retireSession, isSessionScoped: pool.isSessionScoped ?? (() => true) } : {}),
    },
    permissions: { evaluate: () => "allow" } as unknown as PermissionService,
    broadcast: { event() {}, projection() {} },
    queue: store,
    harnesses: { staticFeatures: () => STATIC },
    ...(pool?.idleSessionRuntimes ? { idleSessionRuntimes: pool.idleSessionRuntimes } : {}),
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
  // Usage is turn content, so the session needs the turn the send admitted.
  emit(created.id, { type: "turn/started", turnId: "turn-wire" });
  await flush();
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
  assert.equal(after - before, 2, "the turn marker and its usage sample are the only durable rows");
});

test("native command uses descriptor name not spoofed client name", async () => {
  const requests: CanonicalTurnRequest[] = [];
  const { sessions } = fixture({
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

test("session teardown cancels pending title fallback before the store closes", async () => {
  // A native-title harness that has not named the session yet keeps a bounded
  // retry pending (first retry after 1 s). Those timers are unref'd, so check
  // the behavior: after teardown the retry never reaches the harness again.
  let titleReads = 0;
  const f = fixture({
    capabilities: async () => ({ ...STATIC, title: "native" }),
    sessions: async () => { titleReads++; return []; },
  });
  const { id } = await f.sessions.create({ projectId: "p" });

  await f.sessions.send(id, { text: "Implement truthful fallback title", autoTitle: true });
  await flush();
  assert.equal(titleReads, 1, "automatic-title work starts with one native read");

  f.sessions.dispose();
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  assert.equal(titleReads, 1, "session teardown must cancel the pending title retry");
  await f.store.close();
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

test("a harness prompt suggestion is a live, non-durable projection hint that the next prompt spends", async () => {
  const { sessions, emit, emitObservation, store } = fixture();
  const created = await sessions.create({ projectId: "p" });
  await sessions.send(created.id, { text: "wire" });
  await flush();
  const before = (await store.events(created.id)).length;
  emit(created.id, { type: "runtime/prompt-suggestion", suggestion: "  Add tests for the parser  " });
  await flush();
  assert.equal((await store.events(created.id)).length, before, "a suggestion never becomes history");
  assert.equal((await store.projection(created.id))?.promptSuggestion, undefined, "the stored row never carries it");
  assert.equal((await sessions.snapshot(created.id))?.promptSuggestion, "Add tests for the parser");

  emit(created.id, { type: "runtime/prompt-suggestion", suggestion: "   " });
  await flush();
  assert.equal((await sessions.snapshot(created.id))?.promptSuggestion, "Add tests for the parser", "a blank hint changes nothing");

  await sessions.send(created.id, { text: "next" });
  await flush();
  assert.equal((await sessions.snapshot(created.id))?.promptSuggestion, undefined, "sending spends the suggestion");

  if (!await store.reconciliation(created.id)) await store.startReconciliation(created.id);
  await emitObservation(created.id, { type: "runtime/prompt-suggestion", suggestion: "Ship it" }, "obs-suggestion-1");
  await flush();
  assert.equal((await sessions.snapshot(created.id))?.promptSuggestion, "Ship it", "the observation path applies it too");
  emit(created.id, { type: "turn/started", turnId: "turn-later" });
  await flush();
  assert.equal((await sessions.snapshot(created.id))?.promptSuggestion, undefined, "a starting turn clears it");
});

test("a harness prompt suggestion outlives the idle runtime's release; a rewind spends it", async () => {
  const retired: string[] = [];
  let releasable = false;
  const { sessions, emit, store } = fixture(undefined, {
    idleSessionRuntimes: { sweepMs: 10, minIdleMs: 0, ttlMs: 0, maxIdle: 0 },
    retireSession: async (sessionId) => { retired.push(sessionId); },
    isSessionScoped: () => releasable,
  });
  try {
    const created = await sessions.create({ projectId: "p" });
    await sessions.send(created.id, { text: "wire" });
    await flush();
    emit(created.id, { type: "runtime/prompt-suggestion", suggestion: "Add tests for the parser" });
    await flush();
    assert.equal((await sessions.snapshot(created.id))?.promptSuggestion, "Add tests for the parser");

    // The person comes back after the pool released the idle chat's runtime.
    releasable = true;
    for (let i = 0; i < 100 && !retired.includes(created.id); i += 1) await flush();
    assert.ok(retired.includes(created.id), "the idle runtime was released");
    assert.equal((await sessions.snapshot(created.id))?.promptSuggestion, "Add tests for the parser",
      "the hint describes the conversation, not the released leg");

    const prompt = (await store.events(created.id)).find((event) => event.type === "user/message");
    assert.ok(prompt);
    await sessions.rewind!(created.id, prompt.seq);
    assert.equal((await sessions.snapshot(created.id))?.promptSuggestion, undefined, "a rewind removes the reply it guessed after");
  } finally {
    sessions.dispose?.();
  }
});

test("opening a quiet idle chat starts no runtime; a warm, or work that needs one, does", async () => {
  const { store, sessions, ensureWiredCount } = fixture(undefined, {
    idleSessionRuntimes: { sweepMs: 0 },
    retireSession: async () => {},
  });
  try {
    const quiet = await sessions.create({ projectId: "p" });
    const queued = await sessions.create({ projectId: "p" });
    const legacy = await sessions.create({ projectId: "p" });
    // Dormant chats, as the idle sweep leaves them.
    for (const id of [quiet.id, queued.id, legacy.id]) {
      assert.deepEqual(await sessions.releaseRuntimeIfIdle!(id), { released: true });
      assert.equal((await sessions.debug!(id)).runtime.attached, false);
    }
    await store.enqueue(queued.id, "next step", "queue");

    const before = ensureWiredCount();
    await sessions.activate!(quiet.id, { intent: "open" });
    assert.equal(ensureWiredCount(), before, "reading a quiet chat wires nothing");
    assert.equal((await sessions.debug!(quiet.id)).runtime.attached, false);

    await sessions.activate!(quiet.id, { intent: "warm" });
    assert.equal((await sessions.debug!(quiet.id)).runtime.attached, true, "a warm starts the runtime");

    await sessions.activate!(queued.id, { intent: "open" });
    assert.equal((await sessions.debug!(queued.id)).runtime.attached, true, "a queued prompt needs the runtime even on open");

    await sessions.activate!(legacy.id);
    assert.equal((await sessions.debug!(legacy.id)).runtime.attached, true, "an activation without an intent still warms");
  } finally {
    sessions.dispose?.();
  }
});

test("a runtime that ran no turn idles out on the short unused age; one that ran a turn keeps the ordinary floor", async () => {
  const retired: string[] = [];
  let releasable = false;
  const { sessions } = fixture(undefined, {
    idleSessionRuntimes: { sweepMs: 10, minIdleMs: 3_600_000, ttlMs: 7_200_000, maxIdle: 6, unusedIdleMs: 0 },
    retireSession: async (sessionId) => { retired.push(sessionId); },
    isSessionScoped: () => releasable,
  });
  try {
    const warmed = await sessions.create({ projectId: "p" });
    const used = await sessions.create({ projectId: "p" });
    await sessions.activate!(warmed.id, { intent: "warm" });
    await sessions.send(used.id, { text: "run a turn" });
    await flush();
    assert.equal((await sessions.debug!(warmed.id)).runtime.attached, true);
    assert.equal((await sessions.debug!(used.id)).runtime.attached, true);

    releasable = true;
    for (let i = 0; i < 100 && !retired.includes(warmed.id); i += 1) await flush();
    assert.deepEqual(retired, [warmed.id], "the warmed-but-unused runtime is released despite the 1 h floor");
    for (let i = 0; i < 5; i += 1) await flush();
    assert.deepEqual(retired, [warmed.id], "a runtime that ran a turn stays under the ordinary floor");
    assert.equal((await sessions.debug!(used.id)).runtime.attached, true);

    // Warming the released chat again wires a fresh runtime that is unused
    // until a turn runs; a turn on it moves it to the ordinary rules.
    releasable = false;
    await sessions.send(warmed.id, { text: "now a turn" });
    await flush();
    releasable = true;
    for (let i = 0; i < 5; i += 1) await flush();
    assert.deepEqual(retired, [warmed.id], "after its first turn the runtime is no longer released early");
  } finally {
    sessions.dispose?.();
  }
});

test("a runtime wake request becomes one hidden, idempotent turn", async () => {
  const prompts: string[] = [];
  const { sessions, emit, emitObservation, store } = fixture({
    async startTurn(request) {
      prompts.push(request.text);
      emit(request.sessionId, { type: "turn/started", turnId: `turn-${prompts.length}` });
      emit(request.sessionId, { type: "turn/stopped", turnId: `turn-${prompts.length}`, reason: "completed" });
    },
  });
  const created = await sessions.create({ projectId: "p" });
  await sessions.send(created.id, { text: "start background tests" });
  await flush();
  const text = "A background task you started has finished while no turn was running.\nTask: b66";
  emit(created.id, { type: "runtime/wake-requested", wakeId: "note-1", reason: "background-task", text });
  await flush();
  // The same notification again — a replayed observation — admits nothing new.
  emit(created.id, { type: "runtime/wake-requested", wakeId: "note-1", reason: "background-task", text });
  if (!await store.reconciliation(created.id)) await store.startReconciliation(created.id);
  await emitObservation(created.id, { type: "runtime/wake-requested", wakeId: "note-1", reason: "background-task", text }, "obs-wake-1");
  await flush();

  assert.equal(prompts.filter((prompt) => prompt.includes("Task: b66")).length, 1);
  const events = await store.events(created.id);
  assert.equal(events.some((event) => event.type === "runtime/wake-requested"), false, "the request itself is never a canonical row");
  const woken = events.filter((event) => event.type === "user/message"
    && String((event.data as { text?: unknown }).text).includes("Task: b66"));
  assert.equal(woken.length, 1);
  assert.equal((woken[0]!.data as { hiddenUserMessage?: unknown }).hiddenUserMessage, true);
});
