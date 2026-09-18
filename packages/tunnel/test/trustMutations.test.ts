import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthPrincipal, RouteRequest, SpaceContext } from "@polyth/contracts";
import { grantsForProfile, createTunnelStore } from "../src/index.ts";
import { TunnelEventBus, redactTunnelStatusEvent } from "../src/events.ts";
import { tunnelRoutes } from "../src/serverEntry.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "polyth-tunnel-trust-"));

const SPACE: SpaceContext = {
  spaceId: "spc_test",
  spaceSlug: "test",
  userId: "usr_test",
  role: "owner",
  deployment: "local-trusted",
  storageDir: "/tmp/polyth-tunnel-test-space",
};

const local: AuthPrincipal = { kind: "local-user", trustedLoopback: true };

const request = (opts: {
  path: string;
  method?: string;
  principal?: AuthPrincipal;
  body?: Record<string, unknown>;
}): { rc: RouteRequest; codes: number[]; bodies: unknown[] } => {
  const codes: number[] = [];
  const bodies: unknown[] = [];
  const rc: RouteRequest = {
    req: {} as never,
    res: {} as never,
    url: new URL(`http://polyth.test${opts.path}`),
    path: opts.path.split("?")[0]!,
    method: opts.method ?? "GET",
    ingress: { kind: "public-http", listenerId: "public", loopback: true, secure: false },
    principal: opts.principal ?? local,
    space: SPACE,
    requireCapability() {},
    body: async () => opts.body ?? {},
    json(code, body) { codes.push(code); bodies.push(body); },
  };
  return { rc, codes, bodies };
};

test("revoke A leaves B connected and failed host trust mutation is not success", async () => {
  const store = createTunnelStore(join(tmp(), "tunnel.db"));
  const events = new TunnelEventBus();
  const a = store.commitDevice({
    ownerUserId: SPACE.userId,
    endpointId: "aa".repeat(32),
    label: "Phone A",
    grants: grantsForProfile("interact"),
    pairedVia: "polyth-link",
  });
  const b = store.commitDevice({
    ownerUserId: SPACE.userId,
    endpointId: "bb".repeat(32),
    label: "Phone B",
    grants: grantsForProfile("interact"),
    pairedVia: "polyth-link",
  });
  const connections = new Map<string, AuthPrincipal>([
    ["ca1", {
      kind: "paired-device",
      deviceId: a.id,
      deviceEndpointId: a.endpointId,
      connectionId: "ca1",
      transport: "direct",
      grants: a.grants,
      grantRevision: a.grantRevision,
    }],
    ["ca2", {
      kind: "paired-device",
      deviceId: a.id,
      deviceEndpointId: a.endpointId,
      connectionId: "ca2",
      transport: "direct",
      grants: a.grants,
      grantRevision: a.grantRevision,
    }],
    ["cb1", {
      kind: "paired-device",
      deviceId: b.id,
      deviceEndpointId: b.endpointId,
      connectionId: "cb1",
      transport: "direct",
      grants: b.grants,
      grantRevision: b.grantRevision,
    }],
  ]);
  const closed: string[] = [];
  const hostCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const routes = tunnelRoutes({
    store,
    events,
    host: () => ({
      available: true,
      async request(method: string, params: Record<string, unknown> = {}) {
        if (method === "trust.revoke" && params.deviceId === "fail-me") {
          throw new Error("host down");
        }
        hostCalls.push({ method, params });
        return { ok: true };
      },
    }) as never,
    connections,
    status: async () => ({}),
    diagnostics: async () => ({}),
    closeDeviceSockets(deviceId) { closed.push(deviceId); },
  });

  const listed = request({ path: "/api/tunnel/devices" });
  assert.equal(await routes(listed.rc), true);
  const devices = listed.bodies[0] as Array<{ id: string; activeConnectionCount: number; online: boolean }>;
  const listedA = devices.find((item) => item.id === a.id);
  const listedB = devices.find((item) => item.id === b.id);
  assert.equal(listedA?.activeConnectionCount, 2);
  assert.equal(listedA?.online, true);
  assert.equal(listedB?.activeConnectionCount, 1);

  const revokeA = request({ path: `/api/tunnel/devices/${a.id}/revoke`, method: "POST" });
  assert.equal(await routes(revokeA.rc), true);
  assert.deepEqual(revokeA.codes, [200]);
  assert.equal(connections.has("ca1"), false);
  assert.equal(connections.has("ca2"), false);
  assert.equal(connections.has("cb1"), true);
  assert.deepEqual(closed, [a.id]);
  assert.equal(hostCalls.some((call) => call.method === "trust.revoke" && call.params.deviceId === a.id), true);

  store.commitDevice({
    ownerUserId: SPACE.userId,
    endpointId: "cc".repeat(32),
    label: "Fail",
    grants: grantsForProfile("observe"),
    pairedVia: "polyth-link",
  });
  const failDevice = store.list().find((item) => item.label === "Fail")!;
  const hostFail = tunnelRoutes({
    store,
    events,
    host: () => ({
      available: true,
      async request() { throw new Error("host down"); },
    }) as never,
    connections: new Map(),
    status: async () => ({}),
    diagnostics: async () => ({}),
    closeDeviceSockets() {},
  });
  const failed = request({ path: `/api/tunnel/devices/${failDevice.id}/revoke`, method: "POST" });
  assert.equal(await hostFail(failed.rc), true);
  assert.equal(failed.codes[0], 503);
  assert.equal((failed.bodies[0] as { state?: string }).state, "partial");
  store.close();
});

