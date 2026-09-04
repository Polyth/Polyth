import test from "node:test";
import assert from "node:assert/strict";
import type { TunnelStatusDto } from "@polyth/contracts";
import {
  applyTunnelStatusToCapability,
  polythLinkCapabilityAvailable,
  setPolythLinkCapabilityAvailable,
} from "../widgets/availability.ts";

const base = (): TunnelStatusDto => ({
  enabled: false,
  available: false,
  pairingAvailable: false,
  hostBinaryFound: false,
  hostProcessReady: false,
  endpointBound: false,
  ingressReady: false,
  activePolicy: null,
  mode: "direct-preferred",
  hostFingerprint: null,
  fingerprint: null,
  relayConfigured: false,
  identityAvailable: false,
  activeConnections: 0,
  activeDevices: 0,
  directConnections: 0,
  relayConnections: 0,
});

test("capability availability changes when the host becomes ready", () => {
  setPolythLinkCapabilityAvailable(false);
  assert.equal(polythLinkCapabilityAvailable(), false);
  applyTunnelStatusToCapability({ ...base(), pairingAvailable: true, available: true, enabled: true });
  assert.equal(polythLinkCapabilityAvailable(), true);
  applyTunnelStatusToCapability(base());
  assert.equal(polythLinkCapabilityAvailable(), false);
});
