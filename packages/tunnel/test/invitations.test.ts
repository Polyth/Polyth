// One-time Link invitations: an instance owner sends one link, the invitee's
// app joins the invitee's own account, and the host confirms it when the app
// proves the invite secret. The Node side owns issuance, listing, cancelling,
// the commit that consumes an invitation and restoring it after a restart.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuthPrincipal, type RouteRequest, type SpaceContext } from "@polyth/contracts";
import { createTunnelStore, grantsForProfile } from "../src/index.ts";
import { TunnelEventBus } from "../src/events.ts";
import {
  commitPairingDevice,
  restoreInvitations,
  syncInvitations,
  tunnelRoutes,
} from "../src/serverEntry.ts";

const tempDirs: string[] = [];
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(prefix);
  tempDirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const OWNER = "usr_admin";
const PM = "usr_pm";
const OTHER = "usr_other";
const STRANGER = "usr_stranger";
const SPACE_ID = "spc_team";
const TICKET = "polyth://pair?v=1&t=invite-ticket-that-must-never-be-logged";
const SHARE_URL = "https://polyth.app/join#v=1&t=share-secret-that-must-never-be-logged";

const space = (userId: string, instanceOwner: boolean): SpaceContext => ({
  spaceId: SPACE_ID,
  spaceSlug: "team",
  userId,
  role: instanceOwner ? "owner" : "member",
  deployment: "local-trusted",
  storageDir: "/tmp/polyth-tunnel-invitations",
  instanceOwner,
} as SpaceContext);

const session = (userId: string): AuthPrincipal =>
  ({ kind: "ui-session", sessionId: `s-${userId}`, rememberedDeviceId: `d-${userId}`, userId } as AuthPrincipal);

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

const setup = (opts: {
  invitation?: boolean;
  shareUrl?: string;
  restore?: (params: Record<string, unknown>) => Record<string, unknown>;
} = {}) => {
  const store = createTunnelStore(join(tempDir(join(tmpdir(), "polyth-tunnel-invitations-")), "tunnel.db"));
  const events = new TunnelEventBus();
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let next = 0;
  const host = {
    available: true,
    binaryFound: true,
    platformSupported: true,
    async request(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params });
      if (method === "pairing.create") {
        next += 1;
        const id = `pair-${next}`;
        const expiresAt = new Date(Date.now() + Number(params.ttlMs ?? 604_800_000)).toISOString();
        if (opts.invitation === false) return { pairing: { id, expiresAt, state: "pending" }, ticket: TICKET };
        return {
          pairing: { id, expiresAt, state: "pending" },
          ticket: TICKET,
          qrPayload: "polyth://pair?v=1",
          invitation: true,
          shareUrl: opts.shareUrl ?? SHARE_URL,
          numericCode: null,
          numericExpiresAt: null,
        };
      }
      if (method === "pairing.restore") return opts.restore?.(params) ?? { restored: [], rejected: [] };
      return { ok: true };
    },
  };
  const members = new Set([`${OWNER}@${SPACE_ID}`, `${PM}@${SPACE_ID}`, `${OTHER}@${SPACE_ID}`]);
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
  const issued = async (body: Record<string, unknown> = {}, userId = OWNER, instanceOwner = true) =>
    call(routes, { path: "/api/tunnel/invitations", method: "POST", userId, instanceOwner, body: { forUserId: PM, ...body } });
  return { store, events, host, calls, routes, issued };
};

const endpoint = "ab".repeat(32);

