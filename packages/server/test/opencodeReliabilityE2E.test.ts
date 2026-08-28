import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  createOpenCodeRuntimeLifecycle,
  createOpenCodeRuntimeFacade,
  createBorrowedExternalEndpointLease,
  attachRuntimeLifecycle,
  createConfigApplier,
} from "@polyth/backend-opencode";
import type {
  AgentRuntime,
  Project,
  ProjectService,
  RuntimeEndpoint,
  RuntimeEndpointLease,
  OwnedRuntimeEndpointLease,
  SessionEvent,
  SessionPersistence,
} from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import { createStore } from "@polyth/session";
import {
  createFakeOpenCode,
  httpFaults,
} from "../../backend-opencode/test/fakeOpenCode.ts";
import { createSessionService, type Broadcaster } from "../src/sessions.ts";
import {
  createDeferredConfigApplier,
  createOpenCodePendingService,
} from "../src/opencodePending.ts";

const projectServices = (project: Project): ProjectService => ({
  list: async () => [project],
  get: async (id) => id === project.id ? project : undefined,
  add: async () => project,
  create: async () => project,
  remove: async () => undefined,
});

const permissionService = {
  evaluate: () => "ask",
  addRule: () => undefined,
  rules: () => [],
} as unknown as PermissionService;

const waitForEvent = (
  events: SessionEvent[],
  subscribe: (listener: (event: SessionEvent) => void) => () => void,
  predicate: (event: SessionEvent) => boolean,
): Promise<SessionEvent> => {
  const found = events.find(predicate);
  if (found) return Promise.resolve(found);
  return new Promise<SessionEvent>((resolveEvent, rejectEvent) => {
    let dispose = () => undefined;
    const timeout = setTimeout(() => {
      dispose();
      rejectEvent(new Error("expected durable event was not observed"));
    }, 2_000);
    dispose = subscribe((event) => {
      if (!predicate(event)) return;
      clearTimeout(timeout);
      dispose();
      resolveEvent(event);
    });
  });
};

const reliabilityHarness = async (
  fake: Awaited<ReturnType<typeof createFakeOpenCode>>,
  options: {
    directory?: string;
    store?: SessionPersistence;
    generation?: number;
    sseStallMs?: number;
  } = {},
) => {
  const directory = options.directory ?? mkdtempSync(join(tmpdir(), "polyth-reliability-e2e-"));
  const store = options.store ?? createStore(join(directory, "sessions.db"));
  const endpoint: RuntimeEndpoint = {
    authorityId: `fake:${directory}`,
    continuity: "verified",
    generation: options.generation ?? 1,
    url: fake.baseUrl,
    location: { directory },
    control: { kind: "borrowed", source: "external" },
    config: { kind: "read-only" },
    authentication: { kind: "none" },
  };
  const lease = {
    control: endpoint.control,
    async endpoint() { return endpoint; },
    async refresh() { return endpoint; },
    async dispose() {},
  } satisfies RuntimeEndpointLease;
  const lifecycle = await createOpenCodeRuntimeLifecycle({
    lease,
    protocol: "legacy",
    protocolDeadlineMs: 500,
    startupDeadlineMs: 500,
    probeDeadlineMs: 100,
    transport: { queryAttempts: 1 },
  });
  const facade = createOpenCodeRuntimeFacade({
    cwd: directory,
    lifecycle,
    ...(options.sseStallMs ? { sseStallMs: options.sseStallMs } : {}),
  });
  const disposeFacade = facade.dispose.bind(facade);
  facade.dispose = async () => {
    await disposeFacade();
    await lifecycle.dispose();
  };
  const runtime = attachRuntimeLifecycle(facade, lifecycle);

  const project: Project = {
    id: `project:${directory}`,
    name: "Reliability project",
    path: directory,
    createdAt: 1,
  };
  const events: SessionEvent[] = [];
  const eventListeners = new Set<(event: SessionEvent) => void>();
  const projections: NonNullable<
    Awaited<ReturnType<SessionPersistence["projection"]>>
  >[] = [];
  const projectionListeners = new Set<
    (projection: Awaited<ReturnType<SessionPersistence["projection"]>>) => void
  >();
  const broadcast: Broadcaster = {
    event(event) {
      events.push(event);
      for (const listener of eventListeners) listener(event);
    },
    projection(projection) {
      projections.push(projection);
      for (const listener of projectionListeners) listener(projection);
    },
  };
  const sessions = createSessionService({
    store,
    projects: projectServices(project),
    permissions: permissionService,
    broadcast,
    queue: store as ReturnType<typeof createStore>,
    runtimes: { forProject: async () => runtime },
  });
  return {
    directory,
    endpoint,
    events,
    fake,
    project,
    runtime,
    sessions,
    store,
    waitForEvent: (predicate: (event: SessionEvent) => boolean) =>
      waitForEvent(events, (listener) => {
        eventListeners.add(listener);
        return () => eventListeners.delete(listener);
      }, predicate),
    waitForProjection: (
      predicate: (
        projection: NonNullable<Awaited<ReturnType<SessionPersistence["projection"]>>>,
      ) => boolean,
    ) => {
      const found = projections.find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise<NonNullable<Awaited<ReturnType<SessionPersistence["projection"]>>>>(
        (resolveProjection, rejectProjection) => {
          let dispose = () => undefined;
          const timeout = setTimeout(() => {
            dispose();
            rejectProjection(new Error("expected projection state was not observed"));
          }, 2_000);
          dispose = (() => {
            const listener = (
              projection: Awaited<ReturnType<SessionPersistence["projection"]>>,
            ) => {
              if (!projection || !predicate(projection)) return;
              clearTimeout(timeout);
              projectionListeners.delete(listener);
              resolveProjection(projection);
            };
            projectionListeners.add(listener);
            return () => projectionListeners.delete(listener);
          })();
        },
      );
    },
  };
};

