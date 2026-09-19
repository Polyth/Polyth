import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
  AgentRuntime,
  DurableOperationState,
  Project,
  ProjectService,
  RuntimeEndpoint,
  RuntimeEvent,
  RuntimeSessionBinding,
  RuntimeSnapshot,
  SessionProjection,
} from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import { createStore } from "@polyth/session";

import {
  acquireDataDirectoryLease,
  createRuntimeAdmissionBarrier,
  createRuntimeProtocolForwarder,
  openCodeRemoteRuntimeId,
  openCodeRuntimeId,
} from "../src/index.ts";
import { createOpenCodePendingService } from "../src/opencodePending.ts";
import {
  createRuntimeIdleController,
  OPEN_CODE_RUNTIME_IDLE_TTL_MS,
} from "../src/runtimeIdle.ts";
import {
  createSessionService,
  type Broadcaster,
  type RuntimePool,
} from "../src/sessions.ts";
import { settleAllOrThrow } from "../src/settle.ts";

test("runtime storage identity separates projects and resolved worktrees", () => {
  assert.equal(openCodeRuntimeId("project-a", "/workspace/./tree"), openCodeRuntimeId("project-a", "/workspace/tree"));
  assert.notEqual(openCodeRuntimeId("project-a", "/workspace/tree"), openCodeRuntimeId("project-b", "/workspace/tree"));
  assert.notEqual(openCodeRuntimeId("project-a", "/workspace/tree-a"), openCodeRuntimeId("project-a", "/workspace/tree-b"));
  assert.match(openCodeRuntimeId("project-a", "/workspace/tree"), /^[a-f0-9]{24}$/);
});

test("remote runtime identity separates connections, projects, and POSIX worktrees", () => {
  assert.equal(
    openCodeRemoteRuntimeId("connection-a", "project-a", "/srv/./tree"),
    openCodeRemoteRuntimeId("connection-a", "project-a", "/srv/tree"),
  );
  assert.notEqual(
    openCodeRemoteRuntimeId("connection-a", "project-a", "/srv/tree"),
    openCodeRemoteRuntimeId("connection-b", "project-a", "/srv/tree"),
  );
  assert.notEqual(
    openCodeRemoteRuntimeId("connection-a", "project-a", "/srv/tree"),
    openCodeRemoteRuntimeId("connection-a", "project-b", "/srv/tree"),
  );
  assert.notEqual(
    openCodeRemoteRuntimeId("connection-a", "project-a", "/srv/tree-a"),
    openCodeRemoteRuntimeId("connection-a", "project-a", "/srv/tree-b"),
  );
  assert.match(
    openCodeRemoteRuntimeId("connection-a", "project-a", "/srv/tree"),
    /^[a-f0-9]{24}$/,
  );
});

test("canonical data directory lease fails closed for a second writer", async () => {
  const parent = mkdtempSync(join(tmpdir(), "polyth-writer-lease-"));
  const dataDir = join(parent, "data");
  const first = await acquireDataDirectoryLease(dataDir);
  try {
    await assert.rejects(
      () => acquireDataDirectoryLease(dataDir),
      (error: Error & { code?: string }) =>
        error.code === "data-directory-locked"
        && /already owns data directory/.test(error.message),
    );
  } finally {
    await first.release();
  }

  const afterRelease = await acquireDataDirectoryLease(dataDir);
  await afterRelease.release();
});

test("data directory lease does not depend on an external OS lock helper", async () => {
  const parent = mkdtempSync(join(tmpdir(), "polyth-portable-lease-"));
  const originalExecPath = process.execPath;
  process.execPath = join(parent, "definitely-missing-runtime");
  try {
    const lease = await acquireDataDirectoryLease(join(parent, "data"));
    await lease.release();
  } finally {
    process.execPath = originalExecPath;
  }
});

