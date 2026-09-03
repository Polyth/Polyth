import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GRANT_PROFILE_PRESETS } from "@polyth/contracts";
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
  assert.equal(first.grants.length, GRANT_PROFILE_PRESETS.interact.length);
  assert.equal(fingerprintEndpoint(first.endpointId).includes("…"), true);
  const again = store.commitDevice({
    endpointId: first.endpointId,
    label: "Phone 2",
    grants: grantsForProfile("observe"),
    pairedVia: "polyth-link",
  });
  assert.equal(again.id, first.id);
  assert.equal(again.grantRevision, first.grantRevision + 1);
  const revoked = store.revoke(first.id)!;
  assert.ok(revoked.revokedAt);
  assert.equal(store.forget(first.id), true);
  assert.equal(store.device(first.id), undefined);
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
