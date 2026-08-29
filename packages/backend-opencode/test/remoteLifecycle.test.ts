import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
  RemoteForwardHandle,
  RemoteHost,
  RemoteProcessHandle,
} from "@polyth/contracts";
import { createOwnedSshEndpointLease } from "../src/endpoint.ts";
import { createRemoteOpenCodeRuntime } from "../src/remote.ts";
import { prepareRemoteOpenCodeRuntime } from "../src/remoteStorage.ts";
import {
  applyRemoteStorageCommand,
  createFakeRemoteStorage,
  injectRemoteIdentityBreak,
} from "./fakeRemoteRuntime.ts";

const execSuccess = (storage = createFakeRemoteStorage("/var/lib/polyth/runtimes/project")) =>
  async (command: string) => {
    const handled = applyRemoteStorageCommand(command, () => storage, storage);
    if (handled) return handled;
    if (command.includes("command -v") && !command.includes("POLYTH_REMOTE_STORAGE_INSPECT")) {
      return { code: 0, stdout: "1.18.18\n", stderr: "" };
    }
    if (command.includes(" db path")) {
      const expected = command.match(/OPENCODE_DB='([^']+)'/)?.[1] ?? "";
      return { code: 0, stdout: `${expected}\n`, stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };

const isGuardianCommand = (command: string): boolean =>
  command.includes("POLYTH_REMOTE_LOCK_GUARDIAN=1");

const acquiredGuardianHandle = (): RemoteProcessHandle => {
  const output = new Set<(chunk: string) => void>();
  const exit = new Set<(code: number | null) => void>();
  setImmediate(() => {
    for (const callback of output) callback("POLYTH_LOCK_ACQUIRED=1\n");
  });
  return {
    onOutput(callback) {
      output.add(callback);
      return { dispose: () => { output.delete(callback); } };
    },
    onExit(callback) {
      exit.add(callback);
      return { dispose: () => { exit.delete(callback); } };
    },
    async kill() {},
  };
};

const listeningHandle = (
  port: number,
  onKill: () => Promise<void> = async () => {},
): RemoteProcessHandle => {
  const output = new Set<(chunk: string) => void>();
  const exit = new Set<(code: number | null) => void>();
  setImmediate(() => {
    for (const callback of output) {
      callback("POLYTH_REMOTE_PID=4321\n");
      callback(`opencode server listening on http://127.0.0.1:${port}\n`);
    }
  });
  return {
    onOutput(callback) {
      output.add(callback);
      return { dispose: () => { output.delete(callback); } };
    },
    onExit(callback) {
      exit.add(callback);
      return { dispose: () => { exit.delete(callback); } };
    },
    kill: onKill,
  };
};

test("remote process startup has a finite orchestration deadline", async () => {
  const host: RemoteHost = {
    label: "deadline.example",
    exec: execSuccess(),
    async start() {
      return await new Promise<RemoteProcessHandle>(() => {});
    },
    async forward() {
      assert.fail("forward must not start after a startup deadline");
    },
  };
  const startedAt = Date.now();
  await assert.rejects(
    () => createRemoteOpenCodeRuntime({
      host,
      remotePath: "/srv/project",
      runtimeDir: "/var/lib/polyth/runtimes/project",
      lifecycleTimeoutMs: 25,
      listenTimeoutMs: 1_000,
    }),
    /start exceeded 25ms/,
  );
  assert.ok(Date.now() - startedAt < 500);
});

test("timed-out remote forward is disposed if it resolves late", async () => {
  let processKills = 0;
  let lateForwardDisposals = 0;
  const host: RemoteHost = {
    label: "forward-deadline.example",
    exec: execSuccess(),
    async start(command) {
      if (isGuardianCommand(command)) return acquiredGuardianHandle();
      const port = Number(command.match(/--port (\d+)/)?.[1]);
      return listeningHandle(port, async () => {
        processKills += 1;
      });
    },
    async forward() {
      return await new Promise<RemoteForwardHandle>((resolveForward) => {
        setTimeout(() => {
          resolveForward({
            localPort: 49999,
            async dispose() {
              lateForwardDisposals += 1;
            },
          });
        }, 60);
      });
    },
  };
  await assert.rejects(
    () => createRemoteOpenCodeRuntime({
      host,
      remotePath: "/srv/project",
      runtimeDir: "/var/lib/polyth/runtimes/project",
      lifecycleTimeoutMs: 20,
      listenTimeoutMs: 1_000,
      pickPort: () => 48001,
    }),
    /forward exceeded 20ms/,
  );
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  assert.equal(processKills, 1);
  assert.equal(lateForwardDisposals, 1);
});

test("wiping remote runtime storage between two SSH leases mints a new authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "polyth-remote-lifecycle-id-"));
  const runtimeDir = "/var/lib/polyth/runtimes/project";
  const storage = createFakeRemoteStorage(runtimeDir);
  const host: RemoteHost = {
    label: "identity.example",
    exec: execSuccess(storage),
    async start() {
      throw new Error("serve must not start during prepare-only identity tests");
    },
    async forward() {
      throw new Error("forward must not start during prepare-only identity tests");
    },
  };
  const identityOf = (prepared: Awaited<ReturnType<typeof prepareRemoteOpenCodeRuntime>>) => ({
    connection: "conn-a",
    host: host.label,
    remotePath: "/srv/project",
    runtimeDir: prepared.runtimeDir,
    engine: prepared.engineIdentity.engine,
    version: prepared.engineIdentity.version,
    binaryDigest: prepared.engineIdentity.binaryDigest,
    protocolGeneration: prepared.engineIdentity.protocolGeneration,
    storageId: prepared.storageId,
  });
  const boot = async (
    prepared: Awaited<ReturnType<typeof prepareRemoteOpenCodeRuntime>>,
    stateFile: string,
  ) =>
    createOwnedSshEndpointLease({
      location: { directory: "/srv/project" },
      stateFile,
      runtimeIdentity: identityOf(prepared),
      async start(instanceToken, incarnation) {
        await prepared.recordOpen(incarnation);
        return {
          url: "http://127.0.0.1:45000",
          instanceIdentity: instanceToken,
          async stop() {},
        };
      },
    });

  try {
    const firstPrepared = await prepareRemoteOpenCodeRuntime({
      host,
      runtimeDir,
      projectId: "project-a",
      cwd: "/srv/project",
      bin: "opencode",
      version: "1.18.18",
      binarySource: "path",
    });
    storage.dbKind = "file";
    storage.dbEntries = ["opencode.db"];
    const stateFile = join(directory, "ssh.lease.json");
    const firstLease = await boot(firstPrepared, stateFile);
    const first = await firstLease.endpoint();
    await firstLease.dispose();

    const reopenedPrepared = await prepareRemoteOpenCodeRuntime({
      host,
      runtimeDir,
      projectId: "project-a",
      cwd: "/srv/project",
      bin: "opencode",
      version: "1.18.18",
      binarySource: "path",
    });
    assert.equal(reopenedPrepared.storageId, firstPrepared.storageId);
    const reopenedLease = await boot(reopenedPrepared, stateFile);
    const reopened = await reopenedLease.endpoint();
    assert.equal(reopened.authorityId, first.authorityId);
    assert.equal(reopened.generation, first.generation + 1);
    await reopenedLease.dispose();

    injectRemoteIdentityBreak(storage, { kind: "wipe-runtime" });
    const replacedPrepared = await prepareRemoteOpenCodeRuntime({
      host,
      runtimeDir,
      projectId: "project-a",
      cwd: "/srv/project",
      bin: "opencode",
      version: "1.18.18",
      binarySource: "path",
    });
    assert.notEqual(replacedPrepared.storageId, firstPrepared.storageId);
    const replacedLease = await boot(replacedPrepared, stateFile);
    const replaced = await replacedLease.endpoint();
    assert.notEqual(replaced.authorityId, first.authorityId);
    assert.equal(replaced.generation, 1);
    await replacedLease.dispose();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