test("the owner issues an invitation: the host sees the flag, TTL and grants, and the reply carries the link", async () => {
  const { store, calls, events, issued } = setup();
  const seen: Array<{ type: string; data: Record<string, unknown> }> = [];
  events.subscribe((event) => seen.push({ type: event.type, data: event.data as Record<string, unknown> }));
  const result = await issued({ ttlMs: 3_600_000, profile: "interact" });
  assert.equal(result.code, 200);
  assert.equal(result.body.id, "pair-1");
  assert.equal(result.body.forUserId, PM);
  assert.equal(result.body.profile, "interact");
  assert.equal(result.body.url, SHARE_URL);
  assert.equal(result.body.link, TICKET);
  assert.equal(typeof result.body.expiresAt, "number");

  const create = calls.find((entry) => entry.method === "pairing.create")!;
  assert.equal(create.params.invitation, true);
  assert.equal(create.params.ttlMs, 3_600_000);
  assert.deepEqual(create.params.grants, grantsForProfile("interact"));
  assert.equal(store.invitation("pair-1")!.state, "pending");
  assert.equal(store.pairingAccount("pair-1"), PM, "the invitee's app joins the invitee's account");
  assert.equal(store.pairingOwner("pair-1"), OWNER, "the owner issued it");
  assert.ok(seen.some((event) => event.type === "tunnel/invitation-created" && event.data.forUserId === PM));

  // Neither the audit trail nor the event stream carries the ticket or URL.
  const audit = store["db"].prepare("SELECT event_type, metadata_json FROM tunnel_audit").all() as Array<{ event_type: string; metadata_json: string }>;
  for (const row of audit) {
    assert.ok(!row.metadata_json.includes(TICKET), `${row.event_type} must not record the ticket`);
    assert.ok(!row.metadata_json.includes(SHARE_URL), `${row.event_type} must not record the share URL`);
  }
  for (const event of seen) assert.ok(!JSON.stringify(event.data).includes("polyth.app/join"));
  store.close();
});

test("issuing is owner-only and refuses self, non-members, bad profiles and bad TTLs", async () => {
  const { calls, issued } = setup();
  await assert.rejects(
    () => issued({}, PM, false),
    (error: Error & { code?: string }) => error.code === "forbidden",
  );
  assert.equal((await issued({ forUserId: OWNER })).code, 400);
  assert.equal((await issued({ forUserId: STRANGER })).code, 400);
  assert.equal((await issued({ profile: "god" })).code, 400);
  assert.equal((await issued({ ttlMs: 1000 })).code, 400);
  assert.equal((await issued({ ttlMs: 604_800_001 })).code, 400);
  assert.equal((await issued({ ttlMs: "3600000" })).code, 400);
  assert.equal(calls.filter((entry) => entry.method === "pairing.create").length, 0, "nothing refused reaches the host");
});

test("a host too old for invitations is cancelled and answered 501", async () => {
  const { calls, issued } = setup({ invitation: false });
  const result = await issued();
  assert.equal(result.code, 501);
  assert.equal(result.body.error, "unsupported");
  assert.match(result.body.message, /too old/);
  assert.ok(calls.some((entry) => entry.method === "pairing.cancel" && entry.params.id === "pair-1"));
});

test("a share URL from another origin is as good as no invitation at all", async () => {
  const { calls, issued } = setup({ shareUrl: "https://evil.example/join#v=1&t=x" });
  const result = await issued();
  assert.equal(result.code, 501);
  assert.ok(calls.some((entry) => entry.method === "pairing.cancel"));
});

test("GET lists only the caller's live invitations and re-issuing cancels the earlier one", async () => {
  const { store, calls, routes, issued } = setup();
  await issued();
  await issued({ forUserId: OTHER });
  const listed = await call(routes, { path: "/api/tunnel/invitations", userId: OWNER, instanceOwner: true });
  assert.equal(listed.code, 200);
  assert.deepEqual(listed.body.invitations.map((row: { forUserId: string }) => row.forUserId).sort(), [OTHER, PM].sort());
  const row = listed.body.invitations[0];
  assert.deepEqual(Object.keys(row).sort(), ["createdAt", "expiresAt", "forUserId", "id", "profile", "url"]);

  const again = await issued();
  assert.equal(again.code, 200);
  assert.equal(store.invitation("pair-1")!.state, "cancelled", "an older link for the same person stops working");
  assert.equal(store.invitation("pair-2")!.state, "pending");
  assert.ok(calls.some((entry) => entry.method === "pairing.cancel" && entry.params.id === "pair-1"));
  const after = await call(routes, { path: "/api/tunnel/invitations", userId: OWNER, instanceOwner: true });
  assert.deepEqual(after.body.invitations.map((item: { id: string }) => item.id).sort(), ["pair-2", "pair-3"]);

  // Only the instance owner invites, so anyone else is refused the list
  // outright (the Add user flow reads that as "not offered here").
  await assert.rejects(
    () => call(routes, { path: "/api/tunnel/invitations", userId: PM, instanceOwner: false }),
    (error: { code?: string }) => error.code === "forbidden",
  );
  store.close();
});

