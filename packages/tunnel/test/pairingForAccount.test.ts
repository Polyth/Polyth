// An instance owner pairs someone else's Polyth app: the device joins that
// person's account with a narrowed profile, only the owner sees and approves
// the pairing, and the owner can later revoke the device it issued.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REMOTE_CAPABILITY, type AuthPrincipal, type RouteRequest, type SpaceContext } from "@polyth/contracts";
import { createTunnelStore } from "../src/index.ts";
import { TunnelEventBus } from "../src/events.ts";
import { commitPairingDevice, tunnelRoutes } from "../src/serverEntry.ts";

const OWNER = "usr_admin";
const PM = "usr_pm";
const STRANGER = "usr_stranger";
const SPACE_ID = "spc_team";

const space = (userId: string, instanceOwner: boolean): SpaceContext => ({
  spaceId: SPACE_ID,
  spaceSlug: "team",
  userId,
  role: instanceOwner ? "owner" : "member",
  deployment: "local-trusted",
  storageDir: "/tmp/polyth-tunnel-for-account",
  instanceOwner,
} as SpaceContext);

const session = (userId: string): AuthPrincipal => ({ kind: "ui-session", sessionId: `s-${userId}`, rememberedDeviceId: `d-${userId}`, userId } as AuthPrincipal);

const call = async (
  routes: ReturnType<typeof tunnelRoutes>,
  opts: { path: string; method?: string; userId: string; instanceOwner: boolean; body?: Record<string, unknown> },
): Promise<{ code: number; body: any }> => {
  const out: { code: number; body: any } = { code: 0, body: undefined };
  const rc: RouteRequest = {
    req: {} as never,
    res: {} as never,
    url: new URL(`https://polyth.test${opts.path}`),
    path: opts.path,
    method: opts.method ?? "GET",
    ingress: { kind: "public-http", listenerId: "public", loopback: false, secure: true },
    principal: session(opts.userId),
    space: space(opts.userId, opts.instanceOwner),
    requireCapability() {},
    body: async () => opts.body ?? {},
    json(code, body) { out.code = code; out.body = body; },
  };
  assert.equal(await routes(rc), true);
  return out;
};

const setup = () => {
  const store = createTunnelStore(join(mkdtempSync(join(tmpdir(), "polyth-tunnel-for-account-")), "tunnel.db"));
  const events = new TunnelEventBus();
  const created: Array<Record<string, unknown>> = [];
  let next = 0;
  const host = {
    available: true,
    request: async (method: string, params: Record<string, unknown> = {}) => {
      if (method === "pairing.create") {
        created.push(params);
        next += 1;
        return { pairing: { id: `pair-${next}` }, ticket: "polyth://pair?v=1&t=x" };
      }
      if (method === "pairing.get") return { pairing: { id: params.id, state: "finished" } };
      return { ok: true };
    },
  };
  const members = new Set([`${OWNER}@${SPACE_ID}`, `${PM}@${SPACE_ID}`]);
  const routes = tunnelRoutes({
    store,
    events,
    host: () => host as never,
    connections: new Map(),
    status: async () => ({}),
    diagnostics: async () => ({}),
    closeDeviceSockets() {},
    isSpaceMember: (userId, spaceId) => members.has(`${userId}@${spaceId}`),
  });
  return { store, events, host, created, routes };
};

const endpoint = "cd".repeat(32);

