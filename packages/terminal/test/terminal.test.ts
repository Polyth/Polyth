// Terminal service tests: real long-lived child (`cat`) for I/O roundtrip.
// The suite passes in both process modes — real PTY (optional node-pty) and
// the pipe fallback; mode-specific behavior is tested explicitly below.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { RemoteHost } from "@polyth/contracts";
import {
  createReplayBuffer,
  createTerminalService,
  hasRealPty,
  localShellCommand,
} from "../src/index.ts";

let cwd: string;
const services: ReturnType<typeof createTerminalService>[] = [];
const newService = () => {
  const t = createTerminalService();
  services.push(t);
  return t;
};
test.before(async () => { cwd = await mkdtemp(join(tmpdir(), "polyth-term-")); });
test.after(async () => {
  // close every session so no child keeps the runner alive
  for (const t of services) for (const info of t.list()) await t.close(info.id).catch(() => {});
  await rm(cwd, { recursive: true, force: true });
});

test("local shell defaults are native to the target platform", () => {
  assert.deepEqual(
    localShellCommand(undefined, "win32", {}),
    { file: "cmd.exe", args: [] },
  );
  assert.deepEqual(
    localShellCommand("echo ready", "win32", { COMSPEC: "C:\\Windows\\System32\\cmd.exe" }),
    {
      file: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "echo ready"],
    },
  );
  assert.deepEqual(
    localShellCommand(undefined, "darwin", { SHELL: "/bin/zsh" }),
    { file: "/bin/zsh", args: ["-i"] },
  );
  assert.deepEqual(
    localShellCommand("echo ready", "linux", {}),
    { file: "/bin/sh", args: ["-c", "echo ready"] },
  );
});

test("create + write + read roundtrip through a long-lived child", async () => {
  const t = newService();
  const { id: termId } = await t.create({ projectId: "p", cwd, cmd: "cat" });
  assert.ok(termId, "terminalId returned");

  const echo = new Promise<string>((res, rej) => {
    const timer = setTimeout(() => rej(new Error("no output from cat")), 5000);
    const sub = t.onData((id, data) => {
      if (id !== termId) return;
      if (data.includes("hello, polyth")) { clearTimeout(timer); sub.dispose(); res(data); }
    });
    t.write(termId, "hello, polyth\n");
  });
  assert.match(await echo, /hello, polyth/);

  const info = t.get(termId);
  assert.equal(info?.running, true);
  assert.equal(info?.cwd, cwd);
  assert.equal(info?.title, basename(cwd)); // basename of cwd

  await t.close(termId);
  assert.equal(t.get(termId), undefined, "closed terminal removed");
});

test("list filters by projectId", async () => {
  const t = newService();
  await t.create({ projectId: "proj-a", cwd, cmd: "cat" });
  await t.create({ projectId: "proj-b", cwd, cmd: "cat" });

  const a = t.list("proj-a");
  assert.equal(a.length, 1);
  assert.equal(a[0]!.projectId, "proj-a");
  assert.equal(t.list().length, 2);
});

test("remote projects use an interactive shell on their assigned host", async () => {
  let command = "";
  let interactive = false;
  let output: ((data: string) => void) | undefined;
  let exit: ((code: number | null) => void) | undefined;
  const writes: string[] = [];
  const remote: RemoteHost = {
    label: "dev@build.example",
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    async start(nextCommand, opts) {
      command = nextCommand;
      interactive = opts?.interactive === true;
      return {
        onOutput(callback) {
          output = callback;
          return { dispose: () => { output = undefined; } };
        },
        onExit(callback) {
          exit = callback;
          return { dispose: () => { exit = undefined; } };
        },
        async write(data) {
          writes.push(data);
          output?.(`remote: ${data}`);
        },
        async kill() { exit?.(0); },
      };
    },
    async forward() { throw new Error("not used by terminal"); },
  };
  const t = createTerminalService({
    remoteHostForProject: async (projectId) => projectId === "remote" ? remote : undefined,
  });
  services.push(t);
  const { id } = await t.create({ projectId: "remote", cwd: "/srv/work", cols: 97, rows: 41 });

  assert.equal(interactive, true);
  assert.match(command, /^cd -- '\/srv\/work' && \{ stty cols 97 rows 41 2>\/dev\/null \|\| true; \} && TERM=xterm-256color COLORTERM=truecolor exec "\$\{SHELL:-\/bin\/sh\}" -i$/);
  const received = new Promise<string>((resolve) => {
    const sub = t.onData((terminalId, data) => {
      if (terminalId === id) { sub.dispose(); resolve(data); }
    });
  });
  t.write(id, "echo ready\n");
  assert.deepEqual(writes, ["echo ready\n"]);
  assert.equal(await received, "remote: echo ready\n");

  await t.close(id);
  assert.equal(t.get(id), undefined);
});

