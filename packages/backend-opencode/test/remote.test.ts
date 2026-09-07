import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createRemoteOpenCodeRuntime,
  installRemoteOpenCode,
  probeRemoteOpenCode,
  ownedSshRuntimeIdentityKey,
  DEFAULT_REMOTE_RUNTIME_ROOT_EXPR,
  OPENCODE_UPDATE_DISABLE_ENV,
  parseOpenCodeRuntimeMetadata,
  type ManagedOpenCodeRuntime,
} from "../src/index.ts";
import { acquireRemoteRuntimeLock, REMOTE_STORAGE_MARKERS } from "../src/remoteStorage.ts";
import { createKeyedRuntimeOwner } from "../../server/src/runtimeOccupancy.ts";
import {
  createDeferred,
  createFakeRemoteHost,
  TEST_REMOTE_DIGEST,
  TEST_REMOTE_DIGEST_B,
  waitUntil,
  type FakeRemoteStorageState,
} from "./fakeRemoteRuntime.ts";

const providerBody = {
  all: [
    {
      id: "opencode",
      name: "OpenCode",
      models: { "big-pickle": { id: "big-pickle", name: "Big Pickle", limit: { context: 128000 } } },
    },
  ],
  connected: ["opencode"],
};

/** Minimal stand-in for the REMOTE `opencode serve` — the forwarded port
 *  points here, exactly like an SSH -L forward would. */
const startStubServe = async () => {
  const server = http.createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && path === "/global/health") return json(200, { healthy: true });
    if (req.method === "GET" && path === "/provider") return json(200, providerBody);
    if (req.method === "GET" && path === "/agent") return json(200, [{ name: "build", mode: "primary" }]);
    if (req.method === "POST" && path === "/session") return json(200, { id: "ses_remote_1" });
    if (req.method === "GET" && path === "/event") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: {}\n\n");
      return;
    }
    json(404, { error: path });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  return { server, port: addr.port };
};

const createFakeHost = createFakeRemoteHost;

const bootRemote = async (
  fake: ReturnType<typeof createFakeRemoteHost>,
  options: {
    runtimeDir?: string;
    remotePath?: string;
    leaseStateFile: string;
    port: number;
    projectId?: string;
    remoteStateKey?: string;
  },
) =>
  createRemoteOpenCodeRuntime({
    host: fake.host,
    remotePath: options.remotePath ?? "/home/dev/app",
    ...(options.runtimeDir ? { runtimeDir: options.runtimeDir } : {}),
    ...(options.projectId ? { projectId: options.projectId } : {}),
    ...(options.remoteStateKey ? { remoteStateKey: options.remoteStateKey } : {}),
    leaseStateFile: options.leaseStateFile,
    pickPort: () => options.port,
    readyTimeoutMs: 5_000,
    listenTimeoutMs: 5_000,
  });

const endpointOf = async (runtime: { endpoint?: () => Promise<{
  authorityId: string;
  generation: number;
}> }) => {
  const read = runtime.endpoint;
  assert.ok(read, "owned remote runtime must expose endpoint()");
  return read();
};

test("remote runtime boots serve on the host, attaches through the forward, and cleans up", async () => {
  const stub = await startStubServe();
  const fake = createFakeHost({ stubPort: stub.port });
  const ports = [37001];
  const runtime = await createRemoteOpenCodeRuntime({
    host: fake.host,
    remotePath: "/home/dev/app",
    runtimeDir: "/var/lib/polyth/runtimes/app",
    pickPort: () => ports.shift() ?? 0,
    readyTimeoutMs: 5_000,
    listenTimeoutMs: 5_000,
  });
  try {
    // serve was started with the right cwd, port, and pidfile reaping
    assert.equal(fake.guardianStartCommands.length, 1);
    assert.equal(fake.serveStartCommands.length, 1);
    const cmd = fake.serveStartCommands[0]!;
    assert.ok(cmd.includes("cd '/home/dev/app'"), cmd);
    assert.ok(cmd.includes("setsid opencode serve --hostname 127.0.0.1 --port 37001"), cmd);
    assert.ok(
      fake.storage.serveLive && fake.storage.serveIdentity?.port === 37001,
      "must publish a serve-process record with listen identity after spawn",
    );
    assert.ok(
      cmd.includes("export OPENCODE_DB='/var/lib/polyth/runtimes/app/opencode.db'"),
      "remote owned runtime must export its exact isolated DB path",
    );
    assert.ok(
      cmd.includes(`export ${OPENCODE_UPDATE_DISABLE_ENV}=true`),
      "remote owned runtime must disable OpenCode self-update",
    );
    assert.ok(cmd.includes("umask 077"));
    assert.ok(cmd.includes('oc_start "$OLD_PID"'), "must verify the recorded child start identity");
    assert.ok(cmd.includes('oc_exe "$OLD_PID"'), "must verify the recorded executable");
    assert.ok(cmd.includes('oc_cmd "$OLD_PID"'), "must verify the recorded command");
    assert.match(cmd, /POLYTH_REMOTE_PID=/, "must record the remote serve pid");
    const dbProbe = fake.execCalls.find((call) => call.includes(" db path"));
    assert.ok(
      dbProbe?.includes(
        "OPENCODE_DB='/var/lib/polyth/runtimes/app/probe.db' opencode db path",
      ),
      `missing isolated DB capability probe: ${dbProbe}`,
    );
    const versionProbe = fake.execCalls.find((call) => call.includes("--version"));
    assert.ok(
      versionProbe?.includes(
        "OPENCODE_DB='/var/lib/polyth/runtimes/app/probe.db' opencode --version",
      ),
      `remote version probe could touch the global DB: ${versionProbe}`,
    );
    assert.ok(
      fake.execCalls
        .filter((call) =>
          (call.includes("command -v") || call.includes(" db path"))
          && !call.includes(REMOTE_STORAGE_MARKERS.inspect)
          && !call.includes(REMOTE_STORAGE_MARKERS.hashBinary))
        .every((call) => call.includes(`export ${OPENCODE_UPDATE_DISABLE_ENV}=true`)),
      "all remote engine probes must disable OpenCode self-update",
    );
    const inspect = fake.execCalls.find((call) => call.includes(REMOTE_STORAGE_MARKERS.inspect));
    assert.ok(inspect, "owned remote startup must inspect remote runtime storage");
    assert.ok(
      fake.execCalls.some((call) => call.includes(REMOTE_STORAGE_MARKERS.hashBinary))
        || fake.storage.digestCache,
      "owned remote startup must hash the remote binary or reuse a digest cache",
    );
    const metadata = parseOpenCodeRuntimeMetadata(fake.storage.metadata ?? "");
    assert.ok(metadata, "remote prepare must write valid runtime.json");
    assert.equal(metadata?.engine, "opencode");
    assert.equal(metadata?.binaryDigest, TEST_REMOTE_DIGEST);
    assert.equal(/session|message/i.test(fake.storage.metadata ?? ""), false);
    assert.ok(
      cmd.includes("write_pf()"),
      "serve must write the process record atomically",
    );
    assert.ok(
      cmd.includes("terminate_unpublished_child()"),
      "PF publication failure must reap the unpublished child directly",
    );
    assert.ok(
      cmd.includes('mv "$tmp" "$PF"'),
      "every process-record mutation must rename into place",
    );
    assert.ok(
      cmd.includes("POLYTH_RUNTIME_OWNED="),
      "a live serve-process record must fail closed rather than being killed",
    );
    // the forward targets the actual listen port
    assert.deepEqual(fake.forwards.map((f) => f.remotePort), [37001]);
    // the adapter talks through the forwarded local port
    const models = await runtime.models();
    assert.equal(models[0]?.modelID, "big-pickle");
    const backendId = await runtime.ensureSession({ sessionId: "canon_1", cwd: "/home/dev/app", projectId: "p1" });
    assert.equal(backendId, "ses_remote_1");
  } finally {
    await runtime.dispose();
    stub.server.close();
  }
  // dispose kills the remote pid, removes the pidfile, closes the channel and forward
  const killExec = fake.execCalls.find((c) => c.includes("POLYTH_REMOTE_STOP_SERVE=1"));
  assert.ok(killExec, `expected a remote terminate, got: ${fake.execCalls.join(" | ")}`);
  assert.ok(killExec!.includes("kill -TERM"));
  assert.ok(killExec!.includes("kill -KILL"));
  assert.ok(killExec!.includes("wait_gone"));
  assert.ok(killExec!.includes('oc_start "$PID"'));
  assert.ok(killExec!.includes('oc_exe "$PID"'));
  assert.ok(killExec!.includes('oc_cmd "$PID"'));
  assert.ok(killExec!.includes("remove_ours"));
  assert.deepEqual(fake.storage.killedPids, ["4242"]);
  assert.equal(fake.storage.serveLive, false);
  assert.equal(fake.forwards[0]!.cancelled, true);
});

