// WS gateway: gap-fill from durable log, then live. No race window.
import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import type { SessionEvent, SessionProjection, SessionService } from "@polyth/contracts";
import type { Broadcaster } from "./sessions.ts";

interface Sub { sessionId: string | null; afterSeq: number; caughtUp: boolean }

export function attachWs(server: Server, sessions: SessionService): Broadcaster {
  const wss = new WebSocketServer({ server, path: "/ws" });
  const clients = new Map<WebSocket, Sub>();

  const send = (ws: WebSocket, msg: unknown) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  wss.on("connection", (ws) => {
    const sub: Sub = { sessionId: null, afterSeq: 0, caughtUp: true };
    clients.set(ws, sub);
    ws.on("message", async (raw) => {
      let msg: { type?: string; sessionId?: string; afterSeq?: number };
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.type !== "subscribe") return;
      sub.sessionId = msg.sessionId ?? null;
      sub.afterSeq = Number(msg.afterSeq ?? 0);
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