test("accepted prompt with a lost response is durably unknown and sent once", async () => {
  const fake = await createFakeOpenCode();
  const harness = await reliabilityHarness(fake);
  try {
    const created = await harness.sessions.create({
      projectId: harness.project.id,
      title: "Fault test",
    });
    const backendSessionId = (await harness.store.projection(created.id))!.backendSessionId!;
    const promptPath = `/session/${backendSessionId}/prompt_async`;
    fake.scriptHttp({
      method: "POST",
      path: promptPath,
      steps: [httpFaults.acceptThenClose({ accepted: true })],
    });

    await assert.rejects(
      () => harness.sessions.send(created.id, { text: "perform exactly once" }),
      (error: Error & { code?: string }) => error.code === "outcome-unknown",
    );

    assert.equal(fake.requestCount("POST", promptPath), 1);
    assert.equal(fake.commits().filter((commit) => commit.request.path === promptPath).length, 1);
    const operation = (await (harness.store as ReturnType<typeof createStore>).operations(created.id))
      .find((candidate) => candidate.mutationKind === "turn-submit");
    assert.equal(operation?.state, "unknown");
    assert.equal((await harness.store.events(created.id))
      .filter((event) => event.type === "user/message").length, 1);
    assert.equal((await harness.store.events(created.id))
      .filter((event) => event.type === "turn/started").length, 0,
    "an ambiguous admission must not be presented as a confirmed turn");

    await assert.rejects(
      () => harness.sessions.send(created.id, { text: "perform exactly once" }),
      (error: Error & { code?: string }) => error.code === "conflict",
    );
    assert.equal(fake.requestCount("POST", promptPath), 1);
  } finally {
    await harness.runtime.dispose();
    await fake.close();
    await harness.store.close();
  }
});

test("response-lost prompt reconciles by operation receipt without a second message", async () => {
  const fake = await createFakeOpenCode();
  fake.scriptSse({ silent: true });
  const harness = await reliabilityHarness(fake);
  try {
    const created = await harness.sessions.create({
      projectId: harness.project.id,
      title: "Receipt recovery",
    });
    const backendSessionId = (await harness.store.projection(created.id))!.backendSessionId!;
    const promptPath = `/session/${backendSessionId}/prompt_async`;
    fake.scriptHttp({
      method: "POST",
      path: promptPath,
      steps: [httpFaults.acceptThenClose(undefined, {
        applyLifecycle: true,
        emit: false,
      })],
    });

    await assert.rejects(
      () => harness.sessions.send(created.id, { text: "send exactly once" }),
      (error: Error & { code?: string }) => error.code === "outcome-unknown",
    );
    const operation = (await (harness.store as ReturnType<typeof createStore>)
      .operations(created.id))
      .find((candidate) => candidate.mutationKind === "turn-submit")!;
    await harness.waitForEvent((event) =>
      event.type === "mutation/confirmed"
      && (event.data as { operationId?: string }).operationId === operation.operationId);

    assert.equal(fake.requestCount("POST", promptPath), 1);
    assert.equal(fake.lifecycle.session(backendSessionId)?.messages.length, 1);
    assert.equal(
      (await (harness.store as ReturnType<typeof createStore>)
        .operation(operation.operationId))?.state,
      "confirmed",
    );
    assert.equal((await harness.store.events(created.id))
      .filter((event) => event.type === "user/message").length, 1);
  } finally {
    await harness.runtime.dispose();
    await fake.close();
    await harness.store.close();
  }
});