test("optional terminal limit bounds concurrent child processes", async () => {
  const t = createTerminalService({ maxSessions: 2 });
  services.push(t);
  const first = await t.create({ projectId: "p", cwd, cmd: "cat" });
  await t.create({ projectId: "p", cwd, cmd: "cat" });
  await assert.rejects(
    t.create({ projectId: "p", cwd, cmd: "cat" }),
    /terminal limit reached \(2\)/,
  );
  await t.close(first.id);
  await assert.doesNotReject(t.create({ projectId: "p", cwd, cmd: "cat" }));
});

test("exit is reported when the child exits by itself", async () => {
  const t = newService();
  const { id } = await t.create({ projectId: "p", cwd, cmd: "echo done" }); // exits immediately
  const exit = await new Promise<number | null>((res) => {
    const sub = t.onExit((eid, code) => { if (eid === id) { sub.dispose(); res(code); } });
    setTimeout(() => res("timeout" as unknown as number), 5000).unref();
  });
  assert.equal(exit, 0);
  assert.equal(t.get(id)?.running, false);
});

test("resize + write to a closed terminal are no-ops", async () => {
  const t = newService();
  const { id } = await t.create({ projectId: "p", cwd, cmd: "cat" });
  await t.close(id);
  assert.doesNotThrow(() => { t.resize(id, 120, 40); t.write(id, "x"); });
});

test("run captures bounded command output and removes the short-lived terminal", async () => {
  const t = newService();
  const result = await t.run(
    { projectId: "p", cwd, cmd: "printf 'prefix-'; printf '1234567890'" },
    { timeoutMs: 5_000, maxOutputBytes: 1_024 },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.truncated, false);
  assert.equal(result.output, "prefix-1234567890");
  assert.equal(t.list("p").length, 0);
});

test("run times out a long command", async () => {
  const t = newService();
  const result = await t.run(
    { projectId: "p", cwd, cmd: "sleep 5" },
    { timeoutMs: 100, maxOutputBytes: 1_024 },
  );
  assert.equal(result.timedOut, true);
  assert.equal(t.list("p").length, 0);
});

// ------------------------------------------------------------- F12 replay ring

test("replay buffer is byte-exact under the cap and evicts from the front", () => {
  const rb = createReplayBuffer(10);
  rb.push(Buffer.from("hello"));
  assert.equal(rb.snapshot(), "hello");
  assert.equal(rb.byteLength(), 5);

  rb.push(Buffer.from(" world")); // 11 bytes total -> "h" evicted
  assert.equal(rb.snapshot(), "ello world");
  assert.equal(rb.byteLength(), 10);

  // one chunk bigger than the whole ring keeps only its tail
  rb.push(Buffer.from("0123456789ABCDEF"));
  assert.equal(rb.snapshot(), "6789ABCDEF");

  rb.clear();
  assert.equal(rb.snapshot(), "");
  assert.equal(rb.byteLength(), 0);
});

