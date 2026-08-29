import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type {
  AgentRuntime,
  Project,
  ProjectService,
  RuntimeEndpoint,
  RuntimeEvent,
  RuntimeSnapshot,
  RuntimeSessionBinding,
  SessionService,
} from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import {
  activePinnedMessages,
  compactionRecoveryText,
  createStore,
  unrestoredCompactionSeq,
} from "@polyth/session";
import { contextRoutes } from "../src/routes/context.ts";
import { createSessionService, type Broadcaster } from "../src/sessions.ts";

type Emit = (sessionId: string, event: RuntimeEvent) => void;

function fakeRuntime() {
  const listeners = new Set<Emit>();
  const turns: Array<{ sessionId: string; text: string }> = [];
  const emit = (sessionId: string, event: RuntimeEvent) => {
    for (const listener of listeners) listener(sessionId, event);
  };
  const runtime: AgentRuntime = {
    capabilities: async () => ({
      streaming: true, permissions: true, questions: true, compaction: true, subagents: false,
    }),
    models: async () => [],
    agents: async () => [],
    ensureSession: async (input) => input.backendSessionId ?? `backend_${input.sessionId}`,
    sessions: async () => [],
    history: async () => [],
    startTurn: async (request) => {
      turns.push({ sessionId: request.sessionId, text: request.text });
      emit(request.sessionId, { type: "turn/started", turnId: `turn_${turns.length}` });
    },
    abort: async () => {},
    replyPermission: async () => {},
    replyQuestion: async () => {},
    onEvent(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    dispose: async () => {},
  };
  return { runtime, turns, emit };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 25));

