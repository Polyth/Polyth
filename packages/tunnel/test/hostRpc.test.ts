import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLinkHost, unpackQrModules } from "../src/host.ts";
import registerPackage from "../src/serverEntry.ts";
import type { RouteRequest } from "@polyth/contracts";

const tmp = () => mkdtempSync(join(tmpdir(), "polyth-host-rpc-"));

function writeFakeHost(dir: string, body: string): string {
  const path = join(dir, "fake-host");
  writeFileSync(path, `#!${process.execPath}\n${body}`);
  chmodSync(path, 0o755);
  return path;
}

async function withHostEnv<T>(binary: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.POLYTH_LINK_HOST;
  process.env.POLYTH_LINK_HOST = binary;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.POLYTH_LINK_HOST;
    else process.env.POLYTH_LINK_HOST = previous;
  }
}

const READY_HOST = `
const net = require("node:net");
const fs = require("node:fs");
const socketPath = process.argv[process.argv.length - 1];
try { fs.unlinkSync(socketPath); } catch {}
const server = net.createServer((socket) => {
  let buf = "";
  socket.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const req = JSON.parse(line);
      if (req.method === "crash") process.exit(1);
      if (req.method === "disconnect") { socket.destroy(); continue; }
      socket.write(JSON.stringify({
        id: req.id,
        result: { fingerprint: "abcd1234ef", endpointId: "ep" },
      }) + "\\n");
    }
  });
});
server.listen(socketPath);
`;

test("unpackQrModules rejects malformed input instead of throwing or over-reading", () => {
  assert.deepEqual(unpackQrModules({ size: 0, bits: "" }), []);
  assert.deepEqual(unpackQrModules({ size: -1, bits: "" }), []);
  assert.deepEqual(unpackQrModules({ size: 1.5, bits: "AA==" }), []);
  assert.deepEqual(unpackQrModules({ size: 1000, bits: "AA==" }), []);
  // 3x3 needs ceil(9/8) = 2 bytes; only one is supplied.
  assert.deepEqual(unpackQrModules({ size: 3, bits: Buffer.from([0xff]).toString("base64") }), []);
  assert.deepEqual(
    unpackQrModules({ size: 2, bits: Buffer.from([0b10010000]).toString("base64") }),
    [[true, false], [false, true]],
  );
});

for (const scenario of ["valid-pairing", "wrong-rpc", "invalid-matrix"] as const) {
  test(`large legacy QR control response: ${scenario}`, async () => {
    const dir = tmp();
    const binary = writeFakeHost(dir, READY_HOST.replace(
      'result: { fingerprint: "abcd1234ef", endpointId: "ep" },',
      `result: req.method === "identity.status"
        ? { fingerprint: "abcd1234ef" }
        : { qrModules: Array.from({ length: 177 }, (_, y) => Array.from({ length: 177 }, (_, x) =>
          ${scenario === "invalid-matrix" ? 'y === 0 && x === 0 ? "invalid" : false' : 'false'})) },`,
    ));
    await withHostEnv(binary, async () => {
      const client = await startLinkHost({ dataDir: join(dir, "data"), socketPath: join(dir, "host.sock") });
      try {
        if (scenario === "valid-pairing") {
          const result = await client.request("pairing.create");
          assert.equal((result.qrModules as boolean[][]).length, 177);
          assert.equal(client.available, true);
        } else {
          await assert.rejects(client.request(scenario === "wrong-rpc" ? "status" : "pairing.create"), /control frame too large/);
          assert.equal(client.available, false);
        }
      } finally { await client.close(); }
    });
    rmSync(dir, { recursive: true, force: true });
  });
}

test("host RPC handshake is required and child exit rejects pending requests", async () => {
  const dir = tmp();
  const binary = writeFakeHost(dir, READY_HOST);
  await withHostEnv(binary, async () => {
    const client = await startLinkHost({ dataDir: join(dir, "data"), socketPath: join(dir, "host.sock") });
    assert.equal(client.available, true, client.lastErrorCode ?? "host unavailable");
    assert.equal(client.processReady, true);
    await assert.rejects(client.request("status", { value: "x".repeat(70 * 1024) }), { code: "invalid-input" });
    await assert.rejects(client.request("crash"));
    assert.equal(client.available, false);
    assert.equal(client.processReady, false);
    assert.equal(client.lastErrorCode, "host-process-unavailable");
    await assert.rejects(client.request("status"));
    await client.close();
  });
});

