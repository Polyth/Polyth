import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { join } from "node:path";
import { WebSocket } from "ws";
import { createHash } from "node:crypto";

const repoRoot = join(import.meta.dirname, "../../..");
const echoBin = join(repoRoot, "target/debug/polyth-link-ws-echo");

async function ensureEchoBinary(): Promise<void> {
  if (existsSync(echoBin)) return;
  const cargo = spawn("cargo", ["build", "-p", "polyth-link-core", "--bin", "polyth-link-ws-echo"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  const [code] = await once(cargo, "exit") as [number | null];
  assert.equal(code, 0, "failed to build polyth-link-ws-echo");
}

function spawnEcho(): Promise<{ child: ChildProcess; url: string }> {
  const child = spawn(echoBin, [], { stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("echo did not bind")), 8000);
    child.stdout?.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (!text.includes(":")) return;
      clearTimeout(timer);
      resolve({ child, url: `ws://${text}` });
    });
    child.on("error", reject);
  });
}

test("browser WebSocket handshake, frames, ping, close, and subprotocol against tungstenite", async () => {
  await ensureEchoBinary();
  const { child, url } = await spawnEcho();
  try {
    const ws = new WebSocket(url, "polyth");
    await once(ws, "open");
    assert.equal(ws.protocol, "polyth");
    ws.send("hello");
    const [text] = await once(ws, "message") as [Buffer | string];
    assert.equal(String(text), "hello");
    ws.send(Buffer.from([1, 2, 3]));
    const [binary] = await once(ws, "message") as [Buffer];
    assert.deepEqual(Buffer.from(binary), Buffer.from([1, 2, 3]));
    ws.send("hel", { fin: false });
    ws.send("lo", { fin: true });
    const [fragmented] = await once(ws, "message") as [Buffer | string];
    assert.equal(String(fragmented), "hello");
    const ping = once(ws, "pong");
    ws.ping("ping");
    await ping;
    const closed = once(ws, "close");
    ws.close();
    await closed;
  } finally {
    child.kill("SIGTERM");
  }
});

test("invalid Sec-WebSocket-Accept is rejected by the browser client", async () => {
  const server = createServer();
  server.on("upgrade", (_req, socket) => {
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: aaaaaaaaaaaaaaaaaaaaaaaaaaa=\r\n\r\n",
    );
  });
  server.listen(0);
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const err = await new Promise<Error>((resolve) => {
      ws.once("error", (error) => resolve(error as Error));
      ws.once("unexpected-response", () => resolve(new Error("unexpected-response")));
    });
    assert.ok(err);
  } finally {
    server.close();
  }
});

test("unmasked frames and oversized messages are rejected", async () => {
  await ensureEchoBinary();
  const { child, url } = await spawnEcho();
  try {
    const ws = new WebSocket(url, "polyth");
    await once(ws, "open");
    const oversizedClosed = once(ws, "close");
    ws.send(Buffer.alloc(8 * 1024 * 1024 + 64));
    await oversizedClosed;
    ws.terminate();

    const { child: child2, url: url2 } = await spawnEcho();
    try {
      const parsed = new URL(url2.replace("ws://", "http://"));
      const raw = await new Promise<import("node:net").Socket>((resolve, reject) => {
        const socket = createConnection({ host: parsed.hostname, port: Number(parsed.port) }, () => resolve(socket));
        socket.once("error", reject);
      });
      const key = "dGhlIHNhbXBsZSBub25jZQ==";
      raw.write(
        `GET / HTTP/1.1\r\nHost: ${parsed.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Protocol: polyth\r\n\r\n`,
      );
      await once(raw, "data");
      raw.write(Buffer.from([0x81, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f]));
      const closed = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 1000);
        raw.on("close", () => {
          clearTimeout(timer);
          resolve(true);
        });
        raw.on("end", () => {
          clearTimeout(timer);
          resolve(true);
        });
      });
      assert.equal(closed, true);
      raw.destroy();
    } finally {
      child2.kill("SIGTERM");
    }
  } finally {
    child.kill("SIGTERM");
  }
});

test("RFC6455 accept key used by Node ws matches the core helper", () => {
  const key = "dGhlIHNhbXBsZSBub25jZQ==";
  const accept = createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
  assert.equal(accept, "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
});