test("stable runtime facade forwards protocol identity across replacements", async () => {
  let current = {
    protocol: async () => "v2" as const,
  } as never;
  const protocol = createRuntimeProtocolForwarder(() => current);

  assert.equal(await protocol(), "v2");
  current = {
    lifecycle: { protocol: async () => "legacy" as const },
  } as never;
  assert.equal(await protocol(), "legacy");

  current = {} as never;
  await assert.rejects(
    () => protocol(),
    (error: Error & { code?: string }) => error.code === "unsupported",
  );
});

test("busy runtime defers config apply and keeps the restart batch pending", async () => {
  let safe = false;
  let applied = 0;
  let restarted = 0;
  const pending = createOpenCodePendingService({
    canRestart: async () => safe
      ? { safe: true }
      : { safe: false, reason: "session session-1 is working" },
    restart: async () => {
      restarted += 1;
      return 1;
    },
  });
  pending.stage({
    id: "mcp",
    kind: "mcp",
    label: "MCP servers",
    apply: async () => {
      applied += 1;
    },
  });

  await assert.rejects(
    () => pending.applyAndRestart(),
    (error: Error & { code?: string }) => error.code === "restart-deferred",
  );
  assert.equal(applied, 0);
  assert.equal(restarted, 0);
  assert.equal(pending.list().count, 1);

  safe = true;
  assert.deepEqual(await pending.applyAndRestart(), { applied: 1, restarted: 1 });
  assert.equal(applied, 1);
  assert.equal(restarted, 1);
  assert.equal(pending.list().count, 0);
});

test("config safety check fences a racing admission through write and restart", async () => {
  const barrier = createRuntimeAdmissionBarrier();
  let releaseSafety!: () => void;
  let safetyStarted!: () => void;
  const safetyEntered = new Promise<void>((resolve) => {
    safetyStarted = resolve;
  });
  const safetyRelease = new Promise<void>((resolve) => {
    releaseSafety = resolve;
  });
  const order: string[] = [];
  const pending = createOpenCodePendingService({
    withAdmissionBarrier: (action) => barrier.run(action),
    canRestart: async () => {
      order.push("safety");
      safetyStarted();
      await safetyRelease;
      return { safe: true };
    },
    restart: async () => {
      order.push("restart");
      return 1;
    },
  });
  pending.stage({
    id: "mcp",
    kind: "mcp",
    label: "MCP servers",
    apply: async () => {
      order.push("write");
    },
  });

  const applying = pending.applyAndRestart();
  await safetyEntered;
  assert.equal(barrier.fenced(), true);
  await assert.rejects(
    () => barrier.admit(async () => {
      order.push("admission");
    }),
    (error: Error & { code?: string }) => error.code === "restart-deferred",
  );
  releaseSafety();

  assert.deepEqual(await applying, { applied: 1, restarted: 1 });
  assert.deepEqual(order, ["safety", "write", "restart"]);
  assert.equal(barrier.fenced(), false);
});

test("shutdown drain fences new admissions until active turns stop", async () => {
  const barrier = createRuntimeAdmissionBarrier();
  barrier.trackTurn("session-1", true);
  let stopped = false;

  const draining = barrier.drain(async () => { stopped = true; });
  await Promise.resolve();

  assert.equal(barrier.fenced(), true);
  assert.equal(stopped, false);
  await assert.rejects(
    () => barrier.admit(async () => {}),
    (error: Error & { code?: string }) => error.code === "restart-deferred",
  );

  barrier.trackTurn("session-1", false);
  await draining;
  assert.equal(stopped, true);
  assert.equal(barrier.fenced(), false);
});

