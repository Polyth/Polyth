import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import {
  GUARDRAIL_DEFAULT_GRANTS,
  REMOTE_CAPABILITY,
  type AuthPrincipal,
  type RemoteAccessPolicy,
} from "@polyth/contracts";
import { createAuthService } from "../src/auth.ts";
import { createHttpHandler } from "../src/http.ts";
import { testTenancy } from "./support/spaces.ts";

const tenancy = await testTenancy();

const FILES: RemoteAccessPolicy = {
  routeScopes: ["files"],
  http: [{ methods: ["POST"], path: "/api/files/write", capability: REMOTE_CAPABILITY.filesWrite, mutation: true }],
};

async function withServer(
  accountGrants: readonly string[] | undefined,
  fn: (base: string, reached: string[]) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "polyth-guardrails-http-"));
  const webDist = join(dir, "dist");
  mkdirSync(webDist, { recursive: true });
  writeFileSync(join(webDist, "index.html"), "<html>shell</html>");
  const reached: string[] = [];
  const legacy = createAuthService({ file: join(dir, "auth.json") });
  const principal = {
    kind: "ui-session",
    sessionId: "browser",
    rememberedDeviceId: "browser",
    ...(accountGrants ? { accountGrants } : {}),
  } as AuthPrincipal;
  const auth = { ...legacy, resolve: () => ({ principal, authenticated: true }), gate: () => null };
  const handler = createHttpHandler({
    spaces: tenancy.gateway,
    runtimes: {} as never,
    capabilities: () => [],
    webDist,
    version: "test",
    auth,
    remotePolicies: () => [{ owner: "files", policy: FILES }],
    routes: [async (request) => {
      if (!request.path.startsWith("/api/files/") && !request.path.startsWith("/api/unlisted/")) return false;
      reached.push(`${request.method} ${request.path}`);
      request.json(200, { ok: true });
      return true;
    }],
  });
  const server = createServer((req, res) => void handler(req, res, {
    kind: "public-http", listenerId: "public", loopback: false, secure: false,
  } as never));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try { await fn(`http://127.0.0.1:${address.port}`, reached); }
  finally { server.close(); await once(server, "close"); }
}

const post = (base: string, path: string) => fetch(`${base}${path}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: "{}",
});

test("a guarded browser session reaches only the default-deny route table", async () => {
  await withServer(GUARDRAIL_DEFAULT_GRANTS, async (base, reached) => {
    // The SPA shell stays reachable so the guarded person can sign in and chat.
    assert.equal((await fetch(`${base}/`)).status, 200);
    assert.equal((await fetch(`${base}/api/health`)).status, 200);

    for (const [method, path] of [
      ["POST", "/api/projects"],
      ["GET", "/api/browse?path=/"],
      ["POST", "/api/files/write"],
      ["GET", "/api/unlisted/thing"],
      ["GET", "/debug/state"],
    ] as const) {
      const response = method === "POST" ? await post(base, path) : await fetch(`${base}${path}`);
      assert.equal(response.status, 403, `${method} ${path}`);
    }
    assert.deepEqual(reached, []);
  });
});

test("an owner-granted extra capability opens exactly its declared route", async () => {
  await withServer([...GUARDRAIL_DEFAULT_GRANTS, REMOTE_CAPABILITY.filesWrite], async (base, reached) => {
    assert.equal((await post(base, "/api/files/write")).status, 200);
    assert.equal((await fetch(`${base}/api/unlisted/thing`)).status, 403);
    assert.deepEqual(reached, ["POST /api/files/write"]);
  });
});

test("an unguarded browser session keeps the full local surface", async () => {
  await withServer(undefined, async (base, reached) => {
    assert.equal((await fetch(`${base}/api/unlisted/thing`)).status, 200);
    assert.equal((await post(base, "/api/files/write")).status, 200);
    assert.deepEqual(reached, ["GET /api/unlisted/thing", "POST /api/files/write"]);
  });
});
