import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createTunnelStore } from "../src/index.ts";

const store = () => createTunnelStore(join(mkdtempSync(join(tmpdir(), "polyth-tunnel-account-")), "tunnel.db"));

test("pending pairings are account-owned and can be invalidated as a group", () => {
  const db = store();
  try {
    db.claimPairing("pair-alice-1", "usr_alice");
    db.claimPairing("pair-alice-2", "usr_alice");
    db.claimPairing("pair-bob", "usr_bob");

    assert.deepEqual(db.releasePairingsForUser("usr_alice").sort(), ["pair-alice-1", "pair-alice-2"]);
    assert.equal(db.pairingOwner("pair-alice-1"), undefined);
    assert.equal(db.pairingOwner("pair-alice-2"), undefined);
    assert.equal(db.pairingOwner("pair-bob"), "usr_bob");
  } finally {
    db.close();
  }
});

test("paired devices list only under their owning account", () => {
  const db = store();
  try {
    const alice = db.commitDevice({
      endpointId: "endpoint-alice",
      ownerUserId: "usr_alice",
      label: "Alice phone",
      grants: [],
      pairedVia: "test",
    });
    const bob = db.commitDevice({
      endpointId: "endpoint-bob",
      ownerUserId: "usr_bob",
      label: "Bob phone",
      grants: [],
      pairedVia: "test",
    });

    assert.deepEqual(db.list("usr_alice").map((device) => device.id), [alice.id]);
    assert.deepEqual(db.list("usr_bob").map((device) => device.id), [bob.id]);
    assert.equal(db.deviceForUser(bob.id, "usr_alice"), undefined);
    assert.equal(db.deviceForUser(alice.id, "usr_bob"), undefined);
  } finally {
    db.close();
  }
});