test("remote invocations extend PATH with the standard opencode install locations", async () => {
  const stub = await startStubServe();
  const fake = createFakeHost({ stubPort: stub.port });
  const runtime = await createRemoteOpenCodeRuntime({
    host: fake.host,
    remotePath: "/home/dev/app",
    runtimeDir: "/var/lib/polyth/runtimes/app",
    pickPort: () => 37002,
    readyTimeoutMs: 5_000,
    listenTimeoutMs: 5_000,
  });
  try {
    // Non-interactive SSH shells never source the rc files the installer
    // appends its PATH entry to, so both the probe and the serve start must
    // resolve ~/.opencode/bin (and ~/.local/bin) installs on their own.
    const pathPrefix = 'PATH="$HOME/.opencode/bin:$HOME/.local/bin:$PATH"';
    const probeCmd = fake.execCalls.find((c) => c.includes("command -v"));
    assert.ok(probeCmd?.includes(pathPrefix), `probe misses PATH prefix: ${probeCmd}`);
    assert.ok(
      fake.serveStartCommands[0]!.startsWith(pathPrefix),
      `serve misses PATH prefix: ${fake.serveStartCommands[0]}`,
    );
  } finally {
    await runtime.dispose();
    stub.server.close();
  }
});

test("remote process ownership records separate projects sharing one worktree", async () => {
  const stub = await startStubServe();
  const fake = createFakeHost({ stubPort: stub.port });
  const ports = [37011, 37012];
  const first = await createRemoteOpenCodeRuntime({
    host: fake.host,
    remotePath: "/srv/shared-worktree",
    runtimeDir: "/var/lib/polyth/runtimes/project-a",
    pickPort: () => ports.shift() ?? 0,
    readyTimeoutMs: 5_000,
    listenTimeoutMs: 5_000,
  });
  const second = await createRemoteOpenCodeRuntime({
    host: fake.host,
    remotePath: "/srv/shared-worktree",
    runtimeDir: "/var/lib/polyth/runtimes/project-b",
    pickPort: () => ports.shift() ?? 0,
    readyTimeoutMs: 5_000,
    listenTimeoutMs: 5_000,
  });
  try {
    const pidFiles = fake.serveStartCommands.map((command) =>
      command.match(/polyth\/serve-[a-f0-9]{24}\.pid/)?.[0]);
    assert.equal(pidFiles.every(Boolean), true, String(pidFiles));
    assert.equal(
      new Set(pidFiles).size,
      2,
      "a second project on the same host/path must not reap the first project's worker",
    );
  } finally {
    await Promise.all([first.dispose(), second.dispose()]);
    stub.server.close();
  }
});

test("remote port collisions retry with a fresh candidate", async () => {
  const stub = await startStubServe();
  const fake = createFakeHost({ stubPort: stub.port, busyPorts: [40001, 40002] });
  const ports = [40001, 40002, 40003];
  const runtime = await createRemoteOpenCodeRuntime({
    host: fake.host,
    remotePath: "/srv/app",
    runtimeDir: "/var/lib/polyth/runtimes/app",
    pickPort: () => ports.shift() ?? 0,
    readyTimeoutMs: 5_000,
    listenTimeoutMs: 5_000,
  });
  try {
    assert.equal(fake.serveStartCommands.length, 3);
    assert.equal(fake.guardianStartCommands.length, 1);
    assert.deepEqual(fake.forwards.map((f) => f.remotePort), [40003]);
  } finally {
    await runtime.dispose();
    stub.server.close();
  }
});

test("missing remote binary fails before anything starts, with install guidance", async () => {
  const fake = createFakeHost({ stubPort: 1, missingBinary: true });
  await assert.rejects(
    () => createRemoteOpenCodeRuntime({
      host: fake.host,
      remotePath: "/srv/app",
      runtimeDir: "/var/lib/polyth/runtimes/app",
    }),
    (err: Error & { code?: string }) =>
      err.code === "unavailable"
      && err.message.includes("dev@fake.example")
      && err.message.includes("not installed"),
  );
  assert.equal(fake.startCommands.length, 0);
  assert.equal(fake.forwards.length, 0);
});

test("missing remote workspace path fails with not-found before serve starts", async () => {
  const fake = createFakeHost({ stubPort: 1, missingDir: true });
  await assert.rejects(
    () => createRemoteOpenCodeRuntime({
      host: fake.host,
      remotePath: "/srv/gone",
      runtimeDir: "/var/lib/polyth/runtimes/app",
    }),
    (err: Error & { code?: string }) => err.code === "not-found" && err.message.includes("/srv/gone"),
  );
  assert.equal(fake.startCommands.length, 0);
});

test("owned remote runtime defaults the remote root to XDG polyth runtimes, not OpenCode global or a local data join", async () => {
  const stub = await startStubServe();
  const fake = createFakeHost({
    stubPort: stub.port,
    runtimeDir: "/home/dev/.local/share/polyth/runtimes/opencode/remote-key-1",
  });
  const runtime = await createRemoteOpenCodeRuntime({
    host: fake.host,
    remotePath: "/srv/app",
    remoteStateKey: "remote-key-1",
    pickPort: () => 37021,
    readyTimeoutMs: 5_000,
    listenTimeoutMs: 5_000,
  });
  try {
    const resolve = fake.execCalls.find((call) => call.includes(REMOTE_STORAGE_MARKERS.resolveDir));
    assert.ok(resolve, "omitted runtimeDir must expand on the remote host");
    assert.ok(
      resolve!.includes(`${DEFAULT_REMOTE_RUNTIME_ROOT_EXPR}/remote-key-1`),
      `expected XDG polyth runtime root, got: ${resolve}`,
    );
    assert.ok(
      !resolve!.includes("data/runtimes"),
      "must not join a local Polyth dataDir onto the remote",
    );
    assert.match(
      fake.serveStartCommands[0] ?? "",
      /RUNTIME_DIR='\/home\/dev\/\.local\/share\/polyth\/runtimes\/opencode\/remote-key-1'/,
    );
    const endpoint = await endpointOf(runtime);
    assert.match(endpoint.authorityId, /^owned:/);
  } finally {
    await runtime.dispose();
    stub.server.close();
  }
});

test("owned remote runtime refuses a relative remote runtimeDir", async () => {
  const fake = createFakeHost({ stubPort: 1 });
  await assert.rejects(
    () => createRemoteOpenCodeRuntime({
      host: fake.host,
      remotePath: "/srv/app",
      runtimeDir: "runtimes/opencode/app",
    }),
    (err: Error & { code?: string }) =>
      err.code === "invalid-input"
      && err.message.includes("absolute path"),
  );
  assert.equal(fake.startCommands.length, 0);
});

test("owned remote runtime refuses a binary that ignores OPENCODE_DB", async () => {
  const fake = createFakeHost({
    stubPort: 1,
    reportedDbPath: "/home/dev/.local/share/opencode/opencode.db",
  });
  await assert.rejects(
    () => createRemoteOpenCodeRuntime({
      host: fake.host,
      remotePath: "/srv/app",
      runtimeDir: "/var/lib/polyth/runtimes/app",
    }),
    (error: Error & { code?: string }) =>
      error.code === "unavailable"
      && error.message.includes("does not honor OPENCODE_DB")
      && error.message.includes("/var/lib/polyth/runtimes/app/probe.db"),
  );
  assert.equal(fake.execCalls.filter((call) => call.includes(" db path")).length, 1);
  assert.equal(fake.startCommands.length, 0);
  assert.equal(fake.forwards.length, 0);
});

test("probeRemoteOpenCode reports the installed version honestly", async () => {
  const fake = createFakeHost({ stubPort: 1, version: "1.18.18" });
  const probe = await probeRemoteOpenCode(fake.host);
  assert.deepEqual(probe, { ok: true, version: "1.18.18" });

  const missing = createFakeHost({ stubPort: 1, missingBinary: true });
  const bad = await probeRemoteOpenCode(missing.host);
  assert.equal(bad.ok, false);
  assert.equal(bad.installable, true);
  assert.match(bad.message ?? "", /not installed/);
});

test("installRemoteOpenCode runs the fixed vendor installer on the remote host", async () => {
  const fake = createFakeHost({ stubPort: 1 });
  await installRemoteOpenCode(fake.host);
  assert.ok(fake.execCalls.some((command) => command.includes("curl -fsSL https://opencode.ai/install | bash")));
});

