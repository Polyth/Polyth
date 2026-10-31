import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  parseSavedServerPort,
  readSavedServerPort,
  reserveServerPort,
  saveServerPort,
} from "../src/serverPort.ts";

function listen(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

test("a saved server port must be a whole unprivileged port number", () => {
  assert.equal(parseSavedServerPort({ port: 41_234 }), 41_234);
  for (const value of [null, [], "41234", { port: "41234" }, { port: 80 }, { port: 70_000 }, { port: 4123.5 }, {}]) {
    assert.equal(parseSavedServerPort(value), null, JSON.stringify(value));
  }
});

test("the server port survives a restart of the app", async () => {
  const dir = await mkdtemp(join(tmpdir(), "polyth-desktop-port-"));
  const path = join(dir, "desktop", "server-port.json");
  assert.equal(readSavedServerPort(path), null, "a first launch has no saved port");
  await saveServerPort(path, 41_234);
  assert.equal(readSavedServerPort(path), 41_234);

  await writeFile(path, "{not json");
  assert.equal(readSavedServerPort(path), null, "a damaged file is a first launch, not a crash");
});

test("the window keeps its origin while the saved port is free and moves only when it is taken", async () => {
  const first = await reserveServerPort(null);
  assert.ok(first >= 1024);
  assert.equal(await reserveServerPort(first), first, "a free saved port is reused");

  // Another process now holds it.
  const squatter = await listen(first);
  try {
    const next = await reserveServerPort(first);
    assert.notEqual(next, first);
    assert.ok(next >= 1024);
  } finally {
    await close(squatter);
  }
});
