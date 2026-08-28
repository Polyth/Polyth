import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { ChildProcess, spawn as nodeSpawn } from "node:child_process";
import type {
  OpenCodeTransport,
  ProtocolAdapter,
  RuntimeEndpoint,
} from "@polyth/contracts";
import {
  createOwnedLocalEndpointLease,
  createOwnedSshEndpointLease,
  type OwnedLocalEndpointOptions,
} from "../src/endpoint.ts";
import { createRuntimeLifecycle } from "../src/runtime.ts";

const createFakeChild = (pid: number, port: number): ChildProcess => {
  const emitter = new EventEmitter() as ChildProcess;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
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
    kill(signal: NodeJS.Signals = "SIGTERM") {
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
    killed: { get: () => signalCode !== null },
    exitCode: { get: () => null },
    signalCode: { get: () => signalCode },
  });
  setImmediate(() => {
    stderr.write(`opencode server listening on http://127.0.0.1:${port}\n`);
  });
  return emitter;
};

const createLeaseBooter = (
  directory: string,
  options: Pick<
    OwnedLocalEndpointOptions,
    "authorityId" | "bin" | "dataDir" | "pidFile" | "stateFile"
  > = {},
) => {
  let nextPid = 5000;
  return async (port: number) =>
    createOwnedLocalEndpointLease({
      cwd: directory,
      pidFile: join(directory, "runtime.pid.json"),
      pickPort: async () => port,
      spawn: ((_bin: string, args: readonly string[]) =>
        createFakeChild(nextPid++, Number(args.at(-1)))) as unknown as typeof nodeSpawn,
      readProcessIdentity: async (pid) => ({
        startIdentity: `start-${pid}`,
        executable: "/usr/bin/opencode",
        command: `opencode-${pid}`,
      }),
      gracefulStopMs: 20,
      ...options,
    });
};

const noOpTransport = (): OpenCodeTransport => ({
  async query<T>() { return {} as T; },
  async mutate<T>(request: Parameters<OpenCodeTransport["mutate"]>[0]) {
    return {
      kind: "unknown",
      operationId: request.operationId,
      message: "unused",
    };
  },
  async stream() {},
});