test("control socket loss marks the host dead even if the child stays alive", async () => {
  const dir = tmp();
  const binary = writeFakeHost(dir, READY_HOST);
  await withHostEnv(binary, async () => {
    const client = await startLinkHost({ dataDir: join(dir, "data"), socketPath: join(dir, "host.sock") });
    await assert.rejects(client.request("disconnect"));
    assert.equal(client.available, false);
    assert.equal(client.processReady, false);
    await client.close();
  });
});

test("an unanswered RPC invalidates the host and is not replayed", async () => {
  const dir = tmp();
  const binary = writeFakeHost(dir, READY_HOST.replace(
    'if (req.method === "crash") process.exit(1);',
    'if (req.method === "hang") continue;',
  ));
  await withHostEnv(binary, async () => {
    const client = await startLinkHost({ dataDir: join(dir, "data"), socketPath: join(dir, "host.sock") });
    try {
      await assert.rejects(client.request("hang"), /host RPC timed out: hang/);
      assert.equal(client.available, false);
      assert.equal(client.processReady, false);
      await assert.rejects(client.request("status"), /host control is closed/);
    } finally { await client.close(); }
  });
});

test("close confirms exit even when the owned child ignores graceful shutdown", async () => {
  const dir = tmp();
  const binary = writeFakeHost(dir, `process.on("SIGTERM", () => {});\n${READY_HOST}`);
  await withHostEnv(binary, async () => {
    const client = await startLinkHost({ dataDir: join(dir, "data"), socketPath: join(dir, "host.sock") });
    await Promise.all([client.close(), client.close()]);
    assert.equal(client.available, false);
    // A successful close releases the exact process and socket for a new host.
    const next = await startLinkHost({ dataDir: join(dir, "data"), socketPath: join(dir, "host.sock") });
    assert.equal(next.available, true);
    await next.close();
  });
});

test("the tunnel package restores ingress and trust before a new invitation after host death", async () => {
  const dir = tmp();
  const dataDir = join(dir, "data");
  const binary = writeFakeHost(dir, READY_HOST.replace(
    'if (req.method === "crash") process.exit(1);',
    `const path = require("node:path");
      const data = process.argv[process.argv.length - 2];
      fs.appendFileSync(path.join(data, "calls"), req.method + "\\n");
      if (req.method === "pairing.create" && !fs.existsSync(path.join(data, "crashed"))) {
        fs.writeFileSync(path.join(data, "crashed"), "1");
        process.exit(1);
      }`,
  ).replace(
    'result: { fingerprint: "abcd1234ef", endpointId: "ep" },',
    'result: { fingerprint: "abcd1234ef", endpointId: "ep", endpointBound: true, activePolicy: "direct-preferred", pairing: { id: "new-pairing" } },',
  ));
  await withHostEnv(binary, async () => {
    let ingressStarts = 0;
    let ingressCloses = 0;
    const pkg = registerPackage({
      storageDir: dataDir,
      services: { provide() {}, get() { return undefined; } },
      onHttpServer() {}, attachPairedDeviceResolver() {}, closePairedDevice() {},
      async startTunnelIngress() {
        ingressStarts++;
        return { async close() { ingressCloses++; } };
      },
    } as never);
    const request = (path: string, method = "GET") => {
      let code = 0;
      let body: Record<string, unknown> = {};
      const rc = {
        path, method,
        principal: { kind: "local-user", trustedLoopback: true },
        ingress: { kind: "public-http", loopback: true },
        space: { userId: "usr_test" }, requireCapability() {},
        body: async () => ({ profile: "interact" }),
        json(status: number, value: Record<string, unknown>) { code = status; body = value; },
      } as unknown as RouteRequest;
      return { rc, result: () => ({ code, body }) };
    };
    try {
      await pkg.onEnable?.();
      const before = request("/api/tunnel/status");
      await pkg.routes!(before.rc);
      assert.equal(before.result().body.pairingAvailable, true);
      const crashed = request("/api/tunnel/pairing", "POST");
      await assert.rejects(pkg.routes!(crashed.rc));
      const next = request("/api/tunnel/pairing", "POST");
      await pkg.routes!(next.rc);
      assert.equal(next.result().code, 200);
      assert.equal(ingressStarts, 2);
      assert.equal(ingressCloses, 1);
      const calls = readFileSync(join(dataDir, "calls"), "utf8").trim().split("\n");
      assert.equal(calls.filter((method) => method === "pairing.create").length, 2);
      assert.equal(calls.filter((method) => method === "trust.sync_finish").length, 2);
      assert.deepEqual(calls.slice(-5), ["ingress.configure", "trust.sync_begin", "trust.sync_finish", "endpoint.start", "pairing.create"]);
    } finally { await pkg.onDisable?.(); }
  });
  rmSync(dir, { recursive: true, force: true });
});

