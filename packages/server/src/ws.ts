// WS gateway: gap-fill from durable log, then live. No race window.
import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { SessionEvent, SessionProjection, SessionService } from "@polyth/contracts";
import type { Broadcaster } from "./sessions.ts";

interface Sub {
  sessionId: string | null;
  afterSeq: number;
  caughtUp: boolean;
  busy: boolean; // a subscribe is already being processed for this socket
  windowStart: number;
  windowCount: number;
}

// A client re-subscribing faster than this is either buggy or hostile — either
// way it must never be able to turn "one gap-fill + one projections fan-out"
// into an unbounded number of concurrent DB reads / JSON serializations.
const MAX_MESSAGES_PER_SECOND = 20;

export function attachWs(server: Server, sessions: SessionService): Broadcaster {
  // noServer + manual upgrade matcher: a WSS bound with {server, path} aborts
  // *every* unmatched upgrade with 400, which would kill the terminal channel's
  // /ws/terminal/:id handshakes. Pass-through matching keeps both channels live.
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Map<WebSocket, Sub>();

  const upgrade = (req: IncomingMessage, socket: Socket, head: Buffer) => {
    if (new URL(req.url ?? "/", "http://x").pathname !== "/ws") return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  };
  server.on("upgrade", upgrade);

  const send = (ws: WebSocket, msg: unknown) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  wss.on("connection", (ws) => {
    const sub: Sub = {
      sessionId: null, afterSeq: 0, caughtUp: true,
      busy: false, windowStart: Date.now(), windowCount: 0,
    };
    clients.set(ws, sub);
    ws.on("message", async (raw) => {
      const now = Date.now();
      if (now - sub.windowStart >= 1000) {
        sub.windowStart = now;
        sub.windowCount = 0;
      }
      sub.windowCount++;
      if (sub.windowCount > MAX_MESSAGES_PER_SECOND) {
        ws.close(1008, "message rate exceeded");
        return;
      }
      let msg: { type?: string; sessionId?: string; afterSeq?: number };
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.type !== "subscribe") return;
      sub.sessionId = msg.sessionId ?? null;
      sub.afterSeq = Number(msg.afterSeq ?? 0);
      // One gap-fill + fan-out at a time per socket: a burst of subscribes
      // (buggy client, rapid session switches) must not spawn overlapping
      // DB reads that pile up faster than they can complete.
      if (sub.busy) return;
      sub.busy = true;
      try {
        if (sub.sessionId) {
          sub.caughtUp = false;
          try {
            const gap = await sessions.events(sub.sessionId, sub.afterSeq);
            for (const ev of gap) send(ws, { type: "event", event: ev });
            sub.afterSeq = gap.length ? gap[gap.length - 1]!.seq : sub.afterSeq;
          } catch (err) {
            send(ws, { type: "error", code: "gap-fill", message: String(err) });
          }
          sub.caughtUp = true;
        }
        // projections snapshot so UI can paint sidebar immediately
        try {
          for (const p of await sessions.list()) send(ws, { type: "projection", session: p });
        } catch { /* non-fatal */ }
      } finally {
        sub.busy = false;
      }
    });
    ws.on("close", () => clients.delete(ws));
  });

  return {
    event(ev: SessionEvent) {
      for (const [ws, sub] of clients) {
        if (!sub.caughtUp) continue;
        if (sub.sessionId && ev.sessionId !== sub.sessionId) continue;
        if (sub.sessionId && ev.seq <= sub.afterSeq) continue; // dedupe vs gap-fill
        send(ws, { type: "event", event: ev });
      }
    },
    projection(p: SessionProjection) {
      for (const [ws] of clients) send(ws, { type: "projection", session: p });
    },
  };
}
