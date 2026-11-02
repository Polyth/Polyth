import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthPrincipal } from "@polyth/contracts";
import { createTunnelStore, grantsForProfile } from "../src/index.ts";
import { TunnelEventBus } from "../src/events.ts";
import { deviceBaseLabel, distinctDeviceLabels, uniqueDeviceLabel } from "../src/deviceLabel.ts";
import { commitPairingDevice, revokeAccountDevices } from "../src/serverEntry.ts";
import type { LinkHostClient } from "../src/host.ts";

const db = () => join(mkdtempSync(join(tmpdir(), "polyth-tunnel-identity-")), "tunnel.db");

function fakeHost(): { host: LinkHostClient; calls: Array<[string, Record<string, unknown> | undefined]> } {
  const calls: Array<[string, Record<string, unknown> | undefined]> = [];
  return {
    calls,
    host: {
      available: true,
      binaryFound: true,
      processReady: true,
      platformSupported: true,
      onEvent: () => () => {},
      close: async () => {},
      request: async (method, params) => {
        calls.push([method, params]);
        return { ok: true };
      },
    },
  };
}

async function pair(
  store: ReturnType<typeof createTunnelStore>,
  host: LinkHostClient,
  events: TunnelEventBus,
  input: { pairingId: string; endpointId: string; owner: string; label: string; platform?: string },
) {
  store.claimPairing(input.pairingId, input.owner);
  await commitPairingDevice({
    pairingId: input.pairingId,
    endpointId: input.endpointId,
    label: input.label,
    ...(input.platform ? { platform: input.platform } : {}),
    grants: grantsForProfile("interact"),
  }, { store, host, events });
  return store.deviceByPairing(input.pairingId)!;
}

test("placeholder names become the platform and same names get a number", () => {
  assert.equal(deviceBaseLabel("This phone", "ios"), "iPhone");
  assert.equal(deviceBaseLabel("Mobile device", "android"), "Android");
  assert.equal(deviceBaseLabel("This phone", null), "This phone");
  assert.equal(deviceBaseLabel(" Galaxy S23 ", "android"), "Galaxy S23");
  assert.equal(uniqueDeviceLabel("iPhone", []), "iPhone");
  assert.equal(uniqueDeviceLabel("iPhone", ["iphone"]), "iPhone 2");
  assert.equal(uniqueDeviceLabel("iPhone", ["iPhone", "iPhone 2"]), "iPhone 3");
  assert.equal(uniqueDeviceLabel("x".repeat(80), ["x".repeat(80)]).length, 80);

  const shown = distinctDeviceLabels([
    { id: "c", label: "iPhone 2", platform: "ios", createdAt: 3 },
    { id: "b", label: "This phone", platform: "ios", createdAt: 2 },
    { id: "a", label: "This phone", platform: "ios", createdAt: 1 },
    { id: "d", label: "This phone", platform: "android", createdAt: 4 },
  ]);
  assert.deepEqual(Object.fromEntries(shown), { a: "iPhone", b: "iPhone 3", c: "iPhone 2", d: "Android" });
});

test("a new pairing never takes a name another device of the account already has", async () => {
  const store = createTunnelStore(db());
  const events = new TunnelEventBus();
  const { host } = fakeHost();
  const first = await pair(store, host, events, { pairingId: "p1", endpointId: "a1".repeat(32), owner: "usr_alice", label: "This phone", platform: "ios" });
  const second = await pair(store, host, events, { pairingId: "p2", endpointId: "a2".repeat(32), owner: "usr_alice", label: "iPhone", platform: "ios" });
  const other = await pair(store, host, events, { pairingId: "p3", endpointId: "a3".repeat(32), owner: "usr_bob", label: "iPhone", platform: "ios" });
  assert.equal(first.label, "iPhone");
  assert.equal(second.label, "iPhone 2");
  // Names are per account: Bob's list has only his own phone.
  assert.equal(other.label, "iPhone");
  store.close();
});