test("an instance owner pairs a member's app into that member's account; full access there is that member's own", async () => {
  const { store, events, host, created, routes } = setup();
  const issued = await call(routes, {
    path: "/api/tunnel/pairing", method: "POST", userId: OWNER, instanceOwner: true, body: { forUserId: PM },
  });
  assert.equal(issued.code, 200);
  assert.equal(issued.body.forUserId, PM);
  assert.equal(issued.body.profile, "full-remote", "the person's app may do what they may do signed in here");
  const grants = created[0]!.grants as string[];
  assert.ok(grants.includes(REMOTE_CAPABILITY.deviceFullAccess));
  assert.equal(store.pairingOwner("pair-1"), OWNER, "the owner, not the member, approves");
  assert.equal(store.pairingAccount("pair-1"), PM);

  // The member cannot see or approve the pending pairing.
  await assert.rejects(
    () => call(routes, { path: "/api/tunnel/pairing/pair-1/approve", method: "POST", userId: PM, instanceOwner: false }),
    (error: Error & { code?: string }) => error.code === "not-found",
  );

  await commitPairingDevice({ pairingId: "pair-1", endpointId: endpoint, label: "PM laptop", platform: "macos", grants }, {
    store, host: host as never, events,
  });
  const device = store.deviceByPairing("pair-1")!;
  assert.equal(device.ownerUserId, PM, "the device acts as the member");
  assert.equal(device.issuedBy, OWNER);
  assert.ok(device.grants.includes(REMOTE_CAPABILITY.deviceFullAccess));
  assert.deepEqual(store.list(OWNER), [], "the owner's own device list stays its own");
  assert.equal(store.list(PM).length, 1);

  // The owner's approval dialog can still read the finished pairing.
  const finished = await call(routes, { path: "/api/tunnel/pairing/pair-1", userId: OWNER, instanceOwner: true });
  assert.equal(finished.code, 200);

  const issuedList = await call(routes, { path: "/api/tunnel/devices/issued", userId: OWNER, instanceOwner: true });
  assert.equal(issuedList.code, 200);
  assert.deepEqual(issuedList.body.map((row: { accountId: string }) => row.accountId), [PM]);
  const memberIssued = await call(routes, { path: "/api/tunnel/devices/issued", userId: PM, instanceOwner: false });
  assert.deepEqual(memberIssued.body, []);

  const audit = store["db"].prepare("SELECT metadata_json FROM tunnel_audit WHERE event_type = 'pairing-issued-for-account'").all() as Array<{ metadata_json: string }>;
  assert.equal(audit.length, 1);
  assert.deepEqual(JSON.parse(audit[0]!.metadata_json), { pairingId: "pair-1", profile: "full-remote", issuedBy: OWNER, forUserId: PM });
  store.close();
});

test("only the instance owner may pair for another account, only for a Space member, and never full access", async () => {
  const { store, routes, created } = setup();
  await assert.rejects(
    () => call(routes, { path: "/api/tunnel/pairing", method: "POST", userId: PM, instanceOwner: false, body: { forUserId: OWNER } }),
    (error: Error & { code?: string }) => error.code === "forbidden",
  );
  const stranger = await call(routes, {
    path: "/api/tunnel/pairing", method: "POST", userId: OWNER, instanceOwner: true, body: { forUserId: STRANGER },
  });
  assert.equal(stranger.code, 400);
  const malformed = await call(routes, {
    path: "/api/tunnel/pairing", method: "POST", userId: OWNER, instanceOwner: true, body: { forUserId: 42 },
  });
  assert.equal(malformed.code, 400);
  assert.equal(created.length, 0, "no refused request reaches the Link host");

  // Naming oneself is an ordinary pairing.
  const self = await call(routes, {
    path: "/api/tunnel/pairing", method: "POST", userId: PM, instanceOwner: false, body: { forUserId: PM, profile: "interact" },
  });
  assert.equal(self.code, 200);
  assert.equal(store.pairingAccount("pair-1"), PM);
  assert.equal(self.body.forUserId, undefined);
  store.close();
});

test("the issuing owner can revoke and forget the device; others cannot, nor a former owner", async () => {
  const { store, events, host, routes } = setup();
  await call(routes, { path: "/api/tunnel/pairing", method: "POST", userId: OWNER, instanceOwner: true, body: { forUserId: PM, profile: "interact" } });
  await commitPairingDevice({ pairingId: "pair-1", endpointId: endpoint, label: "PM phone", grants: [] }, { store, host: host as never, events });
  const id = store.deviceByPairing("pair-1")!.id;

  await assert.rejects(
    () => call(routes, { path: `/api/tunnel/devices/${id}/revoke`, method: "POST", userId: STRANGER, instanceOwner: false }),
    (error: Error & { code?: string }) => error.code === "not-found",
  );
  await assert.rejects(
    () => call(routes, { path: `/api/tunnel/devices/${id}/revoke`, method: "POST", userId: OWNER, instanceOwner: false }),
    (error: Error & { code?: string }) => error.code === "not-found",
    "an issuer who is no longer the instance owner loses the device",
  );
  await assert.rejects(
    () => call(routes, { path: `/api/tunnel/devices/${id}/grants`, method: "PUT", userId: OWNER, instanceOwner: true, body: { grants: [REMOTE_CAPABILITY.deviceFullAccess] } }),
    (error: Error & { code?: string }) => error.code === "not-found",
    "the issuer cannot widen another person's device",
  );
  const revoked = await call(routes, { path: `/api/tunnel/devices/${id}/revoke`, method: "POST", userId: OWNER, instanceOwner: true });
  assert.equal(revoked.code, 200);
  assert.ok(store.device(id)!.revokedAt);
  const forgotten = await call(routes, { path: `/api/tunnel/devices/${id}`, method: "DELETE", userId: OWNER, instanceOwner: true });
  assert.equal(forgotten.code, 200);
  assert.equal(store.device(id), undefined);
  store.close();
});