test("DELETE works only for the issuer and gives one answer for everything else", async () => {
  const { store, calls, routes, issued } = setup();
  await issued();
  let strangerError: (Error & { code?: string }) | undefined;
  let unknownError: (Error & { code?: string }) | undefined;
  await assert.rejects(
    () => call(routes, { path: "/api/tunnel/invitations/pair-1", method: "DELETE", userId: PM, instanceOwner: false }),
    (error: Error & { code?: string }) => { strangerError = error; return error.code === "not-found"; },
  );
  await assert.rejects(
    () => call(routes, { path: "/api/tunnel/invitations/pair-9", method: "DELETE", userId: OWNER, instanceOwner: true }),
    (error: Error & { code?: string }) => { unknownError = error; return error.code === "not-found"; },
  );
  assert.equal(strangerError!.message, unknownError!.message, "existence never leaks through wording");

  const cancelled = await call(routes, { path: "/api/tunnel/invitations/pair-1", method: "DELETE", userId: OWNER, instanceOwner: true });
  assert.deepEqual(cancelled.body, { ok: true });
  assert.equal(store.invitation("pair-1")!.state, "cancelled");
  assert.ok(calls.some((entry) => entry.method === "pairing.cancel" && entry.params.id === "pair-1"));
  await assert.rejects(
    () => call(routes, { path: "/api/tunnel/invitations/pair-1", method: "DELETE", userId: OWNER, instanceOwner: true }),
    (error: Error & { code?: string }) => error.code === "not-found",
    "a second delete is not a success",
  );
  const audit = store["db"].prepare("SELECT metadata_json FROM tunnel_audit WHERE event_type = 'invitation-cancelled'").all();
  assert.equal(audit.length, 1);
  store.close();
});

test("committing a live invitation creates the invitee's device, marks it used and tells the issuer", async () => {
  const { store, events, host, issued, calls, routes } = setup();
  await issued({ profile: "interact", name: "Pat Morgan", locale: "uk" });
  const seen: Array<{ type: string; data: Record<string, unknown> }> = [];
  events.subscribe((event) => seen.push({ type: event.type, data: event.data as Record<string, unknown> }));
  const notices: Array<{ account: unknown; notice: Record<string, unknown> }> = [];
  const notify = (account: unknown, notice: Record<string, unknown>) => { notices.push({ account, notice }); };

  await commitPairingDevice({ pairingId: "pair-1", endpointId: endpoint, label: "PM phone", platform: "android", grants: grantsForProfile("interact") }, {
    store, host: host as never, events, notify,
  });
  const device = store.deviceByPairing("pair-1")!;
  assert.equal(device.ownerUserId, PM);
  assert.equal(device.issuedBy, OWNER);
  assert.deepEqual(device.grants, grantsForProfile("interact"));
  assert.equal(device.pairingState, "active");
  assert.equal(store.invitation("pair-1")!.state, "used");
  assert.equal(store.invitation("pair-1")!.deviceId, device.id);
  assert.equal(store.pairingOwner("pair-1"), undefined, "the pairing owner row is released");

  const used = seen.find((event) => event.type === "tunnel/invitation-used")!;
  assert.equal(used.data.id, "pair-1");
  assert.equal(used.data.forUserId, PM);
  assert.equal(used.data.deviceId, device.id);
  assert.equal(used.data.label, device.label);
  assert.equal(used.data.platform, "android");
  assert.equal(events.visibleTo(events.snapshot(0).events.find((event) => event.type === "tunnel/invitation-used")!, OWNER), true);
  assert.equal(events.visibleTo(events.snapshot(0).events.find((event) => event.type === "tunnel/invitation-used")!, PM), false);

  const audit = store["db"].prepare("SELECT metadata_json FROM tunnel_audit WHERE event_type = 'invitation-used'").all() as Array<{ metadata_json: string }>;
  assert.deepEqual(JSON.parse(audit[0]!.metadata_json), { pairingId: "pair-1", forUserId: PM, deviceId: device.id });

  // The issuer hears it in the Space they invited from, and the notice opens
  // the person in Settings → Users; it never carries the link.
  assert.deepEqual(notices, [{
    account: { userId: OWNER, spaceId: SPACE_ID },
    notice: {
      key: "tunnel-invitation-used:pair-1",
      title: "Pat Morgan тепер у Polyth",
      body: "Запрошення прийнято в застосунку Polyth на пристрої PM phone",
      author: { userId: PM, name: "Pat Morgan" },
      settings: { pageId: "users", itemId: PM },
    },
  }]);
  assert.ok(!JSON.stringify(notices).includes("polyth.app/join"));
  const listed = await call(routes, { path: "/api/tunnel/invitations", userId: OWNER, instanceOwner: true });
  assert.deepEqual(listed.body.invitations, [], "a used link is no longer live");
  assert.deepEqual(listed.body.joined, [{ forUserId: PM, at: store.invitation("pair-1")!.finishedAt }]);

  // A second commit of the same invitation must not add or revive anything.
  calls.length = 0;
  await commitPairingDevice({ pairingId: "pair-1", endpointId: endpoint, label: "PM phone", grants: grantsForProfile("interact") }, {
    store, host: host as never, events, notify,
  });
  assert.equal(notices.length, 1, "nobody is told twice");
  assert.equal(store.list(PM).length, 1);
  assert.ok(calls.some((entry) => entry.method === "pairing.storage_failed"), "the late commit is refused like a storage failure");
  store.close();
});