test("next admitted turn restores active goal and pins once per compaction", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-compaction-"));
  const store = createStore(join(dir, "sessions.db"));
  const fake = fakeRuntime();
  const project: Project = { id: "p1", name: "P", path: dir, createdAt: 1 };
  const projects: ProjectService = {
    list: async () => [project],
    get: async (id) => id === project.id ? project : undefined,
    add: async () => project,
    create: async () => project,
    remove: async () => {},
  };
  const permissions = {
    evaluate: () => "allow",
    addRule: () => {},
    rules: () => [],
  } as unknown as PermissionService;
  const broadcast: Broadcaster = { event: () => {}, projection: () => {} };
  const sessions = createSessionService({
    store,
    projects,
    permissions,
    broadcast,
    runtimes: { forProject: async () => fake.runtime },
    hooks: {
      beforeTurn: async (_sessionId, events) => {
        const compactionSeq = unrestoredCompactionSeq(events);
        if (compactionSeq === null) return null;
        const pinned = activePinnedMessages(events);
        return {
          recoveryContext: compactionRecoveryText({
            compactionSeq,
            objective: "Ship compaction resilience",
            pinned,
          }),
          compactionSeq,
          goalRestored: true,
          pinnedSourceSeqs: pinned.map((item) => item.sourceEventSeq),
        };
      },
    },
  });

  try {
    const { id } = await sessions.create({ projectId: project.id });
    await sessions.send(id, { text: "Remember the API contract" });
    await flush();
    fake.emit(id, { type: "turn/stopped", reason: "completed" });
    await flush();
    const source = (await store.events(id)).find((event) => event.type === "user/message")!;
    await sessions.pinContext!(id, source.seq);

    fake.emit(id, {
      type: "compaction/part-recorded",
      partId: "part_compaction",
      messageId: "message_summary",
      auto: true,
    });
    fake.emit(id, { type: "session/compacted", backendEventId: "evt_compacted" });
    await flush();

    await sessions.send(id, { text: "Continue now" });
    await flush();
    assert.match(fake.turns[1]!.text, /Ship compaction resilience/);
    assert.match(fake.turns[1]!.text, /Remember the API contract/);
    assert.match(fake.turns[1]!.text, /\n\nContinue now$/);

    let events = await store.events(id);
    const recovered = events.filter((event) => event.type === "user/message")[1]!;
    assert.equal(
      (recovered.data as { text?: string }).text,
      "Continue now",
      "visible message text stays undecorated",
    );
    const compaction = events.find((event) => event.type === "session/compacted")!;
    assert.equal(
      (recovered.data as { compactionRecovery?: { compactionSeq?: number } })
        .compactionRecovery?.compactionSeq,
      compaction.seq,
    );
    assert.equal(events.filter((event) => event.type === "goal/context-restored").length, 1);
    assert.equal(events.filter((event) => event.type === "context/restored").length, 1);
    assert.equal(events.filter((event) => event.type === "compaction/part-recorded").length, 1);

    fake.emit(id, { type: "turn/stopped", reason: "completed" });
    await flush();
    await sessions.send(id, { text: "No duplicate" });
    await flush();
    assert.equal(fake.turns[2]!.text, "No duplicate");
    events = await store.events(id);
    assert.equal(events.filter((event) => event.type === "goal/context-restored").length, 1);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("context route delegates pin and unpin by source event sequence", async () => {
  const calls: string[] = [];
  const sessions = {
    pinContext: async (_sessionId: string, seq: number) => {
      calls.push(`pin:${seq}`);
      return { id: "e1", sessionId: "s1", seq: 4, time: 1, type: "context/pinned", data: { sourceEventSeq: seq }, v: 1 as const };
    },
    unpinContext: async (_sessionId: string, seq: number) => {
      calls.push(`unpin:${seq}`);
      return { id: "e2", sessionId: "s1", seq: 5, time: 2, type: "context/unpinned", data: { sourceEventSeq: seq }, v: 1 as const };
    },
  } as SessionService;
  const route = contextRoutes(sessions);
  let response: unknown;
  const base = {
    req: {} as never,
    res: {} as never,
    url: new URL("http://local"),
    body: async () => ({}),
    json: (_code: number, value: unknown) => { response = value; },
  };
  assert.equal(await route({ ...base, path: "/api/sessions/s1/context/pins/3", method: "POST" }), true);
  assert.equal((response as { type: string }).type, "context/pinned");
  assert.equal(await route({ ...base, path: "/api/sessions/s1/context/pins/3", method: "DELETE" }), true);
  assert.deepEqual(calls, ["pin:3", "unpin:3"]);
});

test("first turn in a fresh runtime epoch restores active goal and pins", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-epoch-context-"));
  const store = createStore(join(dir, "sessions.db"));
  const listeners = new Set<Emit>();
  const turns: string[] = [];
  let backendSessionId = "backend-old";
  let comparisonOrder = 0;
  let endpoint: RuntimeEndpoint = {
    authorityId: "owned:old",
    continuity: "verified",
    generation: 4,
    url: "http://runtime.invalid",
    location: { directory: dir },
    control: { kind: "owned", instanceToken: "old-instance" },
    config: { kind: "read-only" },
    authentication: { kind: "none" },
  };
  const runtime: AgentRuntime = {
    capabilities: async () => ({
      streaming: true, permissions: true, questions: true, compaction: true, subagents: false,
    }),
    models: async () => [],
    agents: async () => [],
    ensureSession: async (input) => input.backendSessionId ?? backendSessionId,
    sessions: async () => [],
    history: async () => [],
    startTurn: async (request) => {
      turns.push(request.text);
      for (const listener of listeners) {
        listener(request.sessionId, { type: "turn/started", turnId: `turn-${turns.length}` });
      }
    },
    abort: async () => undefined,
    replyPermission: async () => undefined,
    replyQuestion: async () => undefined,
    endpoint: async () => endpoint,
    protocol: async () => "legacy",
    reconcile: async (
      binding: RuntimeSessionBinding & { reconciliationOrdinal?: number },
    ): Promise<RuntimeSnapshot> => ({
      authorityId: binding.authorityId,
      generation: binding.generation,
      location: binding.location,
      backendSessionId: binding.backendSessionId!,
      reconciliationOrdinal: binding.reconciliationOrdinal ?? 1,
      state: {
        value: "idle",
        comparison: { domain: "epoch-context", order: ++comparisonOrder },
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
    onEvent(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    dispose: async () => undefined,
  };
  const project: Project = { id: "p-epoch", name: "Epoch", path: dir, createdAt: 1 };
  const sessions = createSessionService({
    store,
    projects: {
      list: async () => [project],
      get: async (id) => id === project.id ? project : undefined,
      add: async () => project,
      create: async () => project,
      remove: async () => undefined,
    },
    permissions: {
      evaluate: () => "allow",
      addRule: () => undefined,
      rules: () => [],
    } as unknown as PermissionService,
    broadcast: { event: () => undefined, projection: () => undefined },
    runtimes: { forProject: async () => runtime },
    hooks: {
      runtimeEpochContext: async (_sessionId, events) => ({
        objective: "Preserve the durable objective",
        pinned: activePinnedMessages(events),
      }),
    },
  });

  try {
    const created = await sessions.create({ projectId: project.id, title: "Epoch context" });
    await sessions.send(created.id, { text: "Remember this confirmed fact" });
    for (const listener of listeners) {
      listener(created.id, { type: "turn/stopped", reason: "completed" });
    }
    await flush();
    const source = (await store.events(created.id)).find((event) =>
      event.type === "user/message")!;
    await sessions.pinContext!(created.id, source.seq);
    await store.append(created.id, "goal/attached", {
      objective: "Preserve the durable objective",
      status: "active",
    });

    endpoint = {
      ...endpoint,
      authorityId: "owned:new",
      generation: 1,
      control: { kind: "owned", instanceToken: "new-instance" },
    };
    backendSessionId = "backend-new";
    const reset = await store.prepareOperation({
      sessionId: created.id,
      mutationKind: "session-reset",
      intentEvent: {
        type: "session/reset-intended",
        data: { reason: "runtime-epoch-rehydration" },
        ignorable: true,
      },
    });
    await store.claimOperation(reset.operation.operationId);
    await store.settleOperation(reset.operation.operationId, {
      kind: "confirmed",
      receipt: backendSessionId,
    });
    await sessions.transitionRuntimeEpoch(created.id, runtime, {
      resetOperationId: reset.operation.operationId,
      reason: "runtime storage was replaced",
      authorityDisposition: {
        kind: "owned-authority-destroyed",
        authorityId: "owned:old",
        generation: 4,
      },
    });

    await sessions.send(created.id, { text: "Continue after replacement" });
    assert.match(turns[1]!, /Preserve the durable objective/);
    assert.match(turns[1]!, /Remember this confirmed fact/);
    assert.match(turns[1]!, /\n\nContinue after replacement$/);
    const events = await store.events(created.id);
    const recovered = events.filter((event) => event.type === "user/message").at(-1)!;
    assert.equal((recovered.data as { text?: string }).text, "Continue after replacement");
    assert.equal(
      (recovered.data as { runtimeEpochRecovery?: { epoch?: number } })
        .runtimeEpochRecovery?.epoch,
      1,
    );
    assert.equal(events.filter((event) =>
      event.type === "goal/context-restored"
      && (event.data as { epoch?: number }).epoch === 1).length, 1);
    assert.equal(events.filter((event) =>
      event.type === "context/restored"
      && (event.data as { epoch?: number }).epoch === 1).length, 1);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a second runtime epoch never rehydrates an older fenced turn tail", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-repeated-epoch-context-"));
  const store = createStore(join(dir, "sessions.db"));
  const listeners = new Set<Emit>();
  const turns: string[] = [];
  let comparisonOrder = 0;
  let endpoint: RuntimeEndpoint = {
    authorityId: "owned:epoch-zero",
    continuity: "verified",
    generation: 1,
    url: "http://runtime.invalid/zero",
    location: { directory: dir },
    control: { kind: "owned", instanceToken: "epoch-zero" },
    config: { kind: "read-only" },
    authentication: { kind: "none" },
  };
  const emit = (sessionId: string, event: RuntimeEvent): void => {
    for (const listener of listeners) listener(sessionId, event);
  };
  const runtime: AgentRuntime = {
    capabilities: async () => ({
      streaming: true, permissions: true, questions: true, compaction: true, subagents: false,
    }),
    models: async () => [],
    agents: async () => [],
    createSessionOperation: async () => ({
      kind: "confirmed",
      value: { backendSessionId: "backend-zero" },
    }),
    ensureSession: async (input) => input.backendSessionId ?? "backend-zero",
    sessions: async () => [],
    history: async () => [],
    startTurn: async (request) => {
      turns.push(request.text);
      emit(request.sessionId, { type: "turn/started", turnId: `turn-${turns.length}` });
    },
    startTurnOperation: async (request) => {
      turns.push(request.text);
      emit(request.sessionId, { type: "turn/started", turnId: `turn-${turns.length}` });
      return { kind: "confirmed", value: {} };
    },
    abort: async () => undefined,
    replyPermission: async () => undefined,
    replyQuestion: async () => undefined,
    endpoint: async () => endpoint,
    protocol: async () => "legacy",
    reconcile: async (
      binding: RuntimeSessionBinding & { reconciliationOrdinal?: number },
    ): Promise<RuntimeSnapshot> => ({
      authorityId: binding.authorityId,
      generation: binding.generation,
      location: binding.location,
      backendSessionId: binding.backendSessionId!,
      reconciliationOrdinal: binding.reconciliationOrdinal ?? 1,
      state: {
        value: "idle",
        comparison: { domain: "repeated-epoch", order: ++comparisonOrder },
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
    onEvent(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    dispose: async () => undefined,
  };
  const project: Project = {
    id: "p-repeated-epoch",
    name: "Repeated epoch",
    path: dir,
    createdAt: 1,
  };
  const sessions = createSessionService({
    store,
    projects: {
      list: async () => [project],
      get: async (id) => id === project.id ? project : undefined,
      add: async () => project,
      create: async () => project,
      remove: async () => undefined,
    },
    permissions: {
      evaluate: () => "allow",
      addRule: () => undefined,
      rules: () => [],
    } as unknown as PermissionService,
    broadcast: { event: () => undefined, projection: () => undefined },
    runtimes: { forProject: async () => runtime },
  });
  const replaceEpoch = async (
    sessionId: string,
    oldAuthorityId: string,
    oldGeneration: number,
    newAuthorityId: string,
    backendSessionId: string,
  ): Promise<void> => {
    endpoint = {
      ...endpoint,
      authorityId: newAuthorityId,
      generation: 1,
      url: `http://runtime.invalid/${newAuthorityId}`,
      control: { kind: "owned", instanceToken: newAuthorityId },
    };
    const reset = await store.prepareOperation({
      sessionId,
      mutationKind: "session-reset",
      intentEvent: {
        type: "session/reset-intended",
        data: { reason: "runtime-epoch-rehydration" },
        ignorable: true,
      },
    });
    await store.claimOperation(reset.operation.operationId);
    await store.settleOperation(reset.operation.operationId, {
      kind: "confirmed",
      receipt: backendSessionId,
    });
    await sessions.transitionRuntimeEpoch(sessionId, runtime, {
      resetOperationId: reset.operation.operationId,
      reason: "test repeated runtime replacement",
      authorityDisposition: {
        kind: "owned-authority-destroyed",
        authorityId: oldAuthorityId,
        generation: oldGeneration,
      },
    });
  };

  try {
    const created = await sessions.create({
      projectId: project.id,
      title: "Repeated epoch context",
    });
    await sessions.send(created.id, { text: "confirmed before uncertainty" });
    emit(created.id, { type: "turn/stopped", reason: "completed" });
    await flush();

    const uncertain = await store.prepareOperation({
      sessionId: created.id,
      mutationKind: "turn-submit",
      intentEvent: {
        type: "user/message",
        data: { text: "uncertain request" },
      },
    });
    await store.claimOperation(uncertain.operation.operationId);
    await store.settleOperation(uncertain.operation.operationId, {
      kind: "unknown",
      message: "runtime disappeared after admission",
    });
    await store.append(created.id, "assistant/message", {
      partId: "untrusted-partial",
      text: "UNTRUSTED PARTIAL FROM FENCED TURN",
    });

    await replaceEpoch(
      created.id,
      "owned:epoch-zero",
      1,
      "owned:epoch-one",
      "backend-one",
    );
    await sessions.send(created.id, { text: "safe after first replacement" });
    assert.doesNotMatch(turns[1]!, /UNTRUSTED PARTIAL/);
    emit(created.id, { type: "turn/stopped", reason: "completed" });
    await flush();

    await replaceEpoch(
      created.id,
      "owned:epoch-one",
      1,
      "owned:epoch-two",
      "backend-two",
    );
    await sessions.send(created.id, { text: "safe after second replacement" });
    assert.match(turns[2]!, /confirmed before uncertainty/);
    assert.match(turns[2]!, /safe after first replacement/);
    assert.doesNotMatch(
      turns[2]!,
      /UNTRUSTED PARTIAL/,
      "a fenced prior-epoch tail must not reappear after a later runtime loss",
    );
    emit(created.id, { type: "turn/stopped", reason: "completed" });
    await flush();
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