test("failed restart batch waits for every owned replacement to settle", async () => {
  let releaseSlow!: () => void;
  let slowSettled = false;
  let failureReturned = false;
  const slow = new Promise<void>((resolve) => {
    releaseSlow = () => {
      slowSettled = true;
      resolve();
    };
  });
  const failure = Object.assign(new Error("second owned restart failed"), {
    code: "restart-deferred",
  });
  const pending = createOpenCodePendingService({
    restart: async () => {
      await settleAllOrThrow([
        slow,
        Promise.reject(failure),
      ]);
      return 2;
    },
  });
  pending.stage({
    id: "mcp",
    kind: "mcp",
    label: "MCP servers",
    apply: async () => {},
  });
  const applying = pending.applyAndRestart().catch((error) => {
    failureReturned = true;
    throw error;
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    failureReturned,
    false,
    "the replacement interlock must not unwind around a still-running restart",
  );
  assert.equal(pending.list().count, 1);
  releaseSlow();
  await assert.rejects(applying, (error: Error) => error === failure);
  assert.equal(slowSettled, true);
  assert.equal(failureReturned, true);
  assert.equal(pending.list().count, 1, "failed replacement proof must keep the batch pending");
});

test("unproven generation drift fails closed and keeps the captured restart batch pending", async () => {
  let generation = 1;
  let applied = false;
  let destructiveRestarts = 0;
  const pending = createOpenCodePendingService({
    captureRestartState: async () => {
      assert.equal(applied, false, "restart intent must be captured before config writes");
      return generation;
    },
    restart: async (captured) => {
      if (generation !== captured) {
        throw Object.assign(
          new Error("generation changed without loaded-config proof"),
          { code: "restart-deferred" },
        );
      }
      destructiveRestarts += 1;
      return 1;
    },
  });
  pending.stage({
    id: "provider-visibility",
    kind: "provider-visibility",
    label: "Provider visibility",
    apply: async () => {
      applied = true;
      // This models an implementation that failed to establish the lifecycle
      // replacement interlock before applying the batch.
      generation += 1;
    },
  });

  await assert.rejects(
    () => pending.applyAndRestart(),
    (error: Error & { code?: string }) => error.code === "restart-deferred",
  );
  assert.equal(generation, 2);
  assert.equal(destructiveRestarts, 0);
  assert.equal(pending.list().count, 1);
});

const noTimer = () => ({ dispose: () => undefined });

test("idle runtime controller uses an internal ten-minute TTL", () => {
  assert.equal(OPEN_CODE_RUNTIME_IDLE_TTL_MS, 10 * 60_000);
});

test("runtime activity racing an idle safety check prevents eviction", async () => {
  let now = 0;
  let releaseSafety!: () => void;
  let safetyStarted!: () => void;
  let releaseTurn!: () => void;
  const safetyEntered = new Promise<void>((resolve) => { safetyStarted = resolve; });
  const safetyRelease = new Promise<void>((resolve) => { releaseSafety = resolve; });
  const turnRelease = new Promise<void>((resolve) => { releaseTurn = resolve; });
  let evictions = 0;
  const controller = createRuntimeIdleController({
    now: () => now,
    schedule: noTimer,
    withAdmissionBarrier: (action) => action(),
    canEvict: async () => {
      safetyStarted();
      await safetyRelease;
      return true;
    },
    evict: async () => { evictions += 1; },
  });

  now = OPEN_CODE_RUNTIME_IDLE_TTL_MS;
  const idleAttempt = controller.attemptEviction();
  await safetyEntered;
  const activeTurn = controller.use(async () => {
    await turnRelease;
  });
  releaseSafety();
  assert.equal(await idleAttempt, false);
  assert.equal(evictions, 0, "the timer must not kill the racing turn");
  releaseTurn();
  await activeTurn;
  now += OPEN_CODE_RUNTIME_IDLE_TTL_MS;
  assert.equal(await controller.attemptEviction(), true);
  assert.equal(evictions, 1);
});

test("idle eviction is process-only and leaves the OpenCode DB cache in place", async () => {
  const directory = mkdtempSync(join(tmpdir(), "polyth-idle-process-only-"));
  const database = join(directory, "opencode.db");
  writeFileSync(database, "warm continuation cache");
  let now = 0;
  let stoppedProcesses = 0;
  const controller = createRuntimeIdleController({
    now: () => now,
    schedule: noTimer,
    withAdmissionBarrier: (action) => action(),
    canEvict: async () => true,
    evict: async () => { stoppedProcesses += 1; },
  });

  now = OPEN_CODE_RUNTIME_IDLE_TTL_MS;
  assert.equal(await controller.attemptEviction(), true);
  assert.equal(stoppedProcesses, 1);
  assert.equal(existsSync(database), true);
  assert.equal(readFileSync(database, "utf8"), "warm continuation cache");
  now += OPEN_CODE_RUNTIME_IDLE_TTL_MS;
  assert.equal(await controller.attemptEviction(), false);
});

const endpointFor = (directory: string, generation = 1): RuntimeEndpoint => ({
  authorityId: "owned:test-authority",
  continuity: "verified",
  generation,
  url: `http://runtime.invalid/${generation}`,
  location: { directory },
  control: { kind: "owned", instanceToken: `instance-${generation}` },
  config: { kind: "read-only" },
  authentication: { kind: "none" },
});

const runtimeFor = (endpoint: RuntimeEndpoint) => {
  const listeners = new Set<(sessionId: string, event: RuntimeEvent) => void>();
  const snapshot = (
    binding: RuntimeSessionBinding & { reconciliationOrdinal?: number },
  ): RuntimeSnapshot => ({
    authorityId: endpoint.authorityId,
    generation: endpoint.generation,
    location: endpoint.location,
    backendSessionId: binding.backendSessionId!,
    reconciliationOrdinal: binding.reconciliationOrdinal ?? 1,
    state: {
      value: "idle",
      watermark: `idle-${endpoint.generation}`,
      comparison: { domain: "test-runtime", order: endpoint.generation },
    },
    completeness: {
      events: "complete",
      permissions: "complete",
      questions: "complete",
    },
    permissions: [],
    questions: [],
    events: [],
  });
  const runtime: AgentRuntime = {
    capabilities: async () => ({
      streaming: true,
      permissions: true,
      questions: true,
      compaction: false,
      subagents: false,
    }),
    models: async () => [],
    agents: async () => [],
    sessions: async () => [],
    history: async () => [],
    ensureSession: async (input) => input.backendSessionId ?? `backend-${input.sessionId}`,
    startTurn: async () => undefined,
    startTurnOperation: async () => ({ kind: "confirmed", value: {} }),
    abort: async () => undefined,
    replyPermission: async () => undefined,
    replyQuestion: async () => undefined,
    endpoint: async () => endpoint,
    protocol: async () => "legacy",
    reconcile: async (binding) => snapshot(binding),
    onEvent(callback) {
      listeners.add(callback);
      return { dispose: () => { listeners.delete(callback); } };
    },
    dispose: async () => undefined,
  };
  return {
    runtime,
    emit(sessionId: string, event: RuntimeEvent) {
      for (const listener of listeners) listener(sessionId, event);
    },
  };
};

const waitFor = async (condition: () => boolean | Promise<boolean>): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was not reached");
};