test("grant update A does not notify B and restore permits reconnect metadata", async () => {
  const store = createTunnelStore(join(tmp(), "tunnel.db"));
  const events = new TunnelEventBus();
  const a = store.commitDevice({
    ownerUserId: SPACE.userId,
    endpointId: "aa".repeat(32),
    label: "Phone A",
    grants: grantsForProfile("developer"),
    pairedVia: "polyth-link",
  });
  const b = store.commitDevice({
    ownerUserId: SPACE.userId,
    endpointId: "bb".repeat(32),
    label: "Phone B",
    grants: grantsForProfile("developer"),
    pairedVia: "polyth-link",
  });
  const connections = new Map<string, AuthPrincipal>([
    ["ca1", {
      kind: "paired-device",
      deviceId: a.id,
      deviceEndpointId: a.endpointId,
      connectionId: "ca1",
      transport: "direct",
      grants: a.grants,
      grantRevision: a.grantRevision,
    }],
    ["cb1", {
      kind: "paired-device",
      deviceId: b.id,
      deviceEndpointId: b.endpointId,
      connectionId: "cb1",
      transport: "direct",
      grants: b.grants,
      grantRevision: b.grantRevision,
    }],
  ]);
  const seen: Array<{ type: string; deviceId?: string }> = [];
  events.subscribe((event) => {
    seen.push({ type: event.type, deviceId: (event.data as { deviceId?: string }).deviceId });
  });
  const routes = tunnelRoutes({
    store,
    events,
    host: () => ({
      available: true,
      async request() { return { ok: true }; },
    }) as never,
    connections,
    status: async () => ({}),
    diagnostics: async () => ({}),
    closeDeviceSockets() {},
  });
  const nextGrants = a.grants.filter((cap) => cap !== "terminal.input");
  const update = request({
    path: `/api/tunnel/devices/${a.id}/grants`,
    method: "PUT",
    body: { grants: nextGrants },
  });
  assert.equal(await routes(update.rc), true);
  assert.deepEqual(update.codes, [200]);
  const liveA = connections.get("ca1");
  assert.equal(liveA?.kind === "paired-device" && liveA.grants.includes("terminal.input"), false);
  const liveB = connections.get("cb1");
  assert.equal(liveB?.kind === "paired-device" && liveB.grants.includes("terminal.input"), true);
  assert.equal(seen.filter((event) => event.type === "tunnel/grants-updated").every((event) => event.deviceId === a.id), true);

  const revoked = request({ path: `/api/tunnel/devices/${a.id}/revoke`, method: "POST" });
  assert.equal(await routes(revoked.rc), true);
  const restored = request({ path: `/api/tunnel/devices/${a.id}/restore`, method: "POST" });
  assert.equal(await routes(restored.rc), true);
  assert.deepEqual(restored.codes, [200]);
  assert.equal(store.device(a.id)?.revokedAt, null);
  store.close();
});

test("tunnel status events redact endpoint ids, phrases, and grants", () => {
  const event = redactTunnelStatusEvent({
    packageId: "tunnel",
    type: "tunnel/pairing-updated",
    revision: 1,
    data: {
      deviceId: "dev-1",
      endpointId: "secret-endpoint",
      safetyPhrase: ["alpha", "bravo", "charlie", "delta"],
      requestedGrants: ["core.sessions.read"],
      grants: ["core.sessions.read"],
      ticket: "polyth://pair?v=1&t=secret",
      online: true,
    } as never,
  });
  assert.equal((event.data as { endpointId?: string }).endpointId, undefined);
  assert.equal((event.data as { safetyPhrase?: string[] }).safetyPhrase, undefined);
  assert.equal((event.data as { grants?: string[] }).grants, undefined);
  assert.equal((event.data as { ticket?: string }).ticket, undefined);
  assert.equal((event.data as { deviceId?: string }).deviceId, "dev-1");
});

test("pairing POST rejects relay-only and air-gapped product modes", async () => {
  const store = createTunnelStore(join(tmp(), "tunnel.db"));
  const events = new TunnelEventBus();
  const routes = tunnelRoutes({
    store,
    events,
    host: () => ({
      available: true,
      async request() { return { ok: true }; },
    }) as never,
    connections: new Map(),
    status: async () => ({}),
    diagnostics: async () => ({}),
    closeDeviceSockets() {},
  });
  for (const mode of ["relay-only", "air-gapped"]) {
    const req = request({
      path: "/api/tunnel/pairing",
      method: "POST",
      body: { profile: "interact", mode },
    });
    assert.equal(await routes(req.rc), true);
    assert.deepEqual(req.codes, [400]);
  }
  store.close();
});
