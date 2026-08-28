// Phase-4 regression (OC-REAL-060 / OC-REAL-061).
//
// Sessions persist their runtime binding (backendSessionId + authorityId +
// generation) so a restarted Polyth can reattach them (sessions.ts
// runtimeBinding requires persisted.authorityId === endpoint.authorityId).
//
// Observed live consequence (artifacts/opencode-real-world/phase-4/OC-REAL-060):
// after a Polyth restart, the first-wire interaction of every previously bound
// session fails with `binding-mismatch` ("persisted backend binding does not
// match the current endpoint"), permanently — the stale projection (`working`
// or `reconciling`) never resolves and the session can never be used again.
//
// The owned local lease therefore persists both its stable authority and its
// generation counter. The authority survives a process restart, while the
// generation advances before each child spawn so old bindings and callbacks
// remain fenced.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
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

const createLeaseBooter = (directory: string) => {
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

    assert.equal(
      restarted.authorityId,
      persisted.authorityId,
      "a Polyth restart minted a new owned authorityId for the same directory; "
      + "every persisted session binding now fails `binding-mismatch` on first "
      + "wire (persisted backend binding does not match the current endpoint) "
      + "and its stale working/reconciling projection can never resolve "
      + "(OC-REAL-060/OC-REAL-061)",
    );
    assert.equal(
      restarted.generation,
      persisted.generation + 1,
      "the recovered lease reused a prior-process generation",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("OC-REAL-083: SSH-owned authority is stable and generation advances across Polyth restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "polyth-ssh-authority-restart-"));
  const stateFile = join(directory, "remote-runtime.lease.json");
  let starts = 0;
  const bootLease = () => createOwnedSshEndpointLease({
    location: { directory: "/srv/remote-project" },
    stateFile,
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

    assert.equal(
      restarted.authorityId,
      persisted.authorityId,
      "the SSH-owned lease minted a new authority and made every persisted session binding fail",
    );
    assert.equal(restarted.generation, persisted.generation + 1);
    assert.equal(starts, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("owned restart rejects prior-process bindings and callbacks before protocol I/O", async () => {
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

      await assert.rejects(
        () => runtime.ensureSession({
          canonicalSessionId: "canonical-a",
          backendSessionId: "backend-a",
          authorityId: persisted.authorityId,
          generation: persisted.generation,
          continuity: persisted.continuity,
          location: persisted.location,
          protocol: "legacy",
        }, "operation-old-generation"),
        (error: Error & { code?: string }) => error.code === "binding-mismatch",
      );
      assert.equal(protocolCalls, 0);
    } finally {
      await runtime.dispose();
    }
  } finally {
    await restartedLease?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