const lifecycleHarness = async () => {
  const directory = mkdtempSync(join(tmpdir(), "polyth-idle-safety-"));
  const project: Project = {
    id: "project-idle",
    name: "Idle project",
    path: directory,
    createdAt: 1,
  };
  const endpoint = endpointFor(directory);
  const fake = runtimeFor(endpoint);
  const store = createStore(join(directory, "sessions.db"));
  const evictionListeners = new Set<(runtime: AgentRuntime) => void | Promise<void>>();
  let currentRuntime = fake.runtime;
  const pool: RuntimePool = {
    forProject: async () => currentRuntime,
    onEvict(listener) {
      evictionListeners.add(listener);
      return { dispose: () => { evictionListeners.delete(listener); } };
    },
  };
  const projects: ProjectService = {
    list: async () => [project],
    get: async (id) => id === project.id ? project : undefined,
    add: async () => project,
    create: async () => project,
    remove: async () => undefined,
  };
  const permissions = {
    evaluate: () => "ask",
    addRule: () => undefined,
    rules: () => [],
  } as unknown as PermissionService;
  const broadcast: Broadcaster = {
    event: () => undefined,
    projection: () => undefined,
  };
  const sessions = createSessionService({
    store,
    projects,
    permissions,
    broadcast,
    queue: store,
    runtimes: pool,
  });
  const projection: SessionProjection = {
    id: "session-idle",
    projectId: project.id,
    backendSessionId: "backend-idle",
    runtimeBinding: {
      backendSessionId: "backend-idle",
      authorityId: endpoint.authorityId,
      generation: endpoint.generation,
      continuity: endpoint.continuity,
      protocol: "legacy",
      location: endpoint.location,
    },
    title: "Idle session",
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
  };
  await store.upsertProjection(projection);
  await sessions.events(projection.id, 0);
  return {
    directory,
    endpoint,
    fake,
    store,
    sessions,
    projection,
    replaceRuntime(runtime: AgentRuntime) {
      currentRuntime = runtime;
    },
    async notifyEvicted(runtime = fake.runtime) {
      await Promise.all([...evictionListeners].map(async (listener) => listener(runtime)));
    },
  };
};

