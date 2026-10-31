import test from "node:test";
import assert from "node:assert/strict";
import { nativeLinkAvailable, polythLink, setPolythLinkNative } from "../src/polythLink.ts";
import {
  autoReconnectCandidate,
  bootstrapUrlWithNext,
  connectionUiState,
  HUB_LAUNCH_PATIENCE_MS,
  hubPresentation,
  preferredTrustedConnection,
  RESUME_COOLDOWN_MS,
  shouldAutoReconnect,
} from "../src/connectionUi.ts";
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
    recoverConnection: async () => ({ state: "needs-pairing", connectionId: "c1" }),
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


test("preferred trusted connection chooses the newest usable secure server", () => {
  const picked = preferredTrustedConnection([
    {
      id: "old",
      hostEndpointId: "old",
      hostLabel: "Old",
      pairingState: "active",
      lastUsedAt: 10,
      hasSecureIdentity: true,
    },
    {
      id: "revoked",
      hostEndpointId: "revoked",
      hostLabel: "Revoked",
      pairingState: "revoked",
      lastUsedAt: 100,
      hasSecureIdentity: true,
    },
    {
      id: "prepared",
      hostEndpointId: "prepared",
      hostLabel: "Prepared",
      pairingState: "prepared",
      lastUsedAt: 90,
      hasSecureIdentity: true,
    },
    {
      id: "new",
      hostEndpointId: "new",
      hostLabel: "New",
      pairingState: "active",
      lastUsedAt: 50,
      hasSecureIdentity: true,
    },
  ]);
  assert.equal(picked?.id, "new");
});

test("Android and iOS expose native pairing scanners through the PolythLink plugin", async () => {
  const [bridge, android, gradle, manifest, swift] = await Promise.all([
    import("node:fs/promises").then(({ readFile }) => readFile(new URL("../src/nativePolythLink.ts", import.meta.url), "utf8")),
    import("node:fs/promises").then(({ readFile }) => readFile(new URL("../android/app/src/main/java/com/polyth/mobile/PolythLinkPlugin.java", import.meta.url), "utf8")),
    import("node:fs/promises").then(({ readFile }) => readFile(new URL("../android/app/build.gradle", import.meta.url), "utf8")),
    import("node:fs/promises").then(({ readFile }) => readFile(new URL("../android/app/src/main/AndroidManifest.xml", import.meta.url), "utf8")),
    import("node:fs/promises").then(({ readFile }) => readFile(new URL("../ios/App/App/AppDelegate.swift", import.meta.url), "utf8")),
  ]);

  assert.match(bridge, /nativePairingScannerAvailable[\s\S]*isNativePlatform\(\)[\s\S]*isPluginAvailable\("PolythLink"\)/);
  assert.doesNotMatch(bridge, /getPlatform\(\) === "ios"/);
  assert.match(android, /public void scanPairingQr\(PluginCall call\)/);
  assert.match(android, /GmsBarcodeScanning\.getClient/);
  assert.match(android, /Barcode\.FORMAT_QR_CODE/);
  assert.match(gradle, /play-services-code-scanner:16\.1\.0/);
  assert.match(manifest, /com\.google\.mlkit\.vision\.DEPENDENCIES[\s\S]*barcode_ui/);
  assert.match(swift, /func scanPairingQr\(_ call: CAPPluginCall\)/);
});


test("automatic trusted reconnect yields to explicit connection intents", () => {
  assert.equal(shouldAutoReconnect({}), true);
  assert.equal(shouldAutoReconnect({ selectServer: true }), false);
  assert.equal(shouldAutoReconnect({ pendingPair: "polyth://pair?v=1&t=x" }), false);
  assert.equal(shouldAutoReconnect({ hasPendingPush: true }), false);
  assert.equal(shouldAutoReconnect({ deepLinkPath: "/?session=s1" }), false);
});

test("a resume bounce re-opens its own server despite the carried path, but never loops", () => {
  const now = 1_000_000;
  assert.equal(shouldAutoReconnect({ deepLinkPath: "/p/x/s/y", resume: true, now }), true);
  assert.equal(shouldAutoReconnect({ deepLinkPath: "/p/x/s/y", resume: true, lastResumeAt: now - 5_000, now }), false);
  assert.equal(shouldAutoReconnect({ resume: true, lastResumeAt: now - RESUME_COOLDOWN_MS, now }), true);
  assert.equal(shouldAutoReconnect({ resume: true, selectServer: true, now }), false);
  assert.equal(shouldAutoReconnect({ resume: true, hasPendingPush: true, now }), false);
});

test("a resume prefers the server still connected natively over the newest one", () => {
  const server = (id: string, lastUsedAt: number) => ({
    id,
    hostEndpointId: id,
    hostLabel: id,
    pairingState: "active" as const,
    lastUsedAt,
    hasSecureIdentity: true,
  });
  const trusted = [server("older", 10), server("newest", 20)];
  assert.equal(autoReconnectCandidate(trusted, "older", true)?.id, "older");
  assert.equal(autoReconnectCandidate(trusted, "older", false)?.id, "newest");
  assert.equal(autoReconnectCandidate(trusted, null, true)?.id, "newest");
  const revoked = [{ ...server("older", 10), revoked: true }, server("newest", 20)];
  assert.equal(autoReconnectCandidate(revoked, "older", true)?.id, "newest");
});

test("a warm start opens its server behind the launch veil; the hub shows only when needed", () => {
  const opening = {
    veilActive: true,
    nativeAvailable: true,
    trustedLoaded: true,
    phase: "reconnecting" as const,
    autoOpening: true,
    hubShown: false,
    elapsedMs: 0,
  };
  // Splash → workspace with nothing in between.
  assert.equal(hubPresentation({ ...opening, trustedLoaded: false, phase: "loading-trusted-connections" }), "launch");
  assert.equal(hubPresentation({ ...opening, phase: "idle" }), "launch");
  assert.equal(hubPresentation(opening), "launch");
  assert.equal(hubPresentation({ ...opening, phase: "connected" }), "launch");
  // Something to do or read: pairing, nothing to open, a failure, an error.
  assert.equal(hubPresentation({ ...opening, autoOpening: false, phase: "idle" }), "hub");
  assert.equal(hubPresentation({ ...opening, phase: "unreachable" }), "hub");
  assert.equal(hubPresentation({ ...opening, phase: "revoked" }), "hub");
  assert.equal(hubPresentation({ ...opening, phase: "safety-confirmation" }), "hub");
  assert.equal(hubPresentation({ ...opening, error: "Could not restore the secure local connection." }), "hub");
  // A slow open stops hiding the hub; shown controls never hide by themselves.
  assert.equal(hubPresentation({ ...opening, elapsedMs: HUB_LAUNCH_PATIENCE_MS }), "hub");
  assert.equal(hubPresentation({ ...opening, hubShown: true }), "hub");
  // No veil (desktop dev) or no native Link core: the hub is the screen.
  assert.equal(hubPresentation({ ...opening, veilActive: false }), "hub");
  assert.equal(hubPresentation({ ...opening, nativeAvailable: false }), "hub");
});
