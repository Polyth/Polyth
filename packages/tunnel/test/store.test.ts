import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GRANT_PROFILE_PRESETS, REMOTE_CAPABILITY } from "@polyth/contracts";
import { createTunnelStore, fingerprintEndpoint, grantsForProfile } from "../src/index.ts";

const db = () => join(mkdtempSync(join(tmpdir(), "polyth-tunnel-")), "tunnel.db");

test("commitDevice is atomic, unique on endpoint, and revoke does not resurrect on reconnect metadata", () => {
  const store = createTunnelStore(db());
  const first = store.commitDevice({
    endpointId: "aa".repeat(32),
    label: "Phone",
    grants: grantsForProfile("interact"),
    pairedVia: "polyth-link",
  });
  assert.equal(first.ownerUserId, "usr_owner");
  assert.equal(first.grants.length, GRANT_PROFILE_PRESETS.interact.length + 1);
  assert.equal(first.grants.includes(REMOTE_CAPABILITY.dictationUse), true);
  assert.equal(fingerprintEndpoint(first.endpointId).includes("…"), true);
  const again = store.commitDevice({
    endpointId: first.endpointId,
    label: "Phone 2",
    grants: grantsForProfile("observe"),
    pairedVia: "polyth-link",
  });
  assert.equal(again.id, first.id);
  assert.equal(again.grantRevision, first.grantRevision);
  const revoked = store.revoke(first.id)!;
  assert.ok(revoked.revokedAt);
  assert.equal(store.forget(first.id), true);
  assert.equal(store.device(first.id), undefined);
  store.close();
});

test("pairing ownership survives restart and cannot be claimed by another account", () => {
  const path = db();
  let store = createTunnelStore(path);
  store.claimPairing("pair-alice", "usr_alice");
  assert.equal(store.pairingOwner("pair-alice"), "usr_alice");
  const pending = store.prepareDevice({
    pairingId: "pair-alice",
    endpointId: "fa".repeat(32),
    label: "Alice phone",
    grants: grantsForProfile("interact"),
    pairedVia: "polyth-link",
  });
  assert.equal(pending.ownerUserId, "usr_alice");
  assert.throws(
    () => store.claimPairing("pair-alice", "usr_bob"),
    (error: { code?: string }) => error.code === "not-found",
  );
  store.close();

  store = createTunnelStore(path);
  assert.equal(store.pairingOwner("pair-alice"), "usr_alice");
  store.markHostAcknowledged("pair-alice");
  const active = store.activatePairing("pair-alice");
  assert.equal(active.ownerUserId, "usr_alice");
  assert.equal(store.pairingOwner("pair-alice"), undefined);
  assert.equal(store.deviceForUser(active.id, "usr_alice")?.id, active.id);
  assert.equal(store.deviceForUser(active.id, "usr_bob"), undefined);
  assert.deepEqual(store.list("usr_bob"), []);
  assert.deepEqual(store.list("usr_alice").map((device) => device.id), [active.id]);

  store.claimPairing("pair-bob", "usr_bob");
  assert.throws(
    () => store.prepareDevice({
      pairingId: "pair-bob",
      endpointId: active.endpointId,
      label: "Takeover",
      grants: grantsForProfile("interact"),
      pairedVia: "polyth-link",
    }),
    (error: { code?: string }) => error.code === "not-found",
  );
  store.releasePairingOwner("pair-bob");
  store.close();
});

test("full-remote preset never includes privileged administration", () => {
  const grants = grantsForProfile("full-remote");
  assert.equal(grants.includes("tunnel.pairing.manage"), false);
  assert.equal(grants.includes("server.identity.rotate"), false);
  assert.equal(grants.includes("auth.password.manage"), false);
});

test("forget requires revoke, restore is explicit, and revokeAll marks every live device", () => {
  const store = createTunnelStore(db());
  const device = store.commitDevice({
    endpointId: "bb".repeat(32),
    label: "Phone",
    grants: grantsForProfile("interact"),
    pairedVia: "polyth-link",
  });
  assert.equal(store.forget(device.id), false);
  const revoked = store.revoke(device.id)!;
  assert.ok(revoked.revokedAt);
  const restored = store.restore(device.id)!;
  assert.equal(restored.revokedAt, null);
  assert.ok(restored.grantRevision > revoked.grantRevision);
  assert.deepEqual(store.revokeAll(), [device.id]);
  assert.ok(store.device(device.id)?.revokedAt);
  store.close();
});

test("pairing phases recover fail-closed and only active records enter trust sync", () => {
  const pendingDb = db();
  let store = createTunnelStore(pendingDb);
  const pending = store.prepareDevice({
    pairingId: "pair-pending",
    endpointId: "cc".repeat(32),
    label: "Pending",
    grants: grantsForProfile("observe"),
    pairedVia: "polyth-link",
  });
  assert.equal(pending.pairingState, "pending");
  assert.deepEqual(store.list(), []);
  assert.deepEqual(store.trustList(), []);
  store.close();
  store = createTunnelStore(pendingDb);
  assert.equal(store.recoverIncompletePairings()[0]?.pairingState, "failed");
  assert.ok(store.deviceByPairing("pair-pending")?.revokedAt);
  assert.equal(store.restore(pending.id), undefined);
  assert.deepEqual(store.trustList(), []);
  store.close();

  const acknowledgedDb = db();
  store = createTunnelStore(acknowledgedDb);
  store.prepareDevice({
    pairingId: "pair-acked",
    endpointId: "dd".repeat(32),
    label: "Acked",
    grants: grantsForProfile("observe"),
    pairedVia: "polyth-link",
  });
  assert.equal(store.markHostAcknowledged("pair-acked").pairingState, "host-acknowledged");
  store.close();
  store = createTunnelStore(acknowledgedDb);
  assert.deepEqual(store.recoverIncompletePairings(), []);
  assert.equal(store.deviceByPairing("pair-acked")?.pairingState, "active");
  assert.equal(store.trustList().length, 1);
  store.close();

  const activeDb = db();
  store = createTunnelStore(activeDb);
  store.prepareDevice({
    pairingId: "pair-active",
    endpointId: "ee".repeat(32),
    label: "Active",
    grants: grantsForProfile("observe"),
    pairedVia: "polyth-link",
  });
  store.markHostAcknowledged("pair-active");
  store.activatePairing("pair-active");
  store.close();
  store = createTunnelStore(activeDb);
  assert.deepEqual(store.recoverIncompletePairings(), []);
  assert.equal(store.trustList()[0]?.pairingState, "active");
  store.close();
});
