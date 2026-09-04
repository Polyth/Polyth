import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthPrincipal, RouteRequest } from "@polyth/contracts";
import { createTunnelStore } from "../src/index.ts";
import { TunnelEventBus } from "../src/events.ts";
import { tunnelRoutes } from "../src/serverEntry.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "polyth-tunnel-routes-"));

const request = (opts: {
  path: string;
  method?: string;
  principal: AuthPrincipal;
  body?: Record<string, unknown>;
  loopback?: boolean;
  ingressKind?: "public-http" | "polyth-link" | "internal";
}): { rc: RouteRequest; codes: number[] } => {
  const codes: number[] = [];
  const loopback = opts.loopback ?? true;
  const ingress = opts.ingressKind === "polyth-link"
    ? { kind: "polyth-link" as const, connectionId: "c1", transport: "direct" as const }
    : opts.ingressKind === "internal"
      ? { kind: "internal" as const, serviceId: "other" }
      : { kind: "public-http" as const, listenerId: "public", loopback, secure: false };
  const rc: RouteRequest = {
    req: {} as never,
    res: {} as never,
    url: new URL(`http://polyth.test${opts.path}`),
    path: opts.path.split("?")[0]!,
    method: opts.method ?? "GET",
    ingress,
    principal: opts.principal,
    requireCapability() {},
    body: async () => opts.body ?? {},
    json(code) { codes.push(code); },
  };
  return { rc, codes };
};

test("pairing and identity rotation stay local-admin; paired devices only reach status/diagnostics", async () => {
  const store = createTunnelStore(join(tmp(), "tunnel.db"));
  const events = new TunnelEventBus();
  const routes = tunnelRoutes({
    store,
    events,
    host: () => null,
    connections: new Map(),
    status: async () => ({ hostFingerprint: "abcd", identityAvailable: false, pairingAvailable: false }),
    diagnostics: async () => ({ packageStatus: "host-binary-missing", recentErrors: [] }),
    closeDeviceSockets() {},
  });

  const paired: AuthPrincipal = {
    kind: "paired-device",
    deviceId: "dev-1",
    deviceEndpointId: "ep",
    connectionId: "c1",
    transport: "direct",
    grants: ["tunnel.status.read"],
    grantRevision: 1,
  };

  const status = request({ path: "/api/tunnel/status", principal: paired });
  assert.equal(await routes(status.rc), true);
  assert.deepEqual(status.codes, [200]);

  const diagnostics = request({ path: "/api/tunnel/diagnostics", principal: paired });
  assert.equal(await routes(diagnostics.rc), true);
  assert.deepEqual(diagnostics.codes, [200]);

  await assert.rejects(
    () => routes(request({ path: "/api/tunnel/pairing", method: "POST", principal: paired, body: { profile: "interact" } }).rc),
    (error: Error & { code?: string }) => error.code === "forbidden",
  );
  await assert.rejects(
    () => routes(request({ path: "/api/tunnel/identity/rotate", method: "POST", principal: paired }).rc),
    (error: Error & { code?: string }) => error.code === "forbidden",
  );
  await assert.rejects(
    () => routes(request({
      path: "/api/tunnel/pairing",
      method: "POST",
      principal: { kind: "anonymous" },
      body: { profile: "full-remote" },
    }).rc),
    (error: Error & { code?: string }) => error.code === "unauthorized",
  );

  const local = request({
    path: "/api/tunnel/pairing",
    method: "POST",
    principal: { kind: "local-user", trustedLoopback: true },
    body: { profile: "interact" },
  });
  assert.equal(await routes(local.rc), true);
  assert.deepEqual(local.codes, [503]);
  store.close();
});

test("non-loopback UI sessions and fully granted paired devices cannot administer the tunnel", async () => {
  const store = createTunnelStore(join(tmp(), "tunnel.db"));
  const events = new TunnelEventBus();
  const routes = tunnelRoutes({
    store,
    events,
    host: () => null,
    connections: new Map(),
    status: async () => ({ pairingAvailable: false }),
    diagnostics: async () => ({ packageStatus: "host-binary-missing" }),
    closeDeviceSockets() {},
  });
  const session: AuthPrincipal = { kind: "ui-session", sessionId: "s1", rememberedDeviceId: "s1" };
  await assert.rejects(
    () => routes(request({
      path: "/api/tunnel/pairing",
      method: "POST",
      principal: session,
      loopback: false,
      body: { profile: "interact" },
    }).rc),
    (error: Error & { code?: string }) => error.code === "forbidden",
  );
  const paired: AuthPrincipal = {
    kind: "paired-device",
    deviceId: "dev-1",
    deviceEndpointId: "ep",
    connectionId: "c1",
    transport: "direct",
    grants: [
      "tunnel.status.read",
      "tunnel.pairing.manage",
      "tunnel.devices.manage",
      "tunnel.grants.manage",
      "server.identity.rotate",
    ],
    grantRevision: 1,
  };
  for (const path of [
    "/api/tunnel/pairing",
    "/api/tunnel/devices",
    "/api/tunnel/identity/rotate",
  ]) {
    await assert.rejects(
      () => routes(request({ path, method: "POST", principal: paired }).rc),
      (error: Error & { code?: string }) => error.code === "forbidden",
    );
  }
  await assert.rejects(
    () => routes(request({
      path: "/api/tunnel/pairing",
      method: "POST",
      principal: { kind: "internal-service", serviceId: "not-allowlisted" },
      ingressKind: "internal",
    }).rc),
    (error: Error & { code?: string }) => error.code === "forbidden",
  );
  store.close();
});

test("event snapshot is monotonic and local-admin catch-up is bounded", () => {
  const events = new TunnelEventBus();
  events.emit("tunnel/pairing-created", { id: "a" });
  events.emit("tunnel/pairing-updated", { id: "a" });
  const snap = events.snapshot(1);
  assert.equal(snap.revision, 2);
  assert.equal(snap.events.length, 1);
  assert.equal(snap.events[0]?.type, "tunnel/pairing-updated");
});