test("replay buffer never tears UTF-8: split chunks and mid-character eviction", () => {
  // a multi-byte char split ACROSS two pushes reassembles byte-exactly
  const euro = Buffer.from("€"); // e2 82 ac
  const rb = createReplayBuffer(100);
  rb.push(Buffer.from("price: "));
  rb.push(euro.subarray(0, 1));
  rb.push(euro.subarray(1));
  rb.push(Buffer.from("42"));
  assert.equal(rb.snapshot(), "price: €42");

  // eviction that lands INSIDE a multi-byte char skips the torn tail bytes
  const tight = createReplayBuffer(4);
  tight.push(Buffer.from("a€b")); // 61 e2 82 ac 62 -> cap 4 drops 0x61, leaving e2 82 ac 62
  assert.equal(tight.snapshot(), "€b");
  tight.push(Buffer.from("c")); // drops e2, leaving torn 82 ac + "bc"
  assert.equal(tight.snapshot(), "bc"); // orphaned continuation bytes skipped, no garbage
});

test("live onData decodes UTF-8 split across chunk boundaries via the replay path", async () => {
  const t = newService();
  // printf writes the euro sign bytes in one go; the service must both stream
  // it intact and replay it intact afterwards
  // octal escapes (POSIX printf): é = \303\251, € = \342\202\254
  const { id } = await t.create({ projectId: "p", cwd, cmd: "printf 'caf\\303\\251 \\342\\202\\254'" });
  await new Promise<void>((res) => {
    const sub = t.onExit((eid) => { if (eid === id) { sub.dispose(); res(); } });
  });
  assert.equal(t.replay(id), "café €");
  const info = t.get(id);
  assert.equal(info?.running, false);
  assert.equal(info?.exitCode, 0);
});

// ------------------------------------------------- PTY / pipe process modes

test("pipe mode exports COLUMNS/LINES matching the requested grid", async () => {
  const t = createTerminalService({ forcePipe: true });
  services.push(t);
  const result = await t.run(
    { projectId: "p", cwd, cmd: "printenv COLUMNS LINES", cols: 97, rows: 41 },
    { timeoutMs: 5_000 },
  );
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /97\s+41/);
});

test("pipe-mode resize is a safe no-op signal (stored size clamps)", async () => {
  const t = createTerminalService({ forcePipe: true });
  services.push(t);
  const { id } = await t.create({ projectId: "p", cwd, cmd: "cat" });
  assert.doesNotThrow(() => t.resize(id, 150, 50));
  assert.doesNotThrow(() => t.resize(id, -5, 999999)); // clamped, never throws
  assert.equal(t.get(id)?.running, true);
  await t.close(id);
});

test("real PTY sessions allocate a tty with the requested size", { skip: !hasRealPty() }, async () => {
  const t = newService();
  const result = await t.run(
    { projectId: "p", cwd, cmd: "tty; stty size", cols: 100, rows: 40 },
    { timeoutMs: 10_000 },
  );
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /\/dev\/(pts|tty)/, "stdin is a real tty");
  assert.match(result.output, /40 100/, "PTY carries the requested rows/cols");
});

test("real PTY resize propagates to the child", { skip: !hasRealPty() }, async () => {
  const t = newService();
  const { id } = await t.create({ projectId: "p", cwd, cmd: "sleep 3", cols: 80, rows: 24 });
  assert.doesNotThrow(() => t.resize(id, 132, 43));
  assert.equal(t.get(id)?.running, true);
  await t.close(id);
});

test("rename mutates the title; replay survives socket-free reads; unknown ids are undefined", async () => {
  const t = newService();
  const { id } = await t.create({ projectId: "p", cwd, cmd: "cat" });

  const renamed = t.rename(id, "  build watcher  ");
  assert.equal(renamed?.title, "build watcher");
  assert.equal(t.get(id)?.title, "build watcher");
  // a blank title is ignored, not applied
  assert.equal(t.rename(id, "   ")?.title, "build watcher");

  assert.equal(t.rename("nope", "x"), undefined);
  assert.equal(t.replay("nope"), undefined);

  await t.close(id);
  assert.equal(t.replay(id), undefined, "closed terminals free their ring");
});