test("response-lost create recovers its backend id from an exact operation receipt", async () => {
  const fake = await createFakeOpenCode();
  fake.scriptSse({ silent: true });
  fake.scriptHttp({
    method: "POST",
    path: "/session",
    steps: [httpFaults.acceptThenClose(undefined, {
      applyLifecycle: true,
      emit: false,
    })],
  });
  const harness = await reliabilityHarness(fake);
  try {
    await assert.rejects(
      () => harness.sessions.create({
        projectId: harness.project.id,
        title: "Unknown create",
      }),
      (error: Error & { code?: string }) => error.code === "outcome-unknown",
    );
    const shell = (await harness.store.projections(harness.project.id))[0]!;
    assert.equal(shell.status, "unknown");
    assert.equal(shell.backendSessionId, undefined);

    await harness.sessions.events(shell.id, 0);
    const recovered = await harness.store.projection(shell.id);
    assert.equal(recovered?.backendSessionId, fake.lifecycle.sessions()[0]?.id);
    assert.notEqual(recovered?.status, "unknown");
    assert.equal(fake.requestCount("POST", "/session"), 1);
    const createOperation = (await (harness.store as ReturnType<typeof createStore>)
      .operations(shell.id))
      .find((operation) => operation.mutationKind === "session-create");
    assert.equal(createOperation?.state, "confirmed");
  } finally {
    await harness.runtime.dispose();
    await fake.close();
    await harness.store.close();
  }
});

test("missed permission is pulled after disconnect and answered once", async () => {
  const fake = await createFakeOpenCode();
  const harness = await reliabilityHarness(fake);
  try {
    const created = await harness.sessions.create({
      projectId: harness.project.id,
      title: "Permission recovery",
    });
    const backendSessionId = (await harness.store.projection(created.id))!.backendSessionId!;
    await fake.waitForSseConnections();
    fake.lifecycle.addPermission(
      backendSessionId,
      { id: "per_recover", permission: "bash", patterns: ["npm test"] },
      { emit: false },
    );
    fake.disconnectSse();
    await harness.waitForEvent((event) =>
      event.type === "permission/requested"
      && (event.data as { requestId?: string }).requestId === "per_recover");

    await harness.sessions.replyPermission(created.id, "per_recover", "once");
    assert.equal(
      fake.requestCount("POST", `/session/${backendSessionId}/permissions/per_recover`),
      1,
    );
    assert.equal(fake.lifecycle.pendingPermissions().length, 0);
    assert.equal((await harness.store.events(created.id))
      .filter((event) => event.type === "permission/requested").length, 1);
  } finally {
    await harness.runtime.dispose();
    await fake.close();
    await harness.store.close();
  }
});

test("missed question is pulled after disconnect and answered once", async () => {
  const fake = await createFakeOpenCode();
  const harness = await reliabilityHarness(fake);
  try {
    const created = await harness.sessions.create({
      projectId: harness.project.id,
      title: "Question recovery",
    });
    const backendSessionId = (await harness.store.projection(created.id))!.backendSessionId!;
    await fake.waitForSseConnections();
    fake.lifecycle.addQuestion(
      backendSessionId,
      {
        id: "que_recover",
        questions: [{ id: "continue", question: "Continue?" }],
      },
      { emit: false },
    );
    fake.disconnectSse();
    await harness.waitForEvent((event) =>
      event.type === "question/asked"
      && (event.data as { requestId?: string }).requestId === "que_recover");

    await harness.sessions.replyQuestion(created.id, "que_recover", {
      continue: "yes",
    });
    assert.equal(fake.requestCount("POST", "/question/que_recover/reply"), 1);
    assert.equal(fake.lifecycle.pendingQuestions().length, 0);
    assert.equal((await harness.store.events(created.id))
      .filter((event) => event.type === "question/asked").length, 1);
  } finally {
    await harness.runtime.dispose();
    await fake.close();
    await harness.store.close();
  }
});

test("silent connected SSE triggers lifecycle reconciliation under a liveness policy", async () => {
  const fake = await createFakeOpenCode();
  fake.scriptSse({ silent: true });
  const harness = await reliabilityHarness(fake, { sseStallMs: 100 });
  try {
    const created = await harness.sessions.create({
      projectId: harness.project.id,
      title: "Silent stream",
    });
    await harness.waitForEvent((event) =>
      event.sessionId === created.id && event.type === "reconciliation/completed");
    assert.equal(
      (await (harness.store as ReturnType<typeof createStore>)
        .reconciliation(created.id))?.state,
      "ready",
    );
  } finally {
    await harness.runtime.dispose();
    await fake.close();
    await harness.store.close();
  }
});

