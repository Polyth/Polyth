import { createServer, type IncomingMessage, type Server } from "node:http";
import { join } from "node:path";
import { mkdirSync, unlinkSync } from "node:fs";
import type {
  AuthPrincipal,
  GrantProfileId,
  RemoteAccessPolicy,
  RequestIngress,
  RouteHandler,
} from "@polyth/contracts";
import {
  matchRemotePath,
  PRIVILEGED_REMOTE_CAPABILITIES,
  REMOTE_CAPABILITY,
} from "@polyth/contracts";
import {
  type HttpServerContext,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import { createTunnelStore, grantsForProfile, type TunnelStore } from "./index.ts";
import { startLinkHost, randomIngressSecret, type LinkHostClient } from "./host.ts";
import { attachTunnelEventsWs, TunnelEventBus } from "./events.ts";
import { buildTunnelDiagnostics, buildTunnelStatus } from "./status.ts";

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

const requireLocalAdmin = (principal: AuthPrincipal): void => {
  if (principal.kind === "paired-device") {
    throw Object.assign(new Error("not allowed"), { code: "forbidden" });
  }
  if (principal.kind === "anonymous") {
    throw Object.assign(new Error("authentication required"), { code: "unauthorized" });
  }
};

export function tunnelRoutes(deps: {
  store: TunnelStore;
  events: TunnelEventBus;
  host: () => LinkHostClient | null;
  connections: Map<string, AuthPrincipal>;
  status: () => Promise<Record<string, unknown>>;
  diagnostics: () => Promise<Record<string, unknown>>;
}): RouteHandler {
  return async (request) => {
    const { path, method, json, principal } = request;
    if (!path.startsWith("/api/tunnel")) return false;
    if (path === "/api/tunnel/status" && method === "GET") {
      json(200, await deps.status());
      return true;
    }
    if (path === "/api/tunnel/diagnostics" && method === "GET") {
      json(200, await deps.diagnostics());
      return true;
    }
    requireLocalAdmin(principal);
    if (path === "/api/tunnel/pairing" && method === "POST") {
      request.requireCapability(REMOTE_CAPABILITY.tunnelPairingManage);
      const body = await request.body();
      const profile = (body.profile === "observe" || body.profile === "developer" || body.profile === "full-remote"
        ? body.profile
        : "interact") as GrantProfileId;
      const mode = body.mode === "relay-only" || body.mode === "air-gapped" ? body.mode : "direct-preferred";
      const grants = grantsForProfile(profile).filter((cap) => !PRIVILEGED_REMOTE_CAPABILITIES.includes(cap));
      const host = deps.host();
      if (!host?.available) {
        json(503, { error: "unavailable", message: "Polyth Link host is not running" });
        return true;
      }
      const result = await host.request("pairing.create", {
        profile,
        mode,
        label: typeof body.label === "string" ? body.label : "",
        grants,
      });
      deps.events.emit("tunnel/pairing-created", { id: (result.pairing as { id?: string })?.id ?? "" });
      json(200, result);
      return true;
    }

    const pairingMatch = path.match(/^\/api\/tunnel\/pairing\/([^/]+)(?:\/(approve|reject))?$/);
    if (pairingMatch) {
      request.requireCapability(REMOTE_CAPABILITY.tunnelPairingManage);
      const id = pairingMatch[1]!;
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
        json(200, await host.request("pairing.reject", { id }));
        return true;
      }
      if (method === "DELETE") {
        json(200, await host.request("pairing.cancel", { id }));
        return true;
      }
    }

    if (path === "/api/tunnel/devices" && method === "GET") {
      request.requireCapability(REMOTE_CAPABILITY.tunnelDevicesManage);
      json(200, deps.store.list().map((device) => deps.store.toDto(device, deps.connections.has(device.id))));
      return true;
    }

    const deviceMatch = path.match(/^\/api\/tunnel\/devices\/([^/]+)(?:\/(revoke|restore|grants))?$/);
    if (deviceMatch) {
      const id = deviceMatch[1]!;
      const action = deviceMatch[2];
      if (method === "GET" && !action) {
        request.requireCapability(REMOTE_CAPABILITY.tunnelDevicesManage);
        const device = deps.store.device(id);
        if (!device) throw Object.assign(new Error("unknown device"), { code: "not-found" });
        json(200, deps.store.toDto(device, deps.connections.has(device.id)));
        return true;
      }
      if (method === "PATCH" && !action) {
        request.requireCapability(REMOTE_CAPABILITY.tunnelDevicesManage);
        const body = await request.body();
        const device = deps.store.rename(id, String(body.label ?? ""));
        if (!device) throw Object.assign(new Error("unknown device"), { code: "not-found" });
        deps.events.emit("tunnel/device-updated", { id });
        json(200, deps.store.toDto(device, false));
        return true;
      }
      if (method === "POST" && action === "revoke") {
        request.requireCapability(REMOTE_CAPABILITY.tunnelDevicesManage);
        const device = deps.store.revoke(id);
        if (!device) throw Object.assign(new Error("unknown device"), { code: "not-found" });
        for (const [connectionId, principal] of deps.connections) {
          if (principal.kind === "paired-device" && principal.deviceId === id) {
            deps.connections.delete(connectionId);
          }
        }
        void deps.host()?.request("connection.close_device", { deviceId: id }).catch(() => {});
        deps.events.emit("tunnel/device-revoked", { id });
        json(200, deps.store.toDto(device, false));
        return true;
      }
      if (method === "POST" && action === "restore") {
        request.requireCapability(REMOTE_CAPABILITY.tunnelDevicesManage);
        const device = deps.store.restore(id);
        if (!device) throw Object.assign(new Error("unknown device"), { code: "not-found" });
        json(200, deps.store.toDto(device, false));
        return true;
      }
      if (method === "PUT" && action === "grants") {
        request.requireCapability(REMOTE_CAPABILITY.tunnelGrantsManage);
        const body = await request.body();
        const grants = Array.isArray(body.grants) ? body.grants.map(String) : [];
        const device = deps.store.setGrants(id, grants);
        if (!device) throw Object.assign(new Error("unknown device"), { code: "not-found" });
        for (const [connectionId, live] of deps.connections) {
          if (live.kind === "paired-device" && live.deviceId === id) {
            deps.connections.set(connectionId, { ...live, grants: device.grants, grantRevision: device.grantRevision });
          }
        }
        deps.events.emit("tunnel/device-updated", { id });
        void deps.host()?.request("connection.notify_grants", {
          deviceId: id,
          grantRevision: device.grantRevision,
        }).catch(() => {});
        json(200, deps.store.toDto(device, false));
        return true;
      }
      if (method === "DELETE" && !action) {
        request.requireCapability(REMOTE_CAPABILITY.tunnelDevicesManage);
        if (!deps.store.forget(id)) throw Object.assign(new Error("revoke the device first"), { code: "conflict" });
        json(200, { ok: true });
        return true;
      }
    }

    if (path === "/api/tunnel/events" && method === "GET") {
      request.requireCapability(REMOTE_CAPABILITY.tunnelStatusRead);
      const after = Number(request.url.searchParams.get("after") ?? "0");
      json(200, deps.events.snapshot(Number.isFinite(after) ? after : 0));
      return true;
    }

    if (path === "/api/tunnel/identity/rotate" && method === "POST") {
      request.requireCapability(REMOTE_CAPABILITY.serverIdentityRotate);
      const host = deps.host();
      if (!host?.available) {
        json(503, { error: "unavailable", message: "Polyth Link host is not running" });
        return true;
      }
      const revokedIds = deps.store.revokeAll();
      for (const id of revokedIds) {
        void host.request("connection.close_device", { deviceId: id }).catch(() => {});
      }
      for (const [connectionId, live] of [...deps.connections]) {
        if (live.kind === "paired-device") deps.connections.delete(connectionId);
      }
      const result = await host.request("identity.rotate");
      deps.events.emit("tunnel/identity-rotated", { revoked: revokedIds.length });
      json(200, result);
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
  let ingress: Server | null = null;
  let endpointBound = false;
  let ingressReady = false;
  let lastErrorCode: string | undefined;
  const ingressSecret = randomIngressSecret();
  const socketDir = join(host.storageDir, "tunnel");
  mkdirSync(socketDir, { recursive: true });
  const controlSocket = join(socketDir, "host.sock");
  const ingressSocket = join(socketDir, "ingress.sock");

  const syncTrust = async (): Promise<void> => {
    if (!linkHost?.available) return;
    await linkHost.request("trust.sync", {
      devices: store.list().map((device) => ({
        endpointId: device.endpointId,
        deviceId: device.id,
        grants: device.grants,
        grantRevision: device.grantRevision,
        revoked: Boolean(device.revokedAt),
      })),
    }).catch(() => {});
  };

  host.onHttpServer((ctx) => {
    attachTunnelEventsWs(ctx.server, { events, authorize: ctx.authorize });
    if (ctx.listenerId === "public") void startIngress(ctx);
  });

  const resolvePaired = (ingress: Extract<RequestIngress, { kind: "polyth-link" }>): AuthPrincipal | null => {
    const live = connections.get(ingress.connectionId);
    if (!live || live.kind !== "paired-device") return null;
    const device = store.device(live.deviceId);
    if (!device || device.revokedAt) return null;
    return {
      ...live,
      grants: device.grants,
      grantRevision: device.grantRevision,
      transport: ingress.transport,
    };
  };

  const startIngress = async (ctx: HttpServerContext): Promise<void> => {
    try { unlinkSync(ingressSocket); } catch { /* first boot */ }
    ingress = createServer((req, res) => {
      const token = header(req, "x-polyth-internal-token");
      const connectionId = header(req, "x-polyth-internal-connection");
      if (token !== ingressSecret || !connectionId) {
        res.writeHead(403); res.end(); return;
      }
      const ingressKind = lookup(connectionId);
      if (!ingressKind) {
        res.writeHead(403); res.end(); return;
      }
      void ctx.dispatch(req, res, ingressKind);
    });
    await new Promise<void>((resolve, reject) => {
      ingress!.listen(ingressSocket, () => resolve());
      ingress!.on("error", reject);
    });
    ingressReady = true;
    host.attachHttpChannels({
      server: ingress,
      listenerId: "polyth-link",
      dispatch: ctx.dispatch,
      resolve: ctx.resolve,
      authorize: (req) => {
        const token = header(req, "x-polyth-internal-token");
        const connectionId = header(req, "x-polyth-internal-connection");
        if (token !== ingressSecret || !connectionId) return false;
        const kind = lookup(connectionId);
        if (!kind) return false;
        const resolution = ctx.resolve(req, kind);
        if (!resolution.authenticated || resolution.principal.kind !== "paired-device") return false;
        const url = new URL(req.url ?? "/", "http://x");
        const policies = [
          { owner: "core", policy: { routeScopes: ["core"], http: [], websocket: [
            { path: "/ws", capability: REMOTE_CAPABILITY.coreSessionsRead },
            { path: "/ws/tunnel", capability: REMOTE_CAPABILITY.tunnelStatusRead },
          ] } },
          ...host.remotePolicies(),
        ];
        for (const owned of policies) {
          for (const rule of owned.policy.websocket ?? []) {
            if (matchRemotePath(rule.path, url.pathname) && resolution.principal.grants.includes(rule.capability)) {
              return true;
            }
          }
        }
        return false;
      },
    });
  };

  const lookup = (connectionId: string): Extract<RequestIngress, { kind: "polyth-link" }> | null => {
    const principal = connections.get(connectionId);
    if (!principal || principal.kind !== "paired-device") return null;
    if (principal.connectionId !== connectionId) return null;
    const device = store.device(principal.deviceId);
    if (!device || device.revokedAt) {
      connections.delete(connectionId);
      return null;
    }
    return { kind: "polyth-link", connectionId, transport: principal.transport };
  };

  host.attachPairedDeviceResolver(resolvePaired);

  const liveSnapshot = async () => {
    let fingerprint: string | null = null;
    let identityError: string | undefined;
    let identityAvailable = false;
    try {
      if (linkHost?.available) {
        const identity = await linkHost.request("identity.status");
        fingerprint = typeof identity.fingerprint === "string" && identity.fingerprint
          ? identity.fingerprint
          : null;
        identityAvailable = Boolean(fingerprint);
      }
    } catch (error) {
      identityError = error instanceof Error ? error.message : "host-identity-unavailable";
      lastErrorCode = "host-identity-unavailable";
    }
    const platformSupported = linkHost ? linkHost.platformSupported : process.platform !== "win32";
    let directConnections = 0;
    let relayConnections = 0;
    for (const principal of connections.values()) {
      if (principal.kind !== "paired-device") continue;
      if (principal.transport === "relay") relayConnections += 1;
      else directConnections += 1;
    }
    return {
      platformSupported,
      hostBinaryFound: Boolean(linkHost?.binaryFound),
      hostProcessReady: Boolean(linkHost?.processReady && linkHost.available),
      endpointBound,
      ingressReady,
      identityAvailable,
      hostFingerprint: fingerprint,
      ...(identityError ? { identityError } : {}),
      lastErrorCode: lastErrorCode ?? linkHost?.lastErrorCode,
      activePolicy: endpointBound ? "direct-preferred" as const : null,
      relayConfigured: false,
      activeConnections: connections.size,
      activeDevices: store.list().filter((device) => !device.revokedAt).length,
      directConnections,
      relayConnections,
    };
  };

  return {
    remoteAccess: TUNNEL_REMOTE_ACCESS,
    routes: tunnelRoutes({
      store,
      events,
      host: () => linkHost,
      connections,
      status: async () => buildTunnelStatus(await liveSnapshot()),
      diagnostics: async () => buildTunnelDiagnostics(await liveSnapshot()),
    }),
    async onEnable() {
      endpointBound = false;
      lastErrorCode = undefined;
      try {
        linkHost = await startLinkHost({ dataDir: host.storageDir, socketPath: controlSocket });
        if (!linkHost.available) {
          lastErrorCode = linkHost.lastErrorCode ?? "host-binary-missing";
          return;
        }
        linkHost.onEvent((event) => {
          events.emit(event.type, event);
          if (event.type === "tunnel/pairing-committing") {
            const endpointId = String(event.endpointId ?? "");
            if (!endpointId) return;
            try {
              const device = store.commitDevice({
                endpointId,
                label: String(event.label ?? "Mobile device"),
                platform: event.platform ? String(event.platform) : undefined,
                grants: Array.isArray(event.grants) ? event.grants.map(String) : [],
                pairedVia: "polyth-link",
              });
              void linkHost?.request("pairing.finish", { id: String(event.pairingId ?? "") });
              void syncTrust();
              events.emit("tunnel/device-added", { id: device.id });
            } catch {
              void linkHost?.request("pairing.storage_failed", { id: String(event.pairingId ?? "") });
            }
          }
          if (event.type === "tunnel/pairing-storage-failed") {
            const endpointId = String(event.endpointId ?? "");
            const device = endpointId ? store.deviceByEndpoint(endpointId) : undefined;
            if (device) {
              store.revoke(device.id);
              for (const [connectionId, principal] of connections) {
                if (principal.kind === "paired-device" && principal.deviceId === device.id) {
                  connections.delete(connectionId);
                }
              }
              void linkHost?.request("connection.close_device", { deviceId: device.id }).catch(() => {});
            }
          }
          if (event.type === "tunnel/connection-opened") {
            const connectionId = String(event.connectionId ?? "");
            const deviceId = String(event.deviceId ?? "");
            const device = store.device(deviceId);
            if (!connectionId || !device || device.revokedAt) return;
            connections.set(connectionId, {
              kind: "paired-device",
              deviceId: device.id,
              deviceEndpointId: device.endpointId,
              connectionId,
              transport: event.transport === "relay" ? "relay" : "direct",
              grants: device.grants,
              grantRevision: device.grantRevision,
            });
            store.touch(device.id, event.transport === "relay" ? "relay" : "direct");
          }
          if (event.type === "tunnel/connection-closed") {
            connections.delete(String(event.connectionId ?? ""));
          }
        });
        try {
          await linkHost.request("ingress.configure", {
            socket: ingressSocket,
            secret: ingressSecret,
          });
        } catch (error) {
          lastErrorCode = "ingress-configure-failed";
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
      endpointBound = false;
      ingressReady = false;
      await linkHost?.close();
      linkHost = null;
      connections.clear();
      await new Promise<void>((resolve) => ingress?.close(() => resolve()) ?? resolve());
      ingress = null;
    },
  };
}

const header = (req: IncomingMessage, name: string): string | undefined => {
  const raw = req.headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
};