const STORAGE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test("deleting the remote runtime dir mints a new storageId and authority; compatible reopen keeps them", async () => {
  const stub = await startStubServe();
  const directory = await mkdtemp(join(tmpdir(), "polyth-remote-storage-"));
  const runtimeDir = "/var/lib/polyth/runtimes/project-a";
  const fake = createFakeHost({ stubPort: stub.port, runtimeDir });
  const leaseStateFile = join(directory, "ssh.lease.json");
  try {
    const first = await bootRemote(fake, { runtimeDir, leaseStateFile, port: 37101, projectId: "project-a" });
    const original = await endpointOf(first);
    const originalMetadata = parseOpenCodeRuntimeMetadata(fake.storage.metadata ?? "");
    assert.ok(originalMetadata);
    assert.match(originalMetadata!.storageId, STORAGE_ID_RE);
    const hashesAfterFirst = fake.storage.hashCalls;
    await first.dispose();

    const second = await bootRemote(fake, { runtimeDir, leaseStateFile, port: 37102, projectId: "project-a" });
    const reopened = await endpointOf(second);
    const reopenedMetadata = parseOpenCodeRuntimeMetadata(fake.storage.metadata ?? "");
    assert.equal(reopened.authorityId, original.authorityId);
    assert.equal(reopened.generation, original.generation + 1);
    assert.equal(reopenedMetadata?.storageId, originalMetadata?.storageId);
    assert.equal(fake.storage.hashCalls, hashesAfterFirst, "unchanged binary path/mtime/size must not rehash");
    await second.dispose();

    fake.inject({ kind: "wipe-runtime" });
    const third = await bootRemote(fake, { runtimeDir, leaseStateFile, port: 37103, projectId: "project-a" });
    const replacement = await endpointOf(third);
    const replacementMetadata = parseOpenCodeRuntimeMetadata(fake.storage.metadata ?? "");
    assert.notEqual(replacementMetadata?.storageId, originalMetadata?.storageId);
    assert.notEqual(replacement.authorityId, original.authorityId);
    assert.equal(replacement.generation, 1);
    await third.dispose();
  } finally {
    await rm(directory, { recursive: true, force: true });
    stub.server.close();
  }
});

