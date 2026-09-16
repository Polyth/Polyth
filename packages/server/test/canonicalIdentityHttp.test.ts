import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  createHttpHandler,
  createPublicHttpServer,
  type IdentityHttpHandler,
} from "../src/http.ts";
import { testTenancy } from "./support/spaces.ts";

const tenancy = await testTenancy();

const webDist = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-canonical-auth-http-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), "<html>shell</html>");
  return dir;
};

const baseDeps = (identityHttp: IdentityHttpHandler) => ({
  spaces: tenancy.gateway,
  runtimes: {} as never,
  capabilities: () => [],
  webDist: webDist(),
  version: "test",
  identityHttp,
});

async function listening(server: ReturnType<typeof createServer>): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  server.close();
  await once(server, "close");
}

test("canonical identity HTTP owns /api/auth on public ingress", async () => {
  let calls = 0;
  const handler = createHttpHandler(baseDeps({
    async handle(_req, res) {
      calls += 1;
      res.writeHead(204, { "x-polyth-auth": "canonical" });
      res.end();
      return true;
    },
  }));
  const server = createPublicHttpServer(handler);
  const base = await listening(server);
  try {
    const response = await fetch(`${base}/api/auth/status`);
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("x-polyth-auth"), "canonical");
    assert.equal(calls, 1);
  } finally {
    await close(server);
  }
});

test("canonical auth miss cannot fall through to a legacy route", async () => {
  let canonicalCalls = 0;
  let legacyCalls = 0;
  const handler = createHttpHandler({
    ...baseDeps({
      async handle() {
        canonicalCalls += 1;
        return false;
      },
    }),
    routes: [async (request) => {
      if (request.path !== "/api/auth/status") return false;
      legacyCalls += 1;
      request.json(200, { authority: "legacy" });
      return true;
    }],
  });
  const server = createPublicHttpServer(handler);
  const base = await listening(server);
  try {
    const response = await fetch(`${base}/api/auth/status`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "not-found", path: "/api/auth/status" });
    assert.equal(canonicalCalls, 1);
    assert.equal(legacyCalls, 0);
  } finally {
    await close(server);
  }
});

test("paired-device ingress cannot reach browser identity HTTP", async () => {
  let calls = 0;
  const handler = createHttpHandler(baseDeps({
    async handle() {
      calls += 1;
      return true;
    },
  }));
  const server = createServer((req, res) => void handler(req, res, {
    kind: "polyth-link",
    connectionId: "live",
    transport: "direct",
  }));
  const base = await listening(server);
  try {
    const response = await fetch(`${base}/api/auth/status`);
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "forbidden", message: "not allowed" });
    assert.equal(calls, 0);
  } finally {
    await close(server);
  }
});
