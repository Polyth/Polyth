import test from "node:test";
import assert from "node:assert/strict";
import {
  ConnectionController,
  type ConnectionControllerState,
} from "../src/connectionController.ts";
import type { DiscoveredPolyth, DiscoveryUpdate } from "../src/discovery.ts";
import type {
  ConnectionMetadata,
  PairingAttempt,
  PairingPreview,
  PolythLinkNative,
  ProxyLaunch,
} from "../src/polythLink.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function connection(id: string): ConnectionMetadata {
  return {
    id,
    hostEndpointId: id,
    hostLabel: `Server ${id.toUpperCase()}`,
    pairingState: "active",
    lastUsedAt: 1,
    hasSecureIdentity: true,
  };
}

function launch(connectionId: string): ProxyLaunch {
  return {
    origin: "http://127.0.0.1:49152",
    bootstrapUrl: "http://127.0.0.1:49152/bootstrap",
    connectionId,
  };
}

function discovered(id = "a".repeat(64), hostLabel = "Desk"): DiscoveredPolyth {
  return {
    id,
    serviceName: hostLabel,
    hostLabel,
    hostEndpointId: id,
    protocolVersion: 1,
    port: 4433,
    addresses: ["192.168.1.10"],
    numericPairing: true,
  };
}

function native(overrides: Partial<PolythLinkNative> = {}): PolythLinkNative {
  const preview: PairingPreview = {
    hostLabel: "Server",
    hostFingerprint: "fingerprint",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  return {
    parsePairingTicket: async () => preview,
    beginPairing: async () => ({ attemptId: "attempt", safetyPhrase: ["amber", "river"], state: "prepared" }),
    confirmPairing: async () => launch("a"),
    cancelPairing: async () => undefined,
    listConnections: async () => [connection("a")],
    connect: async (connectionId) => launch(connectionId),
    disconnect: async () => undefined,
    forgetConnection: async () => undefined,
    getStatus: async () => ({ state: "disconnected" }),
    ...overrides,
  };
}

async function loadedController(
  adapter: PolythLinkNative,
  observer?: (state: ConnectionControllerState) => void,
): Promise<ConnectionController> {
  const controller = new ConnectionController(adapter);
  if (observer) controller.subscribe(observer);
  await controller.loadTrustedConnections();
  return controller;
}

test("late connect result cannot overwrite a newer QR intent", async () => {
  const pendingConnect = deferred<ProxyLaunch>();
  const disconnected: string[] = [];
  let connectStarted = false;
  const adapter = native({
    connect: async () => {
      connectStarted = true;
      return pendingConnect.promise;
    },
    disconnect: async (connectionId) => {
      disconnected.push(connectionId);
    },
  });
  const controller = await loadedController(adapter);

  const reconnect = controller.connect("a");
  while (!connectStarted) await Promise.resolve();
  controller.startQrScan();
  pendingConnect.resolve(launch("a"));

  assert.equal(await reconnect, undefined);
  assert.equal(controller.state.phase, "scanning-qr");
  assert.deepEqual(disconnected, ["a"]);
});

test("late pairing preparation is cancelled when a newer intent wins", async () => {
  const pendingAttempt = deferred<PairingAttempt>();
  const cancelled: string[] = [];
  let beginStarted = false;
  const adapter = native({
    beginPairing: async () => {
      beginStarted = true;
      return pendingAttempt.promise;
    },
    cancelPairing: async (attemptId) => {
      cancelled.push(attemptId);
    },
  });
  const controller = await loadedController(adapter);

  const pairing = controller.beginPairing("polyth://pair?v=1&t=ticket");
  while (!beginStarted) await Promise.resolve();
  controller.startQrScan();
  pendingAttempt.resolve({ attemptId: "stale-attempt", safetyPhrase: ["amber", "river"], state: "prepared" });

  assert.equal(await pairing, undefined);
  assert.equal(controller.state.phase, "scanning-qr");
  assert.deepEqual(cancelled, ["stale-attempt"]);
});

test("cancelled approval tears down a late successful connection", async () => {
  const pendingConfirm = deferred<ProxyLaunch>();
  const disconnected: string[] = [];
  const cancelled: string[] = [];
  const adapter = native({
    confirmPairing: async () => pendingConfirm.promise,
    cancelPairing: async (attemptId) => {
      cancelled.push(attemptId);
    },
    disconnect: async (connectionId) => {
      disconnected.push(connectionId);
    },
  });
  const controller = await loadedController(adapter);
  await controller.beginPairing("polyth://pair?v=1&t=ticket");

  const confirmation = controller.confirmPairing();
  controller.cancelPairing();
  pendingConfirm.resolve(launch("a"));

  assert.equal(await confirmation, undefined);
  assert.equal(controller.state.phase, "idle");
  assert.deepEqual(cancelled, ["attempt"]);
  assert.deepEqual(disconnected, ["a"]);
});

test("rapid A to B to A switch serializes native mutations and honors newest intent", async () => {
  const disconnectA = deferred<void>();
  const connectCalls: string[] = [];
  let disconnectStarted = false;
  const adapter = native({
    listConnections: async () => [connection("a"), connection("b")],
    getStatus: async (connectionId) => ({ state: connectionId === "a" ? "connected" : "disconnected" }),
    disconnect: async (connectionId) => {
      if (connectionId === "a") {
        disconnectStarted = true;
        await disconnectA.promise;
      }
    },
    connect: async (connectionId) => {
      connectCalls.push(connectionId);
      return launch(connectionId);
    },
  });
  const controller = await loadedController(adapter);
  assert.equal(controller.state.activeConnectionId, "a");

  const toB = controller.connect("b");
  while (!disconnectStarted) await Promise.resolve();
  const backToA = controller.connect("a");
  disconnectA.resolve();

  assert.equal(await toB, undefined);
  assert.equal((await backToA)?.connectionId, "a");
  assert.deepEqual(connectCalls, ["a"]);
  assert.equal(controller.state.phase, "connected");
  assert.equal(controller.state.activeConnectionId, "a");
});

test("discovery results are progressive and stop when QR becomes the newest intent", async () => {
  let publish: ((update: DiscoveryUpdate) => void) | undefined;
  let stops = 0;
  const controller = await loadedController(native());

  await controller.startDiscovery(async (onUpdate) => {
    publish = onUpdate;
    return {
      async stop() {
        stops += 1;
      },
    };
  });
  publish?.({ state: "results", results: [discovered()] });
  assert.equal(controller.state.phase, "discovery-results");
  assert.equal(controller.state.discovered[0]?.hostLabel, "Desk");

  controller.startQrScan();
  await Promise.resolve();
  publish?.({ state: "results", results: [discovered("b".repeat(64), "Stale")] });

  assert.equal(stops, 1);
  assert.equal(controller.state.phase, "scanning-qr");
  assert.equal(controller.state.discovered[0]?.hostLabel, "Desk");
});

test("a discovery session that starts late is immediately stopped after intent changes", async () => {
  const pendingSession = deferred<{ stop(): Promise<void> }>();
  let stops = 0;
  const controller = await loadedController(native());

  const starting = controller.startDiscovery(async () => pendingSession.promise);
  controller.startQrScan();
  pendingSession.resolve({
    async stop() {
      stops += 1;
    },
  });

  await starting;
  assert.equal(stops, 1);
  assert.equal(controller.state.phase, "scanning-qr");
});

test("discovery permission denial is recoverable and does not affect trusted reconnect state", async () => {
  const controller = await loadedController(native());

  await controller.startDiscovery(async () => {
    const error = new Error("discovery-permission-denied") as Error & { code: string };
    error.code = "discovery-permission-denied";
    throw error;
  });

  assert.equal(controller.state.phase, "discovery-permission-required");
  assert.equal(controller.state.trusted.length, 1);
  assert.equal(controller.state.discovered.length, 0);
});
