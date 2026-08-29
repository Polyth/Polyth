import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import type { RemoteHost, RemoteProcessHandle } from "@polyth/contracts";
import {
  createRemoteOpenCodeRuntime,
  OPENCODE_UPDATE_DISABLE_ENV,
  probeRemoteOpenCode,
} from "../src/index.ts";

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

interface FakeHostScript {
  /** Remote `opencode --version` output; POLYTH_OC_MISSING = not installed. */
  version?: string;
  missingBinary?: boolean;
  missingDir?: boolean;
  reportedDbPath?: string;
  /** Ports that fail with EADDRINUSE before one succeeds. */
  busyPorts?: number[];
  stubPort: number;
}

const createFakeHost = (script: FakeHostScript) => {
  const execCalls: string[] = [];
  const startCommands: string[] = [];
  const killedHandles: number[] = [];
  const forwards: Array<{ remotePort: number; cancelled: boolean }> = [];

  const host: RemoteHost = {
    label: "dev@fake.example",
    async exec(command) {
      execCalls.push(command);
      if (command.includes("command -v")) {
        return script.missingBinary
          ? { code: 0, stdout: "POLYTH_OC_MISSING\n", stderr: "" }
          : { code: 0, stdout: `${script.version ?? "1.18.18"}\n`, stderr: "" };
      }
      if (command.includes(" db path")) {
        const expected = command.match(/OPENCODE_DB='([^']+)'/)?.[1] ?? "";
        return {
          code: 0,
          stdout: `${script.reportedDbPath ?? expected}\n`,
          stderr: "",
        };
      }
      if (command.startsWith("test -d")) {
        return { code: script.missingDir ? 1 : 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    async start(command) {
      startCommands.push(command);
      const index = startCommands.length - 1;
      const port = Number(command.match(/--port (\d+)/)?.[1] ?? 0);
      const outputs = new Set<(chunk: string) => void>();
      const exits = new Set<(code: number | null) => void>();
      const handle: RemoteProcessHandle = {
        onOutput(cb) {
          outputs.add(cb);
          return { dispose: () => { outputs.delete(cb); } };
        },
        onExit(cb) {
          exits.add(cb);
          return { dispose: () => { exits.delete(cb); } };
        },
        async kill() { killedHandles.push(index); },
      };
      setTimeout(() => {
        if (script.busyPorts?.includes(port)) {
          for (const cb of outputs) cb(`Error: listen EADDRINUSE: address already in use 127.0.0.1:${port}\n`);
          for (const cb of exits) cb(1);
          return;
        }
        for (const cb of outputs) cb("POLYTH_REMOTE_PID=4242\n");
        for (const cb of outputs) cb(`opencode server listening on http://127.0.0.1:${port}\n`);
      }, 5);
      return handle;
    },
    async forward(remotePort) {
      const record = { remotePort, cancelled: false };
      forwards.push(record);
      return {
        localPort: script.stubPort,
        dispose: async () => { record.cancelled = true; },
      };
    },
  };
  return { host, execCalls, startCommands, killedHandles, forwards };
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
    assert.equal(fake.startCommands.length, 1);
    const cmd = fake.startCommands[0]!;
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
        .filter((call) => call.includes("command -v") || call.includes(" db path"))
        .every((call) => call.includes(`export ${OPENCODE_UPDATE_DISABLE_ENV}=true`)),
      "all remote engine probes must disable OpenCode self-update",
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
  assert.deepEqual(fake.killedHandles, [0]);
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
    assert.ok(fake.startCommands[0]!.startsWith(pathPrefix), `serve misses PATH prefix: ${fake.startCommands[0]}`);
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
    const pidFiles = fake.startCommands.map((command) =>
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
    assert.equal(fake.startCommands.length, 3);
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

test("owned remote runtime fails closed without an explicit remote runtime directory", async () => {
  const fake = createFakeHost({ stubPort: 1 });
  await assert.rejects(
    () => createRemoteOpenCodeRuntime({ host: fake.host, remotePath: "/srv/app" }),
    /runtimeDir is required.*global OpenCode DB/,
  );
  assert.equal(fake.execCalls.length, 0);
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
