import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  createBorrowedExternalEndpointLease,
  createBorrowedServiceEndpointLease,
  createOwnedLocalEndpointLease,
  createOwnedSshEndpointLease,
  createRuntimeLifecycle,
  DEFAULT_RUNTIME_READY_PATHS,
  waitForRuntimeReady,
  OPENCODE_UPDATE_DISABLE_ENV,
  POLYTH_OPENCODE_BIN_ENV,
  type OwnedLocalEndpointOptions,
  type ProcessIdentity,
  type OpenCodeEngineIdentity,
} from "../src/index.ts";
import { createFakeOpenCode } from "./fakeOpenCode.ts";

interface FakeChild extends ChildProcess {
  observedSignals: NodeJS.Signals[];
}

const TEST_ENGINE: OpenCodeEngineIdentity = {
  engine: "opencode",
  version: "1.18.18",
  binaryDigest: "a".repeat(64),
  protocolGeneration: 1,
};

const resolveTestBinary: NonNullable<OwnedLocalEndpointOptions["resolveBinary"]> = async (
  options,
) => ({
  executablePath: resolve("/test-opencode-binaries", options.bin ?? "opencode"),
  binarySource: options.binarySource ?? (options.bin ? "configured" : "path"),
});

const isolatedLocalOptions = (directory: string, projectId = "project-a") => ({
  projectId,
  runtimeDir: join(directory, "isolated-runtime"),
  resolveBinary: resolveTestBinary,
  inspectEngine: async () => TEST_ENGINE,
});

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

