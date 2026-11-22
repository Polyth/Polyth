import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  createHttpHandler,
  createPublicHttpServer,
  type IdentityHttpHandler,
} from "../src/http.ts";
import { openControlPlane } from "@polyth/control-plane";
import { createIdentityService, type PasswordService } from "@polyth/identity";
import { createIdentityHttpAdapter } from "@polyth/identity/http";
import { GRANT_PROFILE_PRESETS, REMOTE_CAPABILITY } from "@polyth/contracts";
import { createAuthService } from "../src/auth.ts";
import { createCanonicalAuthGateway } from "../src/canonicalAuth.ts";
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
      async handlePaired(req, res, { userId, deviceId }) {
        if (req.method !== "GET" || (req.url !== "/api/auth/accounts" && req.url !== "/api/auth/me")) return false;
        reads.push(`${req.url} ${userId} ${deviceId}`);
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
    assert.deepEqual(reads, ["/api/auth/accounts usr_owner dev-full", "/api/auth/me usr_owner dev-full"]);
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

test("an owner's full-access Link device administers people after confirming the password", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-paired-people-"));
  const control = openControlPlane({ directory: dir });
  const passwords: PasswordService = {
    async hash(password) { return `test:${password}`; },
    async verify(password, encoded) { return { valid: encoded === `test:${password}`, needsRehash: false }; },
    close() {},
  };
  const identity = createIdentityService(control, { passwords });
  t.after(() => { identity.close(); control.close(); rmSync(dir, { recursive: true, force: true }); });
  const claim = identity.setup.issueClaim();
  const binding = "c".repeat(64);
  identity.setup.bindClaim(claim.token, binding);
  const recovery = identity.setup.prepareRecovery(claim.token, binding);
  const owner = await identity.setup.complete({
    claimToken: claim.token, browserBinding: binding, name: "Owner", organizationName: "Local",
    login: "owner", password: "owner test passphrase", recoverySetId: recovery.setId, recoveryAcknowledged: true,
  });
  const http = createIdentityHttpAdapter(identity, { origin: "http://127.0.0.1:1", localOnly: true });
  const auth = createCanonicalAuthGateway({
    control,
    identity,
    cookieName: identity.sessions.cookieName(),
    resolvePairedDevice: () => ({
      kind: "paired-device",
      deviceId: "dev-phone",
      deviceEndpointId: "ep",
      connectionId: "full",
      transport: "direct",
      grants: [REMOTE_CAPABILITY.deviceFullAccess],
      grantRevision: 1,
      userId: owner.userId,
    }) as never,
  });
  const handler = createHttpHandler({ ...baseDeps(http), auth: auth as never });
  const server = createServer((req, res) => void handler(req, res, {
    kind: "polyth-link",
    connectionId: "full",
    transport: "direct",
  }));
  const base = await listening(server);
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  try {
    // People can be read without a password, and Listed as manageable.
    const listed = await fetch(`${base}/api/auth/accounts`);
    assert.equal(listed.status, 200);
    const view = await listed.json() as Record<string, any>;
    assert.equal(view.canManage, true);
    assert.equal(view.readOnly, true);
    assert.equal(view.canManageInBrowser, true);
    assert.deepEqual(view.accounts.map((account: { id: string }) => account.id), [owner.userId]);

    // Changing them needs the person's password first.
    const refused = await post("/api/auth/accounts", { login: "olena", name: "Olena", password: "member test passphrase" });
    assert.equal(refused.status, 403);
    assert.deepEqual(await refused.json(), { error: "reauth-required" });
    assert.equal((await post("/api/auth/reauthenticate", { password: "wrong passphrase" })).status, 401);
    assert.equal((await post("/api/auth/reauthenticate", { password: "owner test passphrase" })).status, 200);
    const created = await post("/api/auth/accounts", { login: "olena", name: "Olena", password: "member test passphrase" });
    assert.equal(created.status, 200);
    const person = await created.json() as Record<string, any>;
    assert.equal(person.name, "Olena");
    assert.equal((await fetch(`${base}/api/auth/accounts`)).status, 200);

    // Its own account, passkeys, sessions and tokens stay browser-only.
    for (const [path, method] of [["/api/auth/me", "POST"], ["/api/auth/sessions", "GET"], ["/api/auth/passkeys", "GET"], ["/api/auth/cli/tokens", "POST"]] as const) {
      const response = method === "GET" ? await fetch(`${base}${path}`) : await post(path, {});
      assert.equal(response.status, 403, `${method} ${path}`);
      assert.deepEqual(await response.json(), { error: "forbidden", message: "not allowed" });
    }
  } finally {
    await close(server);
  }
});
