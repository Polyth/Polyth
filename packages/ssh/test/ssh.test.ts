import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSshService, shq, type SshExecResult, type SshRunner, type SshSpawner } from "../src/index.ts";

interface Call { args: string[] }

/** Scriptable fake `ssh`: routes control ops (-O) and dialed commands. */
function fakeRunner(handlers: {
  check?: (call: Call) => number;
  exit?: (call: Call) => number;
  forward?: (call: Call) => SshExecResult;
  cancel?: (call: Call) => SshExecResult;
  dial?: (command: string, call: Call) => SshExecResult;
}) {
  const calls: Call[] = [];
  const ok: SshExecResult = { code: 0, stdout: "", stderr: "" };
  const runner: SshRunner = async (args) => {
    const call = { args };
    calls.push(call);
    const opIndex = args.indexOf("-O");
    if (opIndex >= 0) {
      const op = args[opIndex + 1]!;
      if (op === "check") return { ...ok, code: handlers.check?.(call) ?? 1 };
      if (op === "exit") return { ...ok, code: handlers.exit?.(call) ?? 0 };
      if (op === "forward") return handlers.forward?.(call) ?? ok;
      if (op === "cancel") return handlers.cancel?.(call) ?? ok;
      return { code: 1, stdout: "", stderr: `unexpected control op ${op}` };
    }
    const command = args[args.length - 1]!;
    return handlers.dial?.(command, call) ?? ok;
  };
  return { runner, calls };
}

const tempFile = (): string => join(mkdtempSync(join(tmpdir(), "polyth-ssh-test-")), "ssh.json");

const baseInput = { host: "build.example.com", user: "dev", port: 2222 } as const;

test("connection CRUD round-trip persists across reload and stores no secrets", () => {
  const file = tempFile();
  const { runner } = fakeRunner({});
  const service = createSshService({ file, runner, socketDir: mkdtempSync(join(tmpdir(), "sock-")) });

  const created = service.create({ ...baseInput, name: "Build box" });
  assert.equal(created.name, "Build box");
  assert.equal(created.host, "build.example.com");
  assert.equal(created.user, "dev");
  assert.equal(created.port, 2222);
  assert.equal(created.authMode, "agent");

  const updated = service.update(created.id, { authMode: "identity-file", identityFile: "~/.ssh/id_ed25519" });
  assert.equal(updated.identityFile, "~/.ssh/id_ed25519");
  assert.equal(updated.host, "build.example.com"); // untouched fields survive

  const reloaded = createSshService({ file, runner, socketDir: mkdtempSync(join(tmpdir(), "sock-")) });
  const listed = reloaded.list();
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0], reloaded.get(created.id));
  assert.equal(listed[0]!.identityFile, "~/.ssh/id_ed25519");
  // the DTO shape can never leak secret material — it has nowhere to hold it
  const keys = Object.keys(listed[0]!).sort();
  assert.deepEqual(keys, ["authMode", "createdAt", "host", "id", "identityFile", "name", "port", "user"]);
});

test("secret-looking fields are rejected outright", () => {
  const { runner } = fakeRunner({});
  const service = createSshService({ file: tempFile(), runner });
  for (const field of ["password", "passphrase", "privateKey", "token"]) {
    assert.throws(
      () => service.create({ ...baseInput, [field]: "hunter2" } as never),
      (err: Error & { code?: string }) => err.code === "invalid-input" && err.message.includes(field),
    );
  }
});

test("host/user/port validation blocks option injection and junk", () => {
  const { runner } = fakeRunner({});
  const service = createSshService({ file: tempFile(), runner });
  assert.throws(() => service.create({ host: "-oProxyCommand=evil" }), /must not start with "-"/);
  assert.throws(() => service.create({ host: "two words" }), /whitespace/);
  assert.throws(() => service.create({ host: "ok.example", user: "a b" }), /whitespace/);
  assert.throws(() => service.create({ host: "ok.example", user: "x@y" }), /@/);
  assert.throws(() => service.create({ host: "ok.example", port: 700000 }), /port/);
  assert.throws(
    () => service.create({ host: "ok.example", authMode: "identity-file" }),
    /identityFile is required/,
  );
});