test("control framing preserves Unicode split across socket chunks", async () => {
  const dir = tmp();
  const binary = writeFakeHost(dir, `
const net = require("node:net");
const fs = require("node:fs");
const socketPath = process.argv[process.argv.length - 1];
try { fs.unlinkSync(socketPath); } catch {}
const server = net.createServer((socket) => {
  let calls = 0;
  socket.on("data", (chunk) => {
    const req = JSON.parse(String(chunk));
    calls++;
    if (calls === 1) {
      socket.write(JSON.stringify({ id: req.id, result: { fingerprint: "abcd1234ef" } }) + "\\n");
      return;
    }
    const event = Buffer.from(JSON.stringify({ method: "event", params: { type: "tunnel/test", label: "Телефон" } }) + "\\n");
    const split = event.indexOf(Buffer.from("Т")) + 1;
    socket.write(event.subarray(0, split));
    setTimeout(() => {
      socket.write(event.subarray(split));
      socket.write(JSON.stringify({ id: req.id, result: { ok: true } }) + "\\n");
    }, 5);
  });
});
server.listen(socketPath);
`);
  await withHostEnv(binary, async () => {
    const client = await startLinkHost({ dataDir: join(dir, "data"), socketPath: join(dir, "host.sock") });
    const seen = new Promise<string>((resolve) => client.onEvent((event) => resolve(String(event.label))));
    await client.request("status");
    assert.equal(await seen, "Телефон");
    await client.close();
  });
});

test("unterminated control frames are byte-bounded", async () => {
  const dir = tmp();
  const binary = writeFakeHost(dir, `
const net = require("node:net");
const fs = require("node:fs");
const socketPath = process.argv[process.argv.length - 1];
try { fs.unlinkSync(socketPath); } catch {}
const server = net.createServer((socket) => {
  let calls = 0;
  socket.on("data", (chunk) => {
    const req = JSON.parse(String(chunk));
    calls++;
    if (calls === 1) socket.write(JSON.stringify({ id: req.id, result: { fingerprint: "abcd1234ef" } }) + "\\n");
    else socket.write("x".repeat(70 * 1024));
  });
});
server.listen(socketPath);
`);
  await withHostEnv(binary, async () => {
    const client = await startLinkHost({ dataDir: join(dir, "data"), socketPath: join(dir, "host.sock") });
    await assert.rejects(client.request("status"));
    assert.equal(client.available, false);
    assert.equal(client.processReady, false);
    await client.close();
  });
});

test("malformed control frames close the socket after a bound number of failures", async () => {
  const dir = tmp();
  const binary = writeFakeHost(dir, `
const net = require("node:net");
const fs = require("node:fs");
const socketPath = process.argv[process.argv.length - 1];
try { fs.unlinkSync(socketPath); } catch {}
const server = net.createServer((socket) => {
  let first = true;
  socket.on("data", () => {
    if (first) {
      first = false;
      socket.write(JSON.stringify({ id: 1, result: { fingerprint: "abcd1234ef" } }) + "\\n");
      return;
    }
    for (let i = 0; i < 40; i++) socket.write("{not-json\\n");
  });
});
server.listen(socketPath);
`);
  await withHostEnv(binary, async () => {
    const client = await startLinkHost({ dataDir: join(dir, "data"), socketPath: join(dir, "host.sock") });
    assert.equal(client.available, true, client.lastErrorCode ?? "host unavailable");
    await assert.rejects(client.request("status"));
    await client.close();
  });
});