test("queued follow-up survives disconnect and store restart, then dispatches once", async () => {
  const fake = await createFakeOpenCode();
  const directory = mkdtempSync(join(tmpdir(), "polyth-queue-restart-e2e-"));
  const first = await reliabilityHarness(fake, { directory });
  let second: Awaited<ReturnType<typeof reliabilityHarness>> | undefined;
  try {
    const created = await first.sessions.create({
      projectId: first.project.id,
      title: "Queue restart",
    });
    const backendSessionId = (await first.store.projection(created.id))!.backendSessionId!;
    const promptPath = `/session/${backendSessionId}/prompt_async`;
    await first.sessions.send(created.id, { text: "active turn" });
    const queued = await first.sessions.send(created.id, {
      text: "queued exactly once",
      delivery: "queue",
    });
    assert.equal((await (first.store as ReturnType<typeof createStore>)
      .queueList(created.id)).length, 1);

    fake.disconnectSse();
    await first.waitForEvent((event) =>
      event.sessionId === created.id && event.type === "reconciliation/completed");
    fake.lifecycle.finishTurn(backendSessionId, { emit: false });
    await first.runtime.dispose();
    await first.store.close();

    const reopened = createStore(join(directory, "sessions.db"));
    second = await reliabilityHarness(fake, {
      directory,
      store: reopened,
      generation: 2,
    });
    await second.sessions.events(created.id, 0);
    await fake.waitForRequest({ method: "POST", path: promptPath, count: 2 });
    await second.waitForEvent((event) =>
      event.type === "queue/dispatched"
      && (event.data as { queueId?: string }).queueId === queued.queueId);
    await second.waitForEvent((event) =>
      event.sessionId === created.id && event.type === "turn/started");

    assert.equal(fake.requestCount("POST", promptPath), 2);
    assert.equal(fake.lifecycle.session(backendSessionId)?.messages.length, 2);
    assert.equal((await reopened.queueList(created.id)).length, 0);
    assert.equal((await reopened.events(created.id))
      .filter((event) => event.type === "queue/dispatched"
        && (event.data as { queueId?: string }).queueId === queued.queueId).length, 1);
  } finally {
    if (second) {
      await second.runtime.dispose();
      await second.store.close();
    }
    await fake.close();
  }
});

test("backend hard death leaves an incomplete tool turn truthful across endpoint restart", async () => {
  const fake = await createFakeOpenCode();
  const directory = mkdtempSync(join(tmpdir(), "polyth-backend-death-e2e-"));
  const first = await reliabilityHarness(fake, { directory });
  let restarted: Awaited<ReturnType<typeof createFakeOpenCode>> | undefined;
  let second: Awaited<ReturnType<typeof reliabilityHarness>> | undefined;
  try {
    const created = await first.sessions.create({
      projectId: first.project.id,
      title: "Backend death",
    });
    const backendSessionId = (await first.store.projection(created.id))!.backendSessionId!;
    await first.sessions.send(created.id, { text: "run a tool" });
    fake.emitSse({
      id: "evt_tool_running",
      data: {
        type: "message.part.updated",
        properties: {
          sessionID: backendSessionId,
          part: {
            id: "part_tool_1",
            messageID: "assistant_1",
            type: "tool",
            tool: "bash",
            callID: "call_1",
            state: { status: "running", input: { command: "npm test" } },
          },
        },
      },
    });
    await first.waitForEvent((event) =>
      event.type === "tool/started" || event.type === "tool/call");

    const unknownProjection = first.waitForProjection((projection) =>
      projection.id === created.id && projection.status === "unknown");
    await fake.lifecycle.hardDeath(backendSessionId);
    await first.waitForEvent((event) =>
      event.type === "reconciliation/blocked"
      && (event.data as { state?: string }).state === "unknown");
    await unknownProjection;

    restarted = await fake.restart();
    await first.runtime.dispose();
    second = await reliabilityHarness(restarted, {
      directory,
      store: first.store,
      generation: 2,
    });
    const restartedUnknown = second.waitForProjection((projection) =>
      projection.id === created.id && projection.status === "unknown");
    await second.sessions.events(created.id, 0);
    await restartedUnknown;
    assert.equal(restarted.requestCount("POST", `/session/${backendSessionId}/prompt_async`), 0);
  } finally {
    await first.runtime.dispose();
    if (second) await second.runtime.dispose();
    await first.store.close();
    await fake.close();
    if (restarted) await restarted.close();
  }
});

