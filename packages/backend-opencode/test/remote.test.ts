import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  acquireRemoteRuntimeLock,
  createRemoteOpenCodeRuntime,
  DEFAULT_REMOTE_RUNTIME_ROOT_EXPR,
  OPENCODE_UPDATE_DISABLE_ENV,
  ownedSshRuntimeIdentityKey,
  parseOpenCodeRuntimeMetadata,
  probeRemoteOpenCode,
  REMOTE_STORAGE_MARKERS,
} from "../src/index.ts";
import {
  createFakeRemoteHost,
  TEST_REMOTE_DIGEST,
  TEST_REMOTE_DIGEST_B,
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
    assert.ok(cmd.includes("cd '/home/dev/app'; opencode serve --hostname 127.0.0.1 --port 37001"), cmd);
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
    assert.match(cmd, /printf .*POLYTH_REMOTE_PID/s, "must record an exact instance token");
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
      cmd.includes(`.polyth-runtime-owner`),
      "serve must record a runtime-directory owner token",
    );
    assert.ok(
      cmd.includes("POLYTH_RUNTIME_OWNED="),
      "a live owner must fail closed rather than being killed",
    );
    assert.ok(
      cmd.includes(".polyth-runtime-lock"),
      "serve must write the STARTING→RUNNING handoff after the owner file",
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
  const killExec = fake.execCalls.find((c) => c.includes('kill "$PID"'));
  assert.ok(killExec, `expected a remote kill, got: ${fake.execCalls.join(" | ")}`);
  assert.ok(killExec!.includes('oc_start "$PID"'));
  assert.ok(killExec!.includes('oc_exe "$PID"'));
  assert.ok(killExec!.includes('oc_cmd "$PID"'));
  assert.ok(killExec!.includes('rm -f "$PF"'));
  const serveIndex = fake.startCommands.findIndex((command) => command.includes("opencode serve"));
  assert.ok(serveIndex >= 0);
  assert.ok(fake.killedHandles.includes(serveIndex));
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
  assert.match(bad.message ?? "", /not installed/);
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
    /already owned|locked|held by a live serve/,
  );
  assert.equal(fake.serveStartCommands.length, 0);

  fake.inject({ kind: "symlink-owner" });
  await assert.rejects(
    () => createRemoteOpenCodeRuntime({
      host: fake.host,
      remotePath: "/srv/app",
      runtimeDir: "/var/lib/polyth/runtimes/owned",
    }),
    /owner record is a symlink/,
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
  assert.equal(fake.startCommands.length, 0);
  assert.equal(fake.forwards.length, 0);
  assert.equal(
    fake.execCalls.some((call) => call.includes(REMOTE_STORAGE_MARKERS.acquireLock)),
    false,
    "process-identity failure must happen before the remote lock",
  );
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

test("stale remote lock steal uses exclusive reclaim mkdir", async () => {
  assert.equal(REMOTE_STORAGE_MARKERS.lockGuardian, "POLYTH_REMOTE_LOCK_GUARDIAN=1");
  const src = await readFile(new URL("../src/remoteStorage.ts", import.meta.url), "utf8");
  const acquire = src.slice(
    src.indexOf("const remoteLockGuardianCommand"),
    src.indexOf("const withStartDeadline"),
  );
  const reclaimAt = acquire.indexOf('mkdir "$LOCK.reclaim"');
  const rmAt = acquire.indexOf('rm -rf "$LOCK"', reclaimAt);
  assert.ok(reclaimAt >= 0, "stale path must mkdir an exclusive reclaim dir");
  assert.ok(rmAt > reclaimAt, "must not rm the lock before winning reclaim");
  assert.match(acquire, /REMOTE_STORAGE_MARKERS\.lockGuardian/);
  assert.match(acquire, /write_starting/);
  assert.match(acquire, /id_state/);
  assert.match(acquire, /STARTING_STATE/);
  assert.match(acquire, /SERVE_STATE/);
  assert.match(acquire, /verify-failed/);
});

test("stale lock recover needs complete identities and exclusive reclaim", async () => {
  const runtimeDir = "/var/lib/polyth/runtimes/stale-lock";
  const fake = createFakeHost({ stubPort: 1, runtimeDir });
  const dead = { token: "dead-token", pid: "9", start: "1", exe: "/bin/oc", cmd: "1:1" };
  const state = fake.storageAt(runtimeDir);
  state.lockHeld = true;
  state.lockToken = dead.token;
  state.ownerKind = "file";
  state.ownerLive = false;
  state.ownerIdentity = { ...dead, pid: "" };

  await assert.rejects(
    () => acquireRemoteRuntimeLock(fake.host, runtimeDir, "next", "/home/dev/app"),
    /could not verify remote startup ownership/,
  );
  assert.equal(state.lockHeld, true);
  assert.equal(state.lockToken, dead.token);
  assert.equal(state.lockReclaimHeld, false, "incomplete RUNNING owner must not start reclaim");

  state.ownerKind = "missing";
  state.ownerIdentity = undefined;
  state.startingIdentity = { ...dead, pid: "" };
  state.startingLive = false;
  await assert.rejects(
    () => acquireRemoteRuntimeLock(fake.host, runtimeDir, "next", "/home/dev/app"),
    /could not verify remote startup ownership/,
  );
  assert.equal(state.lockHeld, true);
  assert.equal(state.lockToken, dead.token);
  assert.equal(state.lockReclaimHeld, false, "incomplete STARTING identity must not start reclaim");

  state.startingIdentity = dead;
  state.startingLive = false;
  state.ownerKind = "file";
  state.ownerIdentity = dead;
  state.ownerLive = true;
  await assert.rejects(
    () => acquireRemoteRuntimeLock(fake.host, runtimeDir, "next", "/home/dev/app"),
    /already owned|locked/,
  );
  assert.equal(state.lockHeld, true);
  assert.equal(state.lockToken, dead.token);

  state.ownerLive = false;
  state.lockReclaimHeld = true;
  await assert.rejects(
    () => acquireRemoteRuntimeLock(fake.host, runtimeDir, "next", "/home/dev/app"),
    /already owned|locked/,
  );
  assert.equal(state.lockHeld, true);
  assert.equal(state.lockToken, dead.token, "must not rm while another process holds reclaim");

  state.lockReclaimHeld = false;
  state.ownerKind = "missing";
  state.ownerIdentity = undefined;
  state.startingIdentity = dead;
  state.startingLive = false;
  state.serveLive = false;
  state.serveIdentity = undefined;
  const lock = await acquireRemoteRuntimeLock(fake.host, runtimeDir, "next", "/home/dev/app");
  assert.equal(state.lockHeld, true);
  assert.equal(state.lockToken, "next");
  assert.equal(state.lockReclaimHeld, false);
  assert.equal(state.startingLive, true);
  await lock.guardian.kill();
});

test("dead STARTING lock with no owner or serve is reclaimed by the next runtime", async () => {
  const stub = await startStubServe();
  const directory = await mkdtemp(join(tmpdir(), "polyth-remote-crash-a-"));
  const runtimeDir = "/var/lib/polyth/runtimes/crash-a";
  const fake = createFakeHost({ stubPort: stub.port, runtimeDir });
  const dead = { token: "crash-a", pid: "8", start: "1", exe: "/bin/sh", cmd: "1:1" };
  const state = fake.storageAt(runtimeDir);
  state.lockHeld = true;
  state.lockToken = dead.token;
  state.startingIdentity = dead;
  state.startingLive = false;
  state.ownerKind = "missing";
  state.ownerLive = false;
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
    assert.equal(fake.serveStartCommands.length, 1, "Crash A recovery must start exactly one serve");
    assert.equal(state.lockHeld, true);
    assert.notEqual(state.lockToken, dead.token);
    await runtime.dispose();
  } finally {
    stub.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("live STARTING owner fails closed while the first runtime is still preparing", async () => {
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
    assert.equal(state.startingLive, true);
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
    assert.equal(fake.serveStartCommands.length, 0, "live STARTING must not let B start serve");

    fake.releaseHoldAfterLock();
    const runtime = await first;
    assert.equal(fake.serveStartCommands.length, 1, "only the live STARTING owner may start serve");
    await runtime.dispose();
  } finally {
    stub.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("two simultaneous recoveries of a dead STARTING lock start exactly one serve", async () => {
  const stub = await startStubServe();
  const directory = await mkdtemp(join(tmpdir(), "polyth-remote-reclaim-race-"));
  const runtimeDir = "/var/lib/polyth/runtimes/reclaim-race";
  const fake = createFakeHost({
    stubPort: stub.port,
    runtimeDir,
    awaitLockRivals: 2,
  });
  const dead = { token: "dead-starting", pid: "7", start: "1", exe: "/bin/sh", cmd: "1:1" };
  const state = fake.storageAt(runtimeDir);
  state.lockHeld = true;
  state.lockToken = dead.token;
  state.startingIdentity = dead;
  state.startingLive = false;
  state.ownerKind = "missing";
  state.serveLive = false;
  try {
    const results = await Promise.allSettled([
      createRemoteOpenCodeRuntime({
        host: fake.host,
        remotePath: "/home/dev/app",
        runtimeDir,
        leaseStateFile: join(directory, "a.lease.json"),
        pickPort: () => 37321,
        readyTimeoutMs: 5_000,
        listenTimeoutMs: 5_000,
      }),
      createRemoteOpenCodeRuntime({
        host: fake.host,
        remotePath: "/home/dev/app",
        runtimeDir,
        leaseStateFile: join(directory, "b.lease.json"),
        pickPort: () => 37322,
        readyTimeoutMs: 5_000,
        listenTimeoutMs: 5_000,
      }),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    assert.equal(fulfilled.length, 1, "exactly one recovery may win exclusive reclaim");
    assert.equal(rejected.length, 1, "exactly one recovery must lose exclusive reclaim");
    assert.match(
      String((rejected[0] as PromiseRejectedResult).reason),
      /already owned|locked|startup owner is still alive|could not reclaim/,
    );
    assert.equal(fake.serveStartCommands.length, 1);
    await (fulfilled[0] as PromiseFulfilledResult<
      Awaited<ReturnType<typeof createRemoteOpenCodeRuntime>>
    >).value.dispose();
  } finally {
    stub.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Crash C: live serve pid with missing owner fails closed and does not start another serve", async () => {
  const runtimeDir = "/var/lib/polyth/runtimes/crash-c";
  const fake = createFakeHost({ stubPort: 1, runtimeDir });
  const deadStarting = { token: "dead-start", pid: "6", start: "1", exe: "/bin/sh", cmd: "1:1" };
  const liveServe = { token: "live-serve", pid: "4242", start: "200", exe: "/usr/bin/opencode", cmd: "3:4" };
  const state = fake.storageAt(runtimeDir);
  state.lockHeld = true;
  state.lockToken = deadStarting.token;
  state.startingIdentity = deadStarting;
  state.startingLive = false;
  state.ownerKind = "missing";
  state.ownerIdentity = undefined;
  state.ownerLive = false;
  state.serveIdentity = liveServe;
  state.serveLive = true;
  const serveBefore = fake.serveStartCommands.length;
  await assert.rejects(
    () => createRemoteOpenCodeRuntime({
      host: fake.host,
      remotePath: "/home/dev/app",
      runtimeDir,
    }),
    /already owned|locked/,
  );
  assert.equal(fake.serveStartCommands.length, serveBefore);
  assert.equal(state.lockHeld, true);
  assert.equal(state.lockToken, deadStarting.token);
  assert.equal(state.lockReclaimHeld, false);
});

test("dispose releases lock, owner, and STARTING so the next create succeeds", async () => {
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
    assert.equal(state.lockToken, undefined);
    assert.equal(state.startingIdentity, undefined);
    assert.equal(state.startingLive, false);
    assert.equal(state.ownerKind, "missing");
    assert.equal(state.ownerLive, false);

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

