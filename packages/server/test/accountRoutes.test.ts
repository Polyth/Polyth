import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { RouteRequest } from "@polyth/contracts";
import {
  createAuthService,
  publicHttpIngress,
  type AuthRequestLike,
} from "../src/auth.ts";
import { authRoutes, type AuthRoutesDeps } from "../src/routes/auth.ts";

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
  deps: AuthRoutesDeps = {},
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
  assert.equal(await authRoutes(auth, deps)(rc), true);
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
  const created = await call(auth, "POST", "/api/auth/accounts", {
    name: "Alice",
    password: "alice-password",
  });
  assert.equal(created.status, 201);
  assert.equal(auth.hasCredential("usr_alice"), true);
});

test("account removal revokes external access before credentials are deleted", async () => {
  const auth = createAuthService({ file: tempFile(), ownerUserId: "usr_owner" });
  auth.setPassword("usr_owner", "owner-password");
  auth.setPassword("usr_alice", "alice-password");
  const owner = auth.login("owner-password", "127.0.0.1", "Owner", "usr_owner");
  assert.ok(owner.ok);
  if (!owner.ok) return;

  const calls: string[] = [];
  const removed = await call(
    auth,
    "DELETE",
    "/api/auth/accounts/usr_alice",
    {},
    owner.token,
    { revokeAccountAccess: async (userId) => { calls.push(userId); } },
  );
  assert.equal(removed.status, 200);
  assert.deepEqual(calls, ["usr_alice"]);
  assert.equal(auth.hasCredential("usr_alice"), false);
});

test("auth status reveals the current account only after authentication", async () => {
  const auth = createAuthService({ file: tempFile(), ownerUserId: "usr_owner" });
  auth.setPassword("usr_owner", "owner-password");
  auth.setPassword("usr_alice", "alice-password");

  const anonymous = await call(auth, "GET", "/api/auth/status");
  assert.deepEqual(anonymous.payload, { required: true, authorized: false, scope: "anonymous" });

  const alice = auth.login("alice-password", "127.0.0.1", "Alice", "usr_alice");
  assert.ok(alice.ok);
  if (!alice.ok) return;
  const signedIn = await call(auth, "GET", "/api/auth/status", {}, alice.token);
  assert.deepEqual(signedIn.payload, {
    required: true,
    authorized: true,
    scope: "ui-session",
    accountId: "usr_alice",
  });
  assert.equal("accounts" in signedIn.payload, false);
});