const protocolFor = (
  endpoint: RuntimeEndpoint,
  onEnsure: () => void,
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
  async ensureSession() {
    onEnsure();
    return { kind: "confirmed", value: { backendSessionId: "backend-a" } };
  },
  async resetSession() {
    return { kind: "confirmed", value: { backendSessionId: "backend-reset" } };
  },
  async branchSession() {
    return { kind: "confirmed", value: { backendSessionId: "backend-branch" } };
  },
  async submit() { return { kind: "confirmed", value: {} }; },
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
      reconciliationOrdinal: binding.reconciliationOrdinal ?? 1,
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

test("owned authority is stable and generation advances across Polyth restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "polyth-authority-restart-"));
  const bootLease = createLeaseBooter(directory);
  try {
    const firstBoot = await bootLease(44001);
    const persisted = await firstBoot.endpoint();
    await firstBoot.dispose();

    const secondBoot = await bootLease(44002);
    const restarted = await secondBoot.endpoint();
    await secondBoot.dispose();

    assert.equal(restarted.authorityId, persisted.authorityId);
    assert.equal(
      restarted.generation,
      persisted.generation + 1,
      "the recovered lease reused a prior-process generation",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("local authority survives deletion of temporary PID state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "polyth-authority-durable-"));
  const volatileDirectory = join(directory, "tmp");
  const stateFile = join(directory, "data", "local-runtime.lease.json");
  const pidFile = join(volatileDirectory, "runtime.pid.json");
  await mkdir(volatileDirectory, { recursive: true });
  const bootLease = createLeaseBooter(directory, { pidFile, stateFile });
  try {
    const firstBoot = await bootLease(44011);
    const persisted = await firstBoot.endpoint();
    await firstBoot.dispose();

    await rm(volatileDirectory, { recursive: true, force: true });
    await mkdir(volatileDirectory, { recursive: true });

    const secondBoot = await bootLease(44012);
    const restarted = await secondBoot.endpoint();
    await secondBoot.dispose();

    assert.equal(restarted.authorityId, persisted.authorityId);
    assert.equal(restarted.generation, persisted.generation + 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("configured authority remains valid across identity rotation and two restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "polyth-configured-authority-"));
  const stateFile = join(directory, "local-runtime.lease.json");
  const authorityId = "owned:configured-local";
  try {
    const originalLease = await createLeaseBooter(directory, {
      authorityId,
      bin: "opencode-v1",
      stateFile,
    })(44021);
    const original = await originalLease.endpoint();
    await originalLease.dispose();

    const rotatedLease = await createLeaseBooter(directory, {
      authorityId,
      bin: "opencode-v2",
      stateFile,
    })(44022);
    const rotated = await rotatedLease.endpoint();
    await rotatedLease.dispose();

    const restartedLease = await createLeaseBooter(directory, {
      authorityId,
      bin: "opencode-v2",
      stateFile,
    })(44023);
    const restarted = await restartedLease.endpoint();
    await restartedLease.dispose();

    assert.equal(original.authorityId, authorityId);
    assert.equal(rotated.authorityId, authorityId);
    assert.equal(restarted.authorityId, authorityId);
    assert.equal(rotated.generation, original.generation + 1);
    assert.equal(restarted.generation, rotated.generation + 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("local binary and config-directory identity changes rotate generated authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "polyth-local-identity-"));
  const stateFile = join(directory, "local-runtime.lease.json");
  try {
    const originalLease = await createLeaseBooter(directory, {
      bin: "opencode-v1",
      dataDir: join(directory, "config-a"),
      stateFile,
    })(44031);
    const original = await originalLease.endpoint();
    await originalLease.dispose();

    const binaryLease = await createLeaseBooter(directory, {
      bin: "opencode-v2",
      dataDir: join(directory, "config-a"),
      stateFile,
    })(44032);
    const binaryChanged = await binaryLease.endpoint();
    await binaryLease.dispose();

    const configLease = await createLeaseBooter(directory, {
      bin: "opencode-v2",
      dataDir: join(directory, "config-b"),
      stateFile,
    })(44033);
    const configChanged = await configLease.endpoint();
    await configLease.dispose();

    assert.notEqual(binaryChanged.authorityId, original.authorityId);
    assert.notEqual(configChanged.authorityId, binaryChanged.authorityId);
    assert.equal(binaryChanged.generation, 1);
    assert.equal(configChanged.generation, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("v1 local state migrates from the temporary PID path without losing authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "polyth-v1-authority-"));
  const pidFile = join(directory, "tmp", "runtime.pid.json");
  const stateFile = join(directory, "data", "local-runtime.lease.json");
  const legacyStateFile = `${pidFile}.lease.json`;
  await mkdir(join(directory, "tmp"), { recursive: true });
  await writeFile(legacyStateFile, JSON.stringify({
    version: 1,
    authorityId: "owned:from-v1",
    generation: 7,
  }));
  const bootLease = createLeaseBooter(directory, { pidFile, stateFile });
  try {
    const migratedLease = await bootLease(44041);
    const migrated = await migratedLease.endpoint();
    await migratedLease.dispose();

    const restartedLease = await bootLease(44042);
    const restarted = await restartedLease.endpoint();
    await restartedLease.dispose();

    assert.equal(migrated.authorityId, "owned:from-v1");
    assert.equal(migrated.generation, 8);
    assert.equal(restarted.authorityId, migrated.authorityId);
    assert.equal(restarted.generation, 9);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("SSH-owned authority is stable and generation advances across Polyth restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "polyth-ssh-authority-restart-"));
  const stateFile = join(directory, "remote-runtime.lease.json");
  let starts = 0;
  const bootLease = () => createOwnedSshEndpointLease({
    location: { directory: "/srv/remote-project" },
    stateFile,
    runtimeIdentity: "ssh-connection-a:host-a:/srv/remote-project:opencode",
    async start(instanceToken) {
      starts += 1;
      let stopped = false;
      return {
        url: `http://127.0.0.1:${45_000 + starts}`,
        instanceIdentity: `${instanceToken}:remote-${starts}`,
        alive: () => !stopped,
        async stop() {
          stopped = true;
        },
      };
    },
  });

  try {
    const firstBoot = await bootLease();
    const persisted = await firstBoot.endpoint();
    await firstBoot.dispose();

    const secondBoot = await bootLease();
    const restarted = await secondBoot.endpoint();
    await secondBoot.dispose();

    assert.equal(restarted.authorityId, persisted.authorityId);
    assert.equal(restarted.generation, persisted.generation + 1);
    assert.equal(starts, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const durableSshLease = (
  stateFile: string,
  runtimeIdentity: string,
  remotePath: string,
) => createOwnedSshEndpointLease({
  location: { directory: remotePath },
  stateFile,
  runtimeIdentity,
  async start(instanceToken) {
    return {
      url: "http://127.0.0.1:45000",
      instanceIdentity: instanceToken,
      async stop() {},
    };
  },
});

test("same project with a different SSH host rotates authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "polyth-ssh-host-identity-"));
  const stateFile = join(directory, "project.lease.json");
  try {
    const hostA = await durableSshLease(
      stateFile,
      "connection-a:host-a:opencode",
      "/srv/project",
    );
    const first = await hostA.endpoint();
    await hostA.dispose();

    const hostB = await durableSshLease(
      stateFile,
      "connection-b:host-b:opencode",
      "/srv/project",
    );
    const second = await hostB.endpoint();
    await hostB.dispose();

    assert.notEqual(second.authorityId, first.authorityId);
    assert.equal(second.generation, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("same SSH host with a different remote path rotates authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "polyth-ssh-path-identity-"));
  const stateFile = join(directory, "project.lease.json");
  try {
    const firstPath = await durableSshLease(
      stateFile,
      "connection-a:host-a:opencode",
      "/srv/project-a",
    );
    const first = await firstPath.endpoint();
    await firstPath.dispose();

    const secondPath = await durableSshLease(
      stateFile,
      "connection-a:host-a:opencode",
      "/srv/project-b",
    );
    const second = await secondPath.endpoint();
    await secondPath.dispose();

    assert.notEqual(second.authorityId, first.authorityId);
    assert.equal(second.generation, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("corrupted durable lease state fails closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "polyth-lease-corrupt-"));
  const stateFile = join(directory, "runtime.lease.json");
  try {
    await writeFile(stateFile, "{\"version\":2,\"authorityId\":");
    await assert.rejects(
      () => durableSshLease(
        stateFile,
        "connection-a:host-a:opencode",
        "/srv/project",
      ),
      /owned runtime state is invalid/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const runLeaseWorker = (
  stateFile: string,
): Promise<{ authorityId: string; generation: number }> => {
  const endpointModuleUrl = new URL("../src/endpoint.ts", import.meta.url).href;
  const source = `
    import { createOwnedSshEndpointLease } from ${JSON.stringify(endpointModuleUrl)};
    const lease = await createOwnedSshEndpointLease({
      location: { directory: "/srv/project" },
      stateFile: process.env.LEASE_STATE_FILE,
      runtimeIdentity: "connection-a:host-a:opencode",
      async start(instanceToken) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return {
          url: "http://127.0.0.1:45000",
          instanceIdentity: instanceToken,
          async stop() {},
        };
      },
    });
    const endpoint = await lease.endpoint();
    process.stdout.write(JSON.stringify({
      authorityId: endpoint.authorityId,
      generation: endpoint.generation,
    }));
    await lease.dispose();
  `;
  return new Promise((resolveWorker, rejectWorker) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "--eval", source],
      {
        env: { ...process.env, LEASE_STATE_FILE: stateFile },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    let errorOutput = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output += chunk; });
    child.stderr.on("data", (chunk: string) => { errorOutput += chunk; });
    child.once("error", rejectWorker);
    child.once("exit", (code) => {
      if (code !== 0) {
        rejectWorker(new Error(`lease worker exited ${code}: ${errorOutput}`));
        return;
      }
      resolveWorker(JSON.parse(output) as { authorityId: string; generation: number });
    });
  });
};

test("concurrent processes allocate distinct durable generations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "polyth-generation-race-"));
  const stateFile = join(directory, "runtime.lease.json");
  try {
    const [left, right] = await Promise.all([
      runLeaseWorker(stateFile),
      runLeaseWorker(stateFile),
    ]);
    assert.equal(left.authorityId, right.authorityId);
    assert.deepEqual(
      [left.generation, right.generation].sort((a, b) => a - b),
      [1, 2],
    );
    const thirdLease = await durableSshLease(
      stateFile,
      "connection-a:host-a:opencode",
      "/srv/project",
    );
    const third = await thirdLease.endpoint();
    await thirdLease.dispose();
    assert.equal(third.authorityId, left.authorityId);
    assert.equal(third.generation, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a crashed generation transaction cannot replace committed lease state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "polyth-generation-write-"));
  const stateFile = join(directory, "runtime.lease.json");
  try {
    const firstLease = await durableSshLease(
      stateFile,
      "connection-a:host-a:opencode",
      "/srv/project",
    );
    const first = await firstLease.endpoint();
    await firstLease.dispose();

    const crashSource = `
      import { DatabaseSync } from "node:sqlite";
      const database = new DatabaseSync(process.env.LEASE_STATE_FILE + ".state.db");
      database.exec("PRAGMA busy_timeout = 10000; BEGIN IMMEDIATE");
      database.prepare(
        "UPDATE owned_runtime_state SET generation = 999 WHERE singleton = 1",
      ).run();
      process.exit(17);
    `;
    await new Promise<void>((resolveCrash, rejectCrash) => {
      const child = spawn(
        process.execPath,
        ["--input-type=module", "--eval", crashSource],
        {
          env: { ...process.env, LEASE_STATE_FILE: stateFile },
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      let errorOutput = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => { errorOutput += chunk; });
      child.once("error", rejectCrash);
      child.once("exit", (code) => {
        if (code === 17) resolveCrash();
        else rejectCrash(new Error(`crash worker exited ${code}: ${errorOutput}`));
      });
    });

    const secondLease = await durableSshLease(
      stateFile,
      "connection-a:host-a:opencode",
      "/srv/project",
    );
    const second = await secondLease.endpoint();
    await secondLease.dispose();
    assert.equal(second.authorityId, first.authorityId);
    assert.equal(second.generation, first.generation + 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("owned restart rebinds verified sessions while fencing prior callbacks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "polyth-generation-restart-"));
  const bootLease = createLeaseBooter(directory);
  let restartedLease: Awaited<ReturnType<typeof bootLease>> | undefined;
  try {
    const firstBoot = await bootLease(44101);
    const persisted = await firstBoot.endpoint();
    await firstBoot.dispose();

    restartedLease = await bootLease(44102);
    let protocolCalls = 0;
    const runtime = await createRuntimeLifecycle({
      lease: restartedLease,
      createTransport: noOpTransport,
      createProtocol: (_transport, endpoint) =>
        protocolFor(endpoint, () => { protocolCalls += 1; }),
    });
    restartedLease = undefined;
    try {
      const current = await runtime.endpoint();
      assert.equal(current.authorityId, persisted.authorityId);
      assert.ok(current.generation > persisted.generation);

      let oldCallbackAccepted = false;
      assert.equal(
        runtime.acceptGeneration(
          persisted.authorityId,
          persisted.generation,
          () => { oldCallbackAccepted = true; },
        ),
        false,
      );
      assert.equal(oldCallbackAccepted, false);

      assert.equal(
        (await runtime.ensureSession({
          canonicalSessionId: "canonical-a",
          backendSessionId: "backend-a",
          authorityId: persisted.authorityId,
          generation: persisted.generation,
          continuity: persisted.continuity,
          location: persisted.location,
          protocol: "legacy",
        }, "operation-old-generation")).kind,
        "confirmed",
      );
      assert.equal(protocolCalls, 1);
    } finally {
      await runtime.dispose();
    }
  } finally {
    await restartedLease?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