test("config apply waits for safe idle and restarts only an owned local target", async (t) => {
  const fake = await createFakeOpenCode();
  t.after(() => fake.close());
  const configDir = mkdtempSync(join(tmpdir(), "polyth-config-e2e-"));
  const probe = createConfigApplier({ configDir });
  const targetId = probe.configTargetId!();
  const actual = createConfigApplier({
    configDir,
    targetId,
    authority: { kind: "writable", targetId },
  });
  const backend = fake.lifecycle.createSession({ id: "ses_config" });
  fake.lifecycle.setBusy(backend.id, { emit: false });
  let restarts = 0;
  const pending = createOpenCodePendingService({
    canRestart: async () => {
      return fake.lifecycle.session(backend.id)?.status !== "idle"
        ? { safe: false, reason: "owned local session is busy" }
        : { safe: true };
    },
    restart: async () => {
      restarts += 1;
      return 1;
    },
  });
  const deferred = createDeferredConfigApplier(actual, pending);
  deferred.enableStaging();
  await deferred.applyProviderVisibility({
    disabledProviders: ["fake"],
    blacklists: {},
  });
  assert.equal(deferred.configTargetId?.(), targetId);
  assert.deepEqual(deferred.configAuthority?.(), { kind: "writable", targetId });

  await assert.rejects(
    () => pending.applyAndRestart(),
    (error: Error & { code?: string }) => error.code === "restart-deferred",
  );
  assert.equal(restarts, 0);
  assert.equal(pending.list().count, 1);

  fake.lifecycle.finishTurn(backend.id, { emit: false });
  assert.deepEqual(await pending.applyAndRestart(), { applied: 1, restarted: 1 });
  assert.equal(restarts, 1);
  const config = JSON.parse(readFileSync(actual.configPath(), "utf8")) as {
    disabled_providers?: string[];
  };
  assert.deepEqual(config.disabled_providers, ["fake"]);

  const readOnly = createConfigApplier({
    configDir,
    targetId,
    authority: { kind: "read-only" },
  });
  const borrowedPending = createOpenCodePendingService({
    restart: async () => {
      restarts += 1;
      return 1;
    },
  });
  const borrowed = createDeferredConfigApplier(readOnly, borrowedPending);
  borrowed.enableStaging();
  await borrowed.applyAgent("review", { mode: "subagent" });
  await assert.rejects(
    () => borrowedPending.applyAndRestart(),
    (error: Error & { code?: string }) => error.code === "config-read-only",
  );
  assert.equal(restarts, 1);
  assert.deepEqual(borrowed.configAuthority?.(), { kind: "read-only" });
});

test("natural replacement before the first config write is interlocked until the owned restart loads the applied config", async (t) => {
  const fake = await createFakeOpenCode();
  t.after(() => fake.close());
  const configDir = mkdtempSync(join(tmpdir(), "polyth-config-interlock-"));
  const configPath = join(configDir, "opencode.json");
  writeFileSync(configPath, JSON.stringify({ revision: "old" }));

  let generation = 0;
  let alive = true;
  let naturalReplacements = 0;
  let configRestarts = 0;
  const loadedRevision = new Map<number, string>();
  const replace = (reason: "initial" | "natural" | "config"): RuntimeEndpoint => {
    generation += 1;
    alive = true;
    if (reason === "natural") naturalReplacements += 1;
    if (reason === "config") configRestarts += 1;
    const revision = (JSON.parse(readFileSync(configPath, "utf8")) as {
      revision: string;
    }).revision;
    loadedRevision.set(generation, revision);
    return {
      authorityId: "owned-config-interlock",
      continuity: "generation-only",
      generation,
      url: fake.baseUrl,
      location: { directory: configDir },
      control: { kind: "owned", instanceToken: `owned-${generation}` },
      config: { kind: "writable", targetId: configPath },
      authentication: { kind: "none" },
    };
  };
  let endpoint = replace("initial");
  const lease: OwnedRuntimeEndpointLease = {
    get control() {
      return endpoint.control as { kind: "owned"; instanceToken: string };
    },
    async endpoint() {
      return endpoint;
    },
    async refresh() {
      if (!alive) endpoint = replace("natural");
      return endpoint;
    },
    async restart() {
      endpoint = replace("config");
      return endpoint;
    },
    async dispose() {},
  };
  const lifecycle = await createOpenCodeRuntimeLifecycle({
    lease,
    protocol: "legacy",
    protocolDeadlineMs: 500,
    startupDeadlineMs: 500,
    probeDeadlineMs: 100,
    transport: { queryAttempts: 1 },
  });
  t.after(() => lifecycle.dispose());
  assert.equal(lifecycle.control.kind, "owned");
  if (lifecycle.control.kind !== "owned" || !("withConfigRestart" in lifecycle)) {
    assert.fail("owned runtime lifecycle must expose the config replacement interlock");
  }

  let restartCapability: (() => Promise<RuntimeEndpoint>) | undefined;
  let naturalRefresh: Promise<RuntimeEndpoint> | undefined;
  let naturalSettled = false;
  const pending = createOpenCodePendingService({
    withAdmissionBarrier: (action) =>
      lifecycle.withConfigRestart(async (restart) => {
        restartCapability = restart;
        try {
          return await action();
        } finally {
          restartCapability = undefined;
        }
      }),
    captureRestartState: async () => {
      const captured = await lifecycle.endpoint();
      assert.equal(captured.generation, 1);
      assert.equal(loadedRevision.get(captured.generation), "old");
      return captured.generation;
    },
    canRestart: async () => {
      // Safe-idle reconciliation has completed. The old generation now dies
      // and its natural refresh races immediately before the first write.
      alive = false;
      naturalRefresh = lifecycle.refresh("disconnect").then((next) => {
        naturalSettled = true;
        return next;
      });
      await Promise.resolve();
      assert.equal(naturalSettled, false, "natural replacement must wait behind the config lock");
      return { safe: true };
    },
    restart: async () => {
      assert.ok(restartCapability, "config restart must use the lock-owned capability");
      const restarted = await restartCapability();
      assert.equal(loadedRevision.get(restarted.generation), "new");
      return 1;
    },
  });
  pending.stage({
    id: "provider-visibility",
    kind: "provider-visibility",
    label: "Provider visibility",
    apply: async () => {
      assert.equal(pending.list().count, 1);
      assert.equal(naturalSettled, false);
      assert.equal((await lifecycle.endpoint()).generation, 1);
      assert.equal(loadedRevision.get(1), "old");
      writeFileSync(configPath, JSON.stringify({ revision: "new" }));
      assert.equal(pending.list().count, 1, "the batch remains pending until restart proof");
    },
  });

  assert.deepEqual(await pending.applyAndRestart(), { applied: 1, restarted: 1 });
  assert.equal(pending.list().count, 0);
  assert.ok(naturalRefresh);
  const afterQueuedRefresh = await naturalRefresh;
  assert.equal(afterQueuedRefresh.generation, 2);
  assert.equal(loadedRevision.get(afterQueuedRefresh.generation), "new");
  assert.equal(configRestarts, 1);
  assert.equal(naturalReplacements, 0);
});