test("remote identity breaks fail closed and mint a new authority", async () => {
  const stub = await startStubServe();
  const directory = await mkdtemp(join(tmpdir(), "polyth-remote-breaks-"));
  const runtimeDir = "/var/lib/polyth/runtimes/project-b";
  const cases = [
    { name: "delete-metadata", break: { kind: "delete-metadata" as const } },
    { name: "replace-database", break: { kind: "replace-database" as const } },
    { name: "replace-both", break: { kind: "replace-both" as const } },
    { name: "copy-database", break: { kind: "copy-database" as const } },
    { name: "symlink-database", break: { kind: "symlink-database" as const, target: "/tmp/other.db" } },
    { name: "symlink-metadata", break: { kind: "symlink-metadata" as const, target: "/tmp/other.json" } },
    { name: "digest-change", break: { kind: "digest-change" as const, digest: TEST_REMOTE_DIGEST_B } },
  ];
  try {
    for (const [index, entry] of cases.entries()) {
      const fake = createFakeHost({ stubPort: stub.port, runtimeDir });
      const leaseStateFile = join(directory, `${entry.name}.lease.json`);
      const first = await bootRemote(fake, {
        runtimeDir,
        leaseStateFile,
        port: 37200 + index * 2,
        projectId: "project-b",
      });
      const original = await endpointOf(first);
      const originalMetadata = parseOpenCodeRuntimeMetadata(fake.storage.metadata ?? "");
      await first.dispose();
      fake.inject(entry.break);
      const second = await bootRemote(fake, {
        runtimeDir,
        leaseStateFile,
        port: 37200 + index * 2 + 1,
        projectId: "project-b",
      });
      const replacement = await endpointOf(second);
      const replacementMetadata = parseOpenCodeRuntimeMetadata(fake.storage.metadata ?? "");
      assert.notEqual(
        replacement.authorityId,
        original.authorityId,
        `${entry.name} must mint a new authority`,
      );
      assert.equal(replacement.generation, 1, `${entry.name} must restart generation`);
      assert.notEqual(
        replacementMetadata?.storageId,
        originalMetadata?.storageId,
        `${entry.name} must mint a new storageId`,
      );
      assert.equal(/session|message/i.test(fake.storage.metadata ?? ""), false);
      await second.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
    stub.server.close();
  }
});

test("restoring stale remote runtime.json with a different storageId rotates authority", async () => {
  const stub = await startStubServe();
  const directory = await mkdtemp(join(tmpdir(), "polyth-remote-stale-"));
  const runtimeDir = "/var/lib/polyth/runtimes/project-stale";
  const fake = createFakeHost({ stubPort: stub.port, runtimeDir });
  const leaseStateFile = join(directory, "ssh.lease.json");
  try {
    const first = await bootRemote(fake, {
      runtimeDir,
      leaseStateFile,
      port: 37301,
      projectId: "project-stale",
    });
    const original = await endpointOf(first);
    const originalMetadata = parseOpenCodeRuntimeMetadata(fake.storage.metadata ?? "");
    await first.dispose();
    const stale = {
      ...originalMetadata!,
      storageId: "22222222-2222-4222-8222-222222222222",
    };
    fake.inject({
      kind: "restore-stale-metadata",
      metadata: `${JSON.stringify(stale, null, 2)}\n`,
    });
    const second = await bootRemote(fake, {
      runtimeDir,
      leaseStateFile,
      port: 37302,
      projectId: "project-stale",
    });
    const restored = await endpointOf(second);
    const restoredMetadata = parseOpenCodeRuntimeMetadata(fake.storage.metadata ?? "");
    assert.equal(restoredMetadata?.storageId, stale.storageId);
    assert.notEqual(restored.authorityId, original.authorityId);
    assert.equal(restored.generation, 1);
    await second.dispose();

    fake.inject({ kind: "restore-stale-metadata", metadata: "{not-json" });
    const third = await bootRemote(fake, {
      runtimeDir,
      leaseStateFile,
      port: 37303,
      projectId: "project-stale",
    });
    const invalid = await endpointOf(third);
    const invalidMetadata = parseOpenCodeRuntimeMetadata(fake.storage.metadata ?? "");
    assert.notEqual(invalidMetadata?.storageId, stale.storageId);
    assert.notEqual(invalid.authorityId, restored.authorityId);
    await third.dispose();
  } finally {
    await rm(directory, { recursive: true, force: true });
    stub.server.close();
  }
});

test("missing or uncreatable remote runtime dir fails closed without starting serve", async () => {
  const fake = createFakeHost({
    stubPort: 1,
    runtimeDir: "/var/lib/polyth/runtimes/uncreatable",
  });
  fake.inject({ kind: "uncreatable-dir" });
  await assert.rejects(
    () => createRemoteOpenCodeRuntime({
      host: fake.host,
      remotePath: "/srv/app",
      runtimeDir: "/var/lib/polyth/runtimes/uncreatable",
    }),
    (error: Error & { code?: string }) =>
      error.code === "unavailable"
      && error.message.includes("mkdir-failed"),
  );
  assert.equal(fake.serveStartCommands.length, 0);
  assert.equal(fake.forwards.length, 0);
});

test("a live remote owner token fails closed instead of opening writable storage", async () => {
  const fake = createFakeHost({
    stubPort: 1,
    runtimeDir: "/var/lib/polyth/runtimes/owned",
  });
  fake.inject({ kind: "live-owner" });
  await assert.rejects(
    () => createRemoteOpenCodeRuntime({
      host: fake.host,
      remotePath: "/srv/app",
      runtimeDir: "/var/lib/polyth/runtimes/owned",
    }),
    /already owned|locked|held by a live serve|startup owner is still alive/,
  );
  assert.equal(fake.serveStartCommands.length, 0);

  fake.inject({ kind: "symlink-owner" });
  await assert.rejects(
    () => createRemoteOpenCodeRuntime({
      host: fake.host,
      remotePath: "/srv/app",
      runtimeDir: "/var/lib/polyth/runtimes/owned",
    }),
    /owner record is a symlink|could not verify remote startup ownership/,
  );
  assert.equal(fake.serveStartCommands.length, 0);
});

test("SSH identity keys do not alias across connection, host, path, or storageId", () => {
  const base = {
    connection: "conn-a",
    host: "git.example",
    remotePath: "/srv/app",
    runtimeDir: "/var/lib/polyth/runtimes/a",
    engine: "opencode" as const,
    version: "1.18.18",
    binaryDigest: "a".repeat(64),
    protocolGeneration: 1,
    storageId: "11111111-1111-4111-8111-111111111111",
  };
  const original = ownedSshRuntimeIdentityKey(base);
  assert.notEqual(
    ownedSshRuntimeIdentityKey({ ...base, connection: "conn-b" }),
    original,
    "different SSH connections must not share authority",
  );
  assert.notEqual(
    ownedSshRuntimeIdentityKey({ ...base, host: "other.example" }),
    original,
    "different host labels must not share authority",
  );
  assert.notEqual(
    ownedSshRuntimeIdentityKey({ ...base, remotePath: "/srv/other" }),
    original,
    "different remote worktrees must not share authority",
  );
  assert.notEqual(
    ownedSshRuntimeIdentityKey({ ...base, runtimeDir: "/var/lib/polyth/runtimes/b" }),
    original,
    "different remote runtime dirs must not share authority",
  );
  assert.notEqual(
    ownedSshRuntimeIdentityKey({
      ...base,
      storageId: "22222222-2222-4222-8222-222222222222",
    }),
    original,
    "storageId rotation must break the SSH identity",
  );
  assert.equal(ownedSshRuntimeIdentityKey({ ...base }), original);
});

test("owned SSH startup fails closed without Linux process identity and never starts serve", async () => {
  const fake = createFakeHost({ stubPort: 1, processIdentityCapable: false });
  await assert.rejects(
    () => createRemoteOpenCodeRuntime({
      host: fake.host,
      remotePath: "/srv/app",
      runtimeDir: "/var/lib/polyth/runtimes/app",
    }),
    (error: Error & { code?: string }) =>
      error.code === "unavailable"
      && /Linux-compatible process identity/.test(error.message),
  );
  assert.equal(fake.serveStartCommands.length, 0);
  assert.equal(fake.forwards.length, 0);
});

test("two simultaneous remote runtimes cannot share one runtimeDir", async () => {
  const stub = await startStubServe();
  const directory = await mkdtemp(join(tmpdir(), "polyth-remote-lock-"));
  const fake = createFakeHost({
    stubPort: stub.port,
    probeYieldMs: 25,
    startYieldMs: 30,
    awaitLockRivals: 2,
  });
  const runtimeDir = "/var/lib/polyth/runtimes/shared";
  try {
    const results = await Promise.allSettled([
      createRemoteOpenCodeRuntime({
        host: fake.host,
        remotePath: "/home/dev/app",
        runtimeDir,
        leaseStateFile: join(directory, "a.lease.json"),
        pickPort: () => 37101,
        readyTimeoutMs: 5_000,
        listenTimeoutMs: 5_000,
      }),
      createRemoteOpenCodeRuntime({
        host: fake.host,
        remotePath: "/home/dev/app",
        runtimeDir,
        leaseStateFile: join(directory, "b.lease.json"),
        pickPort: () => 37102,
        readyTimeoutMs: 5_000,
        listenTimeoutMs: 5_000,
      }),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    assert.equal(fulfilled.length, 1, "exactly one runtime must win the remote lock");
    assert.equal(rejected.length, 1, "exactly one runtime must lose the remote lock");
    const failure = rejected[0] as PromiseRejectedResult;
    assert.match(
      String((failure.reason as Error).message),
      /already owned|locked|startup owner is still alive/,
    );
    assert.equal(fake.serveStartCommands.length, 1, "only the lock winner may start OpenCode serve");
    assert.equal(fake.guardianStartCommands.length, 2);
    assert.equal(fake.storageAt(runtimeDir).lockAcquireCalls, 2);
    await (fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof createRemoteOpenCodeRuntime>>>).value.dispose();
  } finally {
    stub.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("incomplete serve-process record fails closed", async () => {
  const runtimeDir = "/var/lib/polyth/runtimes/stale-lock";
  const fake = createFakeHost({ stubPort: 1, runtimeDir });
  const dead = { token: "dead-token", pid: "9", start: "1", exe: "/bin/oc", cmd: "1:1" };
  const state = fake.storageAt(runtimeDir);
  state.lockHeld = false;
  state.serveIdentity = { ...dead, pid: "" };

  await assert.rejects(
    () => acquireRemoteRuntimeLock(fake.host, runtimeDir, "/home/dev/app"),
    /could not verify remote startup ownership/,
  );
  assert.equal(state.lockHeld, false);

  state.serveIdentity = { ...dead };
  state.serveLive = true;
  await assert.rejects(
    () => acquireRemoteRuntimeLock(fake.host, runtimeDir, "/home/dev/app"),
    /listen endpoint is unknown/,
  );
  assert.equal(state.lockHeld, false);

  state.serveLive = false;
  state.serveIdentity = undefined;
  const lock = await acquireRemoteRuntimeLock(fake.host, runtimeDir, "/home/dev/app");
  assert.equal(state.lockHeld, true);
  await lock.release();
});

test("stale controller metadata does not block a free flock", async () => {
  const stub = await startStubServe();
  const directory = await mkdtemp(join(tmpdir(), "polyth-remote-crash-a-"));
  const runtimeDir = "/var/lib/polyth/runtimes/crash-a";
  const fake = createFakeHost({ stubPort: stub.port, runtimeDir });
  const dead = { token: "crash-a", pid: "8", start: "1", exe: "/bin/sh", cmd: "1:1" };
  const state = fake.storageAt(runtimeDir);
  state.lockHeld = false;
  state.serveLive = false;
  try {
    const runtime = await createRemoteOpenCodeRuntime({
      host: fake.host,
      remotePath: "/home/dev/app",
      runtimeDir,
      leaseStateFile: join(directory, "b.lease.json"),
      pickPort: () => 37301,
      readyTimeoutMs: 5_000,
      listenTimeoutMs: 5_000,
    });
    assert.equal(fake.serveStartCommands.length, 1, "a free flock must start exactly one serve");
    assert.equal(state.lockHeld, true);
    await runtime.dispose();
  } finally {
    stub.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("controller flock held during prepare blocks a second controller", async () => {
  const stub = await startStubServe();
  const directory = await mkdtemp(join(tmpdir(), "polyth-remote-hold-"));
  const runtimeDir = "/var/lib/polyth/runtimes/hold-starting";
  const fake = createFakeHost({
    stubPort: stub.port,
    runtimeDir,
    holdAfterLock: true,
  });
  try {
    const first = createRemoteOpenCodeRuntime({
      host: fake.host,
      remotePath: "/home/dev/app",
      runtimeDir,
      leaseStateFile: join(directory, "a.lease.json"),
      pickPort: () => 37311,
      readyTimeoutMs: 5_000,
      listenTimeoutMs: 5_000,
    });
    await fake.whenLockHeld();
    const state = fake.storageAt(runtimeDir);
    assert.equal(state.lockHeld, true);
    assert.equal(fake.serveStartCommands.length, 0, "A must still be preparing when B starts");

    const second = createRemoteOpenCodeRuntime({
      host: fake.host,
      remotePath: "/home/dev/app",
      runtimeDir,
      leaseStateFile: join(directory, "b.lease.json"),
      pickPort: () => 37312,
      readyTimeoutMs: 5_000,
      listenTimeoutMs: 5_000,
    });
    await assert.rejects(
      () => second,
      /already owned|locked|startup owner is still alive/,
    );
    assert.equal(fake.serveStartCommands.length, 0, "held flock must not let B start serve");

    fake.releaseHoldAfterLock();
    const runtime = await first;
    assert.equal(fake.serveStartCommands.length, 1, "only the flock holder may start serve");
    await runtime.dispose();
  } finally {
    stub.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("live serve-process record without a port fails closed and does not start another serve", async () => {
  const runtimeDir = "/var/lib/polyth/runtimes/crash-c";
  const fake = createFakeHost({ stubPort: 1, runtimeDir });
  const liveServe = { token: "live-serve", pid: "4242", start: "200", exe: "/usr/bin/opencode", cmd: "3:4" };
  const state = fake.storageAt(runtimeDir);
  state.lockHeld = false;
  state.serveIdentity = liveServe;
  state.serveLive = true;
  const serveBefore = fake.serveStartCommands.length;
  await assert.rejects(
    () => createRemoteOpenCodeRuntime({
      host: fake.host,
      remotePath: "/home/dev/app",
      runtimeDir,
    }),
    /listen endpoint is unknown/,
  );
  assert.equal(fake.serveStartCommands.length, serveBefore);
  assert.equal(state.lockHeld, false);
});

test("dispose releases the controller flock so the next create succeeds", async () => {
  const stub = await startStubServe();
  const directory = await mkdtemp(join(tmpdir(), "polyth-remote-dispose-"));
  const runtimeDir = "/var/lib/polyth/runtimes/dispose-lock";
  const fake = createFakeHost({ stubPort: stub.port, runtimeDir });
  try {
    const first = await createRemoteOpenCodeRuntime({
      host: fake.host,
      remotePath: "/home/dev/app",
      runtimeDir,
      leaseStateFile: join(directory, "a.lease.json"),
      pickPort: () => 37331,
      readyTimeoutMs: 5_000,
      listenTimeoutMs: 5_000,
    });
    await first.dispose();
    const state = fake.storageAt(runtimeDir);
    assert.equal(state.lockHeld, false);
    assert.equal(state.serveLive, false);
    assert.equal(state.serveIdentity, undefined);

    const second = await createRemoteOpenCodeRuntime({
      host: fake.host,
      remotePath: "/home/dev/app",
      runtimeDir,
      leaseStateFile: join(directory, "b.lease.json"),
      pickPort: () => 37332,
      readyTimeoutMs: 5_000,
      listenTimeoutMs: 5_000,
    });
    assert.equal(fake.serveStartCommands.length, 2);
    await second.dispose();
  } finally {
    stub.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("orphan live OpenCode with a dead controller is adopted without a second serve", async () => {
  const stub = await startStubServe();
  const directory = await mkdtemp(join(tmpdir(), "polyth-remote-adopt-"));
  const runtimeDir = "/var/lib/polyth/runtimes/adopt";
  const fake = createFakeRemoteHost({ stubPort: stub.port, runtimeDir });
  const owner = {
    token: "orphan-token",
    pid: "4242",
    start: "100",
    exe: "/usr/bin/opencode",
    cmd: "1:2",
    port: stub.port,
  };
  const state = fake.storageAt(runtimeDir);
  state.lockHeld = false;
  state.serveIdentity = owner;
  state.serveLive = true;
  state.dbKind = "file";
  state.dbEntries = ["opencode.db"];
  state.dbContent = "opaque-remote-opencode-db";
  state.metadataKind = "file";
  state.metadata = JSON.stringify({
    engine: "opencode",
    version: "1.18.18",
    binaryDigest: TEST_REMOTE_DIGEST,
    protocolGeneration: 1,
    storageId: "11111111-1111-4111-8111-111111111111",
    binarySource: "path",
    binaryPath: state.binaryPath,
    runtimeAuthority: "owned:orphan",
    runtimeLocation: { projectId: "dev@fake.example", cwd: "/home/dev/app" },
    createdAt: new Date().toISOString(),
    lastOpenedAt: new Date().toISOString(),
  });
  try {
    const runtime = await createRemoteOpenCodeRuntime({
      host: fake.host,
      remotePath: "/home/dev/app",
      runtimeDir,
      leaseStateFile: join(directory, "adopt.lease.json"),
      pickPort: () => 37401,
      readyTimeoutMs: 5_000,
      listenTimeoutMs: 5_000,
    });
    assert.equal(fake.serveStartCommands.length, 0, "adoption must not spawn a second OpenCode");
    assert.equal(state.serveIdentity?.token, owner.token, "adopt keeps the immutable serve token");
    assert.equal(state.serveIdentity?.port, stub.port);
    assert.equal(state.serveLive, true);
    await runtime.dispose();
    assert.deepEqual(state.killedPids, ["4242"]);
    assert.equal(state.serveLive, false);
    assert.equal(state.serveIdentity, undefined);
    const next = await createRemoteOpenCodeRuntime({
      host: fake.host,
      remotePath: "/home/dev/app",
      runtimeDir,
      leaseStateFile: join(directory, "next.lease.json"),
      pickPort: () => 37402,
      readyTimeoutMs: 5_000,
      listenTimeoutMs: 5_000,
    });
    assert.equal(fake.serveStartCommands.length, 1, "clean acquisition after adopted dispose may spawn");
    await next.dispose();
  } finally {
    stub.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("PID reuse of a stale owner record does not kill the unrelated process", async () => {
  const runtimeDir = "/var/lib/polyth/runtimes/pid-reuse";
  const fake = createFakeRemoteHost({ stubPort: 1, runtimeDir });
  const stale = {
    token: "stale",
    pid: "9999",
    start: "1",
    exe: "/usr/bin/opencode",
    cmd: "1:1",
  };
  const state = fake.storageAt(runtimeDir);
  state.lockHeld = false;
  state.serveLive = false;
  state.serveIdentity = stale;
  const lock = await acquireRemoteRuntimeLock(fake.host, runtimeDir, "/home/dev/app");
  assert.equal(state.killedPids.length, 0);
  assert.equal(state.lockHeld, true);
  await lock.release();
});

test("second live Polyth controller cannot steal a locked remote runtime", async () => {
  const runtimeDir = "/var/lib/polyth/runtimes/second-server";
  const fake = createFakeRemoteHost({ stubPort: 1, runtimeDir });
  const state = fake.storageAt(runtimeDir);
  state.lockHeld = true;
  state.serveLive = true;
  state.serveIdentity = {
    token: "serve",
    pid: "4242",
    start: "200",
    exe: "/usr/bin/opencode",
    cmd: "3:4",
    port: 4100,
  };
  await assert.rejects(
    () => acquireRemoteRuntimeLock(fake.host, runtimeDir, "/home/dev/app"),
    /already owned|locked/,
  );
  assert.equal(state.lockHeld, true);
  assert.equal(state.killedPids.length, 0);
});

test("daemonized OpenCode stays alive until explicit runtime dispose", async () => {
  const stub = await startStubServe();
  const directory = await mkdtemp(join(tmpdir(), "polyth-remote-ssh-drop-"));
  const runtimeDir = "/var/lib/polyth/runtimes/ssh-drop";
  const fake = createFakeRemoteHost({ stubPort: stub.port, runtimeDir });
  try {
    const runtime = await createRemoteOpenCodeRuntime({
      host: fake.host,
      remotePath: "/home/dev/app",
      runtimeDir,
      leaseStateFile: join(directory, "ssh.lease.json"),
      pickPort: () => 37411,
      readyTimeoutMs: 5_000,
      listenTimeoutMs: 5_000,
    });
    const serveStarts = fake.serveStartCommands.length;
    const state = fake.storageAt(runtimeDir);
    assert.equal(serveStarts, 1);
    assert.equal(state.serveLive, true, "daemonized OpenCode outlives the one-shot start shell");
    assert.equal(state.lockHeld, true, "controller guardian stays until dispose");
    await runtime.dispose();
    assert.equal(fake.serveStartCommands.length, serveStarts);
    assert.equal(state.serveLive, false);
  } finally {
    stub.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("SSH transport loss with live OpenCode reconnects without a second serve", async () => {
  const stub = await startStubServe();
  const directory = await mkdtemp(join(tmpdir(), "polyth-remote-revive-live-"));
  const runtimeDir = "/var/lib/polyth/runtimes/revive-live";
  const fake = createFakeRemoteHost({ stubPort: stub.port, runtimeDir });
  try {
    const runtime = await createRemoteOpenCodeRuntime({
      host: fake.host,
      remotePath: "/home/dev/app",
      runtimeDir,
      leaseStateFile: join(directory, "revive.lease.json"),
      pickPort: () => 37421,
      readyTimeoutMs: 5_000,
      listenTimeoutMs: 5_000,
    });
    const starts = fake.serveStartCommands.length;
    const forwards = fake.forwards.length;
    await (runtime as ManagedOpenCodeRuntime).lifecycle.refresh("disconnect");
    assert.equal(fake.serveStartCommands.length, starts);
    assert.ok(fake.forwards.length > forwards, "must re-establish the SSH forward");
    await runtime.dispose();
  } finally {
    stub.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("SSH transport loss with a dead OpenCode replaces the serve", async () => {
  const stub = await startStubServe();
  const directory = await mkdtemp(join(tmpdir(), "polyth-remote-revive-dead-"));
  const runtimeDir = "/var/lib/polyth/runtimes/revive-dead";
  const fake = createFakeRemoteHost({ stubPort: stub.port, runtimeDir });
  try {
    const runtime = await createRemoteOpenCodeRuntime({
      host: fake.host,
      remotePath: "/home/dev/app",
      runtimeDir,
      leaseStateFile: join(directory, "dead.lease.json"),
      pickPort: () => 37422,
      readyTimeoutMs: 5_000,
      listenTimeoutMs: 5_000,
    });
    const state = fake.storageAt(runtimeDir);
    state.serveLive = false;
    await (runtime as ManagedOpenCodeRuntime).lifecycle.refresh("disconnect");
    assert.equal(fake.serveStartCommands.length, 2);
    await runtime.dispose();
  } finally {
    stub.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("unreachable SSH during revive does not spawn a second OpenCode", async () => {
  const stub = await startStubServe();
  const directory = await mkdtemp(join(tmpdir(), "polyth-remote-revive-ssh-"));
  const runtimeDir = "/var/lib/polyth/runtimes/revive-ssh";
  const fake = createFakeRemoteHost({ stubPort: stub.port, runtimeDir });
  try {
    const runtime = await createRemoteOpenCodeRuntime({
      host: fake.host,
      remotePath: "/home/dev/app",
      runtimeDir,
      leaseStateFile: join(directory, "ssh-down.lease.json"),
      pickPort: () => 37423,
      readyTimeoutMs: 5_000,
      listenTimeoutMs: 5_000,
    });
    fake.setServeProbeUnreachable(true);
    await assert.rejects(
      () => (runtime as ManagedOpenCodeRuntime).lifecycle.refresh("disconnect"),
      /owned serve may still be alive/,
    );
    assert.equal(fake.serveStartCommands.length, 1);
    fake.setServeProbeUnreachable(false);
    await runtime.dispose();
  } finally {
    stub.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("controller lease loss is observable and allows a new controller to adopt", async () => {
  const runtimeDir = "/var/lib/polyth/runtimes/controller-lost";
  const fake = createFakeRemoteHost({ stubPort: 1, runtimeDir });
  const first = await acquireRemoteRuntimeLock(fake.host, runtimeDir, "/home/dev/app");
    assert.equal(first.held(), true);
  await assert.rejects(
    () => acquireRemoteRuntimeLock(fake.host, runtimeDir, "/home/dev/app"),
    /already owned|locked/,
  );
  fake.killGuardians();
  await first.lost;
  assert.equal(first.held(), false);
  const second = await acquireRemoteRuntimeLock(fake.host, runtimeDir, "/home/dev/app");
  assert.equal(second.held(), true);
  await second.release();
});

test("startup fails when the forwarded HTTP endpoint never becomes ready", async () => {
  const directory = await mkdtemp(join(tmpdir(), "polyth-remote-unready-"));
  const runtimeDir = "/var/lib/polyth/runtimes/unready";
  const fake = createFakeRemoteHost({ stubPort: 1, runtimeDir });
  try {
    await assert.rejects(
      () => createRemoteOpenCodeRuntime({
        host: fake.host,
        remotePath: "/home/dev/app",
        runtimeDir,
        leaseStateFile: join(directory, "unready.lease.json"),
        pickPort: () => 37999,
        readyTimeoutMs: 400,
        listenTimeoutMs: 2_000,
      }),
      /did not become ready/,
    );
    assert.equal(fake.serveStartCommands.length, 1);
    const failed = fake.storageAt(runtimeDir);
    assert.equal(failed.serveLive, false);
    assert.equal(failed.serveIdentity, undefined);
    assert.deepEqual(failed.killedPids, ["4242"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("live PID with mismatched owner identity fails closed and is not killed", async () => {
  const runtimeDir = "/var/lib/polyth/runtimes/pid-mismatch";
  const fake = createFakeRemoteHost({ stubPort: 1, runtimeDir });
  const stale = {
    token: "stale",
    pid: "9999",
    start: "1",
    exe: "/usr/bin/opencode",
    cmd: "1:1",
  };
  const state = fake.storageAt(runtimeDir);
  state.lockHeld = false;
  state.serveIdentity = stale;
  state.serveLive = true;
  state.serveMismatch = true;
  await assert.rejects(
    () => acquireRemoteRuntimeLock(fake.host, runtimeDir, "/home/dev/app"),
    /identity does not match/,
  );
  assert.equal(state.lockHeld, false);
  assert.equal(state.killedPids.length, 0);
});

test("lost controller lease fences the old runtime before another controller may adopt", async () => {
  const stub = await startStubServe();
  const directory = await mkdtemp(join(tmpdir(), "polyth-remote-controller-fence-"));
  const runtimeDir = "/var/lib/polyth/runtimes/controller-fence";
  const fake = createFakeRemoteHost({ stubPort: stub.port, runtimeDir });
  try {
    const runtime = await createRemoteOpenCodeRuntime({
      host: fake.host,
      remotePath: "/home/dev/app",
      runtimeDir,
      leaseStateFile: join(directory, "a.lease.json"),
      pickPort: () => 37501,
      readyTimeoutMs: 5_000,
      listenTimeoutMs: 5_000,
    });
    fake.killGuardians();
    await assert.rejects(
      () => runtime.endpoint!(),
      (error: Error & { code?: string }) =>
        error.code === "conflict" && /controller lease was lost/.test(error.message),
    );
    const adopted = await acquireRemoteRuntimeLock(fake.host, runtimeDir, "/home/dev/app");
    assert.equal(adopted.held(), true);
    await adopted.release();
    await runtime.dispose();
  } finally {
    stub.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("guardian exit after ACQUIRED before the caller observes the handle marks the lease lost", async () => {
  const runtimeDir = "/var/lib/polyth/runtimes/acquire-gap";
  const fake = createFakeRemoteHost({ stubPort: 1, runtimeDir, exitAfterAcquired: true });
  const lock = await acquireRemoteRuntimeLock(fake.host, runtimeDir, "/home/dev/app");
  assert.equal(lock.held(), false);
  await lock.lost;
  await lock.release();
});

test("a stale controller cannot release a later controller's flock", async () => {
  const runtimeDir = "/var/lib/polyth/runtimes/stale-release";
  const fake = createFakeRemoteHost({ stubPort: 1, runtimeDir });
  const first = await acquireRemoteRuntimeLock(fake.host, runtimeDir, "/home/dev/app");
  fake.killGuardians();
  await first.lost;
  const second = await acquireRemoteRuntimeLock(fake.host, runtimeDir, "/home/dev/app");
  await first.release();
  assert.equal(second.held(), true);
  assert.equal(fake.storageAt(runtimeDir).lockHeld, true);
  await second.release();
  assert.equal(second.held(), false);
  assert.equal(fake.storageAt(runtimeDir).lockHeld, false);
});

test("crash after spawn before ready recovers a healthy candidate without a second serve", async () => {
  const stub = await startStubServe();
  const directory = await mkdtemp(join(tmpdir(), "polyth-remote-candidate-"));
  const runtimeDir = "/var/lib/polyth/runtimes/candidate";
  const fake = createFakeRemoteHost({ stubPort: stub.port, runtimeDir });
  const owner = {
    token: "spawned-not-ready",
    pid: "4242",
    start: "100",
    exe: "/usr/bin/opencode",
    cmd: "1:2",
    port: stub.port,
  };
  const state = fake.storageAt(runtimeDir);
  state.lockHeld = false;
  state.serveLive = true;
  state.serveIdentity = owner;
  state.dbKind = "file";
  state.dbEntries = ["opencode.db"];
  state.dbContent = "opaque-remote-opencode-db";
  state.metadataKind = "file";
  state.metadata = JSON.stringify({
    engine: "opencode",
    version: "1.18.18",
    binaryDigest: TEST_REMOTE_DIGEST,
    protocolGeneration: 1,
    storageId: "22222222-2222-4222-8222-222222222222",
    binarySource: "path",
    binaryPath: state.binaryPath,
    runtimeAuthority: "owned:candidate",
    runtimeLocation: { projectId: "dev@fake.example", cwd: "/home/dev/app" },
    createdAt: new Date().toISOString(),
    lastOpenedAt: new Date().toISOString(),
  });
  try {
    const runtime = await createRemoteOpenCodeRuntime({
      host: fake.host,
      remotePath: "/home/dev/app",
      runtimeDir,
      leaseStateFile: join(directory, "candidate.lease.json"),
      pickPort: () => 39999,
      readyTimeoutMs: 5_000,
      listenTimeoutMs: 5_000,
    });
    assert.equal(fake.serveStartCommands.length, 0, "healthy candidate must be adopted, not respawned");
    assert.equal(state.serveIdentity?.port, stub.port);
    await runtime.dispose();
  } finally {
    stub.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("adopted serve survives pre-commit forward failure and remains adoptable", async () => {
  const stub = await startStubServe();
  const directory = await mkdtemp(join(tmpdir(), "polyth-remote-forward-fail-"));
  const runtimeDir = "/var/lib/polyth/runtimes/forward-fail";
  const fake = createFakeRemoteHost({ stubPort: stub.port, runtimeDir });
  const owner = {
    token: "orphan-old",
    pid: "4242",
    start: "100",
    exe: "/usr/bin/opencode",
    cmd: "1:2",
    port: stub.port,
  };
  const state = fake.storageAt(runtimeDir);
  state.lockHeld = false;
  state.serveIdentity = owner;
  state.serveLive = true;
  state.dbKind = "file";
  state.dbEntries = ["opencode.db"];
  state.dbContent = "opaque-remote-opencode-db";
  state.metadataKind = "file";
  state.metadata = JSON.stringify({
    engine: "opencode",
    version: "1.18.18",
    binaryDigest: TEST_REMOTE_DIGEST,
    protocolGeneration: 1,
    storageId: "11111111-1111-4111-8111-111111111111",
    binarySource: "path",
    binaryPath: state.binaryPath,
    runtimeAuthority: "owned:orphan",
    runtimeLocation: { projectId: "dev@fake.example", cwd: "/home/dev/app" },
    createdAt: new Date().toISOString(),
    lastOpenedAt: new Date().toISOString(),
  });
  fake.failNextForwards(1);
  try {
    await assert.rejects(
      () => createRemoteOpenCodeRuntime({
        host: fake.host,
        remotePath: "/home/dev/app",
        runtimeDir,
        leaseStateFile: join(directory, "b.lease.json"),
        pickPort: () => 37601,
        readyTimeoutMs: 5_000,
        listenTimeoutMs: 5_000,
      }),
      /injected forward failure|forward/,
    );
    assert.equal(fake.serveStartCommands.length, 0, "forward failure must not spawn a second serve");
    assert.equal(state.serveLive, true, "adopted serve must survive pre-commit forward failure");
    assert.equal(state.serveIdentity?.token, owner.token);
    assert.equal(state.killedPids.length, 0, "no kill issued");
    assert.equal(state.lockHeld, false, "controller B must release flock");

    const runtime = await createRemoteOpenCodeRuntime({
      host: fake.host,
      remotePath: "/home/dev/app",
      runtimeDir,
      leaseStateFile: join(directory, "c.lease.json"),
      pickPort: () => 37602,
      readyTimeoutMs: 5_000,
      listenTimeoutMs: 5_000,
    });
    assert.equal(fake.serveStartCommands.length, 0, "controller C must adopt the same serve");
    assert.equal(state.serveIdentity?.token, owner.token);
    await runtime.dispose();
  } finally {
    stub.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

const seedLiveServe = (
  state: FakeRemoteStorageState,
  port: number,
  token = "live-serve",
) => {
  state.lockHeld = false;
  state.serveLive = true;
  state.serveIdentity = {
    token,
    pid: "4242",
    start: "100",
    exe: "/usr/bin/opencode",
    cmd: "1:2",
    port,
  };
  state.dbKind = "file";
  state.dbEntries = ["opencode.db"];
  state.dbContent = "opaque-remote-opencode-db";
  state.metadataKind = "file";
  state.metadata = JSON.stringify({
    engine: "opencode",
    version: "1.18.18",
    binaryDigest: TEST_REMOTE_DIGEST,
    protocolGeneration: 1,
    storageId: "11111111-1111-4111-8111-111111111111",
    binarySource: "path",
    binaryPath: state.binaryPath,
    runtimeAuthority: "owned:seed",
    runtimeLocation: { projectId: "dev@fake.example", cwd: "/home/dev/app" },
    createdAt: new Date().toISOString(),
    lastOpenedAt: new Date().toISOString(),
  });
};

const keyedFactory = (
  fake: ReturnType<typeof createFakeRemoteHost>,
  directory: string,
  runtimeDir: string,
  options: { lifecycleTimeoutMs?: number } = {},
) => {
  let n = 0;
  return async () => {
    n += 1;
    const runtime = await createRemoteOpenCodeRuntime({
      host: fake.host,
      remotePath: "/home/dev/app",
      runtimeDir,
      leaseStateFile: join(directory, `${n}.lease.json`),
      pickPort: () => 38000 + n,
      readyTimeoutMs: 5_000,
      listenTimeoutMs: 5_000,
      lifecycleTimeoutMs: options.lifecycleTimeoutMs ?? 5_000,
    });
    return { value: runtime, dispose: () => runtime.dispose() };
  };
};

test("R2 delayed SIGTERM death keeps same-key acquire blocked until the process is gone", async () => {
  const stub = await startStubServe();
  const directory = await mkdtemp(join(tmpdir(), "polyth-r2-"));
  const runtimeDir = "/var/lib/polyth/runtimes/r2";
  const fake = createFakeRemoteHost({ stubPort: stub.port, runtimeDir });
  const owner = createKeyedRuntimeOwner<Awaited<ReturnType<typeof createRemoteOpenCodeRuntime>>>();
  const factory = keyedFactory(fake, directory, runtimeDir);
  try {
    await owner.acquire("k", factory);
    const state = fake.storageAt(runtimeDir);
    state.exitOnTerm = false;
    state.holdAfterTerm = createDeferred();
    const disposeP = owner.dispose("k");
    await waitUntil(() => state.serveSignals.includes("TERM"));
    let created = false;
    const next = owner.acquire("k", async () => {
      created = true;
      return factory();
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(created, false, "R2 must not start while R1 death is unproven");
    assert.equal(state.serveLive, true);
    state.serveLive = false;
    state.serveIdentity = undefined;
    state.holdAfterTerm.resolve();
    await disposeP;
    await next;
    assert.equal(created, true);
    await owner.dispose("k");
  } finally {
    stub.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("R3 SIGKILL is issued only after SIGTERM grace if the exact process remains", async () => {
  const stub = await startStubServe();
  const directory = await mkdtemp(join(tmpdir(), "polyth-r3-"));
  const runtimeDir = "/var/lib/polyth/runtimes/r3";
  const fake = createFakeRemoteHost({ stubPort: stub.port, runtimeDir });
  try {
    const runtime = await createRemoteOpenCodeRuntime({
      host: fake.host,
      remotePath: "/home/dev/app",
      runtimeDir,
      leaseStateFile: join(directory, "a.lease.json"),
      pickPort: () => 38011,
      readyTimeoutMs: 5_000,
      listenTimeoutMs: 5_000,
    });
    const state = fake.storageAt(runtimeDir);
    state.exitOnTerm = false;
    state.exitOnKill = true;
    await runtime.dispose();
    assert.deepEqual(state.serveSignals, ["TERM", "KILL"]);
    assert.equal(state.serveLive, false);
    assert.equal(state.serveIdentity, undefined);
  } finally {
    stub.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("R4 unproven death rejects dispose, keeps PF, and fences the keyed owner", async () => {
  const stub = await startStubServe();
  const directory = await mkdtemp(join(tmpdir(), "polyth-r4-"));
  const runtimeDir = "/var/lib/polyth/runtimes/r4";
  const fake = createFakeRemoteHost({ stubPort: stub.port, runtimeDir });
  const owner = createKeyedRuntimeOwner<Awaited<ReturnType<typeof createRemoteOpenCodeRuntime>>>();
  const factory = keyedFactory(fake, directory, runtimeDir);
  try {
    await owner.acquire("k", factory);
    const state = fake.storageAt(runtimeDir);
    state.exitOnTerm = false;
    state.exitOnKill = false;
    await assert.rejects(() => owner.dispose("k"), /could not prove|still-alive/);
    assert.equal(state.serveLive, true);
    assert.ok(state.serveIdentity, "PF must remain when death is unproven");
    assert.deepEqual(state.serveSignals, ["TERM", "KILL"]);
    let created = false;
    await assert.rejects(
      () => owner.acquire("k", async () => {
        created = true;
        return factory();
      }),
      /fenced/,
    );
    assert.equal(created, false);
  } finally {
    stub.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("R5 PID reuse during SIGTERM never kills the replacement process", async () => {
  const stub = await startStubServe();
  const directory = await mkdtemp(join(tmpdir(), "polyth-r5-"));
  const runtimeDir = "/var/lib/polyth/runtimes/r5";
  const fake = createFakeRemoteHost({ stubPort: stub.port, runtimeDir });
  try {
    const runtime = await createRemoteOpenCodeRuntime({
      host: fake.host,
      remotePath: "/home/dev/app",
      runtimeDir,
      leaseStateFile: join(directory, "a.lease.json"),
      pickPort: () => 38021,
      readyTimeoutMs: 5_000,
      listenTimeoutMs: 5_000,
    });
    const state = fake.storageAt(runtimeDir);
    state.exitOnTerm = false;
    state.pidReuseAfterTerm = true;
    await runtime.dispose();
    assert.deepEqual(state.serveSignals, ["TERM"]);
    assert.equal(state.reusedProcessLive, true);
    assert.equal(state.serveIdentity, undefined);
  } finally {
    stub.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("R6/R7 replacement generation is published and adopted after Polyth restart", async () => {
  const stub = await startStubServe();
  const directory = await mkdtemp(join(tmpdir(), "polyth-r67-"));
  const runtimeDir = "/var/lib/polyth/runtimes/r67";
  const fake = createFakeRemoteHost({ stubPort: stub.port, runtimeDir });
  try {
    const runtime = await createRemoteOpenCodeRuntime({
      host: fake.host,
      remotePath: "/home/dev/app",
      runtimeDir,
      leaseStateFile: join(directory, "a.lease.json"),
      pickPort: () => 38031,
      readyTimeoutMs: 5_000,
      listenTimeoutMs: 5_000,
    }) as ManagedOpenCodeRuntime;
    const firstToken = fake.storageAt(runtimeDir).serveIdentity?.token;
    assert.ok(firstToken);
    assert.equal(runtime.lifecycle.control.kind, "owned");
    assert.ok("restart" in runtime.lifecycle);
    await runtime.lifecycle.restart("manual");
    const second = fake.storageAt(runtimeDir).serveIdentity;
    assert.ok(second);
    assert.notEqual(second.token, firstToken);
    assert.equal(fake.serveStartCommands.length, 2);
    assert.equal(fake.storageAt(runtimeDir).serveLive, true);
    fake.killGuardians();
    const adopted = await createRemoteOpenCodeRuntime({
      host: fake.host,
      remotePath: "/home/dev/app",
      runtimeDir,
      leaseStateFile: join(directory, "b.lease.json"),
      pickPort: () => 38032,
      readyTimeoutMs: 5_000,
      listenTimeoutMs: 5_000,
    });
    assert.equal(fake.serveStartCommands.length, 2, "new Polyth must adopt R2, not spawn R3");
    assert.equal(fake.storageAt(runtimeDir).serveIdentity?.token, second.token);
    await adopted.dispose();
    await runtime.dispose().catch(() => undefined);
  } finally {
    stub.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("R8 live candidate plus transient attach failure does not spawn a replacement", async () => {
  const stub = await startStubServe();
  const directory = await mkdtemp(join(tmpdir(), "polyth-r8-"));
  const runtimeDir = "/var/lib/polyth/runtimes/r8";
  const fake = createFakeRemoteHost({ stubPort: stub.port, runtimeDir });
  const state = fake.storageAt(runtimeDir);
  seedLiveServe(state, stub.port, "candidate-live");
  fake.failNextAttach(1);
  try {
    await assert.rejects(
      () => createRemoteOpenCodeRuntime({
        host: fake.host,
        remotePath: "/home/dev/app",
        runtimeDir,
        leaseStateFile: join(directory, "a.lease.json"),
        pickPort: () => 38041,
        readyTimeoutMs: 5_000,
        listenTimeoutMs: 5_000,
      }),
      /could not attach|connection refused|unavailable/,
    );
    assert.equal(fake.serveStartCommands.length, 0);
    assert.equal(state.serveLive, true);
    assert.equal(state.serveIdentity?.token, "candidate-live");
    assert.equal(state.lockHeld, false);
    const recovered = await createRemoteOpenCodeRuntime({
      host: fake.host,
      remotePath: "/home/dev/app",
      runtimeDir,
      leaseStateFile: join(directory, "b.lease.json"),
      pickPort: () => 38042,
      readyTimeoutMs: 5_000,
      listenTimeoutMs: 5_000,
    });
    assert.equal(fake.serveStartCommands.length, 0, "later controller must still adopt the candidate");
    await recovered.dispose();
  } finally {
    stub.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("R9 proven-dead candidate record may be replaced", async () => {
  const stub = await startStubServe();
  const directory = await mkdtemp(join(tmpdir(), "polyth-r9-"));
  const runtimeDir = "/var/lib/polyth/runtimes/r9";
  const fake = createFakeRemoteHost({ stubPort: stub.port, runtimeDir });
  const state = fake.storageAt(runtimeDir);
  seedLiveServe(state, stub.port, "dead-candidate");
  state.serveLive = false;
  try {
    const runtime = await createRemoteOpenCodeRuntime({
      host: fake.host,
      remotePath: "/home/dev/app",
      runtimeDir,
      leaseStateFile: join(directory, "a.lease.json"),
      pickPort: () => 38051,
      readyTimeoutMs: 5_000,
      listenTimeoutMs: 5_000,
    });
    assert.equal(fake.serveStartCommands.length, 1);
    assert.notEqual(state.serveIdentity?.token, "dead-candidate");
    await runtime.dispose();
  } finally {
    stub.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("R11 spawned serve plus precommit forward failure reaps that process", async () => {
  const stub = await startStubServe();
  const directory = await mkdtemp(join(tmpdir(), "polyth-r11-"));
  const runtimeDir = "/var/lib/polyth/runtimes/r11";
  const fake = createFakeRemoteHost({ stubPort: stub.port, runtimeDir });
  fake.failNextForwards(1);
  try {
    await assert.rejects(
      () => createRemoteOpenCodeRuntime({
        host: fake.host,
        remotePath: "/home/dev/app",
        runtimeDir,
        leaseStateFile: join(directory, "a.lease.json"),
        pickPort: () => 38061,
        readyTimeoutMs: 5_000,
        listenTimeoutMs: 5_000,
      }),
      /injected forward failure|forward/,
    );
    const state = fake.storageAt(runtimeDir);
    assert.equal(fake.serveStartCommands.length, 1);
    assert.equal(state.serveLive, false);
    assert.equal(state.serveIdentity, undefined);
    assert.deepEqual(state.killedPids, ["4242"]);
    assert.equal(state.lockHeld, false);
  } finally {
    stub.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("R13 controller release failure fences the keyed owner", async () => {
  const stub = await startStubServe();
  const directory = await mkdtemp(join(tmpdir(), "polyth-r13-"));
  const runtimeDir = "/var/lib/polyth/runtimes/r13";
  const fake = createFakeRemoteHost({ stubPort: stub.port, runtimeDir });
  const owner = createKeyedRuntimeOwner<Awaited<ReturnType<typeof createRemoteOpenCodeRuntime>>>();
  const factory = keyedFactory(fake, directory, runtimeDir, { lifecycleTimeoutMs: 200 });
  try {
    await owner.acquire("k", factory);
    fake.storageAt(runtimeDir).failControllerRelease = true;
    await assert.rejects(() => owner.dispose("k"), /did not release|exceeded|no release channel/);
    let created = false;
    await assert.rejects(
      () => owner.acquire("k", async () => {
        created = true;
        return factory();
      }),
      /fenced/,
    );
    assert.equal(created, false);
    assert.equal(fake.storageAt(runtimeDir).lockHeld, true);
  } finally {
    stub.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

const pfWriteFailBoot = (
  fake: ReturnType<typeof createFakeRemoteHost>,
  directory: string,
  runtimeDir: string,
  port: number,
) =>
  createRemoteOpenCodeRuntime({
    host: fake.host,
    remotePath: "/home/dev/app",
    runtimeDir,
    leaseStateFile: join(directory, `${port}.lease.json`),
    pickPort: () => port,
    readyTimeoutMs: 5_000,
    listenTimeoutMs: 5_000,
  });

test("F1 PF write fails and TERM exits the unpublished child", async () => {
  const stub = await startStubServe();
  const directory = await mkdtemp(join(tmpdir(), "polyth-f1-"));
  const runtimeDir = "/var/lib/polyth/runtimes/f1";
  const fake = createFakeRemoteHost({ stubPort: stub.port, runtimeDir });
  const state = fake.storageAt(runtimeDir);
  state.failPfWrite = true;
  state.exitOnTerm = true;
  try {
    await assert.rejects(
      () => pfWriteFailBoot(fake, directory, runtimeDir, 38101),
      (error: Error) =>
        /IDENTITY_INCOMPLETE|exited|did not become ready/.test(error.message)
        && !/unpublished remote OpenCode serve/.test(error.message),
    );
    assert.deepEqual(state.serveSignals, ["TERM"]);
    assert.equal(state.serveLive, false);
    assert.equal(state.serveIdentity, undefined);
    assert.equal(state.lockHeld, false);
    state.failPfWrite = false;
    const next = await pfWriteFailBoot(fake, directory, runtimeDir, 38102);
    assert.equal(fake.serveStartCommands.length, 2);
    assert.equal(state.serveLive, true);
    await next.dispose();
  } finally {
    stub.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("F2 PF write fails, TERM does not stop the child, KILL does", async () => {
  const stub = await startStubServe();
  const directory = await mkdtemp(join(tmpdir(), "polyth-f2-"));
  const runtimeDir = "/var/lib/polyth/runtimes/f2";
  const fake = createFakeRemoteHost({ stubPort: stub.port, runtimeDir });
  const state = fake.storageAt(runtimeDir);
  state.failPfWrite = true;
  state.exitOnTerm = false;
  state.exitOnKill = true;
  try {
    await assert.rejects(
      () => pfWriteFailBoot(fake, directory, runtimeDir, 38111),
      (error: Error) =>
        /IDENTITY_INCOMPLETE|exited|did not become ready/.test(error.message)
        && !/unpublished remote OpenCode serve/.test(error.message),
    );
    assert.deepEqual(state.serveSignals, ["TERM", "KILL"]);
    assert.equal(state.serveLive, false);
    assert.equal(state.serveIdentity, undefined);
    assert.equal(state.lockHeld, false);
    state.failPfWrite = false;
    const next = await pfWriteFailBoot(fake, directory, runtimeDir, 38112);
    assert.equal(state.serveLive, true);
    await next.dispose();
  } finally {
    stub.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("F3 PF write fails and unpublished child death is unprovable", async () => {
  const stub = await startStubServe();
  const directory = await mkdtemp(join(tmpdir(), "polyth-f3-"));
  const runtimeDir = "/var/lib/polyth/runtimes/f3";
  const fake = createFakeRemoteHost({ stubPort: stub.port, runtimeDir });
  const state = fake.storageAt(runtimeDir);
  state.failPfWrite = true;
  state.exitOnTerm = false;
  state.exitOnKill = false;
  try {
    await assert.rejects(
      () => pfWriteFailBoot(fake, directory, runtimeDir, 38121),
      (error: Error) =>
        /unpublished remote OpenCode serve/.test(error.message)
        && !/IDENTITY_INCOMPLETE/.test(error.message),
    );
    assert.deepEqual(state.serveSignals, ["TERM", "KILL"]);
    assert.equal(state.serveLive, true);
    assert.equal(state.serveIdentity, undefined);
    assert.equal(state.lockHeld, true);
    assert.equal(fake.serveStartCommands.length, 1);
  } finally {
    stub.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("F4 acquisition timeout with successful guardian cleanup allows the next acquire", async () => {
  const runtimeDir = "/var/lib/polyth/runtimes/f4";
  const fake = createFakeRemoteHost({ stubPort: 1, runtimeDir, lockOutputDelayMs: 200 });
  await assert.rejects(
    () => acquireRemoteRuntimeLock(fake.host, runtimeDir, "/home/dev/app", { timeoutMs: 30 }),
    /did not acquire within/,
  );
  assert.equal(fake.storageAt(runtimeDir).lockHeld, false);
  const lock = await acquireRemoteRuntimeLock(fake.host, runtimeDir, "/home/dev/app");
  assert.equal(lock.held(), true);
  await lock.release();
  assert.equal(fake.storageAt(runtimeDir).lockHeld, false);
});

test("F5 acquisition timeout plus guardian cleanup failure keeps the flock", async () => {
  const runtimeDir = "/var/lib/polyth/runtimes/f5";
  const fake = createFakeRemoteHost({ stubPort: 1, runtimeDir, lockOutputDelayMs: 200 });
  fake.storageAt(runtimeDir).failControllerRelease = true;
  await assert.rejects(
    () => acquireRemoteRuntimeLock(fake.host, runtimeDir, "/home/dev/app", { timeoutMs: 30 }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /guardian cleanup could not be confirmed/);
      assert.match(String(error.errors[0]), /did not acquire within/);
      return true;
    },
  );
  assert.equal(fake.storageAt(runtimeDir).lockHeld, true);
});