test("connect classifies success, auth failure, and unreachable hosts", async () => {
  const { runner } = fakeRunner({
    dial: (command, call) => {
      const dest = call.args[call.args.length - 2];
      if (dest === "dev@auth.example") return { code: 255, stdout: "", stderr: "dev@auth.example: Permission denied (publickey)." };
      if (dest === "dev@down.example") return { code: 255, stdout: "", stderr: "ssh: connect to host down.example port 22: Connection refused" };
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  const service = createSshService({ file: tempFile(), runner, now: () => 1000 });
  const good = service.create({ host: "up.example", user: "dev" });
  const auth = service.create({ host: "auth.example", user: "dev" });
  const down = service.create({ host: "down.example", user: "dev" });

  assert.equal((await service.connect(good.id)).state, "connected");
  const authStatus = await service.connect(auth.id);
  assert.equal(authStatus.state, "auth-failed");
  assert.match(authStatus.message ?? "", /Permission denied/);
  const downStatus = await service.connect(down.id);
  assert.equal(downStatus.state, "unreachable");
  assert.equal(service.cachedStatus(down.id)?.state, "unreachable");
});

test("status uses the local mux check and never dials", async () => {
  let muxAlive = true;
  const dialed: string[] = [];
  const { runner, calls } = fakeRunner({
    check: () => (muxAlive ? 0 : 1),
    dial: (command) => { dialed.push(command); return { code: 0, stdout: "", stderr: "" }; },
  });
  const service = createSshService({ file: tempFile(), runner });
  const conn = service.create({ host: "up.example" });

  assert.equal((await service.status(conn.id)).state, "connected");
  muxAlive = false;
  assert.equal((await service.status(conn.id)).state, "disconnected");
  assert.equal(dialed.length, 0, "status must not run remote commands");
  // every status call was a -O check against the control socket
  assert.ok(calls.every((c) => c.args.includes("-O")));
});

test("exec builds safe argv: BatchMode, ControlPath mux, -- before destination", async () => {
  const { runner, calls } = fakeRunner({
    dial: () => ({ code: 0, stdout: "ok\n", stderr: "" }),
  });
  const service = createSshService({ file: tempFile(), runner });
  const conn = service.create({ ...baseInput, authMode: "identity-file", identityFile: "/keys/id" });
  const result = await service.exec(conn.id, "uname -a");
  assert.equal(result.stdout, "ok\n");

  const args = calls[0]!.args;
  assert.ok(args.includes("BatchMode=yes"));
  assert.ok(args.some((a) => a.startsWith("ControlPath=")));
  assert.ok(args.some((a) => a.startsWith("ControlPersist=")));
  assert.deepEqual(args.slice(args.indexOf("-p"), args.indexOf("-p") + 2), ["-p", "2222"]);
  assert.deepEqual(args.slice(args.indexOf("-i"), args.indexOf("-i") + 2), ["-i", "/keys/id"]);
  // `--` terminates option parsing right before the destination + command
  assert.deepEqual(args.slice(-3), ["--", "dev@build.example.com", "uname -a"]);
});

test("test() measures latency and verifies the probe nonce", async () => {
  let clock = 5000;
  const { runner } = fakeRunner({
    dial: (command) => {
      clock += 42;
      const nonce = command.replace("echo ", "");
      return { code: 0, stdout: `${nonce}\n`, stderr: "" };
    },
  });
  const service = createSshService({ file: tempFile(), runner, now: () => clock });
  const conn = service.create({ host: "up.example" });
  const status = await service.test(conn.id);
  assert.equal(status.state, "connected");
  assert.equal(status.latencyMs, 42);
});

test("browse lists remote directories and resolves parent/home", async () => {
  const { runner } = fakeRunner({
    dial: (command) => {
      if (command.includes("$HOME")) return { code: 0, stdout: "/home/dev", stderr: "" };
      if (command.startsWith("cd -- '/home/dev/projects'")) {
        return { code: 0, stdout: "/home/dev/projects\napi/\nweb/\nREADME.md\n.git/\n", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "no such directory" };
    },
  });
  const service = createSshService({ file: tempFile(), runner });
  const conn = service.create({ host: "up.example" });

  const browsed = await service.browse(conn.id, "/home/dev/projects");
  assert.equal(browsed.path, "/home/dev/projects");
  assert.equal(browsed.parent, "/home/dev");
  assert.equal(browsed.home, "/home/dev");
  assert.deepEqual(browsed.entries, [
    { name: "api", path: "/home/dev/projects/api" },
    { name: "web", path: "/home/dev/projects/web" },
  ]);

  await assert.rejects(
    () => service.browse(conn.id, "/nope"),
    (err: Error & { code?: string }) => err.code === "not-found",
  );
});

test("dirExists and makeDir shell-quote remote paths", async () => {
  const seen: string[] = [];
  const { runner } = fakeRunner({
    dial: (command) => {
      seen.push(command);
      return { code: command.includes("missing") ? 1 : 0, stdout: "", stderr: "" };
    },
  });
  const service = createSshService({ file: tempFile(), runner });
  const conn = service.create({ host: "up.example" });

  assert.equal(await service.dirExists(conn.id, "/srv/it's here"), true);
  assert.equal(await service.dirExists(conn.id, "/srv/missing"), false);
  await service.makeDir(conn.id, "/srv/new dir");
  assert.ok(seen[0]!.includes(shq("/srv/it's here")));
  assert.ok(seen[2]!.includes(`mkdir -p -- ${shq("/srv/new dir")}`));
});

test("host(): start ensures the master, streams output, forward maps a local port", async () => {
  let muxAlive = false;
  const spawned: string[][] = [];
  const { runner, calls } = fakeRunner({
    check: () => (muxAlive ? 0 : 1),
    dial: (command) => {
      if (command === "true") { muxAlive = true; return { code: 0, stdout: "", stderr: "" }; }
      return { code: 0, stdout: "", stderr: "" };
    },
    forward: () => ({ code: 0, stdout: "", stderr: "" }),
    cancel: () => ({ code: 0, stdout: "", stderr: "" }),
  });
  const spawner: SshSpawner = (args) => {
    spawned.push(args);
    return {
      onOutput: (cb) => { cb("remote says hi\n"); return { dispose: () => {} }; },
      onExit: () => ({ dispose: () => {} }),
      kill: () => {},
    };
  };
  const service = createSshService({
    file: tempFile(), runner, spawner, freeLocalPort: async () => 43_210,
  });
  const conn = service.create({ host: "up.example", user: "dev" });
  const host = service.host(conn.id);
  assert.equal(host.label, "dev@up.example");

  let output = "";
  const proc = await host.start("run-something");
  proc.onOutput((chunk) => { output += chunk; });
  assert.equal(output, "remote says hi\n");
  assert.ok(muxAlive, "start() must establish the master first");
  assert.deepEqual(spawned[0]!.slice(-3), ["--", "dev@up.example", "run-something"]);

  const fwd = await host.forward(8123);
  assert.equal(fwd.localPort, 43_210);
  const forwardCall = calls.find((c) => c.args.includes("forward"));
  assert.ok(forwardCall);
  assert.ok(forwardCall!.args.includes("-L"));
  assert.ok(forwardCall!.args.includes("127.0.0.1:43210:127.0.0.1:8123"));
  await fwd.dispose();
  assert.ok(calls.some((c) => c.args.includes("cancel")));
});

test("host() fails honestly when the connection cannot be established", async () => {
  const { runner } = fakeRunner({
    check: () => 1,
    dial: () => ({ code: 255, stdout: "", stderr: "Permission denied (publickey)." }),
  });
  const service = createSshService({ file: tempFile(), runner });
  const conn = service.create({ host: "auth.example", name: "Auth box" });
  await assert.rejects(
    () => service.host(conn.id).start("anything"),
    (err: Error & { code?: string }) => err.code === "unavailable" && /auth-failed/.test(err.message),
  );
});

test("disconnect and remove tear down the mux; concurrent connects dedupe", async () => {
  let dials = 0;
  let exits = 0;
  const { runner } = fakeRunner({
    exit: () => { exits += 1; return 0; },
    dial: () => { dials += 1; return { code: 0, stdout: "", stderr: "" }; },
  });
  const service = createSshService({ file: tempFile(), runner });
  const conn = service.create({ host: "up.example" });

  const [a, b] = await Promise.all([service.connect(conn.id), service.connect(conn.id)]);
  assert.equal(a.state, "connected");
  assert.equal(b.state, "connected");
  assert.equal(dials, 1, "concurrent connects must share one dial");

  assert.equal((await service.disconnect(conn.id)).state, "disconnected");
  await service.remove(conn.id);
  assert.equal(exits, 2, "remove also closes the master");
  assert.equal(service.list().length, 0);
  await assert.rejects(() => service.connect(conn.id), (err: Error & { code?: string }) => err.code === "not-found");
});
