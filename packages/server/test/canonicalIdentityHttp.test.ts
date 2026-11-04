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
import { GRANT_PROFILE_PRESETS, REMOTE_CAPABILITY } from "@polyth/contracts";
import { createAuthService } from "../src/auth.ts";
import { authRoutes } from "../src/routes/auth.ts";
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

test("paired-device ingress cannot reach browser identity HTTP but learns its status", async () => {
  let calls = 0;
  const auth = createAuthService({
    file: join(mkdtempSync(join(tmpdir(), "polyth-canonical-auth-paired-")), "auth.json"),
    envPassword: "pw",
    resolvePairedDevice: (ingress) => ingress.connectionId === "live" ? {
      kind: "paired-device",
      deviceId: "dev-1",
      deviceEndpointId: "ep",
      connectionId: ingress.connectionId,
      transport: ingress.transport,
      grants: [...GRANT_PROFILE_PRESETS.observe],
      grantRevision: 1,
    } : null,
  });
  const handler = createHttpHandler({
    ...baseDeps({
      async handle() {
        calls += 1;
        return true;
      },
    }),
    auth,
    routes: [authRoutes(auth)],
  });
  const server = createServer((req, res) => void handler(req, res, {
    kind: "polyth-link",
    connectionId: "live",
    transport: "direct",
  }));
  const base = await listening(server);
  try {
    const status = await fetch(`${base}/api/auth/status`);
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), { required: false, authorized: true, scope: "paired-device" });
    for (const [path, method] of [["/api/auth/accounts", "GET"], ["/api/auth/login", "POST"]] as const) {
      const response = await fetch(`${base}${path}`, { method });
      assert.equal(response.status, 403, path);
      assert.deepEqual(await response.json(), { error: "forbidden", message: "not allowed" });
    }
    assert.equal(calls, 0);
  } finally {
    await close(server);
  }
});

test("only a full-access paired device reads its own account views over Link", async () => {
  // connectionId → the device the tunnel would resolve for it.
  const devices: Record<string, { grants: string[]; accountGrants?: string[] }> = {
    full: { grants: [REMOTE_CAPABILITY.deviceFullAccess] },
    observe: { grants: [...GRANT_PROFILE_PRESETS.observe] },
    // A guarded account's ceiling binds even a full-access device.
    guarded: { grants: [REMOTE_CAPABILITY.deviceFullAccess], accountGrants: [...GRANT_PROFILE_PRESETS.interact] },
  };
  const auth = createAuthService({
    file: join(mkdtempSync(join(tmpdir(), "polyth-canonical-auth-full-")), "auth.json"),
    envPassword: "pw",
    resolvePairedDevice: (ingress) => {
      const device = devices[ingress.connectionId];
      return device ? {
        kind: "paired-device",
        deviceId: `dev-${ingress.connectionId}`,
        deviceEndpointId: "ep",
        connectionId: ingress.connectionId,
        transport: ingress.transport,
        grants: device.grants,
        grantRevision: 1,
        ...(device.accountGrants ? { accountGrants: device.accountGrants } : {}),
        userId: "usr_owner",
      } as never : null;
    },
  });
  let browserCalls = 0;
  const reads: string[] = [];
  const handler = createHttpHandler({
    ...baseDeps({
      async handle() {
        browserCalls += 1;
        return true;
      },
      handlePairedRead(req, res, userId) {
        if (req.method !== "GET" || (req.url !== "/api/auth/accounts" && req.url !== "/api/auth/me")) return false;
        reads.push(`${req.url} ${userId}`);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ currentAccountId: userId, readOnly: true }));
        return true;
      },
    }),
    auth,
  });
  let connection = "full";
  const server = createServer((req, res) => void handler(req, res, {
    kind: "polyth-link",
    connectionId: connection,
    transport: "direct",
  }));
  const base = await listening(server);
  try {
    const accounts = await fetch(`${base}/api/auth/accounts`);
    assert.equal(accounts.status, 200);
    assert.deepEqual(await accounts.json(), { currentAccountId: "usr_owner", readOnly: true });
    assert.equal((await fetch(`${base}/api/auth/me`)).status, 200);
    assert.deepEqual(reads, ["/api/auth/accounts usr_owner", "/api/auth/me usr_owner"]);
    // Changes and other identity routes still need a browser identity session.
    for (const [path, method] of [["/api/auth/me", "POST"], ["/api/auth/accounts", "POST"], ["/api/auth/sessions", "GET"], ["/api/auth/login", "POST"]] as const) {
      const response = await fetch(`${base}${path}`, { method });
      assert.equal(response.status, 403, `${method} ${path}`);
      assert.deepEqual(await response.json(), { error: "forbidden", message: "not allowed" });
    }
    for (const denied of ["observe", "guarded", "unknown"]) {
      connection = denied;
      const response = await fetch(`${base}/api/auth/accounts`);
      assert.equal(response.status, 403, denied);
    }
    assert.equal(reads.length, 2);
    assert.equal(browserCalls, 0);
  } finally {
    await close(server);
  }
});
