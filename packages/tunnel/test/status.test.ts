import test from "node:test";
import assert from "node:assert/strict";
import { buildTunnelDiagnostics, buildTunnelStatus, pairingAvailableFrom } from "../src/status.ts";

const ready = {
  platformSupported: true,
  hostBinaryFound: true,
  hostProcessReady: true,
  endpointBound: true,
  ingressReady: true,
  identityAvailable: true,
  hostFingerprint: "abcd…ef01",
  activePolicy: "direct-preferred" as const,
  relayConfigured: false,
  activeConnections: 0,
  activeDevices: 0,
  directConnections: 0,
  relayConnections: 0,
};

test("missing host binary produces an unavailable status and disabled pairing", () => {
  const status = buildTunnelStatus({
    ...ready,
    hostBinaryFound: false,
    hostProcessReady: false,
    endpointBound: false,
    ingressReady: false,
    identityAvailable: false,
    hostFingerprint: null,
    lastErrorCode: "host-binary-missing",
  });
  assert.equal(status.enabled, false);
  assert.equal(status.available, false);
  assert.equal(status.pairingAvailable, false);
  assert.equal(status.hostBinaryFound, false);
  assert.equal(status.lastErrorCode, "host-binary-missing");
  assert.equal(pairingAvailableFrom({
    ...ready,
    hostBinaryFound: false,
    hostProcessReady: false,
    endpointBound: false,
    ingressReady: false,
    identityAvailable: false,
    hostFingerprint: null,
  }), false);
});

test("capability availability changes when the host becomes ready", () => {
  const before = buildTunnelStatus({
    ...ready,
    hostProcessReady: false,
    endpointBound: false,
    identityAvailable: false,
    hostFingerprint: null,
  });
  const after = buildTunnelStatus(ready);
  assert.equal(before.pairingAvailable, false);
  assert.equal(after.pairingAvailable, true);
  assert.equal(after.available, true);
  assert.equal(after.hostProcessReady, true);
  assert.equal(after.endpointBound, true);
  assert.equal(after.ingressReady, true);
  assert.equal(after.activePolicy, "direct-preferred");
});

test("unsupported platforms stay hidden and do not search for a Unix binary", () => {
  const status = buildTunnelStatus({
    ...ready,
    platformSupported: false,
    hostBinaryFound: false,
    hostProcessReady: false,
    endpointBound: false,
    ingressReady: false,
    identityAvailable: false,
    hostFingerprint: null,
    lastErrorCode: "unsupported-platform",
  });
  assert.equal(status.unsupportedPlatform, true);
  assert.equal(status.pairingAvailable, false);
  assert.equal(buildTunnelDiagnostics({
    ...ready,
    platformSupported: false,
    hostBinaryFound: false,
    hostProcessReady: false,
    endpointBound: false,
    ingressReady: false,
    identityAvailable: false,
    hostFingerprint: null,
  }).packageStatus, "unsupported-platform");
});
