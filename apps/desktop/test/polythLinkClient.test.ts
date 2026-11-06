import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createPolythLinkClient, linkClientEnv } from "../src/polythLinkClient.ts";

class FakeProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  killed: Array<string | undefined> = [];
  requests: Array<{ id: number; method: string; params: Record<string, unknown> }> = [];

  constructor() {
    super();
    let buffer = "";
    this.stdin.on("data", (chunk) => {
      buffer += String(chunk);
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        this.requests.push(JSON.parse(buffer.slice(0, newline)));
        buffer = buffer.slice(newline + 1);
      }
    });
    this.stdin.on("end", () => this.exit(0));
  }

  answer(line: unknown): void {
    this.stdout.write(`${typeof line === "string" ? line : JSON.stringify(line)}\n`);
  }

  exit(code: number): void {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.emit("exit", code, null);
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killed.push(signal);
    this.exit(137);
    return true;
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Starting makes a folder first, so requests arrive after real I/O. */
async function received(started: FakeProcess[], index: number, count: number): Promise<FakeProcess> {
  const deadline = Date.now() + 2_000;
  while ((started[index]?.requests.length ?? 0) < count) {
    assert.ok(Date.now() < deadline, `process ${index} never received ${count} request(s)`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  return started[index]!;
}

async function withClient(run: (context: {
  client: ReturnType<typeof createPolythLinkClient>;
  started: FakeProcess[];
  starts: Array<{ binary: string; args: string[]; env: NodeJS.ProcessEnv }>;
  dataDir: string;
}) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "polyth-link-client-"));
  const dataDir = join(dir, "link-client");
  const started: FakeProcess[] = [];
  const starts: Array<{ binary: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const client = createPolythLinkClient({
    binary: "/app/polyth-link-client",
    dataDir,
    webDist: "/app/web",
    packagesDir: "/app/packages",
    env: { PATH: "/bin", ANTHROPIC_API_KEY: "secret", POLYTH_DATA_DIR: "/x" },
    start: (binary, args, env) => {
      const process_ = new FakeProcess();
      started.push(process_);
      starts.push({ binary, args, env });
      return process_ as never;
    },
  });
  try {
    await run({ client, started, starts, dataDir });
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("nothing starts until the client is first used", async () => {
  await withClient(async ({ started }) => {
    await settle();
    assert.equal(started.length, 0);
  });
});

test("the client gets its folders and none of the app's credentials", async () => {
  await withClient(async ({ client, started, starts, dataDir }) => {
    const pending = client.invoke("connections.list");
    await received(started, 0, 1);
    assert.equal(started.length, 1);
    assert.deepEqual(starts[0]?.args, ["stdio", dataDir]);
    assert.equal(starts[0]?.env.POLYTH_WEB_DIST, "/app/web");
    assert.equal(starts[0]?.env.POLYTH_WEB_PACKAGES_DIR, "/app/packages");
    assert.equal(starts[0]?.env.PATH, "/bin");
    assert.equal(starts[0]?.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(starts[0]?.env.POLYTH_DATA_DIR, undefined);
    if (process.platform !== "win32") assert.equal((await stat(dataDir)).mode & 0o777, 0o700);
    started[0]!.answer({ id: started[0]!.requests[0]!.id, result: [] });
    assert.deepEqual(await pending, []);
  });
});

test("answers find their requests, in any order, and failures keep their code", async () => {
  await withClient(async ({ client, started }) => {
    const first = client.invoke("connect", { connectionId: "a" });
    const second = client.invoke("status", { connectionId: "b" });
    await received(started, 0, 2);
    const [one, two] = started[0]!.requests;
    assert.equal(one?.method, "connect");
    assert.deepEqual(two?.params, { connectionId: "b" });
    started[0]!.answer({ id: two!.id, result: { state: "connected" } });
    started[0]!.answer({ id: one!.id, error: { code: "device-revoked" } });
    assert.deepEqual(await second, { state: "connected" });
    await assert.rejects(first, { code: "device-revoked" });
  });
});

test("noise on stdout never breaks the client", async () => {
  await withClient(async ({ client, started }) => {
    const pending = client.invoke("connections.list");
    await received(started, 0, 1);
    started[0]!.answer("not json");
    started[0]!.answer("");
    started[0]!.answer({ id: 999, result: "someone else's" });
    started[0]!.answer({ id: 0, error: { code: "pairing-invalid" } });
    started[0]!.answer({ id: started[0]!.requests[0]!.id, result: ["ok"] });
    assert.deepEqual(await pending, ["ok"]);
  });
});

test("a split line is reassembled and an endless one stops the client", async () => {
  await withClient(async ({ client, started }) => {
    const pending = client.invoke("connections.list");
    await received(started, 0, 1);
    const id = started[0]!.requests[0]!.id;
    started[0]!.stdout.write(`{"id":${id},`);
    await settle();
    started[0]!.stdout.write(`"result":[1]}\n`);
    assert.deepEqual(await pending, [1]);
    const orphaned = client.invoke("connections.list");
    await received(started, 0, 2);
    started[0]!.stdout.write("x".repeat(5 * 1024 * 1024));
    await assert.rejects(orphaned, { code: "link-client-exited" });
    assert.equal(started[0]!.killed.length, 1);
  });
});

test("a client that dies fails what was waiting, says so, and comes back on the next request", async () => {
  await withClient(async ({ client, started }) => {
    let exits = 0;
    client.onExit(() => { exits += 1; });
    const pending = client.invoke("connect", { connectionId: "a" });
    await received(started, 0, 1);
    started[0]!.exit(1);
    await assert.rejects(pending, { code: "link-client-exited" });
    assert.equal(exits, 1);
    const next = client.invoke("connections.list");
    await received(started, 1, 1);
    assert.equal(started.length, 2);
    started[1]!.answer({ id: started[1]!.requests[0]!.id, result: [] });
    assert.deepEqual(await next, []);
  });
});

test("closing ends stdin, waits for the exit, and reports no crash", async () => {
  await withClient(async ({ client, started }) => {
    let exits = 0;
    client.onExit(() => { exits += 1; });
    const pending = client.invoke("connections.list");
    await received(started, 0, 1);
    await Promise.all([client.close(), assert.rejects(pending, { code: "link-client-closed" })]);
    assert.equal(started[0]!.exitCode, 0);
    assert.deepEqual(started[0]!.killed, []);
    assert.equal(exits, 0);
    await assert.rejects(client.invoke("connections.list"), { code: "link-client-closed" });
    assert.equal(started.length, 1);
  });
});

test("the environment keeps what the process needs and drops the rest", () => {
  const kept = linkClientEnv({
    PATH: "/bin",
    SystemRoot: "C:\\Windows",
    APPDATA: "C:\\x",
    HTTPS_PROXY: "http://p",
    http_proxy: "http://p",
    SSL_CERT_FILE: "/ca",
    LC_ALL: "C",
    OPENAI_API_KEY: "secret",
    POLYTH_SECRET: "secret",
    GITHUB_TOKEN: "secret",
  });
  assert.deepEqual(Object.keys(kept).sort(), ["APPDATA", "HTTPS_PROXY", "LC_ALL", "PATH", "SSL_CERT_FILE", "SystemRoot", "http_proxy"].sort());
});
