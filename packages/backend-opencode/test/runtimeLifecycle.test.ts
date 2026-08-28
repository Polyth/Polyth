import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { ChildProcess, spawn as nodeSpawn } from "node:child_process";
import type {
  AgentRuntime,
  OpenCodeTransport,
  ProtocolAdapter,
  ReplayPolicy,
  RuntimeEndpoint,
} from "@polyth/contracts";
import {
  attachRuntimeLifecycle,
  createOpenCodeRuntimeLifecycle,
  createOpenCodeRuntimeFacade,
} from "../src/index.ts";
import {
  createBorrowedExternalEndpointLease,
  createBorrowedServiceEndpointLease,
  createOwnedLocalEndpointLease,
  createOwnedSshEndpointLease,
  type ProcessIdentity,
} from "../src/endpoint.ts";
import {
  createRuntimeLifecycle,
  waitForRuntimeReady,
} from "../src/runtime.ts";
import { createFakeOpenCode } from "./fakeOpenCode.ts";

interface FakeChild extends ChildProcess {
  observedSignals: NodeJS.Signals[];
}

const createFakeChild = (
  pid: number,
  output: string,
): FakeChild => {
  const emitter = new EventEmitter() as FakeChild;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let killed = false;
  let exitCode: number | null = null;
  let signalCode: NodeJS.Signals | null = null;
  Object.assign(emitter, {
    pid,
    stdout,
    stderr,
    stdin: null,
    stdio: [null, stdout, stderr, null, null],
    connected: false,
    spawnargs: [],
    spawnfile: "opencode",
    observedSignals: [] as NodeJS.Signals[],
    kill(signal: NodeJS.Signals = "SIGTERM") {
      emitter.observedSignals.push(signal);
      killed = true;
      signalCode = signal;
      queueMicrotask(() => emitter.emit("exit", null, signal));
      return true;
    },
    ref() {},
    unref() {},
    disconnect() {},
    send() { return false; },
  });
  Object.defineProperties(emitter, {
    killed: { get: () => killed },
    exitCode: { get: () => exitCode },
    signalCode: { get: () => signalCode },
  });
  setImmediate(() => {
    stderr.write(output);
    if (/EADDRINUSE/i.test(output)) {
      exitCode = 1;
      emitter.emit("exit", 1, null);
    }
  });
  return emitter;
};

test("borrowed ensured and external leases never expose process/config mutation", async () => {
  const calls = { discover: 0, ensure: 0, start: 0, stop: 0, config: 0 };
  let endpointHeaders = { authorization: "Bearer first" };
  let discovered = false;
  const service = {
    async start() { calls.start += 1; },
    async stop() { calls.stop += 1; },
    async writeConfig() { calls.config += 1; },
  };
  void service;

  const shared = await createBorrowedServiceEndpointLease({
    location: { directory: "/workspace/project" },
    async discover() {
      calls.discover += 1;
      if (!discovered) return undefined;
      return {
        url: "http://service.invalid",
        instanceId: "service-a",
        headers: async () => endpointHeaders,
      };
    },
    async ensure() {
      calls.ensure += 1;
      discovered = true;
      return {
        url: "http://service.invalid",
        instanceId: "service-a",
        headers: async () => endpointHeaders,
      };
    },
  });
  const first = await shared.endpoint();
  assert.deepEqual(first.control, { kind: "borrowed", source: "shared" });
  assert.deepEqual(first.config, { kind: "read-only" });
  assert.equal("restart" in shared, false);
  endpointHeaders = { authorization: "Bearer rotated" };
  const rotated = await shared.refresh("unauthorized");
  assert.equal(rotated.generation, first.generation + 1);
  assert.deepEqual(
    first.authentication.kind === "endpoint-headers"
      ? await first.authentication.resolve()
      : {},
    { authorization: "Bearer first" },
  );
  await shared.dispose();
  assert.deepEqual(calls, {
    discover: 2,
    ensure: 1,
    start: 0,
    stop: 0,
    config: 0,
  });

  const oldUsername = process.env.TEST_OC_USERNAME;
  const oldPassword = process.env.TEST_OC_PASSWORD;
  process.env.TEST_OC_USERNAME = "alice";
  process.env.TEST_OC_PASSWORD = "first";
  try {
    const external = await createBorrowedExternalEndpointLease({
      url: "https://external.invalid",
      location: { directory: "/workspace/project" },
      usernameEnv: "TEST_OC_USERNAME",
      passwordEnv: "TEST_OC_PASSWORD",
    });
    const externalFirst = await external.endpoint();
    process.env.TEST_OC_PASSWORD = "second";
    const externalSecond = await external.refresh("unauthorized");
    assert.equal(externalSecond.generation, externalFirst.generation + 1);
    assert.equal("restart" in external, false);
    await external.dispose();
  } finally {
    if (oldUsername === undefined) delete process.env.TEST_OC_USERNAME;
    else process.env.TEST_OC_USERNAME = oldUsername;
    if (oldPassword === undefined) delete process.env.TEST_OC_PASSWORD;
    else process.env.TEST_OC_PASSWORD = oldPassword;
  }
});