test("runtime eviction is blocked by active/admitting turns", async () => {
  const harness = await lifecycleHarness();
  try {
    harness.fake.emit(harness.projection.id, { type: "turn/started", turnId: "turn-live" });
    await waitFor(async () => (await harness.store.projection(harness.projection.id))?.status === "working");
    const safety = await harness.sessions.canEvictRuntime(
      harness.fake.runtime,
      harness.fake.runtime,
      harness.endpoint,
      [],
    );
    assert.equal(safety.safe, false);
    assert.match(safety.safe ? "" : safety.reason, /active or admitting turn/);
  } finally {
    await harness.store.close();
  }
});

for (const state of ["prepared", "executing", "unknown"] as const satisfies readonly DurableOperationState[]) {
  test(`runtime eviction is blocked by a ${state} operation`, async () => {
    const harness = await lifecycleHarness();
    try {
      const prepared = await harness.store.prepareOperation({
        sessionId: harness.projection.id,
        mutationKind: "turn-submit",
        intentEvent: { type: "user/message", data: { text: state } },
      });
      if (state === "executing" || state === "unknown") {
        const claimed = await harness.store.claimOperation(prepared.operation.operationId);
        assert.equal(claimed.kind, "claimed");
      }
      if (state === "unknown") {
        await harness.store.settleOperation(prepared.operation.operationId, {
          kind: "unknown",
          message: "outcome unavailable",
        });
      }
      const safety = await harness.sessions.canEvictRuntime(
        harness.fake.runtime,
        harness.fake.runtime,
        harness.endpoint,
        [],
      );
      assert.equal(safety.safe, false);
      assert.match(safety.safe ? "" : safety.reason, new RegExp(state));
    } finally {
      await harness.store.close();
    }
  });
}

test("runtime eviction is blocked by an open permission/question/secret request", async () => {
  for (const [type, data] of [
    ["permission/requested", { requestId: "permission-1", permission: "edit", patterns: [] }],
    ["question/asked", { requestId: "question-1", questions: [] }],
    ["secret/requested", { requestId: "secret-1", handle: "token", label: "Token" }],
  ] as const) {
    const harness = await lifecycleHarness();
    try {
      await harness.store.append(harness.projection.id, type, data);
      const safety = await harness.sessions.canEvictRuntime(
        harness.fake.runtime,
        harness.fake.runtime,
        harness.endpoint,
        [],
      );
      assert.equal(safety.safe, false, type);
      assert.match(safety.safe ? "" : safety.reason, /open runtime request/);
    } finally {
      await harness.store.close();
    }
  }
});

test("runtime eviction is blocked by a queued message and a live stream", async () => {
  const queued = await lifecycleHarness();
  try {
    await queued.store.enqueue(queued.projection.id, "wait", "queue");
    const safety = await queued.sessions.canEvictRuntime(
      queued.fake.runtime,
      queued.fake.runtime,
      queued.endpoint,
      [],
    );
    assert.equal(safety.safe, false);
    assert.match(safety.safe ? "" : safety.reason, /queued message/);
  } finally {
    await queued.store.close();
  }

  const streamed = await lifecycleHarness();
  try {
    const safety = await streamed.sessions.canEvictRuntime(
      streamed.fake.runtime,
      streamed.fake.runtime,
      streamed.endpoint,
      ["oneshot-active"],
    );
    assert.equal(safety.safe, false);
    assert.match(safety.safe ? "" : safety.reason, /live stream/);
  } finally {
    await streamed.store.close();
  }
});