test("committing a cancelled or expired invitation stores nothing and fails it", async () => {
  for (const how of ["cancelled", "expired"] as const) {
    const { store, events, host, routes, issued, calls } = setup();
    await issued();
    if (how === "cancelled") {
      await call(routes, { path: "/api/tunnel/invitations/pair-1", method: "DELETE", userId: OWNER, instanceOwner: true });
    } else {
      store["db"].prepare("UPDATE tunnel_invitation SET expires_at = ? WHERE pairing_id = 'pair-1'").run(Date.now() - 1000);
    }
    await commitPairingDevice({ pairingId: "pair-1", endpointId: endpoint, label: "PM phone", grants: [] }, {
      store, host: host as never, events,
    });
    assert.equal(store.deviceByPairing("pair-1"), undefined, `${how}: no device`);
    assert.deepEqual(store.list(PM), [], `${how}: nothing for the invitee`);
    assert.ok(calls.some((entry) => entry.method === "pairing.storage_failed"), `${how}: the host is told`);
    if (how === "expired") assert.equal(store.invitation("pair-1")!.state, "expired", "the row is swept");
    store.close();
  }
});

test("a live pairing that is not an invitation behaves exactly as before", async () => {
  const { store, events, host, routes, calls } = setup();
  const paired = await call(routes, {
    path: "/api/tunnel/pairing", method: "POST", userId: PM, instanceOwner: false, body: { profile: "interact" },
  });
  assert.equal(paired.code, 200);
  await commitPairingDevice({ pairingId: "pair-1", endpointId: endpoint, label: "PM phone", grants: grantsForProfile("interact") }, {
    store, host: host as never, events,
  });
  assert.equal(store.invitation("pair-1"), undefined);
  assert.equal(store.deviceByPairing("pair-1")!.ownerUserId, PM);
  assert.ok(!calls.some((entry) => entry.method === "pairing.storage_failed"));
  store.close();
});

