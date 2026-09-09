import type { IncomingMessage, Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { AuthPrincipal, PackageEvent } from "@polyth/contracts";
import { REMOTE_CAPABILITY } from "@polyth/contracts";
import {
  allowWsCapability,
  claimWsUpgrade,
  closeWs,
  defaultWsIdentity,
  denyUpgrade,
  liveWsPrincipal,
  type WsAttachAuth,
} from "@polyth/plugins";

const RECENT_LIMIT = 64;

const ADMIN_EVENT_KEYS = new Set([
  "endpointId",
  "safetyPhrase",
  "requestedGrants",
  "grants",
  "ticket",
  "qrPayload",
  "qrModules",
  "secret",
  "inviteSecret",
  "phrase",
]);

const principalUserId = (principal: AuthPrincipal): string | undefined => {
  const userId = (principal as AuthPrincipal & { userId?: unknown }).userId;
  return typeof userId === "string" && userId ? userId : undefined;
};

export function redactTunnelStatusEvent(event: PackageEvent): PackageEvent {
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event.data ?? {})) {
    if (ADMIN_EVENT_KEYS.has(key)) continue;
    data[key] = value;
  }
  if (typeof data.deviceId !== "string" && typeof data.id === "string") {
    data.deviceId = data.id;
  }
  return { ...event, data: data as PackageEvent["data"] };
}

export class TunnelEventBus {
  private revision = 0;
  private readonly listeners = new Set<(event: PackageEvent) => void>();
  private readonly recent: PackageEvent[] = [];
  private readonly owners = new WeakMap<PackageEvent, string>();

  emit(type: string, data: Record<string, unknown>, userId?: string): PackageEvent {
    this.revision += 1;
    const event: PackageEvent = {
      packageId: "tunnel",
      type,
      revision: this.revision,
      data: data as PackageEvent["data"],
    };
    if (userId) this.owners.set(event, userId);
    this.recent.push(event);
    if (this.recent.length > RECENT_LIMIT) this.recent.shift();
    for (const listener of this.listeners) listener(event);
    return event;
  }

  visibleTo(event: PackageEvent, userId: string | undefined): boolean {
    const owner = this.owners.get(event);
    return owner === undefined || (userId !== undefined && owner === userId);
  }

  subscribe(listener: (event: PackageEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  snapshotRevision(): number {
    return this.revision;
  }

  snapshot(afterRevision = 0, userId?: string): { revision: number; events: PackageEvent[] } {
    return {
      revision: this.revision,
      events: this.recent.filter((event) =>
        event.revision > afterRevision && (userId === undefined || this.visibleTo(event, userId))),
    };
  }
}

export function attachTunnelEventsWs(server: Server, deps: WsAttachAuth & {
  events: TunnelEventBus;
}): () => void {
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Map<WebSocket, { principal: AuthPrincipal }>();
  const send = (socket: WebSocket, message: unknown) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };

  wss.on("connection", (socket, request: IncomingMessage) => {
    const resolution = defaultWsIdentity(deps, request);
    sockets.set(socket, { principal: resolution.principal });
    deps.pairedSockets?.bind(socket, resolution.principal, () => closeWs(socket));
    send(socket, { type: "tunnel/snapshot", revision: deps.events.snapshotRevision() });
    socket.on("message", () => {
      send(socket, { type: "error", code: "forbidden", message: "tunnel events are read-only" });
    });
    socket.on("close", () => {
      deps.pairedSockets?.unbind(socket);
      sockets.delete(socket);
    });
    socket.on("error", () => {
      deps.pairedSockets?.unbind(socket);
      sockets.delete(socket);
    });
  });

  const unsubscribe = deps.events.subscribe((event) => {
    const redacted = redactTunnelStatusEvent(event);
    for (const [socket, bound] of sockets) {
      const live = liveWsPrincipal(bound.principal, deps.refreshPrincipal);
      if (!live) {
        closeWs(socket);
        continue;
      }
      bound.principal = live;
      if (!allowWsCapability(live, REMOTE_CAPABILITY.tunnelStatusRead)) continue;
      if (!deps.events.visibleTo(event, principalUserId(live))) continue;
      send(socket, redacted);
    }
  });

  const stopClaim = claimWsUpgrade(server, (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://x");
    if (url.pathname !== "/ws/tunnel") return false;
    const resolution = defaultWsIdentity(deps, request);
    if (deps.authorize ? !deps.authorize(request) : !resolution.authenticated) {
      denyUpgrade(socket, 401);
      return true;
    }
    if (!allowWsCapability(resolution.principal, REMOTE_CAPABILITY.tunnelStatusRead)) {
      denyUpgrade(socket, 403);
      return true;
    }
    wss.handleUpgrade(request, socket, head, (webSocket) => {
      wss.emit("connection", webSocket, request);
    });
    return true;
  });
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    server.off("close", stop);
    stopClaim();
    unsubscribe();
    for (const [socket] of sockets) closeWs(socket);
    sockets.clear();
    wss.close();
  };
  server.on("close", stop);
  return stop;
}
