import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GRANT_PROFILE_PRESETS, matchRemotePath, REMOTE_CAPABILITY, requireLocalTunnelAdmin } from "@polyth/contracts";
import {
  createAuthService,
  publicHttpIngress,
  requirePrincipalCapability,
  AuthorizationError,
  type AuthRequestLike,
} from "../src/auth.ts";
import { assertPairedHttpAllowed, CORE_REMOTE_ACCESS } from "../src/remotePolicy.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "polyth-auth-ingress-"));
const reqOf = (remoteAddress = "127.0.0.1"): AuthRequestLike => ({
  headers: {},
  socket: { remoteAddress },
});

test("polyth-link ingress never inherits localhost optional or auth-disabled local-user", () => {
  const tunnel = { kind: "polyth-link", connectionId: "c1", transport: "direct" } as const;

  const open = createAuthService({ file: join(tmp(), "off.json") });
  const openPublic = open.resolve(reqOf(), publicHttpIngress(reqOf()));
  assert.equal(openPublic.principal.kind, "local-user");
  assert.equal(openPublic.authenticated, true);
  const openTunnel = open.resolve(reqOf(), tunnel);
  assert.equal(openTunnel.principal.kind, "anonymous");
  assert.equal(openTunnel.authenticated, false);

  const lax = createAuthService({
    file: join(tmp(), "lax.json"), envPassword: "pw", localhostOptional: true,
  });
  assert.equal(lax.resolve(reqOf("127.0.0.1"), publicHttpIngress(reqOf("127.0.0.1"))).authenticated, true);
  assert.equal(lax.resolve(reqOf("127.0.0.1"), tunnel).authenticated, false);
  assert.equal(lax.resolve(reqOf("127.0.0.1"), tunnel).principal.kind, "anonymous");
});

test("paired-device principal comes only from the trusted resolver, never headers", () => {
  const auth = createAuthService({
    file: join(tmp(), "auth.json"),
    envPassword: "pw",
    resolvePairedDevice: (ingress) => ingress.connectionId === "live" ? {
      kind: "paired-device",
      deviceId: "dev-1",
      deviceEndpointId: "abc",
      connectionId: ingress.connectionId,
      transport: ingress.transport,
      grants: [...GRANT_PROFILE_PRESETS.interact],
      grantRevision: 1,
    } : null,
  });
  const spoofed: AuthRequestLike = {
    headers: { cookie: "polyth_auth=" + "a".repeat(64) },
    socket: { remoteAddress: "127.0.0.1" },
  };
  const miss = auth.resolve(spoofed, { kind: "polyth-link", connectionId: "stale", transport: "relay" });
  assert.equal(miss.authenticated, false);
  const hit = auth.resolve(spoofed, { kind: "polyth-link", connectionId: "live", transport: "relay" });
  assert.equal(hit.authenticated, true);
  assert.equal(hit.principal.kind, "paired-device");
  if (hit.principal.kind === "paired-device") {
    assert.equal(hit.principal.connectionId, "live");
    assert.equal(hit.principal.transport, "relay");
    assert.deepEqual(auth.statusDto(hit), {
      required: false, authorized: true, scope: "paired-device",
    });
  }
});

test("paired-device default-deny: unknown route, read grant, and admin capability", () => {
  const principal = {
    kind: "paired-device",
    deviceId: "dev-1",
    deviceEndpointId: "abc",
    connectionId: "c1",
    transport: "direct" as const,
    grants: [...GRANT_PROFILE_PRESETS.observe],
    grantRevision: 1,
  };
  const policies = [{ owner: "core", policy: CORE_REMOTE_ACCESS }];
  assert.throws(
    () => assertPairedHttpAllowed(principal, "GET", "/api/not-a-route", policies),
    (e: AuthorizationError) => e.status === 403,
  );
  assert.throws(
    () => assertPairedHttpAllowed(principal, "POST", "/api/sessions", policies),
    (e: AuthorizationError) => e.status === 403,
  );
  const allowed = assertPairedHttpAllowed(principal, "GET", "/api/sessions", policies);
  assert.equal(allowed.rule.capability, REMOTE_CAPABILITY.coreSessionsRead);
  assert.throws(
    () => requirePrincipalCapability(principal, REMOTE_CAPABILITY.tunnelPairingManage),
    (e: AuthorizationError) => e.status === 403,
  );
  assert.throws(
    () => requirePrincipalCapability({ kind: "anonymous" }, REMOTE_CAPABILITY.coreSessionsRead),
    (e: AuthorizationError) => e.status === 401,
  );
});

