import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REMOTE_CAPABILITY } from "@polyth/contracts";
import { createTunnelStore } from "../src/index.ts";
import { TunnelEventBus } from "../src/events.ts";
import { commitPairingDevice } from "../src/serverEntry.ts";
import type { LinkHostClient } from "../src/host.ts";

const input = (suffix: string) => ({
  pairingId: `pair-${suffix}`,
  endpointId: suffix.repeat(64).slice(0, 64),
  label: "Phone",
  grants: [REMOTE_CAPABILITY.coreSessionsRead],
});

function fakeHost(failOn?: string): { host: LinkHostClient; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    host: {
      available: true,
      binaryFound: true,
      processReady: true,
      platformSupported: true,
      onEvent: () => () => {},
      close: async () => {},
      request: async (method) => {
        calls.push(method);
        if (method === failOn) throw new Error(`failed ${method}`);
        return { ok: true };
      },
    },
  };
}

test("pairing prepare, host acknowledgement, finish, and activation are idempotent", async () => {
  const store = createTunnelStore(join(mkdtempSync(join(tmpdir(), "polyth-pair-")), "tunnel.db"));
  const events = new TunnelEventBus();
  const { host, calls } = fakeHost();
  store.claimPairing("pair-a", "usr_alice");
  await commitPairingDevice(input("a"), { store, host, events });
  await commitPairingDevice(input("a"), { store, host, events });
  assert.deepEqual(calls, ["trust.upsert", "pairing.finish", "trust.upsert", "pairing.finish"]);
  assert.equal(store.deviceByPairing("pair-a")?.pairingState, "active");
  assert.equal(store.deviceByPairing("pair-a")?.ownerUserId, "usr_alice");
  assert.equal(store.pairingOwner("pair-a"), undefined);
  assert.equal(store.trustList("usr_alice").length, 1);
  assert.equal(events.snapshot(0, "usr_alice").events.filter((event) => event.type === "tunnel/device-added").length, 1);
  assert.equal(events.snapshot(0, "usr_bob").events.filter((event) => event.type === "tunnel/device-added").length, 0);
  store.close();
});

for (const failedMethod of ["trust.upsert", "pairing.finish"]) {
  test(`pairing failure at ${failedMethod} leaves no trusted active device`, async () => {
    const store = createTunnelStore(join(mkdtempSync(join(tmpdir(), "polyth-pair-")), "tunnel.db"));
    const { host } = fakeHost(failedMethod);
    await assert.rejects(commitPairingDevice(input(failedMethod[0]!), {
      store,
      host,
      events: new TunnelEventBus(),
    }));
    const device = store.deviceByPairing(`pair-${failedMethod[0]}`)!;
    assert.equal(device.pairingState, "failed");
    assert.ok(device.revokedAt);
    assert.deepEqual(store.trustList(), []);
    store.close();
  });
}