test("stale idle projection cannot authorize config restart while upstream is running", async () => {
  const fake = await createFakeOpenCode();
  const harness = await reliabilityHarness(fake);
  let writes = 0;
  let restarts = 0;
  try {
    const created = await harness.sessions.create({
      projectId: harness.project.id,
      title: "Stale idle safety",
    });
    const projection = (await harness.store.projection(created.id))!;
    assert.equal(projection.status, "idle");
    fake.lifecycle.setBusy(projection.backendSessionId!, { emit: false });
    assert.equal(
      (await harness.store.projection(created.id))?.status,
      "idle",
      "the persisted projection is deliberately stale",
    );

    const pending = createOpenCodePendingService({
      captureRestartState: async () => ({
        authorityId: harness.endpoint.authorityId,
        generation: harness.endpoint.generation,
      }),
      canRestart: async (captured) =>
        harness.sessions.reconcileForRuntimeRestart(
          created.id,
          harness.runtime,
          captured as { authorityId: string; generation: number },
        ),
      restart: async () => {
        restarts += 1;
        return 1;
      },
    });
    pending.stage({
      id: "provider-visibility",
      kind: "provider-visibility",
      label: "Provider visibility",
      apply: async () => {
        writes += 1;
      },
    });

    await assert.rejects(
      () => pending.applyAndRestart(),
      (error: Error & { code?: string }) => error.code === "restart-deferred",
    );
    assert.equal((await harness.store.projection(created.id))?.status, "working");
    assert.equal(writes, 0);
    assert.equal(restarts, 0);
    assert.equal(pending.list().count, 1);
  } finally {
    await harness.runtime.dispose();
    await fake.close();
    await harness.store.close();
  }
});

test("fresh session-service consumer sees running pending state from durable truth", async () => {
  const fake = await createFakeOpenCode();
  const harness = await reliabilityHarness(fake);
  try {
    const created = await harness.sessions.create({
      projectId: harness.project.id,
      title: "Fresh consumer",
    });
    const backendSessionId = (await harness.store.projection(created.id))!.backendSessionId!;
    await harness.sessions.send(created.id, { text: "still running" });
    fake.lifecycle.addPermission(
      backendSessionId,
      { id: "per_fresh", permission: "edit", patterns: ["src/*"] },
      { emit: false },
    );
    fake.disconnectSse();
    await harness.waitForEvent((event) =>
      event.type === "permission/requested"
      && (event.data as { requestId?: string }).requestId === "per_fresh");

    const secondConsumer = createSessionService({
      store: harness.store,
      projects: projectServices(harness.project),
      permissions: permissionService,
      broadcast: { event: () => undefined, projection: () => undefined },
      queue: harness.store as ReturnType<typeof createStore>,
      runtimes: { forProject: async () => harness.runtime },
    });
    await secondConsumer.events(created.id, 0);
    assert.equal((await secondConsumer.snapshot(created.id)).status, "waiting");
    assert.equal((await harness.store.events(created.id))
      .filter((event) => event.type === "permission/requested"
        && (event.data as { requestId?: string }).requestId === "per_fresh").length, 1);
  } finally {
    await harness.runtime.dispose();
    await fake.close();
    await harness.store.close();
  }
});