test("remote paired devices cannot use custom-provider discovery as a fetch primitive", () => {
  const principal = {
    kind: "paired-device" as const,
    deviceId: "dev-1",
    deviceEndpointId: "abc",
    connectionId: "c1",
    transport: "direct" as const,
    grants: [...GRANT_PROFILE_PRESETS.interact],
    grantRevision: 1,
  };
  const policies = [{ owner: "core", policy: CORE_REMOTE_ACCESS }];
  for (const path of [
    "/api/providers/custom",
    "/api/providers/custom/lab",
    "/api/providers/custom/lab/discover",
    "/api/providers/custom/lab/models",
    "/api/providers/custom/lab/models/gpt-x",
  ]) {
    for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
      assert.throws(
        () => assertPairedHttpAllowed(principal, method, path, policies),
        (e: AuthorizationError) => e.status === 403,
        `${method} ${path} must be denied remotely`,
      );
    }
  }
});

test("remote path matcher rejects traversal and accepts :param segments", () => {
  assert.equal(matchRemotePath("/api/sessions/:id", "/api/sessions/abc"), true);
  assert.equal(matchRemotePath("/api/sessions/:id", "/api/sessions/abc/extra"), false);
  assert.equal(matchRemotePath("/api/sessions/:id/message", "/api/sessions/abc/message"), true);
  assert.equal(matchRemotePath("/api/files/stat", "/api/files/stat"), true);
  assert.equal(matchRemotePath("/api/files/stat", "/api/files/../stat"), false);
  assert.equal(matchRemotePath("/api/health", "/api/health"), true);
  assert.equal(matchRemotePath("/api/health", "/api/Health"), false);
});

test("auth disabled: loopback is local-user; non-loopback is not", () => {
  const auth = createAuthService({ file: join(tmp(), "off.json") });
  const loop = auth.resolve(reqOf("127.0.0.1"), publicHttpIngress(reqOf("127.0.0.1")));
  assert.equal(loop.principal.kind, "local-user");
  assert.equal(loop.authenticated, true);
  if (loop.principal.kind === "local-user") assert.equal(loop.principal.trustedLoopback, true);

  const remote = auth.resolve(reqOf("203.0.113.9"), publicHttpIngress(reqOf("203.0.113.9")));
  assert.equal(remote.principal.kind, "anonymous");
  assert.equal(remote.authenticated, false);
});

test("spoofed forwarded and internal headers do not change ingress or principal", () => {
  const auth = createAuthService({ file: join(tmp(), "off.json") });
  const spoofed: AuthRequestLike = {
    headers: {
      cookie: "polyth_auth=" + "a".repeat(64),
      "user-agent": "spoof",
    },
    socket: { remoteAddress: "203.0.113.9" },
  };
  const ingress = publicHttpIngress(spoofed);
  assert.equal(ingress.kind, "public-http");
  assert.equal(ingress.loopback, false);
  const resolution = auth.resolve(spoofed, ingress);
  assert.equal(resolution.principal.kind, "anonymous");
});

test("requireLocalTunnelAdmin denies paired, anonymous, non-loopback, and unknown internals", () => {
  const loop = { kind: "public-http" as const, listenerId: "public", loopback: true, secure: false };
  const remote = { kind: "public-http" as const, listenerId: "public", loopback: false, secure: false };
  const grants = [
    ...GRANT_PROFILE_PRESETS["full-remote"],
    REMOTE_CAPABILITY.tunnelPairingManage,
    REMOTE_CAPABILITY.tunnelDevicesManage,
    REMOTE_CAPABILITY.tunnelGrantsManage,
    REMOTE_CAPABILITY.serverIdentityRotate,
  ];

  requireLocalTunnelAdmin({ ingress: loop, principal: { kind: "local-user", trustedLoopback: true } });
  requireLocalTunnelAdmin({
    ingress: loop,
    principal: { kind: "ui-session", sessionId: "s", rememberedDeviceId: "s" },
  });

  assert.throws(
    () => requireLocalTunnelAdmin({ ingress: remote, principal: { kind: "ui-session", sessionId: "s", rememberedDeviceId: "s" } }),
    (error: Error & { code?: string }) => error.code === "forbidden",
  );
  assert.throws(
    () => requireLocalTunnelAdmin({ ingress: loop, principal: { kind: "anonymous" } }),
    (error: Error & { code?: string }) => error.code === "unauthorized",
  );
  assert.throws(
    () => requireLocalTunnelAdmin({
      ingress: loop,
      principal: {
        kind: "paired-device",
        deviceId: "d",
        deviceEndpointId: "e",
        connectionId: "c",
        transport: "direct",
        grants,
        grantRevision: 1,
      },
    }),
    (error: Error & { code?: string }) => error.code === "forbidden",
  );
  assert.throws(
    () => requireLocalTunnelAdmin({
      ingress: loop,
      principal: { kind: "internal-service", serviceId: "not-allowlisted" },
    }),
    (error: Error & { code?: string }) => error.code === "forbidden",
  );
  requireLocalTunnelAdmin(
    { ingress: loop, principal: { kind: "internal-service", serviceId: "link-admin" } },
    { allowInternalServices: ["link-admin"] },
  );
});

