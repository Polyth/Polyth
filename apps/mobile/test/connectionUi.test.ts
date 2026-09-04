import test from "node:test";
import assert from "node:assert/strict";
import { nativeLinkAvailable, polythLink, setPolythLinkNative } from "../src/polythLink.ts";
import { bootstrapUrlWithNext, connectionUiState } from "../src/connectionUi.ts";
import {
  clearPendingPairingLink,
  peekPendingPairingLink,
  rememberPendingPairingLink,
} from "../src/pendingPair.ts";

test("missing native adapter does not expose a broken primary pairing flow", () => {
  const ui = connectionUiState({ nativeAvailable: false, pendingPair: "polyth://pair?v=1&t=abc" });
  assert.equal(ui.showSecurePairing, false);
  assert.equal(ui.showUnavailableBanner, true);
  assert.equal(ui.autoStartPairing, false);
  assert.equal(ui.preservePendingPair, true);
  assert.equal(ui.legacyIsSecure, false);
  assert.equal(nativeLinkAvailable(), false);
  assert.equal(polythLink().constructor.name, "MissingNativeCore");
});

test("a pending pairing deep link is not lost when native is unavailable", () => {
  clearPendingPairingLink();
  const saved = rememberPendingPairingLink("polyth://pair?v=1&t=abc");
  assert.equal(saved, "polyth://pair?v=1&t=abc");
  assert.equal(peekPendingPairingLink(), "polyth://pair?v=1&t=abc");
  const ui = connectionUiState({ nativeAvailable: false, pendingPair: peekPendingPairingLink() });
  assert.equal(ui.preservePendingPair, true);
  assert.equal(ui.autoStartPairing, false);
  clearPendingPairingLink();
});

test("native adapter enables secure pairing without calling legacy connections secure", () => {
  const ui = connectionUiState({ nativeAvailable: true, pendingPair: "polyth://pair?v=1&t=abc" });
  assert.equal(ui.showSecurePairing, true);
  assert.equal(ui.autoStartPairing, true);
  assert.equal(ui.legacyIsSecure, false);
});

test("setPolythLinkNative flips nativeLinkAvailable", async () => {
  const previous = polythLink();
  setPolythLinkNative({
    parsePairingTicket: async () => ({ hostLabel: "x", hostFingerprint: "abcd", expiresAt: "1" }),
    beginPairing: async () => ({ attemptId: "a", state: "created" }),
    confirmPairing: async () => ({ origin: "http://127.0.0.1:9", bootstrapUrl: "http://127.0.0.1:9/__polyth_boot/abc", connectionId: "c1" }),
    cancelPairing: async () => {},
    listConnections: async () => [],
    connect: async () => ({ origin: "http://127.0.0.1:9", bootstrapUrl: "http://127.0.0.1:9/__polyth_boot/abc", connectionId: "c1" }),
    disconnect: async () => {},
    forgetConnection: async () => {},
    getStatus: async () => ({ state: "connected" }),
  });
  assert.equal(nativeLinkAvailable(), true);
  setPolythLinkNative(previous);
  assert.equal(nativeLinkAvailable(), false);
});

test("ProxyLaunch keeps origin and bootstrapUrl separate", () => {
  const launched = {
    origin: "http://127.0.0.1:9",
    bootstrapUrl: "http://127.0.0.1:9/__polyth_boot/abc",
    connectionId: "c1",
  };
  assert.equal(launched.origin.endsWith("/"), false);
  assert.equal(launched.bootstrapUrl.includes("/__polyth_boot/"), true);
  assert.equal(new URL(launched.bootstrapUrl).origin, launched.origin);
  assert.notEqual(`${launched.bootstrapUrl}/`, launched.bootstrapUrl);
});

test("bootstrap next uses one form-encoding layer for canonical paths and queries", () => {
  const bootstrap = "http://127.0.0.1:9/__polyth_boot/abc";
  for (const next of ["/sessions/x", "/projects/x", "/sessions/x?tab=files&line=2"]) {
    const url = new URL(bootstrapUrlWithNext(bootstrap, next));
    assert.equal(url.searchParams.get("next"), next);
    assert.match(url.search, /^\?next=%2F/);
  }
});

test("pending pairing tickets stay in process memory", () => {
  clearPendingPairingLink();
  rememberPendingPairingLink("polyth://pair?v=1&t=abc");
  assert.equal(peekPendingPairingLink(), "polyth://pair?v=1&t=abc");
  clearPendingPairingLink();
  assert.equal(peekPendingPairingLink(), undefined);
});