test("owned local runtimes require and export exact isolated writable DB paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "polyth-db-isolation-"));
  const worktreeA = join(directory, "worktree-a");
  const worktreeB = join(directory, "worktree-b");
  const runtimeA = join(directory, "runtimes", "runtime-a");
  const runtimeB = join(directory, "runtimes", "runtime-b");
  await Promise.all([
    mkdir(worktreeA, { recursive: true }),
    mkdir(worktreeB, { recursive: true }),
  ]);
  const environments: NodeJS.ProcessEnv[] = [];
  let nextPid = 7000;
  const fakeSpawn = ((
    _bin: string,
    args: readonly string[],
    spawnOptions: { env?: NodeJS.ProcessEnv },
  ) => {
    const env = spawnOptions.env ?? {};
    environments.push(env);
    assert.ok(env.OPENCODE_DB, "owned spawn must always receive OPENCODE_DB");
    writeFileSync(env.OPENCODE_DB, "opaque OpenCode database bytes", { mode: 0o666 });
    return createFakeChild(
      nextPid++,
      `opencode server listening on http://127.0.0.1:${Number(args.at(-1))}\n`,
    );
  }) as unknown as typeof nodeSpawn;
  const leases: Array<Awaited<ReturnType<typeof createOwnedLocalEndpointLease>>> = [];
  const previousGlobalDb = process.env.OPENCODE_DB;
  const globalDb = join(directory, "forbidden-global.db");
  const newerGlobalBytes = "newer OpenCode schema that Polyth must never open";
  await writeFile(globalDb, newerGlobalBytes, { mode: 0o600 });
  process.env.OPENCODE_DB = globalDb;
  try {
    for (const [projectId, cwd, runtimeDir, port] of [
      ["project-a", worktreeA, runtimeA, 43101],
      ["project-b", worktreeB, runtimeB, 43102],
    ] as const) {
      const lease = await createOwnedLocalEndpointLease({
        projectId,
        cwd,
        runtimeDir,
        configDir: join(directory, "config"),
        resolveBinary: resolveTestBinary,
        inspectEngine: async () => TEST_ENGINE,
        spawn: fakeSpawn,
        pickPort: async () => port,
        pidFile: join(directory, `${projectId}.pid.json`),
        stateFile: join(directory, `${projectId}.lease.json`),
        readProcessIdentity: async (pid) => ({
          startIdentity: `start-${pid}`,
          executable: "/usr/bin/opencode",
          command: `opencode-${pid}`,
        }),
        gracefulStopMs: 20,
      });
      leases.push(lease);
      const endpoint = await lease.endpoint();
      const metadataRaw = await readFile(join(runtimeDir, "runtime.json"), "utf8");
      const metadata = JSON.parse(metadataRaw) as Record<string, unknown>;
      assert.equal(metadata.runtimeAuthority, endpoint.authorityId);
      assert.deepEqual(metadata.runtimeLocation, { projectId, cwd });
      assert.equal(metadata.engine, "opencode");
      assert.equal(metadata.version, TEST_ENGINE.version);
      assert.equal(metadata.binaryDigest, TEST_ENGINE.binaryDigest);
      assert.equal(metadata.protocolGeneration, TEST_ENGINE.protocolGeneration);
      assert.equal(metadata.binarySource, "path");
      assert.equal(metadata.binaryPath, resolve("/test-opencode-binaries/opencode"));
      assert.match(
        String(metadata.storageId),
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      assert.equal(/session|message/i.test(metadataRaw), false);
      assert.equal((await stat(runtimeDir)).mode & 0o777, 0o700);
      assert.equal((await stat(join(runtimeDir, "runtime.json"))).mode & 0o777, 0o600);
      assert.equal((await stat(join(runtimeDir, "opencode.db"))).mode & 0o777, 0o600);
      await writeFile(join(runtimeDir, "opencode.db"), "writable", { flag: "a" });
    }

    assert.deepEqual(
      environments.map((env) => env.OPENCODE_DB),
      [join(runtimeA, "opencode.db"), join(runtimeB, "opencode.db")],
    );
    assert.equal(new Set(environments.map((env) => env.OPENCODE_DB)).size, 2);
    assert.ok(environments.every((env) =>
      env.OPENCODE_CONFIG_DIR === join(directory, "config")));
    assert.ok(environments.every((env) =>
      env[OPENCODE_UPDATE_DISABLE_ENV] === "true"));
    assert.equal(
      await readFile(globalDb, "utf8"),
      newerGlobalBytes,
      "an ambient global DB modified by another OpenCode version must remain untouched",
    );
  } finally {
    if (previousGlobalDb === undefined) delete process.env.OPENCODE_DB;
    else process.env.OPENCODE_DB = previousGlobalDb;
    await Promise.all(leases.map((lease) => lease.dispose()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("default local process records separate servers sharing one project and worktree", async () => {
  const directory = await mkdtemp(join(tmpdir(), "polyth-local-process-isolation-"));
  const leases: Array<Awaited<ReturnType<typeof createOwnedLocalEndpointLease>>> = [];
  let nextPid = 7050;
  const fakeSpawn = ((
    _bin: string,
    args: readonly string[],
    spawnOptions: { env?: NodeJS.ProcessEnv },
  ) => {
    const isolatedDb = spawnOptions.env?.OPENCODE_DB;
    assert.ok(isolatedDb);
    writeFileSync(isolatedDb, `opaque database ${nextPid}`, { mode: 0o600 });
    return createFakeChild(
      nextPid++,
      `opencode server listening on http://127.0.0.1:${Number(args.at(-1))}\n`,
    );
  }) as unknown as typeof nodeSpawn;
  const boot = async (runtimeId: string, port: number) => {
    const lease = await createOwnedLocalEndpointLease({
      projectId: "project-a",
      cwd: directory,
      runtimeDir: join(directory, "runtimes", runtimeId),
      stateFile: join(directory, "state", `${runtimeId}.lease.json`),
      resolveBinary: resolveTestBinary,
      inspectEngine: async () => TEST_ENGINE,
      spawn: fakeSpawn,
      pickPort: async () => port,
      readProcessIdentity: async (pid) => ({
        startIdentity: `start-${pid}`,
        executable: "/usr/bin/opencode",
        command: `opencode-${pid}`,
      }),
      gracefulStopMs: 20,
    });
    leases.push(lease);
    return lease.endpoint();
  };

  try {
    const first = await boot("server-a", 43111);
    const second = await boot("server-b", 43112);
    assert.notEqual(first.authorityId, second.authorityId);
  } finally {
    await Promise.all(leases.map((lease) => lease.dispose()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("owned local startup fails before spawn when isolation cannot be established", async () => {
  const directory = await mkdtemp(join(tmpdir(), "polyth-db-fail-closed-"));
  const runtimeFile = join(directory, "not-a-directory");
  await writeFile(runtimeFile, "occupied");
  let spawned = false;
  const base = {
    projectId: "project-a",
    cwd: directory,
    inspectEngine: async () => TEST_ENGINE,
    resolveBinary: resolveTestBinary,
    spawn: (() => {
      spawned = true;
      return createFakeChild(7100, "");
    }) as unknown as typeof nodeSpawn,
  };
  try {
    await assert.rejects(
      () => createOwnedLocalEndpointLease(base),
      /runtimeDir is required.*global OpenCode DB/,
    );
    await assert.rejects(
      () => createOwnedLocalEndpointLease({ ...base, runtimeDir: runtimeFile }),
      /could not create isolated OpenCode runtime directory/,
    );
    assert.equal(spawned, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

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
      ...isolatedLocalOptions(directory),
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

test("separate runtime directories do not reap each other's local child", async () => {
  const directory = await mkdtemp(join(tmpdir(), "polyth-endpoint-instances-"));
  const runtimeA = join(directory, "instance-a");
  const runtimeB = join(directory, "instance-b");
  const children: FakeChild[] = [];
  const signalled: number[] = [];
  const spawn = ((_bin: string, args: readonly string[]) => {
    const child = createFakeChild(
      1100 + children.length,
      `opencode server listening on http://127.0.0.1:${args.at(-1)}\n`,
    );
    children.push(child);
    return child;
  }) as unknown as typeof nodeSpawn;
  const makeLease = (runtimeDir: string, port: number) => createOwnedLocalEndpointLease({
    ...isolatedLocalOptions(directory),
    runtimeDir,
    cwd: directory,
    pickPort: async () => port,
    spawn,
    readProcessIdentity: async (pid) => ({
      startIdentity: `start-${pid}`,
      executable: "/usr/bin/opencode",
      command: `opencode-${pid}`,
    }),
    signalProcess(pid) { signalled.push(pid); },
    gracefulStopMs: 20,
  });
  try {
    const first = await makeLease(runtimeA, 41001);
    await first.endpoint();
    const second = await makeLease(runtimeB, 41002);
    await second.endpoint();

    assert.deepEqual(signalled, []);
    assert.equal(children.length, 2);
    await stat(join(runtimeA, "opencode.pid.json"));
    await stat(join(runtimeB, "opencode.pid.json"));
    await Promise.all([first.dispose(), second.dispose()]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// Phase-4 regression (OC-REAL-059): when the owned child dies but the
// one-shot post-disconnect refresh raced ahead of Node's exit notification,
// every later acquisition goes through lease.endpoint(). Handing out the dead
// generation there wedges the runtime permanently (negotiation fails against a
// closed port forever); the lease must respawn once the instance is known-dead.
test("endpoint() never hands out a dead owned child; it respawns", async () => {
  const directory = await mkdtemp(join(tmpdir(), "polyth-endpoint-dead-"));
  const ports = [43001, 43002];
  const children: FakeChild[] = [];
  const spawn = ((_bin: string, args: readonly string[], spawnOptions: { env?: NodeJS.ProcessEnv }) => {
    const port = Number(args.at(-1));
    const isolatedDb = spawnOptions.env?.OPENCODE_DB;
    assert.ok(isolatedDb);
    writeFileSync(isolatedDb, `opaque database ${port}`, { mode: 0o600 });
    const child = createFakeChild(
      3000 + children.length,
      `opencode server listening on http://127.0.0.1:${port}\n`,
    );
    children.push(child);
    return child;
  }) as unknown as typeof nodeSpawn;
  try {
    const lease = await createOwnedLocalEndpointLease({
      ...isolatedLocalOptions(directory),
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
    const first = await lease.endpoint();
    assert.equal(first.url, "http://127.0.0.1:43001");
    assert.equal(children.length, 1);

    // The child dies out-of-band (SIGKILL); no refresh() is ever called —
    // exactly the wedged path where only endpoint() runs afterwards.
    children[0]!.kill("SIGKILL");
    await new Promise((resolveTick) => setImmediate(resolveTick));

    const second = await lease.endpoint();
    assert.equal(second.url, "http://127.0.0.1:43002");
    assert.notEqual(second.generation, first.generation);
    assert.equal(children.length, 2);
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
      ...isolatedLocalOptions(directory),
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

test("deleting owned runtime storage mints a new authority for the same engine", async () => {
  const directory = await mkdtemp(join(tmpdir(), "polyth-runtime-storage-loss-"));
  const runtimeDir = join(directory, "runtimes", "opencode", "project-a");
  const stateFile = join(directory, "opencode-local", "project-a.lease.json");
  let nextPid = 8000;
  const boot = (port: number) => createOwnedLocalEndpointLease({
    projectId: "project-a",
    cwd: directory,
    runtimeDir,
    stateFile,
    pidFile: join(directory, "runtime.pid.json"),
    inspectEngine: async () => TEST_ENGINE,
    resolveBinary: resolveTestBinary,
    pickPort: async () => port,
    spawn: ((_bin: string, args: readonly string[], spawnOptions: { env?: NodeJS.ProcessEnv }) => {
      const isolatedDb = spawnOptions.env?.OPENCODE_DB;
      assert.ok(isolatedDb);
      writeFileSync(isolatedDb, `opaque database ${nextPid}`, { mode: 0o600 });
      return createFakeChild(
        nextPid++,
        `opencode server listening on http://127.0.0.1:${Number(args.at(-1))}\n`,
      );
    }) as unknown as typeof nodeSpawn,
    readProcessIdentity: async (pid) => ({
      startIdentity: `start-${pid}`,
      executable: "/usr/bin/opencode",
      command: `opencode-${pid}`,
    }),
    gracefulStopMs: 20,
  });
  let firstLease: Awaited<ReturnType<typeof boot>> | undefined;
  let secondLease: Awaited<ReturnType<typeof boot>> | undefined;
  let thirdLease: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    firstLease = await boot(43201);
    const original = await firstLease.endpoint();
    const originalMetadata = JSON.parse(
      await readFile(join(runtimeDir, "runtime.json"), "utf8"),
    ) as { storageId: string };
    await firstLease.dispose();
    firstLease = undefined;

    const metadataBeforeLoss = await readFile(join(runtimeDir, "runtime.json"), "utf8");
    await rm(join(runtimeDir, "opencode.db"), { force: true });
    secondLease = await boot(43202);
    const replacement = await secondLease.endpoint();
    const replacementMetadata = JSON.parse(
      await readFile(join(runtimeDir, "runtime.json"), "utf8"),
    ) as { storageId: string };

    assert.ok(metadataBeforeLoss, "runtime metadata deliberately survives the DB deletion");
    assert.notEqual(replacementMetadata.storageId, originalMetadata.storageId);
    assert.notEqual(replacement.authorityId, original.authorityId);
    assert.equal(replacement.generation, 1);

    await secondLease.dispose();
    secondLease = undefined;
    const unrelatedDb = join(directory, "unrelated-global.db");
    await writeFile(unrelatedDb, "unrelated newer database", { mode: 0o600 });
    await rm(join(runtimeDir, "opencode.db"), { force: true });
    await symlink(unrelatedDb, join(runtimeDir, "opencode.db"));
    thirdLease = await boot(43203);
    const afterUnsafePath = await thirdLease.endpoint();
    assert.notEqual(afterUnsafePath.authorityId, replacement.authorityId);
    assert.equal(afterUnsafePath.generation, 1);
    assert.equal(
      await readFile(unrelatedDb, "utf8"),
      "unrelated newer database",
      "an owned worker must not follow a tampered DB symlink",
    );

    const lifecycle = await createRuntimeLifecycle({
      lease: thirdLease,
      createTransport: () => noOpTransport(),
      createProtocol: (_transport, endpoint) =>
        protocolFor(endpoint, { submit: 0 }),
    });
    thirdLease = undefined;
    try {
      await assert.rejects(
        () => lifecycle.ensureSession({
          canonicalSessionId: "canonical-before-storage-loss",
          backendSessionId: "backend-before-storage-loss",
          authorityId: original.authorityId,
          generation: original.generation,
          continuity: original.continuity,
          location: original.location,
          protocol: "legacy",
        }, "operation-before-storage-loss"),
        (error: Error & { code?: string }) => error.code === "binding-mismatch",
      );
    } finally {
      await lifecycle.dispose();
    }
  } finally {
    await firstLease?.dispose();
    await secondLease?.dispose();
    await thirdLease?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("developer override is spawned and recorded instead of the PATH binary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "polyth-opencode-override-"));
  const pathDirectory = join(directory, "path-bin");
  const pathBinary = join(pathDirectory, "opencode");
  const overrideBinary = join(directory, "override-opencode");
  await mkdir(pathDirectory);
  await Promise.all([
    writeFile(pathBinary, "#!/bin/sh\nexit 0\n"),
    writeFile(overrideBinary, "#!/bin/sh\nexit 0\n"),
  ]);
  await Promise.all([chmod(pathBinary, 0o700), chmod(overrideBinary, 0o700)]);
  const previousPath = process.env.PATH;
  const previousOverride = process.env[POLYTH_OPENCODE_BIN_ENV];
  process.env.PATH = pathDirectory;
  process.env[POLYTH_OPENCODE_BIN_ENV] = overrideBinary;
  let spawnedBinary = "";
  let inspectedBinary = "";
  let lease: Awaited<ReturnType<typeof createOwnedLocalEndpointLease>> | undefined;
  try {
    lease = await createOwnedLocalEndpointLease({
      projectId: "project-override",
      cwd: directory,
      runtimeDir: join(directory, "runtime"),
      stateFile: join(directory, "runtime.lease.json"),
      pidFile: join(directory, "runtime.pid.json"),
      inspectEngine: async (binary) => {
        inspectedBinary = binary;
        return TEST_ENGINE;
      },
      pickPort: async () => 43211,
      spawn: ((binary: string, args: readonly string[]) => {
        spawnedBinary = binary;
        return createFakeChild(
          8111,
          `opencode server listening on http://127.0.0.1:${Number(args.at(-1))}\n`,
        );
      }) as unknown as typeof nodeSpawn,
      readProcessIdentity: async (pid) => ({
        startIdentity: `start-${pid}`,
        executable: overrideBinary,
        command: `${overrideBinary} serve`,
      }),
      gracefulStopMs: 20,
    });
    const selected = resolve(overrideBinary);
    assert.equal(inspectedBinary, selected);
    assert.equal(spawnedBinary, selected);
    const recorded = JSON.parse(
      await readFile(join(directory, "runtime", "runtime.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(recorded.binarySource, "override");
    assert.equal(recorded.binaryPath, selected);
    assert.equal(recorded.binaryOverrideEnv, POLYTH_OPENCODE_BIN_ENV);
  } finally {
    await lease?.dispose();
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousOverride === undefined) delete process.env[POLYTH_OPENCODE_BIN_ENV];
    else process.env[POLYTH_OPENCODE_BIN_ENV] = previousOverride;
    await rm(directory, { recursive: true, force: true });
  }
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

test("waitReady does not treat /provider or /agent as default liveness", () => {
  assert.deepEqual([...DEFAULT_RUNTIME_READY_PATHS], ["/global/health", "/api/health"]);
});

test("waitReady returns as soon as any health path succeeds without waiting on a hung sibling", async () => {
  const transport: OpenCodeTransport = {
    async query<T>(request: { method: "GET" | "HEAD"; path: string; deadlineMs: number }) {
      if (request.path === "/global/health") {
        await new Promise((resolveHang) => setTimeout(resolveHang, request.deadlineMs + 50));
        throw new Error("hung health");
      }
      return { status: 200, body: { healthy: true } } as T;
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
  await waitForRuntimeReady(transport, {
    startupDeadlineMs: 1_000,
    probeDeadlineMs: 400,
    retryDelayMs: 1,
    paths: ["/global/health", "/api/health"],
  });
  assert.ok(
    Date.now() - startedAt < 150,
    "a ready sibling must not wait for a hung health path",
  );
});
