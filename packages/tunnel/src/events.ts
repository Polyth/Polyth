import type { IncomingMessage, Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { PackageEvent } from "@polyth/contracts";

const RECENT_LIMIT = 64;

export class TunnelEventBus {
  private revision = 0;
  private readonly listeners = new Set<(event: PackageEvent) => void>();
  private readonly recent: PackageEvent[] = [];

  emit(type: string, data: Record<string, unknown>): PackageEvent {
    this.revision += 1;
    const event: PackageEvent = {
      packageId: "tunnel",
      type,
      revision: this.revision,
      data: data as PackageEvent["data"],
    };
    this.recent.push(event);
    if (this.recent.length > RECENT_LIMIT) this.recent.shift();
    for (const listener of this.listeners) listener(event);
    return event;
  }

  subscribe(listener: (event: PackageEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  snapshotRevision(): number {
    return this.revision;
  }

  snapshot(afterRevision = 0): { revision: number; events: PackageEvent[] } {
    return {
      revision: this.revision,
      events: this.recent.filter((event) => event.revision > afterRevision),
    };
  }
}

export function attachTunnelEventsWs(server: Server, deps: {
  events: TunnelEventBus;
  authorize?: (request: IncomingMessage) => boolean;
}): void {
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<WebSocket>();
  const send = (socket: WebSocket, message: unknown) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };

  wss.on("connection", (socket) => {
    sockets.add(socket);
    send(socket, { type: "tunnel/snapshot", revision: deps.events.snapshotRevision() });
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => sockets.delete(socket));
  });

  const unsubscribe = deps.events.subscribe((event) => {
    for (const socket of sockets) send(socket, event);
  });

  const upgrade = (
    request: IncomingMessage,
    socket: import("node:net").Socket,
    head: Buffer,
  ) => {
    const url = new URL(request.url ?? "/", "http://x");
    if (url.pathname !== "/ws/tunnel") return;
    if (deps.authorize && !deps.authorize(request)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (webSocket) => {
      wss.emit("connection", webSocket, request);
    });
  };
  server.on("upgrade", upgrade);
  server.on("close", () => {
    server.off("upgrade", upgrade);
    unsubscribe();
    wss.close();
  });
}
