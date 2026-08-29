import assert from "node:assert/strict";
import type { ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import {
  createOpenCodeRuntimeLifecycle,
  createOpenCodeRuntimeFacade,
  createBorrowedExternalEndpointLease,
  attachRuntimeLifecycle,
  createConfigApplier,
  createOwnedLocalEndpointLease,
  type OpenCodeEngineIdentity,
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

const waitForCondition = async (
  condition: () => boolean | Promise<boolean>,
): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("expected condition was not reached");
};

const TEST_ENGINE: OpenCodeEngineIdentity = {
  engine: "opencode",
  version: "1.18.18",
  binaryDigest: "a".repeat(64),
  protocolGeneration: 1,
};

let nextOwnedPid = 12_000;

const createOwnedFakeLease = async (
  fake: Awaited<ReturnType<typeof createFakeOpenCode>>,
  directory: string,
) => {
  const port = Number(new URL(fake.baseUrl).port);
  return createOwnedLocalEndpointLease({
    projectId: `project:${directory}`,
    cwd: directory,
    runtimeDir: join(directory, "runtimes", "opencode", "project"),
    stateFile: join(directory, "opencode-local", "project.lease.json"),
    pidFile: join(directory, "opencode-local", "project.pid.json"),
    resolveBinary: async () => ({
      executablePath: join(directory, "fake-opencode"),
      binarySource: "configured",
    }),
    inspectEngine: async () => TEST_ENGINE,
    pickPort: async () => port,
    spawn: ((_bin: string, args: readonly string[], spawnOptions: { env?: NodeJS.ProcessEnv }) => {
      const isolatedDb = spawnOptions.env?.OPENCODE_DB;
      assert.ok(isolatedDb);
      writeFileSync(isolatedDb, `opaque fake database ${nextOwnedPid}`, { mode: 0o600 });
      const child = new EventEmitter() as ChildProcess;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      let signalCode: NodeJS.Signals | null = null;
      Object.assign(child, {
        pid: nextOwnedPid++,
        stdout,
        stderr,
        stdin: null,
        stdio: [null, stdout, stderr, null, null],
        connected: false,
        spawnargs: [],
        spawnfile: "opencode",
        kill(signal: NodeJS.Signals = "SIGTERM") {
          signalCode = signal;
          queueMicrotask(() => child.emit("exit", null, signal));
          return true;
        },
        ref() {},
        unref() {},
        disconnect() {},
        send() { return false; },
      });
      Object.defineProperties(child, {
        killed: { get: () => signalCode !== null },
        exitCode: { get: () => null },
        signalCode: { get: () => signalCode },
      });
      setImmediate(() => {
        stderr.write(
          `opencode server listening on http://127.0.0.1:${Number(args.at(-1))}\n`,
        );
      });
      return child;
    }) as unknown as typeof nodeSpawn,
    readProcessIdentity: async (pid) => ({
      startIdentity: `start-${pid}`,
      executable: "/usr/bin/opencode",
      command: `opencode-${pid}`,
    }),
    gracefulStopMs: 20,
  });
};

const reliabilityHarness = async (
  fake: Awaited<ReturnType<typeof createFakeOpenCode>>,
  options: {
    directory?: string;
    store?: SessionPersistence;
    generation?: number;
    sseStallMs?: number;
    authorityId?: string;
    control?: RuntimeEndpoint["control"];
    lease?: RuntimeEndpointLease;
  } = {},
) => {
  const directory = options.directory ?? mkdtempSync(join(tmpdir(), "polyth-reliability-e2e-"));
  const store = options.store ?? createStore(join(directory, "sessions.db"));
  const endpoint: RuntimeEndpoint = options.lease
    ? await options.lease.endpoint()
    : {
        authorityId: options.authorityId ?? `fake:${directory}`,
        continuity: "verified",
        generation: options.generation ?? 1,
        url: fake.baseUrl,
        location: { directory },
        control: options.control ?? { kind: "borrowed", source: "external" },
        config: { kind: "read-only" },
        authentication: { kind: "none" },
      };
  const lease = options.lease ?? {
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

test("fresh owned runtime rehydrates confirmed history without replaying an uncertain prompt", async () => {
  const directory = mkdtempSync(join(tmpdir(), "polyth-fresh-epoch-e2e-"));
  const oldFake = await createFakeOpenCode();
  const firstLease = await createOwnedFakeLease(oldFake, directory);
  const first = await reliabilityHarness(oldFake, {
    directory,
    lease: firstLease,
  });
  let newFake: Awaited<ReturnType<typeof createFakeOpenCode>> | undefined;
  let second: Awaited<ReturnType<typeof reliabilityHarness>> | undefined;
  try {
    const created = await first.sessions.create({
      projectId: first.project.id,
      title: "Fresh epoch recovery",
    });
    const oldBackendSessionId = (await first.store.projection(created.id))!.backendSessionId!;
    await first.sessions.send(created.id, { text: "confirmed canonical fact" });
    oldFake.lifecycle.finishTurn(oldBackendSessionId);
    await first.waitForEvent((event) =>
      event.sessionId === created.id && event.type === "turn/stopped");

    const uncertainPath = `/session/${oldBackendSessionId}/prompt_async`;
    oldFake.scriptHttp({
      method: "POST",
      path: uncertainPath,
      steps: [httpFaults.acceptThenClose({ accepted: true })],
    });
    await assert.rejects(
      () => first.sessions.send(created.id, { text: "uncertain request must stay held" }),
      (error: Error & { code?: string }) => error.code === "outcome-unknown",
    );
    const uncertain = (await (first.store as ReturnType<typeof createStore>)
      .operations(created.id))
      .find((operation) => operation.mutationKind === "turn-submit"
        && operation.state === "unknown")!;

    // A fresh fake endpoint models deletion/quarantine of the old runtime DB:
    // it retains no backend sessions, messages, or in-memory facade mappings.
    await first.runtime.dispose();
    rmSync(join(directory, "runtimes"), { recursive: true, force: true });
    newFake = await createFakeOpenCode();
    newFake.lifecycle.createSession({ title: "unrelated fresh-runtime session" });
    const secondLease = await createOwnedFakeLease(newFake, directory);
    second = await reliabilityHarness(newFake, {
      directory,
      store: first.store,
      lease: secondLease,
    });
    assert.notEqual(second.endpoint.authorityId, first.endpoint.authorityId);
    assert.equal(second.endpoint.generation, 1);

    await second.sessions.send(created.id, { text: "continue on the clean runtime" });

    const projection = (await first.store.projection(created.id))!;
    assert.equal(projection.runtimeBinding?.epoch, 1);
    assert.equal(projection.runtimeBinding?.authorityId, second.endpoint.authorityId);
    assert.notEqual(projection.backendSessionId, oldBackendSessionId);
    assert.equal(
      (await (first.store as ReturnType<typeof createStore>)
        .operation(uncertain.operationId))?.state,
      "fenced",
    );
    assert.deepEqual(
      (await (first.store as ReturnType<typeof createStore>).queueList(created.id))
        .map((item) => ({ text: item.text, heldForReview: item.heldForReview })),
      [{ text: "uncertain request must stay held", heldForReview: true }],
    );
    const freshSession = newFake.lifecycle.session(projection.backendSessionId!);
    assert.equal(freshSession?.messages.length, 1);
    const sentText = (freshSession?.messages[0]?.body as {
      parts?: Array<{ text?: string }>;
    }).parts?.[0]?.text ?? "";
    assert.match(sentText, /confirmed canonical fact/);
    assert.match(sentText, /continue on the clean runtime/);
    assert.doesNotMatch(sentText, /uncertain request must stay held/);
    const events = await first.store.events(created.id);
    assert.equal(events.filter((event) => event.type === "runtime/epoch-replaced").length, 1);
    assert.equal(events.some((event) =>
      event.type === "mutation/rejected"
      && (event.data as { operationId?: string }).operationId === uncertain.operationId), false);
  } finally {
    await first.runtime.dispose();
    if (second) await second.runtime.dispose();
    await first.store.close();
    await oldFake.close();
    if (newFake) await newFake.close();
  }
});

test("DB loss after prompt preparation holds the never-admitted turn without replaying it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "polyth-pre-admission-crash-"));
  const oldFake = await createFakeOpenCode();
  const firstLease = await createOwnedFakeLease(oldFake, directory);
  const first = await reliabilityHarness(oldFake, {
    directory,
    lease: firstLease,
  });
  let newFake: Awaited<ReturnType<typeof createFakeOpenCode>> | undefined;
  let second: Awaited<ReturnType<typeof reliabilityHarness>> | undefined;
  try {
    const created = await first.sessions.create({
      projectId: first.project.id,
      title: "Pre-admission crash",
    });
    const oldBackendSessionId = (await first.store.projection(created.id))!.backendSessionId!;
    const prepared = await (first.store as ReturnType<typeof createStore>).prepareOperation({
      sessionId: created.id,
      mutationKind: "turn-submit",
      intentEvent: {
        type: "user/message",
        data: { text: "prepared but never admitted" },
      },
    });
    assert.equal(prepared.operation.state, "prepared");
    assert.equal(
      oldFake.requestCount("POST", `/session/${oldBackendSessionId}/prompt_async`),
      0,
    );

    await first.runtime.dispose();
    rmSync(
      join(directory, "runtimes", "opencode", "project", "opencode.db"),
      { force: true },
    );
    newFake = await createFakeOpenCode();
    newFake.lifecycle.createSession({ title: "unrelated fresh-runtime session" });
    const secondLease = await createOwnedFakeLease(newFake, directory);
    second = await reliabilityHarness(newFake, {
      directory,
      store: first.store,
      lease: secondLease,
    });
    assert.notEqual(second.endpoint.authorityId, first.endpoint.authorityId);

    await second.sessions.send(created.id, { text: "new epoch prompt" });

    const rejected = await (first.store as ReturnType<typeof createStore>)
      .operation(prepared.operation.operationId);
    assert.equal(rejected?.state, "rejected");
    assert.equal(rejected?.code, "runtime-epoch-replaced-before-execution");
    assert.deepEqual(
      (await (first.store as ReturnType<typeof createStore>).queueList(created.id))
        .map((item) => ({ text: item.text, heldForReview: item.heldForReview })),
      [{ text: "prepared but never admitted", heldForReview: true }],
    );
    const projection = (await first.store.projection(created.id))!;
    assert.equal(projection.runtimeBinding?.epoch, 1);
    const freshSession = newFake.lifecycle.session(projection.backendSessionId!);
    assert.equal(freshSession?.messages.length, 1);
    const sentText = (freshSession?.messages[0]?.body as {
      parts?: Array<{ text?: string }>;
    }).parts?.[0]?.text ?? "";
    assert.match(sentText, /new epoch prompt/);
    assert.doesNotMatch(sentText, /prepared but never admitted/);
    assert.equal(
      newFake.requestCount("POST", `/session/${projection.backendSessionId}/prompt_async`),
      1,
    );
  } finally {
    await first.runtime.dispose();
    if (second) await second.runtime.dispose();
    await first.store.close();
    await oldFake.close();
    if (newFake) await newFake.close();
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

test("changed-ID semantic SSE duplicate is consumed without an observation error", async () => {
  const fake = await createFakeOpenCode();
  const harness = await reliabilityHarness(fake);
  const originalError = console.error;
  const errors: string[] = [];
  try {
    const created = await harness.sessions.create({
      projectId: harness.project.id,
      title: "Semantic duplicate",
    });
    const backendSessionId = (await harness.store.projection(created.id))!.backendSessionId!;
    await fake.waitForSseConnections();
    const completeAssistant = {
      type: "message.updated",
      properties: {
        sessionID: backendSessionId,
        info: {
          id: "msg_duplicate_complete",
          sessionID: backendSessionId,
          role: "assistant",
          providerID: "test",
          modelID: "duplicate",
          cost: 0,
          tokens: {
            input: 1,
            output: 1,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          time: { created: 1, completed: 2 },
        },
      },
    };
    fake.emitSse({ id: "transport-first", data: completeAssistant });
    await harness.waitForEvent((event) =>
      event.sessionId === created.id && event.type === "usage/recorded");

    console.error = (...args: unknown[]) => {
      errors.push(args.map((arg) => String(arg)).join(" "));
    };
    fake.emitSse({ id: "transport-second", data: completeAssistant });
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.deepEqual(
      errors,
      [],
      "a semantic duplicate must be a no-op, not an unconsumed persisted-event error",
    );
    assert.equal(
      (await harness.store.events(created.id))
        .filter((event) => event.type === "usage/recorded").length,
      1,
    );
  } finally {
    console.error = originalError;
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
    const canonical = await first.store.events(created.id);
    assert.equal(
      canonical.filter((event) => event.type === "assistant/message").length,
      0,
      "stream loss must not invent an assistant completion",
    );
    assert.equal(
      canonical.filter((event) =>
        event.type === "turn/stopped"
        && (event.data as { reason?: string }).reason === "completed").length,
      0,
    );
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

test("two owned projects prompt concurrently and one restarts without touching the other", async () => {
  const base = mkdtempSync(join(tmpdir(), "polyth-two-project-restart-"));
  const directoryA = join(base, "project-a");
  const directoryB = join(base, "project-b");
  mkdirSync(directoryA);
  mkdirSync(directoryB);
  const store = createStore(join(base, "sessions.db"));
  const fakeA = await createFakeOpenCode();
  const fakeB = await createFakeOpenCode();
  const leaseA = await createOwnedFakeLease(fakeA, directoryA);
  const leaseB = await createOwnedFakeLease(fakeB, directoryB);
  const firstA = await reliabilityHarness(fakeA, {
    directory: directoryA,
    store,
    lease: leaseA,
  });
  const harnessB = await reliabilityHarness(fakeB, {
    directory: directoryB,
    store,
    lease: leaseB,
  });
  let restartedA: Awaited<ReturnType<typeof reliabilityHarness>> | undefined;
  try {
    const [sessionA, sessionB] = await Promise.all([
      firstA.sessions.create({ projectId: firstA.project.id, title: "Project A" }),
      harnessB.sessions.create({ projectId: harnessB.project.id, title: "Project B" }),
    ]);
    const backendA = (await store.projection(sessionA.id))!.backendSessionId!;
    const backendB = (await store.projection(sessionB.id))!.backendSessionId!;

    await Promise.all([
      firstA.sessions.send(sessionA.id, { text: "project A first" }),
      harnessB.sessions.send(sessionB.id, { text: "project B first" }),
    ]);
    fakeA.lifecycle.finishTurn(backendA);
    fakeB.lifecycle.finishTurn(backendB);
    await Promise.all([
      firstA.waitForEvent((event) =>
        event.sessionId === sessionA.id && event.type === "turn/stopped"),
      harnessB.waitForEvent((event) =>
        event.sessionId === sessionB.id && event.type === "turn/stopped"),
      waitForCondition(async () => (await store.projection(sessionA.id))?.status === "idle"),
      waitForCondition(async () => (await store.projection(sessionB.id))?.status === "idle"),
    ]);

    const bindingBBefore = structuredClone((await store.projection(sessionB.id))!.runtimeBinding);
    const endpointABefore = firstA.endpoint;
    await firstA.runtime.dispose();
    const restartedLeaseA = await createOwnedFakeLease(fakeA, directoryA);
    restartedA = await reliabilityHarness(fakeA, {
      directory: directoryA,
      store,
      lease: restartedLeaseA,
    });
    assert.equal(restartedA.endpoint.authorityId, endpointABefore.authorityId);
    assert.equal(restartedA.endpoint.generation, endpointABefore.generation + 1);
    await restartedA.sessions.events(sessionA.id, 0);
    const projectionAAfterRestart = (await store.projection(sessionA.id))!;
    const reconciliationAAfterRestart = await store.reconciliation(sessionA.id);
    assert.equal(
      projectionAAfterRestart.status,
      "idle",
      JSON.stringify({
        projection: projectionAAfterRestart,
        reconciliation: reconciliationAAfterRestart,
      }),
    );

    assert.deepEqual(
      (await store.projection(sessionB.id))!.runtimeBinding,
      bindingBBefore,
      "restarting project A must not change project B's runtime binding",
    );
    await Promise.all([
      restartedA.sessions.send(sessionA.id, { text: "project A after restart" }),
      harnessB.sessions.send(sessionB.id, { text: "project B while A restarts" }),
    ]);

    assert.equal(fakeA.lifecycle.session(backendA)?.messages.length, 2);
    assert.equal(fakeB.lifecycle.session(backendB)?.messages.length, 2);
    assert.equal(
      (await store.events(sessionA.id)).filter((event) => event.type === "user/message").length,
      2,
    );
    assert.equal(
      (await store.events(sessionB.id)).filter((event) => event.type === "user/message").length,
      2,
    );
    assert.notEqual(
      join(directoryA, "runtimes", "opencode", "project", "opencode.db"),
      join(directoryB, "runtimes", "opencode", "project", "opencode.db"),
    );
  } finally {
    await firstA.runtime.dispose();
    await restartedA?.runtime.dispose();
    await harnessB.runtime.dispose();
    await store.close();
    await fakeA.close();
    await fakeB.close();
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

test("V2 creates sessions on its native route without fabricating V1 traffic", async () => {
  const fake = await createFakeOpenCode();
  fake.scriptHttp({
    method: "POST",
    path: "/api/session",
    steps: [httpFaults.success({ data: { id: "ses_v2_created" } })],
  });
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
    assert.equal(await runtime.protocol?.(), "v2");
    const outcome = await runtime.createSessionOperation!(
      { projectId: "p-v2", sessionId: "canonical-v2", cwd: directory },
      "operation-v2",
    );
    assert.deepEqual(outcome, {
      kind: "confirmed",
      value: { backendSessionId: "ses_v2_created" },
      receipt: "ses_v2_created",
    });
    assert.equal(fake.requestCount("POST", "/api/session"), 1);
    assert.equal(fake.requestCount("POST", "/session"), 0);
  } finally {
    await runtime.dispose();
    await lifecycle.dispose();
    await fake.close();
  }
});
