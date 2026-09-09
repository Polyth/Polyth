import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AuthPrincipal, RouteRequest } from "@polyth/contracts";
import {
  createAuthService,
  publicHttpIngress,
  type AuthRequestLike,
} from "../src/auth.ts";
import { authRoutes } from "../src/routes/auth.ts";

const tempFile = () => join(mkdtempSync(join(tmpdir(), "polyth-account-routes-")), "auth.json");

function request(cookie?: string): AuthRequestLike {
  return {
    headers: { ...(cookie ? { cookie } : {}), "user-agent": "account-route-test" },
    socket: { remoteAddress: "127.0.0.1" },
  };
}

async function call(
  auth: ReturnType<typeof createAuthService>,
  method: string,
  path: string,
  body: Record<string, unknown> = {},
  token?: string,
) {
  const req = request(token ? `polyth_auth=${token}` : undefined);
  const ingress = publicHttpIngress(req);
  const principal = auth.resolve(req, ingress).principal;
  let status = 0;
  let payload: unknown;
  const rc = {
    req,
    res: { setHeader() {} },
    url: new URL(`http://polyth${path}`),
    path,
    method,
    ingress,
    principal,
    requireCapability: (capability: string) => auth.requireCapability(principal, capability),
    body: async () => body,
    json: (code: number, value: unknown) => { status = code; payload = value; },
  } as unknown as RouteRequest;
  assert.equal(await authRoutes(auth)(rc), true);
  return { status, payload: payload as Record<string, unknown> };
}

test("owner cannot create a second account until the owner account is secured", async () => {
  const auth = createAuthService({ file: tempFile(), ownerUserId: "usr_owner" });

  const blocked = await call(auth, "POST", "/api/auth/accounts", {
    name: "Alice",
    password: "alice-password",
  });
  assert.equal(blocked.status, 409);
  assert.equal(auth.hasCredential("usr_alice"), false);

  auth.setPassword("usr_owner", "owner-password");
  const owner = auth.login("owner-password", "127.0.0.1", "Owner", "usr_owner");
  assert.ok(owner.ok);
  if (!owner.ok) return;
  const created = await call(auth, "POST", "/api/auth/accounts", {
    name: "Alice",
    password: "alice-password",
  }, owner.token);
  assert.equal(created.status, 201);
  assert.equal(auth.hasCredential("usr_alice"), true);
});

test("public auth status never enumerates server accounts", async () => {
  const auth = createAuthService({ file: tempFile(), ownerUserId: "usr_owner" });
  auth.setPassword("usr_owner", "owner-password");
  auth.setPassword("usr_alice", "alice-password");

  const anonymous = await call(auth, "GET", "/api/auth/status");
  assert.deepEqual(anonymous.payload, { required: true, authorized: false, scope: "anonymous" });
  assert.equal("accounts" in anonymous.payload, false);
});

test("removing a secondary credential invalidates its paired principal", () => {
  const auth = createAuthService({ file: tempFile(), ownerUserId: "usr_owner" });
  auth.setPassword("usr_owner", "owner-password");
  auth.setPassword("usr_alice", "alice-password");
  auth.attachPairedDeviceResolver((ingress) => ({
    kind: "paired-device",
    deviceId: "device-alice",
    deviceEndpointId: "endpoint-alice",
    connectionId: ingress.connectionId,
    transport: ingress.transport,
    grants: [],
    grantRevision: 1,
    userId: "usr_alice",
  } as AuthPrincipal));

  const req: AuthRequestLike = { headers: {}, socket: {} };
  const ingress = { kind: "polyth-link", connectionId: "connection-alice", transport: "direct" } as const;
  assert.equal(auth.resolve(req, ingress).authenticated, true);

  assert.equal(auth.removeAccount("usr_alice"), true);
  assert.equal(auth.resolve(req, ingress).authenticated, false);
});
