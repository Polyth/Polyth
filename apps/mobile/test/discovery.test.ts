import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeDiscoveredPolyth,
  normalizeDiscoveryUpdate,
} from "../src/discovery.ts";

const endpoint = "a".repeat(64);

function result(overrides: Record<string, unknown> = {}) {
  return {
    id: endpoint,
    serviceName: "Desk",
    hostLabel: "Desk",
    hostEndpointId: endpoint,
    protocolVersion: 1,
    port: 4433,
    addresses: ["192.168.1.10", "fe80::1"],
    numericPairing: true,
    ...overrides,
  };
}

test("normalizes bounded discovery metadata without creating trust material", () => {
  assert.deepEqual(normalizeDiscoveredPolyth(result()), result());
});

test("accepts a standards-compliant browse result when platform resolution does not expose SRV port", () => {
  const normalized = normalizeDiscoveredPolyth(result({ port: undefined }));
  assert.equal(normalized?.port, null);
  assert.equal(normalized?.hostEndpointId, endpoint);
});

test("splits iroh DNS-SD comma-separated address TXT candidates before transport parsing", () => {
  assert.deepEqual(
    normalizeDiscoveredPolyth(result({
      addresses: ["192.168.1.10:4433,10.0.0.8:4433", "[fd00::1]:4433,[fd00::2]:4433"],
    }))?.addresses,
    ["192.168.1.10:4433", "10.0.0.8:4433", "[fd00::1]:4433", "[fd00::2]:4433"],
  );
});

test("rejects malformed endpoint, protocol and explicit port", () => {
  assert.equal(normalizeDiscoveredPolyth(result({ hostEndpointId: "<script>" })), undefined);
  assert.equal(normalizeDiscoveredPolyth(result({ protocolVersion: 2 })), undefined);
  assert.equal(normalizeDiscoveredPolyth(result({ port: 0 })), undefined);
  assert.equal(normalizeDiscoveredPolyth(result({ port: 65536 })), undefined);
});

test("rejects control characters and strips hostile addresses", () => {
  assert.equal(normalizeDiscoveredPolyth(result({ hostLabel: "Desk\nInjected" })), undefined);
  assert.deepEqual(
    normalizeDiscoveredPolyth(result({ addresses: ["192.168.1.10", "http://evil/", "a b", "192.168.1.10"] }))?.addresses,
    ["192.168.1.10"],
  );
});

test("deduplicates discovery updates by stable host endpoint identity", () => {
  const update = normalizeDiscoveryUpdate({
    state: "results",
    results: [
      result({ serviceName: "Desk on Wi-Fi" }),
      result({ serviceName: "Desk duplicate", hostLabel: "Desk updated" }),
      result({ hostEndpointId: "b".repeat(64), id: "b".repeat(64), hostLabel: "Backup" }),
    ],
  });
  assert.equal(update.state, "results");
  assert.equal(update.results.length, 2);
  assert.deepEqual(update.results.map((item) => item.hostLabel), ["Backup", "Desk updated"]);
});