test("a revoked phone pairing under another account becomes that account's new device", async () => {
  const store = createTunnelStore(db());
  const events = new TunnelEventBus();
  const { host } = fakeHost();
  const endpointId = "b1".repeat(32);
  const alice = await pair(store, host, events, { pairingId: "pa", endpointId, owner: "usr_alice", label: "Pixel 8", platform: "android" });
  store.revoke(alice.id);

  const bob = await pair(store, host, events, { pairingId: "pb", endpointId, owner: "usr_bob", label: "Pixel 8", platform: "android" });
  assert.notEqual(bob.id, alice.id);
  assert.equal(bob.ownerUserId, "usr_bob");
  assert.equal(bob.pairingState, "active");
  assert.equal(bob.revokedAt, null);
  assert.ok(bob.grantRevision > alice.grantRevision, "the host's grant revision keeps moving forward");
  assert.equal(store.device(alice.id), undefined);
  assert.deepEqual(store.list("usr_alice"), []);
  assert.deepEqual(store.list("usr_bob").map((device) => device.id), [bob.id]);

  // The same account pairing its revoked phone again keeps the device.
  store.revoke(bob.id);
  const again = await pair(store, host, events, { pairingId: "pb2", endpointId, owner: "usr_bob", label: "Pixel 8", platform: "android" });
  assert.equal(again.id, bob.id);
  assert.equal(again.revokedAt, null);
  store.close();
});

test("an active phone of another account is still not taken over", async () => {
  const store = createTunnelStore(db());
  const events = new TunnelEventBus();
  const { host } = fakeHost();
  const endpointId = "c1".repeat(32);
  await pair(store, host, events, { pairingId: "pa", endpointId, owner: "usr_alice", label: "Phone" });
  await assert.rejects(
    pair(store, host, events, { pairingId: "pb", endpointId, owner: "usr_bob", label: "Phone" }),
    (error: { code?: string }) => error.code === "not-found",
  );
  assert.equal(store.deviceByEndpoint(endpointId)?.ownerUserId, "usr_alice");
  store.close();
});

test("removing an account revokes and disconnects only its phones", async () => {
  const store = createTunnelStore(db());
  const events = new TunnelEventBus();
  const { host, calls } = fakeHost();
  const alice = await pair(store, host, events, { pairingId: "pa", endpointId: "d1".repeat(32), owner: "usr_alice", label: "Phone" });
  const bob = await pair(store, host, events, { pairingId: "pb", endpointId: "d2".repeat(32), owner: "usr_bob", label: "Phone" });
  const connections = new Map<string, AuthPrincipal>([
    ["conn-alice", { kind: "paired-device", deviceId: alice.id } as AuthPrincipal],
    ["conn-bob", { kind: "paired-device", deviceId: bob.id } as AuthPrincipal],
  ]);
  const closed: string[] = [];
  calls.length = 0;

  const revoked = await revokeAccountDevices("usr_alice", {
    store,
    connections,
    closeDeviceSockets: (deviceId) => closed.push(deviceId),
    host,
    events,
  });

  assert.deepEqual(revoked, [alice.id]);
  assert.ok(store.device(alice.id)?.revokedAt);
  assert.equal(store.device(bob.id)?.revokedAt, null);
  assert.deepEqual([...connections.keys()], ["conn-bob"]);
  assert.deepEqual(closed, [alice.id]);
  assert.deepEqual(calls, [["trust.revoke", { deviceId: alice.id, endpointId: alice.endpointId }]]);
  assert.equal(events.snapshot(0, "usr_alice").events.filter((event) => event.type === "tunnel/device-revoked").length, 1);
  assert.equal(events.snapshot(0, "usr_bob").events.filter((event) => event.type === "tunnel/device-revoked").length, 0);

  // Without a running host the revoke is durable; the next trust sync sends it.
  const offline = await revokeAccountDevices("usr_bob", {
    store,
    connections,
    closeDeviceSockets: () => {},
    host: null,
    events,
  });
  assert.deepEqual(offline, [bob.id]);
  assert.ok(store.device(bob.id)?.revokedAt);
  store.close();
});