test("borrowed daemon rotation rebinds public HTTP and SSE for two active sessions without stopping it", async () => {
  const first = await createFakeOpenCode();
  let second: Awaited<ReturnType<typeof createFakeOpenCode>> | undefined;
  let selected = first;
  const lease = await createBorrowedServiceEndpointLease({
    location: { directory: "/workspace/project" },
    authorityId: "shared-authority",
    async discover() {
      return {
        url: selected.baseUrl,
        authorityId: "shared-authority",
        instanceId: "shared-instance",
        continuity: "verified",
        headers: {},
      };
    },
    async ensure() {
      throw new Error("the shared daemon is already discoverable");
    },
  });
  const lifecycle = await createOpenCodeRuntimeLifecycle({
    lease,
    protocol: "legacy",
    startupDeadlineMs: 500,
    probeDeadlineMs: 100,
    protocolDeadlineMs: 500,
    transport: { queryAttempts: 1 },
  });
  const facade = createOpenCodeRuntimeFacade({
    cwd: "/workspace/project",
    lifecycle,
  });
  const disposeFacade = facade.dispose.bind(facade);
  facade.dispose = async () => {
    await disposeFacade();
    await lifecycle.dispose();
  };
  const runtime = attachRuntimeLifecycle(facade, lifecycle);

  try {
    await first.waitForSseConnections(1);
    const left = await runtime.createSessionOperation!(
      {
        projectId: "project-a",
        sessionId: "canonical-left",
        cwd: "/workspace/project",
      },
      "create-left",
    );
    const right = await runtime.createSessionOperation!(
      {
        projectId: "project-a",
        sessionId: "canonical-right",
        cwd: "/workspace/project",
      },
      "create-right",
    );
    assert.equal(left.kind, "confirmed");
    assert.equal(right.kind, "confirmed");
    if (left.kind !== "confirmed" || right.kind !== "confirmed") {
      assert.fail("both shared-daemon sessions must be created");
    }
    const initial = await runtime.endpoint!();
    await runtime.reconcile!({
      canonicalSessionId: "canonical-left",
      backendSessionId: left.value.backendSessionId,
      authorityId: initial.authorityId,
      generation: initial.generation,
      continuity: initial.continuity,
      location: initial.location,
      reconciliationOrdinal: 1,
    });
    await runtime.reconcile!({
      canonicalSessionId: "canonical-right",
      backendSessionId: right.value.backendSessionId,
      authorityId: initial.authorityId,
      generation: initial.generation,
      continuity: initial.continuity,
      location: initial.location,
      reconciliationOrdinal: 1,
    });
    const observedSessions = new Set<string>();
    let resolveBoth!: () => void;
    const observedBoth = new Promise<void>((resolve) => {
      resolveBoth = resolve;
    });
    const observationSubscription = runtime.onObservation!((sessionId, observation) => {
      assert.equal(observation.identity.generation, initial.generation);
      assert.equal(observation.reconciliationOrdinal, 1);
      observedSessions.add(sessionId);
      if (observedSessions.size === 2) resolveBoth();
    });
    await runtime.startTurnOperation!(
      { sessionId: "canonical-left", text: "left" },
      "turn-left",
    );
    await runtime.startTurnOperation!(
      { sessionId: "canonical-right", text: "right" },
      "turn-right",
    );
    await observedBoth;
    observationSubscription.dispose();

    second = await first.restart();
    selected = second;
    const rotated = await lifecycle.refresh("disconnect");
    assert.equal(rotated.generation, initial.generation + 1);
    await second.waitForSseConnections(1);
    await runtime.reconcile!({
      canonicalSessionId: "canonical-left",
      backendSessionId: left.value.backendSessionId,
      authorityId: rotated.authorityId,
      generation: rotated.generation,
      continuity: rotated.continuity,
      location: rotated.location,
      reconciliationOrdinal: 2,
    });
    await runtime.reconcile!({
      canonicalSessionId: "canonical-right",
      backendSessionId: right.value.backendSessionId,
      authorityId: rotated.authorityId,
      generation: rotated.generation,
      continuity: rotated.continuity,
      location: rotated.location,
      reconciliationOrdinal: 2,
    });
    let resolveRotated!: () => void;
    const observedRotated = new Promise<void>((resolve) => {
      resolveRotated = resolve;
    });
    const rotatedSubscription = runtime.onObservation!((sessionId, observation) => {
      if (sessionId !== "canonical-left") return;
      assert.equal(observation.identity.generation, rotated.generation);
      assert.equal(observation.reconciliationOrdinal, 2);
      resolveRotated();
    });
    second.lifecycle.addPermission(left.value.backendSessionId, {
      id: "permission-after-rotation",
      permission: "bash",
      patterns: ["npm test"],
    });
    await observedRotated;
    rotatedSubscription.dispose();

    const sessions = await runtime.sessions();
    assert.deepEqual(
      sessions.map((session) => session.id).sort(),
      [left.value.backendSessionId, right.value.backendSessionId].sort(),
    );
    assert.ok(second.requestCount("GET", "/session") > 0);
    const oldRequestCount = first.requests().length;
    await runtime.history(left.value.backendSessionId);
    assert.equal(first.requests().length, oldRequestCount);
    assert.ok(second.requestCount("GET", `/session/${left.value.backendSessionId}/message`) > 0);

    await runtime.dispose();
    assert.equal((await fetch(`${first.baseUrl}/global/health`)).status, 200);
    assert.equal((await fetch(`${second.baseUrl}/global/health`)).status, 200);
  } finally {
    await runtime.dispose().catch(() => {});
    await first.close();
    await second?.close();
  }
});