test("worktree runtimes keep messages, attachments, attention, forks, and queries isolated", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "polyth-isolation-root-"));
  const worktree = mkdtempSync(join(tmpdir(), "polyth-isolation-worktree-"));
  const rootFake = await createFakeOpenCode();
  const worktreeFake = await createFakeOpenCode();
  t.after(async () => {
    await rootFake.close();
    await worktreeFake.close();
  });

  const makeRuntime = async (
    fake: Awaited<ReturnType<typeof createFakeOpenCode>>,
    directory: string,
  ): Promise<AgentRuntime> => {
    const endpoint: RuntimeEndpoint = {
      authorityId: `isolation:${directory}`,
      continuity: "verified",
      generation: 1,
      url: fake.baseUrl,
      location: { directory },
      control: { kind: "borrowed", source: "external" },
      config: { kind: "read-only" },
      authentication: { kind: "none" },
    };
    const lease = {
      control: endpoint.control,
      async endpoint() { return endpoint; },
      async refresh() { return endpoint; },
      async dispose() {},
    } satisfies RuntimeEndpointLease;
    const lifecycle = await createOpenCodeRuntimeLifecycle({
      lease,
      protocol: "legacy",
      protocolDeadlineMs: 500,
      startupDeadlineMs: 500,
      probeDeadlineMs: 100,
      transport: { queryAttempts: 1 },
    });
    const facade = createOpenCodeRuntimeFacade({ cwd: directory, lifecycle });
    const disposeFacade = facade.dispose.bind(facade);
    facade.dispose = async () => {
      await disposeFacade();
      await lifecycle.dispose();
    };
    return attachRuntimeLifecycle(facade, lifecycle);
  };
  const rootRuntime = await makeRuntime(rootFake, root);
  const worktreeRuntime = await makeRuntime(worktreeFake, worktree);
  t.after(async () => {
    await rootRuntime.dispose();
    await worktreeRuntime.dispose();
  });

  const store = createStore(join(root, "isolation.db"));
  t.after(() => store.close());
  const project: Project = {
    id: "project-isolation",
    name: "Isolation",
    path: root,
    createdAt: 1,
  };
  const durableEvents: SessionEvent[] = [];
  const listeners = new Set<(event: SessionEvent) => void>();
  const sessions = createSessionService({
    store,
    projects: projectServices(project),
    permissions: permissionService,
    queue: store,
    broadcast: {
      event(event) {
        durableEvents.push(event);
        for (const listener of listeners) listener(event);
      },
      projection: () => undefined,
    },
    worktrees: {
      list: async () => [{ path: worktree, branch: "feature/isolation" }],
    },
    attachments: {
      maxBytes: 1_000,
      stat: async () => ({ kind: "file", size: 4 }),
    },
    runtimes: {
      forProject: async (_projectId, cwd) =>
        cwd === worktree ? worktreeRuntime : rootRuntime,
    },
  });
  const wait = (predicate: (event: SessionEvent) => boolean) =>
    waitForEvent(durableEvents, (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }, predicate);

  const rootSession = await sessions.create({ projectId: project.id, title: "Root" });
  const worktreeSession = await sessions.create({
    projectId: project.id,
    title: "Worktree",
    worktreePath: worktree,
  });
  const rootBackend = (await store.projection(rootSession.id))!.backendSessionId!;
  const worktreeBackend = (await store.projection(worktreeSession.id))!.backendSessionId!;
  const attachment = {
    id: "att",
    name: "note.txt",
    mime: "text/plain",
    size: 4,
    kind: "file" as const,
    path: "note.txt",
  };
  await sessions.send(rootSession.id, { text: "root message", attachments: [attachment] });
  await sessions.send(worktreeSession.id, {
    text: "worktree message",
    attachments: [attachment],
  });

  const rootBody = rootFake.lifecycle.session(rootBackend)?.messages[0]?.body as {
    parts?: Array<{ url?: string }>;
  };
  const worktreeBody = worktreeFake.lifecycle.session(worktreeBackend)?.messages[0]?.body as {
    parts?: Array<{ url?: string }>;
  };
  assert.match(rootBody.parts?.[1]?.url ?? "", new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(
    worktreeBody.parts?.[1]?.url ?? "",
    new RegExp(worktree.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  assert.equal(
    (rootFake.lifecycle.session(rootBackend)?.messages[0]?.body as {
      parts?: Array<{ text?: string }>;
    }).parts?.[0]?.text,
    "root message",
  );
  assert.equal(
    (worktreeFake.lifecycle.session(worktreeBackend)?.messages[0]?.body as {
      parts?: Array<{ text?: string }>;
    }).parts?.[0]?.text,
    "worktree message",
  );

  rootFake.lifecycle.finishTurn(rootBackend);
  worktreeFake.lifecycle.finishTurn(worktreeBackend);
  await wait((event) => event.sessionId === rootSession.id && event.type === "turn/stopped");
  await wait((event) => event.sessionId === worktreeSession.id && event.type === "turn/stopped");

  rootFake.lifecycle.addPermission(rootBackend, {
    id: "per_root",
    permission: "edit",
    patterns: ["root.txt"],
  });
  worktreeFake.lifecycle.addQuestion(worktreeBackend, {
    id: "que_worktree",
    questions: [{ id: "scope", question: "Worktree only?" }],
  });
  await wait((event) => event.type === "permission/requested"
    && (event.data as { requestId?: string }).requestId === "per_root");
  await wait((event) => event.type === "question/asked"
    && (event.data as { requestId?: string }).requestId === "que_worktree");
  assert.equal((await store.events(rootSession.id))
    .some((event) => (event.data as { requestId?: string }).requestId === "que_worktree"), false);
  assert.equal((await store.events(worktreeSession.id))
    .some((event) => (event.data as { requestId?: string }).requestId === "per_root"), false);

  await sessions.replyPermission(rootSession.id, "per_root", "once");
  const firstRootPrompt = (await store.events(rootSession.id))
    .find((event) => event.type === "user/message")!;
  const fork = await sessions.fork(rootSession.id, firstRootPrompt.seq);
  assert.equal((await store.projection(fork.id))?.worktreePath, undefined);
  assert.equal(rootFake.requestCount("POST", "/session"), 2);
  assert.equal(worktreeFake.requestCount("POST", "/session"), 1);

  await rootRuntime.models();
  await worktreeRuntime.models();
  assert.equal(rootFake.requests().some((request) =>
    request.path === "/provider" && request.url.includes(encodeURIComponent(root))), true);
  assert.equal(worktreeFake.requests().some((request) =>
    request.path === "/provider" && request.url.includes(encodeURIComponent(worktree))), true);
});

test("legacy V1 fake supports core create, prompt, event, and reconcile behavior", async () => {
  const fake = await createFakeOpenCode();
  const harness = await reliabilityHarness(fake);
  try {
    const created = await harness.sessions.create({
      projectId: harness.project.id,
      title: "Legacy V1",
    });
    const backendSessionId = (await harness.store.projection(created.id))!.backendSessionId!;
    await harness.sessions.send(created.id, { text: "legacy prompt" });
    const idleProjection = harness.waitForProjection((projection) =>
      projection.id === created.id && projection.status === "idle");
    fake.lifecycle.finishTurn(backendSessionId);
    await harness.waitForEvent((event) =>
      event.sessionId === created.id && event.type === "turn/stopped");
    await idleProjection;
    fake.disconnectSse();
    await harness.waitForEvent((event) =>
      event.sessionId === created.id && event.type === "reconciliation/completed");

    assert.equal(fake.requestCount("POST", "/session"), 1);
    assert.equal(
      fake.requestCount("POST", `/session/${backendSessionId}/prompt_async`),
      1,
    );
    assert.equal(
      (await (harness.store as ReturnType<typeof createStore>)
        .reconciliation(created.id))?.state,
      "ready",
    );
  } finally {
    await harness.runtime.dispose();
    await fake.close();
    await harness.store.close();
  }
});

test("V2 keeps unsupported operations capability-gated without fabricating V1 traffic", async () => {
  const fake = await createFakeOpenCode();
  const directory = mkdtempSync(join(tmpdir(), "polyth-v2-gate-e2e-"));
  const lease = await createBorrowedExternalEndpointLease({
    url: fake.baseUrl,
    location: { directory },
    authorityId: "fake-v2",
  });
  const lifecycle = await createOpenCodeRuntimeLifecycle({
    lease,
    protocol: "v2",
    startupDeadlineMs: 500,
    probeDeadlineMs: 100,
  });
  const facade = createOpenCodeRuntimeFacade({
    cwd: directory,
    lifecycle,
  });
  const runtime = attachRuntimeLifecycle(facade, lifecycle);
  try {
    const outcome = await runtime.createSessionOperation!(
      { projectId: "p-v2", sessionId: "canonical-v2", cwd: directory },
      "operation-v2",
    );
    assert.deepEqual(outcome, {
      kind: "rejected",
      code: "capability-unsupported",
      message: "OpenCode V2 session creation is disabled until its beta contract is pinned",
    });
    assert.equal(fake.requestCount("POST", "/session"), 0);
  } finally {
    await runtime.dispose();
    await lifecycle.dispose();
    await fake.close();
  }
});