test("fenced operations and held review drafts do not pin a runtime forever", async () => {
  const harness = await lifecycleHarness();
  try {
    const item = (await harness.store.enqueue(
      harness.projection.id,
      "uncertain turn",
      "queue",
    )).item;
    const reserved = await harness.store.reserveQueueHead({
      sessionId: harness.projection.id,
      mutationKind: "turn-submit",
    });
    assert.equal(reserved.kind, "reserved");
    if (reserved.kind !== "reserved") assert.fail("queue reservation expected");
    const claimed = await harness.store.claimOperation(
      reserved.reservation.operation.operationId,
    );
    assert.equal(claimed.kind, "claimed");
    await harness.store.settleOperation(
      reserved.reservation.operation.operationId,
      { kind: "unknown", message: "runtime disappeared" },
    );
    const reset = await harness.store.prepareOperation({
      sessionId: harness.projection.id,
      mutationKind: "session-reset",
      intentEvent: {
        type: "runtime/session-reset-intended",
        data: { reason: "test" },
        ignorable: true,
      },
    });
    await harness.store.claimOperation(reset.operation.operationId);
    await harness.store.settleOperation(reset.operation.operationId, {
      kind: "confirmed",
      receipt: "backend-replacement",
    });
    const replacementEndpoint = {
      ...harness.endpoint,
      authorityId: "owned:replacement-authority",
      generation: 1,
      url: "http://runtime.invalid/replacement",
      control: { kind: "owned", instanceToken: "replacement-instance" } as const,
    };
    const oldBinding = harness.projection.runtimeBinding!;
    const replacementBinding = {
      ...oldBinding,
      backendSessionId: "backend-replacement",
      authorityId: replacementEndpoint.authorityId,
      generation: replacementEndpoint.generation,
      epoch: 1,
      location: replacementEndpoint.location,
    };
    const transition = await harness.store.transitionRuntimeEpoch({
      sessionId: harness.projection.id,
      expectedBinding: oldBinding,
      replacementBinding,
      resetOperationId: reset.operation.operationId,
      reason: "test replacement",
      fence: {
        mode: "destroyed",
        authorityId: oldBinding.authorityId,
        generation: oldBinding.generation,
      },
    });
    assert.equal(transition.fencedOperations.length, 1);
    assert.deepEqual(transition.heldQueueItems.map((queuedItem) => queuedItem.id), [item.id]);

    const replacement = runtimeFor(replacementEndpoint);
    harness.replaceRuntime(replacement.runtime);
    await harness.notifyEvicted();
    await harness.sessions.events(harness.projection.id, 0);
    const safety = await harness.sessions.canEvictRuntime(
      replacement.runtime,
      replacement.runtime,
      replacementEndpoint,
      [],
    );
    assert.deepEqual(safety, { safe: true });
  } finally {
    await harness.store.close();
  }
});

test("evicted verified runtime respawns, rebinds, and does not create an epoch", async () => {
  const harness = await lifecycleHarness();
  try {
    const replacementEndpoint = endpointFor(harness.directory, 2);
    const replacement = runtimeFor(replacementEndpoint);
    harness.replaceRuntime(replacement.runtime);
    await harness.notifyEvicted();
    await harness.sessions.events(harness.projection.id, 0);

    const projection = await harness.store.projection(harness.projection.id);
    assert.equal(projection?.runtimeBinding?.authorityId, harness.endpoint.authorityId);
    assert.equal(projection?.runtimeBinding?.generation, 2);
    assert.equal(projection?.runtimeBinding?.epoch, undefined);
    assert.equal(projection?.backendSessionId, harness.projection.backendSessionId);
    assert.equal(
      (await harness.store.events(harness.projection.id))
        .some((event) => event.type === "runtime/epoch-replaced"),
      false,
    );
  } finally {
    await harness.store.close();
  }
});