test("owned SSH restart is single-flight and local config remains read-only", async () => {
  let starts = 0;
  const stopped: string[] = [];
  const lease = await createOwnedSshEndpointLease({
    location: { directory: "/srv/worktree", workspace: "feature-a" },
    async start(instanceToken) {
      starts += 1;
      await new Promise((resolveStart) => setTimeout(resolveStart, 5));
      return {
        url: `http://127.0.0.1:${45_000 + starts}`,
        instanceIdentity: `remote:${instanceToken}`,
        async stop() { stopped.push(instanceToken); },
      };
    },
  });
  const initial = await lease.endpoint();
  assert.equal(initial.config.kind, "read-only");
  const [left, right, third] = await Promise.all([
    lease.restart("crash"),
    lease.restart("manual"),
    lease.restart("config"),
  ]);
  assert.equal(starts, 2);
  assert.equal(left.generation, initial.generation + 1);
  assert.equal(right.generation, left.generation);
  assert.equal(third.generation, left.generation);
  assert.equal(left.control.kind, "owned");
  assert.equal(stopped.length, 1);
  await lease.dispose();
  assert.equal(stopped.length, 2);
});

test("PID reuse is rejected without signalling the unrelated process", async () => {
  const directory = await mkdtemp(join(tmpdir(), "polyth-endpoint-pid-"));
  const pidFile = join(directory, "runtime.pid.json");
  const expected: ProcessIdentity = {
    startIdentity: "old-start",
    executable: "/usr/bin/opencode",
    command: "opencode serve --port 41000",
  };
  await writeFile(pidFile, JSON.stringify({
    version: 1,
    ownerPid: process.pid + 1,
    ownerInstanceToken: "old-instance",
    child: { pid: 999, ...expected },
  }));
  const signalled: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
  const child = createFakeChild(
    1001,
    "opencode server listening on http://127.0.0.1:41001\n",
  );
  const spawn = (() => child) as unknown as typeof nodeSpawn;
  try {
    const lease = await createOwnedLocalEndpointLease({
      cwd: directory,
      pidFile,
      pickPort: async () => 41001,
      spawn,
      readProcessIdentity: async (pid) => {
        if (pid === 999) {
          return {
            ...expected,
            startIdentity: "reused-start",
            executable: "/usr/bin/unrelated",
          };
        }
        if (pid === 1001) {
          return {
            startIdentity: "current-start",
            executable: "/usr/bin/opencode",
            command: "opencode serve --port 41001",
          };
        }
        return undefined;
      },
      signalProcess(pid, signal) {
        signalled.push({ pid, signal });
      },
    });
    assert.deepEqual(signalled, []);
    await lease.dispose();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("three local bind collisions select fresh ports and leak no children", async () => {
  const directory = await mkdtemp(join(tmpdir(), "polyth-endpoint-bind-"));
  const ports = [42001, 42002, 42003, 42004];
  const children: FakeChild[] = [];
  const spawn = ((_bin: string, args: readonly string[]) => {
    const port = Number(args.at(-1));
    const collision = port !== 42004;
    const child = createFakeChild(
      2000 + children.length,
      collision
        ? `Error: listen EADDRINUSE 127.0.0.1:${port}\n`
        : `opencode server listening on http://127.0.0.1:${port}\n`,
    );
    children.push(child);
    return child;
  }) as unknown as typeof nodeSpawn;
  try {
    const lease = await createOwnedLocalEndpointLease({
      cwd: directory,
      pidFile: join(directory, "runtime.pid.json"),
      pickPort: async () => ports.shift() ?? 0,
      spawn,
      readProcessIdentity: async (pid) => ({
        startIdentity: `start-${pid}`,
        executable: "/usr/bin/opencode",
        command: `opencode-${pid}`,
      }),
      gracefulStopMs: 20,
    });
    const endpoint = await lease.endpoint();
    assert.equal(endpoint.url, "http://127.0.0.1:42004");
    assert.equal(children.length, 4);
    assert.deepEqual(
      children.slice(0, 3).map(
        (candidate) =>
          candidate.exitCode !== null
          || candidate.signalCode !== null
          || candidate.observedSignals.length > 0,
      ),
      [true, true, true],
    );
    assert.deepEqual(children[3]!.observedSignals, []);
    await lease.dispose();
    assert.deepEqual(children[3]!.observedSignals, ["SIGTERM"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const noOpTransport = (
  onStream?: (callback: (value: unknown) => void) => void,
): OpenCodeTransport => ({
  async query<T>() { return {} as T; },
  async mutate<T>(request: {
    method: "POST" | "PUT" | "PATCH" | "DELETE";
    path: string;
    body?: unknown;
    operationId: string;
    deadlineMs: number;
    replay: ReplayPolicy;
  }) {
    return {
      kind: "unknown",
      operationId: request.operationId,
      message: "unused",
    };
  },
  async stream(request) {
    onStream?.(request.onEvent);
  },
});

const protocolFor = (
  endpoint: RuntimeEndpoint,
  calls: { submit: number },
): ProtocolAdapter => ({
  protocol: "legacy",
  async capabilities() {
    return {
      eventReplay: "none",
      pendingSnapshot: "partial",
      idempotentMutations: new Set(),
    };
  },
  async models() { return []; },
  async agents() { return []; },
  async sessions() { return []; },
  async history() { return []; },
  eventStreamPath() { return "/event"; },
  async ensureSession(_binding, _operationId) {
    return { kind: "confirmed", value: { backendSessionId: "backend-a" } };
  },
  async resetSession(_binding, _title, _operationId) {
    return { kind: "confirmed", value: { backendSessionId: "backend-reset" } };
  },
  async branchSession(_input, _operationId) {
    return { kind: "confirmed", value: { backendSessionId: "backend-branch" } };
  },
  async submit() {
    calls.submit += 1;
    return { kind: "confirmed", value: {} };
  },
  async steer() { return { kind: "confirmed", value: {} }; },
  async abort() { return { kind: "confirmed", value: {} }; },
  async deleteSession() { return { kind: "confirmed", value: {} }; },
  async replyPermission() { return { kind: "confirmed", value: {} }; },
  async replyQuestion() { return { kind: "confirmed", value: {} }; },
  async reconcile(binding) {
    return {
      authorityId: endpoint.authorityId,
      generation: endpoint.generation,
      location: endpoint.location,
      backendSessionId: binding.backendSessionId ?? "",
      reconciliationOrdinal: 1,
      state: { value: "idle" },
      completeness: {
        events: "partial",
        permissions: "partial",
        questions: "partial",
      },
      permissions: [],
      questions: [],
      events: [],
    };
  },
});

test("runtime discards late old-generation callbacks before translation", async () => {
  let starts = 0;
  const callbacks: Array<(value: unknown) => void> = [];
  const calls = { submit: 0 };
  const lease = await createOwnedSshEndpointLease({
    location: { directory: "/srv/project" },
    async start(instanceToken) {
      starts += 1;
      return {
        url: `http://127.0.0.1:${46_000 + starts}`,
        instanceIdentity: instanceToken,
        async stop() {},
      };
    },
  });
  const runtime = await createRuntimeLifecycle({
    lease,
    createTransport: () => noOpTransport((callback) => callbacks.push(callback)),
    createProtocol: (_transport, endpoint) => protocolFor(endpoint, calls),
  });
  let translated = 0;
  let observedGeneration = 0;
  await runtime.stream("/event", {
    signal: new AbortController().signal,
    onEvent(observation) {
      translated += 1;
      observedGeneration = observation.generation;
      assert.deepEqual(observation.value, { current: true });
    },
  });
  assert.equal(callbacks.length, 1);
  assert.equal(runtime.control.kind, "owned");
  if (runtime.control.kind !== "owned" || !("restart" in runtime)) {
    assert.fail("owned runtime must expose restart");
  }
  const restarted = await runtime.restart("crash");
  callbacks[0]!({ old: true });
  assert.equal(translated, 0);
  await runtime.stream("/event", {
    signal: new AbortController().signal,
    onEvent(observation) {
      translated += 1;
      observedGeneration = observation.generation;
      assert.deepEqual(observation.value, { current: true });
    },
  });
  callbacks[1]!({ current: true });
  assert.equal(translated, 1);
  assert.equal(observedGeneration, restarted.generation);
  await runtime.dispose();
});

test("attached runtimes notify consumers after endpoint generation replacement", async () => {
  let starts = 0;
  const calls = { submit: 0 };
  const lease = await createOwnedSshEndpointLease({
    location: { directory: "/srv/project" },
    async start(instanceToken) {
      starts += 1;
      return {
        url: `http://127.0.0.1:${46_500 + starts}`,
        instanceIdentity: instanceToken,
        async stop() {},
      };
    },
  });
  const lifecycle = await createRuntimeLifecycle({
    lease,
    createTransport: () => noOpTransport(),
    createProtocol: (_transport, endpoint) => protocolFor(endpoint, calls),
  });
  const facade: AgentRuntime = {
    capabilities: async () => ({
      streaming: true,
      permissions: true,
      questions: true,
      compaction: false,
      subagents: false,
    }),
    models: async () => [],
    agents: async () => [],
    ensureSession: async () => "backend-a",
    sessions: async () => [],
    history: async () => [],
    startTurn: async () => {},
    abort: async () => {},
    replyPermission: async () => {},
    replyQuestion: async () => {},
    onEvent: () => ({ dispose() {} }),
    dispose: async () => {},
  };
  const managed = attachRuntimeLifecycle(facade, lifecycle);
  const notifications: Array<{
    type: string;
    generation?: number;
    reason?: string;
  }> = [];
  const subscription = managed.onLifecycle!((notification) => {
    notifications.push(notification);
  });
  try {
    const initial = await lifecycle.endpoint();
    if (lifecycle.control.kind !== "owned" || !("restart" in lifecycle)) {
      assert.fail("owned runtime must expose restart");
    }
    const restarted = await lifecycle.restart("config");
    assert.equal(restarted.generation, initial.generation + 1);
    assert.deepEqual(notifications, [{
      type: "endpoint-replaced",
      authorityId: restarted.authorityId,
      generation: restarted.generation,
      reason: "config",
    }]);

    subscription.dispose();
    await lifecycle.restart("manual");
    assert.equal(notifications.length, 1);
  } finally {
    subscription.dispose();
    await lifecycle.dispose();
  }
});

test("runtime rejects stale generation bindings before protocol I/O", async () => {
  let starts = 0;
  const calls = { submit: 0 };
  const lease = await createOwnedSshEndpointLease({
    location: { directory: "/srv/project" },
    async start(instanceToken) {
      starts += 1;
      return {
        url: `http://127.0.0.1:${47_000 + starts}`,
        instanceIdentity: instanceToken,
        async stop() {},
      };
    },
  });
  const runtime = await createRuntimeLifecycle({
    lease,
    createTransport: () => noOpTransport(),
    createProtocol: (_transport, endpoint) => protocolFor(endpoint, calls),
  });
  const endpoint = await runtime.endpoint();
  const binding = {
    canonicalSessionId: "canonical-a",
    authorityId: endpoint.authorityId,
    generation: endpoint.generation,
    continuity: endpoint.continuity,
    location: endpoint.location,
    protocol: "legacy" as const,
  };
  const ensured = await runtime.ensureSession(binding, "operation-create");
  assert.equal(ensured.kind, "confirmed");
  if (runtime.control.kind !== "owned" || !("restart" in runtime)) {
    assert.fail("owned runtime must expose restart");
  }
  await runtime.restart("crash");
  await assert.rejects(
    () => runtime.submit({
      session: { ...binding, backendSessionId: "backend-a" },
      text: "must not send",
    }, "operation-submit"),
    (error: Error & { code?: string }) => error.code === "binding-mismatch",
  );
  assert.equal(calls.submit, 0);
  await runtime.dispose();
});

test("failed replacement cannot reactivate the stopped generation", async () => {
  let starts = 0;
  const builtGenerations: number[] = [];
  const lease = await createOwnedSshEndpointLease({
    location: { directory: "/srv/project" },
    async start(instanceToken) {
      starts += 1;
      if (starts === 2) throw new Error("replacement failed");
      return {
        url: `http://127.0.0.1:${48_000 + starts}`,
        instanceIdentity: instanceToken,
        async stop() {},
      };
    },
  });
  const runtime = await createRuntimeLifecycle({
    lease,
    createTransport: () => noOpTransport(),
    createProtocol: (_transport, endpoint) => {
      builtGenerations.push(endpoint.generation);
      return protocolFor(endpoint, { submit: 0 });
    },
  });
  const initial = await runtime.endpoint();
  assert.equal(initial.generation, 1);
  if (runtime.control.kind !== "owned" || !("restart" in runtime)) {
    assert.fail("owned runtime must expose restart");
  }

  await assert.rejects(() => runtime.restart("crash"), /replacement failed/);
  const recovered = await runtime.endpoint();
  assert.equal(recovered.generation, 2);
  assert.notEqual(recovered.url, initial.url);
  assert.deepEqual(builtGenerations, [1, 2]);
  await runtime.dispose();
});

test("waitReady bounds a transport probe that ignores its own deadline", async () => {
  const transport: OpenCodeTransport = {
    async query<T>() {
      return await new Promise<T>(() => {});
    },
    async mutate<T>(request: {
      method: "POST" | "PUT" | "PATCH" | "DELETE";
      path: string;
      body?: unknown;
      operationId: string;
      deadlineMs: number;
      replay: ReplayPolicy;
    }) {
      return {
        kind: "unknown",
        operationId: request.operationId,
        message: "unused",
      };
    },
    async stream() {},
  };
  const startedAt = Date.now();
  await assert.rejects(
    () => waitForRuntimeReady(transport, {
      startupDeadlineMs: 80,
      probeDeadlineMs: 20,
      retryDelayMs: 1,
      paths: ["/hung"],
    }),
    /not ready within 80ms/,
  );
  assert.ok(Date.now() - startedAt < 500);
});
