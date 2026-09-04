import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLinkHost } from "../src/host.ts";

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
      socket.write(JSON.stringify({
        id: req.id,
        result: { fingerprint: "abcd1234ef", endpointId: "ep" },
      }) + "\\n");
    }
  });
});
server.listen(socketPath);
`;

test("host RPC handshake is required and child exit rejects pending requests", async () => {
  const dir = tmp();
  const binary = writeFakeHost(dir, READY_HOST);
  await withHostEnv(binary, async () => {
    const client = await startLinkHost({ dataDir: join(dir, "data"), socketPath: join(dir, "host.sock") });
    assert.equal(client.available, true, client.lastErrorCode ?? "host unavailable");
    assert.equal(client.processReady, true);
    await assert.rejects(client.request("crash"));
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