test("restore hands live invitations back and marks the ones the host rejects", async () => {
  const restoreCalls: Array<Record<string, unknown>> = [];
  const { store, host } = setup({
    restore: (params) => {
      restoreCalls.push(params);
      return { restored: ["pair-1"], rejected: [{ index: 1, code: "pairing-expired" }, { index: 2, code: "pairing-unknown" }] };
    },
  });
  const now = Date.now();
  const seed = (id: string, expiresAt = now + 3_600_000) => {
    store.claimPairing(id, OWNER, PM);
    store.createInvitation({ pairingId: id, issuedBy: OWNER, forUserId: PM, profile: "observe", ticket: `t-${id}`, shareUrl: `https://polyth.app/join#${id}`, label: "Team phone", expiresAt });
  };
  seed("pair-1");
  seed("pair-2");
  const expired = store.createInvitation({ pairingId: "pair-3", issuedBy: OWNER, forUserId: PM, profile: "observe", ticket: "t-3", shareUrl: "https://polyth.app/join#3", expiresAt: now + 3_600_000 });
  assert.equal(expired.state, "pending");
  seed("pair-4", now - 1000);

  await restoreInvitations(store, host as never);
  assert.equal(restoreCalls.length, 1);
  const sent = restoreCalls[0]!.invitations as Array<{ ticket: string; grants: string[]; label?: string }>;
  assert.deepEqual(sent.map((item) => item.ticket), ["t-pair-1", "t-pair-2", "t-3"], "only live invitations, never the swept one");
  assert.deepEqual(sent[0]!.grants, grantsForProfile("observe"));
  assert.equal(sent[0]!.label, "Team phone");
  assert.equal(store.invitation("pair-1")!.state, "pending", "a restored invitation keeps working");
  assert.equal(store.invitation("pair-2")!.state, "expired");
  assert.equal(store.pairingOwner("pair-2"), undefined, "a dead invitation releases its pairing");
  assert.equal(store.invitation("pair-3")!.state, "cancelled");
  assert.equal(store.invitation("pair-4")!.state, "expired", "the sweep closed the past-expiry row before restore");
  store.close();
});

test("an old host without pairing.restore does not break the trust sync", async () => {
  const store = createTunnelStore(join(tempDir(join(tmpdir(), "polyth-tunnel-invitations-")), "tunnel.db"));
  store.claimPairing("pair-1", OWNER, PM);
  store.createInvitation({ pairingId: "pair-1", issuedBy: OWNER, forUserId: PM, profile: "observe", ticket: "t-1", shareUrl: SHARE_URL, expiresAt: Date.now() + 3_600_000 });
  const host = {
    available: true,
    request: async (method: string) => {
      if (method === "pairing.restore") throw Object.assign(new Error("unknown method"), { code: "unknown-method" });
      return { ok: true };
    },
  };
  await syncInvitations(store, host as never); // resolves: the sync continues
  assert.equal(store.invitation("pair-1")!.state, "pending", "the local row is untouched");
  store.close();
});

test("rotating the server identity cancels every live invitation", async () => {
  const { store, calls, issued, routes } = setup();
  await issued({ forUserId: PM });
  await issued({ forUserId: OTHER });
  const rotated = await call(routes, { path: "/api/tunnel/identity/rotate", method: "POST", userId: OWNER, instanceOwner: true });
  assert.equal(rotated.code, 200);
  assert.equal(store.invitation("pair-1")!.state, "cancelled");
  assert.equal(store.invitation("pair-2")!.state, "cancelled");
  assert.ok(!calls.some((entry) => entry.method === "pairing.cancel"), "the host forgot them; nothing to cancel there");
  const listed = await call(routes, { path: "/api/tunnel/invitations", userId: OWNER, instanceOwner: true });
  assert.deepEqual(listed.body.invitations, []);
  store.close();
});

test("recovering incomplete pairings never releases a live invitation's owner row", async () => {
  const { store, issued } = setup();
  await issued();
  store.recoverIncompletePairings();
  assert.equal(store.invitation("pair-1")!.state, "pending");
  assert.equal(store.pairingOwner("pair-1"), OWNER, "the invitation still needs its pairing owner");
  store.sweepInvitations(Date.now() + 604_800_001);
  assert.equal(store.invitation("pair-1")!.state, "expired");
  assert.equal(store.pairingOwner("pair-1"), undefined);
  store.close();
});
