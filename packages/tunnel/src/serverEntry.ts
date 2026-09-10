import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type {
  AuthPrincipal,
  GrantProfileId,
  RemoteAccessPolicy,
  RequestIngress,
  RouteHandler,
  TunnelDiagnosticsDto,
  TunnelStatusDto,
} from "@polyth/contracts";
import {
  PRIVILEGED_REMOTE_CAPABILITIES,
  REMOTE_CAPABILITY,
  requireLocalTunnelAdmin,
} from "@polyth/contracts";
import {
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import { createTunnelStore, grantsForProfile, type TunnelStore } from "./index.ts";
import { startLinkHost, randomIngressSecret, type LinkHostClient } from "./host.ts";
import { attachTunnelEventsWs, TunnelEventBus } from "./events.ts";
import { buildTunnelDiagnostics, buildTunnelStatus, type TunnelLiveSnapshot } from "./status.ts";

const OWNER_USER_ID = "usr_owner";

const principalUserId = (principal: AuthPrincipal): string | undefined => {
  const userId = (principal as AuthPrincipal & { userId?: unknown }).userId;
  return typeof userId === "string" && userId ? userId : undefined;
};

const notFound = (message: string): Error =>
  Object.assign(new Error(message), { code: "not-found" });

export const TUNNEL_REMOTE_ACCESS: RemoteAccessPolicy = {
  routeScopes: ["tunnel"],
  http: [
    { methods: ["GET"], path: "/api/tunnel/status", capability: REMOTE_CAPABILITY.tunnelStatusRead, mutation: false },
    { methods: ["GET"], path: "/api/tunnel/diagnostics", capability: REMOTE_CAPABILITY.tunnelStatusRead, mutation: false },
  ],
  websocket: [
    { path: "/ws/tunnel", capability: REMOTE_CAPABILITY.tunnelStatusRead },
  ],
};

/** Narrow, durable authority seam consumed by server-owned native push.
 *  It exposes neither tunnel records nor connection IDs. */
export interface NativePushAuthorityService {
  hostEndpointId(): Promise<string | undefined>;
  validate(input: { userId: string; spaceId: string; deviceId: string; deviceEndpointId: string }): Promise<boolean>;
}

export async function commitPairingDevice(input: {
  pairingId: string;
  endpointId: string;
  label: string;
  platform?: string;
  grants: string[];
}, deps: {
  store: TunnelStore;
  host: LinkHostClient;
  events: TunnelEventBus;
}): Promise<void> {
  let device: ReturnType<TunnelStore["prepareDevice"]> | undefined;
  let activated = false;
  try {
    device = deps.store.prepareDevice({
      ...input,
      pairedVia: "polyth-link",
    });
    await deps.host.request("trust.upsert", {
      deviceId: device.id,
      endpointId: device.endpointId,
      grants: device.grants,
      grantRevision: device.grantRevision,
      revoked: false,
      pairingId: input.pairingId,
    });
    if (device.pairingState !== "active") {
      device = deps.store.markHostAcknowledged(input.pairingId);
      device = deps.store.activatePairing(input.pairingId);
      activated = true;
    }
    await deps.host.request("pairing.finish", { id: input.pairingId });
    deps.store.releasePairingOwner(input.pairingId);
  } catch (error) {
    const failed = device?.pairingId === input.pairingId
      ? deps.store.failPairing(input.pairingId, activated)
      : undefined;
    deps.store.releasePairingOwner(input.pairingId);
    if (failed?.pairingState === "failed") {
      try {
        await deps.host.request("trust.revoke", { deviceId: failed.id, endpointId: failed.endpointId });
      } catch { /* host may already be gone; startup sync excludes failed records */ }
    }
    try {
      await deps.host.request("pairing.storage_failed", { id: input.pairingId });
    } catch { /* pairing may already be gone or finalized */ }
    throw error;
  }
  if (activated) {
    deps.events.emit("tunnel/device-added", { id: device.id, deviceId: device.id }, device.ownerUserId);
  }
}

export function tunnelRoutes(deps: {
  store: TunnelStore;
  events: TunnelEventBus;
  host: () => LinkHostClient | null;
  connections: Map<string, AuthPrincipal>;
  status: (userId: string) => Promise<TunnelStatusDto | Record<string, unknown>>;
  diagnostics: (userId: string) => Promise<TunnelDiagnosticsDto | Record<string, unknown>>;
  closeDeviceSockets: (deviceId: string) => void;
}): RouteHandler {
  const connectionCount = (deviceId: string): number => {
    let count = 0;
    for (const principal of deps.connections.values()) {
      if (principal.kind === "paired-device" && principal.deviceId === deviceId) count += 1;
    }
    return count;
  };
  const dto = (device: ReturnType<TunnelStore["device"]>) => {
    if (!device) return null;
    const count = connectionCount(device.id);
    return deps.store.toDto(device, count > 0, count);
  };
  const ownedDevice = (id: string, userId: string) => {
    const device = deps.store.deviceForUser(id, userId);
    if (!device) throw notFound("unknown device");
    return device;
  };
  const assertPairingOwner = (id: string, userId: string): void => {
    const owner = deps.store.pairingOwner(id) ?? deps.store.deviceByPairing(id)?.ownerUserId ?? OWNER_USER_ID;
    if (owner !== userId) throw notFound("unknown pairing");
  };
  const dropDevicePrincipals = (deviceId: string): void => {
    for (const [connectionId, principal] of deps.connections) {
      if (principal.kind === "paired-device" && principal.deviceId === deviceId) {
        deps.connections.delete(connectionId);
      }
    }
    deps.closeDeviceSockets(deviceId);
  };
  return async (request) => {
    const { path, method, json, principal } = request;
    if (!path.startsWith("/api/tunnel")) return false;
    if (path === "/api/tunnel/status" && method === "GET") {
      json(200, await deps.status(request.space.userId));
      return true;
    }
    if (path === "/api/tunnel/diagnostics" && method === "GET") {
      json(200, await deps.diagnostics(request.space.userId));
      return true;
    }
    requireLocalTunnelAdmin(request);
    if (path === "/api/tunnel/pairing" && method === "POST") {
      request.requireCapability(REMOTE_CAPABILITY.tunnelPairingManage);
      const body = await request.body();
      const profile = (body.profile === "observe" || body.profile === "developer" || body.profile === "full-remote"
        ? body.profile
        : "interact") as GrantProfileId;
      if (body.mode && body.mode !== "direct-preferred") {
        json(400, { error: "invalid-input", message: "only direct-preferred pairing is available" });
        return true;
      }
      const grants = grantsForProfile(profile).filter((cap) => !PRIVILEGED_REMOTE_CAPABILITIES.includes(cap));
      const host = deps.host();
      if (!host?.available) {
        json(503, { error: "unavailable", message: "Polyth Link host is not running" });
        return true;
      }
      const result = await host.request("pairing.create", {
        profile,
        mode: "direct-preferred",
        label: typeof body.label === "string" ? body.label : "",
        grants,
      });
      const pairingId = typeof (result.pairing as { id?: unknown })?.id === "string"
        ? (result.pairing as { id: string }).id
        : "";
      if (!pairingId) {
        throw Object.assign(new Error("Polyth Link returned no pairing id"), { code: "invalid-response" });
      }
      try {
        deps.store.claimPairing(pairingId, request.space.userId);
      } catch (error) {
        try { await host.request("pairing.cancel", { id: pairingId }); } catch { /* fail closed locally */ }
        throw error;
      }
      deps.events.emit("tunnel/pairing-created", { id: pairingId }, request.space.userId);
      json(200, result);
      return true;
    }

    const pairingMatch = path.match(/^\/api\/tunnel\/pairing\/([^/]+)(?:\/(approve|reject))?$/);
    if (pairingMatch) {
      request.requireCapability(REMOTE_CAPABILITY.tunnelPairingManage);
      const id = pairingMatch[1]!;
      assertPairingOwner(id, request.space.userId);
      const host = deps.host();
      if (!host?.available) {
        json(503, { error: "unavailable", message: "Polyth Link host is not running" });
        return true;
      }
      if (method === "GET" && !pairingMatch[2]) {
        json(200, await host.request("pairing.get", { id }));
        return true;
      }
      if (method === "POST" && pairingMatch[2] === "approve") {
        json(200, await host.request("pairing.approve", { id }));
        return true;
      }
      if (method === "POST" && pairingMatch[2] === "reject") {
        const result = await host.request("pairing.reject", { id });
        deps.store.releasePairingOwner(id);
        json(200, result);
        return true;
      }
      if (method === "DELETE") {
        const result = await host.request("pairing.cancel", { id });
        deps.store.releasePairingOwner(id);
        json(200, result);
        return true;
      }
    }

    if (path === "/api/tunnel/devices" && method === "GET") {
      request.requireCapability(REMOTE_CAPABILITY.tunnelDevicesManage);
      json(200, deps.store.list(request.space.userId).map((device) => dto(device)));
      return true;
    }

    const deviceMatch = path.match(/^\/api\/tunnel\/devices\/([^/]+)(?:\/(revoke|restore|grants))?$/);
    if (deviceMatch) {
      const id = deviceMatch[1]!;
      const action = deviceMatch[2];
      if (method === "GET" && !action) {
        request.requireCapability(REMOTE_CAPABILITY.tunnelDevicesManage);
        json(200, dto(ownedDevice(id, request.space.userId)));
        return true;
      }
      if (method === "PATCH" && !action) {
        request.requireCapability(REMOTE_CAPABILITY.tunnelDevicesManage);
        ownedDevice(id, request.space.userId);
        const body = await request.body();
        const device = deps.store.rename(id, String(body.label ?? ""));
        if (!device) throw notFound("unknown device");
        deps.events.emit("tunnel/device-updated", { id, deviceId: id }, device.ownerUserId);
        json(200, dto(device));
        return true;
      }
      if (method === "POST" && action === "revoke") {
        request.requireCapability(REMOTE_CAPABILITY.tunnelDevicesManage);
        ownedDevice(id, request.space.userId);
        const device = deps.store.revoke(id);
        if (!device) throw notFound("unknown device");
        const host = deps.host();
        if (host?.available) {
          try {
            await host.request("trust.revoke", { deviceId: id, endpointId: device.endpointId });
          } catch (error) {
            json(503, {
              error: "unavailable",
              message: error instanceof Error ? error.message : "host trust revoke failed",
              state: "partial",
              deviceId: id,
            });
            return true;
          }
        }
        dropDevicePrincipals(id);
        deps.events.emit("tunnel/device-revoked", { id, deviceId: id }, device.ownerUserId);
        json(200, dto(device));
        return true;
      }
      if (method === "POST" && action === "restore") {
        request.requireCapability(REMOTE_CAPABILITY.tunnelDevicesManage);
        ownedDevice(id, request.space.userId);
        const device = deps.store.restore(id);
        if (!device) throw notFound("unknown device");
        const host = deps.host();
        if (host?.available) {
          try {
            await host.request("trust.restore", { deviceId: id, endpointId: device.endpointId });
            await host.request("trust.upsert", {
              deviceId: device.id,
              endpointId: device.endpointId,
              grants: device.grants,
              grantRevision: device.grantRevision,
              revoked: false,
            });
          } catch (error) {
            json(503, {
              error: "unavailable",
              message: error instanceof Error ? error.message : "host trust restore failed",
              state: "partial",
              deviceId: id,
            });
            return true;
          }
        }
        deps.events.emit("tunnel/device-updated", { id, deviceId: id }, device.ownerUserId);
        json(200, dto(device));
        return true;
      }
      if (method === "PUT" && action === "grants") {
        request.requireCapability(REMOTE_CAPABILITY.tunnelGrantsManage);
        ownedDevice(id, request.space.userId);
        const body = await request.body();
        const grants = Array.isArray(body.grants) ? body.grants.map(String) : [];
        const device = deps.store.setGrants(id, grants);
        if (!device) throw notFound("unknown device");
        for (const [connectionId, live] of deps.connections) {
          if (live.kind === "paired-device" && live.deviceId === id) {
            deps.connections.set(connectionId, { ...live, grants: device.grants, grantRevision: device.grantRevision });
          }
        }
        const host = deps.host();
        if (host?.available) {
          try {
            await host.request("trust.update_grants", {
              deviceId: id,
              endpointId: device.endpointId,
              grants: device.grants,
              grantRevision: device.grantRevision,
            });
          } catch (error) {
            json(503, {
              error: "unavailable",
              message: error instanceof Error ? error.message : "host grant update failed",
              state: "partial",
              deviceId: id,
            });
            return true;
          }
        }
        deps.events.emit("tunnel/grants-updated", { id, deviceId: id, grantRevision: device.grantRevision }, device.ownerUserId);
        json(200, dto(device));
        return true;
      }
      if (method === "DELETE" && !action) {
        request.requireCapability(REMOTE_CAPABILITY.tunnelDevicesManage);
        ownedDevice(id, request.space.userId);
        if (!deps.store.forget(id)) throw Object.assign(new Error("revoke the device first"), { code: "conflict" });
        json(200, { ok: true });
        return true;
      }
    }

    if (path === "/api/tunnel/events" && method === "GET") {
      request.requireCapability(REMOTE_CAPABILITY.tunnelStatusRead);
      const after = Number(request.url.searchParams.get("after") ?? "0");
      json(200, deps.events.snapshot(Number.isFinite(after) ? after : 0, request.space.userId));
      return true;
    }

    if (path === "/api/tunnel/identity/rotate" && method === "POST") {
      request.requireCapability(REMOTE_CAPABILITY.serverIdentityRotate);
      if (request.space.userId !== OWNER_USER_ID) {
        throw Object.assign(new Error("not allowed"), { code: "forbidden" });
      }
      const host = deps.host();
      if (!host?.available) {
        json(503, { error: "unavailable", message: "Polyth Link host is not running" });
        return true;
      }
      const revokedIds = deps.store.revokeAll();
      for (const id of revokedIds) dropDevicePrincipals(id);
      try {
        const result = await host.request("identity.rotate");
        deps.events.emit("tunnel/identity-rotated", { revoked: revokedIds.length });
        json(200, result);
      } catch (error) {
        json(503, {
          error: "unavailable",
          message: error instanceof Error ? error.message : "host identity rotate failed",
          state: "partial",
          revoked: revokedIds.length,
        });
      }
      return true;
    }

    return false;
  };
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  const store = createTunnelStore(join(host.storageDir, "tunnel", "tunnel.db"));
  const events = new TunnelEventBus();
  const connections = new Map<string, AuthPrincipal>();
  let linkHost: LinkHostClient | null = null;
  let ingressHandle: { close(): Promise<void> } | null = null;
  let endpointBound = false;
  let ingressReady = false;
  let lastErrorCode: string | undefined;
  let acceptingCommitTasks = false;
  let detachHostEvents: (() => void) | null = null;
  const pairingCommits = new Map<string, Promise<void>>();
  let ingressSecret = randomIngressSecret();
  const socketDir = join(host.storageDir, "tunnel");
  mkdirSync(socketDir, { recursive: true });
  const controlSocket = join(socketDir, "host.sock");
  const ingressSocket = join(socketDir, "ingress.sock");
  const nativePushAuthority: NativePushAuthorityService = {
    async hostEndpointId() {
      if (!linkHost?.available) return undefined;
      try {
        const status = await linkHost.request("identity.status");
        return typeof status.endpointId === "string" && status.endpointId ? status.endpointId : undefined;
      } catch { return undefined; }
    },
    async validate(input) {
      const membership = host.services.get(serverServiceKey<{ hasAccess(userId: string, spaceId: string): boolean }>("tenancy.membership"));
      if (!membership?.hasAccess(input.userId, input.spaceId)) return false;
      const device = store.device(input.deviceId);
      return Boolean(
        device && device.endpointId === input.deviceEndpointId && device.ownerUserId === input.userId && device.pairingState === "active" && !device.revokedAt
        && device.grants.includes(REMOTE_CAPABILITY.coreNotificationsRead),
      );
    },
  };
  host.services.provide(serverServiceKey<NativePushAuthorityService>("tunnel.native-push"), nativePushAuthority);

  const syncTrust = async (): Promise<void> => {
    if (!linkHost?.available) return;
    store.recoverIncompletePairings();
    await linkHost.request("trust.sync_begin");
    for (const device of store.trustList()) {
      await linkHost.request("trust.upsert", {
        endpointId: device.endpointId,
        deviceId: device.id,
        grants: device.grants,
        grantRevision: device.grantRevision,
        revoked: Boolean(device.revokedAt),
        pairingId: device.pairingId,
      });
    }
    await linkHost.request("trust.sync_finish");
  };

  let eventsEnabled = false;
  const httpContexts = new Set<import("@polyth/plugins").HttpServerContext>();
  const detachers = new Map<import("node:http").Server, () => void>();
  const attachEvents = (ctx: import("@polyth/plugins").HttpServerContext) => {
    detachers.get(ctx.server)?.();
    detachers.set(ctx.server, attachTunnelEventsWs(ctx.server, {
      events,
      authorize: ctx.authorize,
      identity: ctx.identity,
      refreshPrincipal: ctx.refreshPrincipal,
      pairedSockets: ctx.pairedSockets,
    }));
  };
  host.onHttpServer((ctx) => {
    httpContexts.add(ctx);
    ctx.server.on("close", () => {
      httpContexts.delete(ctx);
      detachers.get(ctx.server)?.();
      detachers.delete(ctx.server);
    });
    if (eventsEnabled) attachEvents(ctx);
  });

  const resolvePaired = (ingress: Extract<RequestIngress, { kind: "polyth-link" }>): AuthPrincipal | null => {
    if (!linkHost?.available) return null;
    const live = connections.get(ingress.connectionId);
    if (!live || live.kind !== "paired-device") return null;
    const device = store.device(live.deviceId);
    if (!device || device.pairingState !== "active" || device.revokedAt) return null;
    return {
      ...live,
      userId: device.ownerUserId,
      grants: device.grants,
      grantRevision: device.grantRevision,
      transport: ingress.transport,
    } as AuthPrincipal;
  };

  const startIngress = async (): Promise<void> => {
    if (ingressHandle) await ingressHandle.close();
    ingressReady = false;
    ingressSecret = randomIngressSecret();
    ingressHandle = await host.startTunnelIngress({
      socketPath: ingressSocket,
      secret: ingressSecret,
      lookup,
    });
    ingressReady = true;
  };

  const lookup = (connectionId: string): Extract<RequestIngress, { kind: "polyth-link" }> | null => {
    if (!linkHost?.available) return null;
    const principal = connections.get(connectionId);
    if (!principal || principal.kind !== "paired-device") return null;
    if (principal.connectionId !== connectionId) return null;
    const device = store.device(principal.deviceId);
    if (!device || device.pairingState !== "active" || device.revokedAt) {
      connections.delete(connectionId);
      return null;
    }
    return { kind: "polyth-link", connectionId, transport: principal.transport };
  };

  host.attachPairedDeviceResolver(resolvePaired);

  const liveSnapshot = async (userId: string): Promise<TunnelLiveSnapshot> => {
    let fingerprint: string | null = null;
    let identityError: string | undefined;
    let identityAvailable = false;
    let hostPolicy: string | null = null;
    let hostBound: boolean | null = null;
    let relayUrls: string[] | null = null;
    let irohVersion: string | null = null;
    try {
      if (linkHost?.available) {
        const identity = await linkHost.request("identity.status");
        fingerprint = typeof identity.fingerprint === "string" && identity.fingerprint
          ? identity.fingerprint
          : null;
        identityAvailable = Boolean(fingerprint);
        const status = await linkHost.request("status");
        hostBound = Boolean(status.endpointBound);
        hostPolicy = typeof status.activePolicy === "string"
          ? status.activePolicy
          : typeof status.mode === "string" ? status.mode : null;
        relayUrls = Array.isArray(status.relayUrls) ? status.relayUrls.map(String) : [];
        irohVersion = typeof status.irohVersion === "string" ? status.irohVersion : null;
        endpointBound = hostBound;
      }
    } catch (error) {
      identityError = error instanceof Error ? error.message : "host-identity-unavailable";
      lastErrorCode = "host-identity-unavailable";
    }
    const platformSupported = linkHost ? linkHost.platformSupported : process.platform !== "win32";
    const hostAlive = Boolean(linkHost?.available);
    let directConnections = 0;
    let relayConnections = 0;
    let activeConnections = 0;
    for (const principal of hostAlive ? connections.values() : []) {
      if (principal.kind !== "paired-device" || principalUserId(principal) !== userId) continue;
      activeConnections += 1;
      if (principal.transport === "relay") relayConnections += 1;
      else directConnections += 1;
    }
    const policy = hostPolicy === "direct-preferred" || hostPolicy === "relay-only" || hostPolicy === "air-gapped"
      ? hostPolicy
      : null;
    return {
      platformSupported,
      hostBinaryFound: Boolean(linkHost?.binaryFound),
      hostProcessReady: Boolean(linkHost?.processReady && linkHost.available),
      endpointBound: hostAlive && (hostBound ?? endpointBound),
      ingressReady: hostAlive && ingressReady,
      identityAvailable: hostAlive && identityAvailable,
      hostFingerprint: hostAlive ? fingerprint : null,
      ...(identityError ? { identityError } : {}),
      lastErrorCode: linkHost?.lastErrorCode ?? lastErrorCode,
      activePolicy: hostAlive ? policy : null,
      relayConfigured: hostAlive && Array.isArray(relayUrls) ? relayUrls.length > 0 : false,
      relayUrls: hostAlive ? relayUrls : null,
      irohVersion: hostAlive ? irohVersion : null,
      activeConnections,
      activeDevices: store.trustList(userId).filter((device) => !device.revokedAt).length,
      directConnections,
      relayConnections,
    };
  };

  const eventOwner = (event: Record<string, unknown>): string | undefined => {
    const pairingId = typeof event.pairingId === "string" ? event.pairingId : "";
    if (pairingId) {
      const owner = store.pairingOwner(pairingId) ?? store.deviceByPairing(pairingId)?.ownerUserId;
      if (owner) return owner;
    }
    const deviceId = typeof event.deviceId === "string" ? event.deviceId : "";
    if (deviceId) {
      const owner = store.device(deviceId)?.ownerUserId;
      if (owner) return owner;
    }
    const endpointId = typeof event.endpointId === "string" ? event.endpointId : "";
    return endpointId ? store.deviceByEndpoint(endpointId)?.ownerUserId : undefined;
  };

  return {
    remoteAccess: TUNNEL_REMOTE_ACCESS,
    routes: tunnelRoutes({
      store,
      events,
      host: () => linkHost,
      connections,
      status: async (userId) => buildTunnelStatus(await liveSnapshot(userId)),
      diagnostics: async (userId) => buildTunnelDiagnostics(await liveSnapshot(userId)),
      closeDeviceSockets: (deviceId) => host.closePairedDevice(deviceId),
    }),
    async onEnable() {
      eventsEnabled = true;
      for (const ctx of httpContexts) attachEvents(ctx);
      endpointBound = false;
      lastErrorCode = undefined;
      try {
        linkHost = await startLinkHost({ dataDir: host.storageDir, socketPath: controlSocket });
        if (!linkHost.available) {
          lastErrorCode = linkHost.lastErrorCode ?? "host-binary-missing";
          return;
        }
        acceptingCommitTasks = true;
        detachHostEvents = linkHost.onEvent((event) => {
          events.emit(
            event.type,
            { ...event, ...(typeof event.deviceId === "string" ? { deviceId: event.deviceId } : {}) },
            eventOwner(event),
          );
          if (event.type === "tunnel/pairing-committing") {
            const pairingId = String(event.pairingId ?? "");
            const endpointId = String(event.endpointId ?? "");
            if (!endpointId || !pairingId) return;
            if (!acceptingCommitTasks || pairingCommits.has(pairingId)) return;
            const activeHost = linkHost;
            if (!activeHost) return;
            const task = commitPairingDevice({
              pairingId,
              endpointId,
              label: String(event.label ?? "Mobile device"),
              platform: event.platform ? String(event.platform) : undefined,
              grants: Array.isArray(event.grants) ? event.grants.map(String) : [],
            }, { store, host: activeHost, events })
              .catch((error) => {
                console.error("[polyth-link] pairing commit failed", error instanceof Error ? error.message : error);
              })
              .finally(() => pairingCommits.delete(pairingId));
            pairingCommits.set(pairingId, task);
          }
          if (event.type === "tunnel/pairing-storage-failed") {
            const pairingId = String(event.pairingId ?? "");
            if (pairingId) store.releasePairingOwner(pairingId);
            const endpointId = String(event.endpointId ?? "");
            const device = endpointId ? store.deviceByEndpoint(endpointId) : undefined;
            if (device) {
              void (async () => {
                store.revoke(device.id);
                for (const [connectionId, principal] of connections) {
                  if (principal.kind === "paired-device" && principal.deviceId === device.id) {
                    connections.delete(connectionId);
                  }
                }
                host.closePairedDevice(device.id);
                try {
                  await linkHost?.request("trust.revoke", { deviceId: device.id });
                } catch (error) {
                  console.error("[polyth-link] close after storage-failed event failed", error instanceof Error ? error.message : error);
                }
              })();
            }
          }
          if (event.type === "tunnel/connection-opened") {
            const connectionId = String(event.connectionId ?? "");
            const deviceId = String(event.deviceId ?? "");
            const device = store.device(deviceId);
            if (!connectionId || !device || device.pairingState !== "active" || device.revokedAt) return;
            connections.set(connectionId, {
              kind: "paired-device",
              deviceId: device.id,
              deviceEndpointId: device.endpointId,
              connectionId,
              transport: event.transport === "relay" ? "relay" : "direct",
              grants: device.grants,
              grantRevision: device.grantRevision,
              userId: device.ownerUserId,
            } as AuthPrincipal);
            store.touch(device.id, event.transport === "relay" ? "relay" : "direct");
          }
          if (event.type === "tunnel/connection-closed") {
            connections.delete(String(event.connectionId ?? ""));
          }
        });
        try {
          await startIngress();
          await linkHost.request("ingress.configure", {
            socket: ingressSocket,
            secret: ingressSecret,
          });
        } catch (error) {
          lastErrorCode = "ingress-configure-failed";
          ingressReady = false;
          console.error("[polyth-link] ingress configure failed", error instanceof Error ? error.message : error);
        }
        await syncTrust();
        try {
          await linkHost.request("endpoint.start");
          endpointBound = true;
        } catch (error) {
          endpointBound = false;
          lastErrorCode = "endpoint-bind-failed";
          console.error("[polyth-link] endpoint did not bind", error instanceof Error ? error.message : error);
        }
      } catch (error) {
        lastErrorCode = "host-start-failed";
        console.error("[polyth-link] host failed to start", error instanceof Error ? error.message : error);
      }
    },
    async onDisable() {
      eventsEnabled = false;
      acceptingCommitTasks = false;
      detachHostEvents?.();
      detachHostEvents = null;
      for (const stop of detachers.values()) stop();
      detachers.clear();
      await Promise.allSettled(pairingCommits.values());
      endpointBound = false;
      ingressReady = false;
      await ingressHandle?.close();
      ingressHandle = null;
      await linkHost?.close();
      linkHost = null;
      connections.clear();
    },
    stopIngress() {
      eventsEnabled = false;
      for (const stop of detachers.values()) stop();
      detachers.clear();
    },
  };
}
