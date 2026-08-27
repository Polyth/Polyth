// WS gateway: gap-fill from durable log, then live. No race window.
import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type {
  InstalledPluginDto,
  NotificationRecord,
  PackageDescriptorDto,
  SessionEvent,
  SessionProjection,
  SessionService,
} from "@polyth/contracts";
import type { BrowserFrame, BrowserService } from "@polyth/browser";
import type { DictationService } from "@polyth/dictation";
import type { Broadcaster } from "./sessions.ts";

interface Sub {
  sessionId: string | null;
  afterSeq: number;
  caughtUp: boolean;
  busy: boolean; // a subscribe is already being processed for this socket
  // Latest subscribe that arrived while busy; processed after the in-flight
  // gap-fill finishes so rapid session switches never lose their gap-fill.
  pendingSubscribe: { sessionId: string | null; afterSeq: number; projectId: string | null } | null;
  // Scope ("*" or a projectId) whose projection snapshot this socket already
  // received. Live projection broadcasts keep it current afterwards, so a
  // session switch within the same project skips the redundant snapshot.
  snapshotScope: string | null;
  // Live events broadcast while gap-fill is awaiting the DB; their seqs sit
  // above the gap-fill boundary, so they are flushed (seq-deduped) afterwards
  // instead of being dropped.
  liveBuffer: SessionEvent[];
  windowStart: number;
  windowCount: number;
  // WP14: browser frame stream. Backpressure keeps only the newest
  // undelivered frame per socket; reconnect resumes via afterRevision.
  browserSessionId: string | null;
  browserAfterRevision: number;
  pendingFrame: BrowserFrame | null;
  // WP15: dictation audio gets its own rate window (higher than control msgs).
  audioCount: number;
}

// A client re-subscribing faster than this is either buggy or hostile — either
// way it must never be able to turn "one gap-fill + one projections fan-out"
// into an unbounded number of concurrent DB reads / JSON serializations.
const MAX_MESSAGES_PER_SECOND = 20;
// PCM chunks stream ~4-10/s; the ceiling only exists to stop floods.
const MAX_AUDIO_PER_SECOND = 100;
// Above this many buffered bytes, hold frames (newest only) until drained.
const FRAME_HIGH_WATER = 1_000_000;
// Gap-fill events travel in batched frames: one JSON envelope + one socket
// write per chunk instead of one per event.
const GAP_FILL_CHUNK = 500;

export function attachWs(
  server: Server,
  sessions: SessionService,
  browser?: BrowserService,
  dictation?: DictationService,
  /** F16: when provided, upgrades without a valid auth cookie are rejected. */
  authorize?: (req: IncomingMessage) => boolean,
): Broadcaster {
  // noServer + manual upgrade matcher: a WSS bound with {server, path} aborts
  // *every* unmatched upgrade with 400, which would kill the terminal channel's
  // /ws/terminal/:id handshakes. Pass-through matching keeps both channels live.
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Map<WebSocket, Sub>();

  const upgrade = (req: IncomingMessage, socket: Socket, head: Buffer) => {
    if (new URL(req.url ?? "/", "http://x").pathname !== "/ws") return;
    if (authorize && !authorize(req)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  };
  server.on("upgrade", upgrade);

  const send = (ws: WebSocket, msg: unknown) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  const frameMsg = (f: BrowserFrame) => ({
    type: "browser/frame",
    browserSessionId: f.browserSessionId,
    revision: f.revision,
    mime: f.mime,
    data: Buffer.from(f.data).toString("base64"),
  });

  const deliverFrame = (ws: WebSocket, sub: Sub, frame: BrowserFrame): void => {
    if (frame.revision <= sub.browserAfterRevision) return; // already seen
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > FRAME_HIGH_WATER) {
      sub.pendingFrame = frame; // newest replaces older undelivered
      return;
    }
    sub.pendingFrame = null;
    sub.browserAfterRevision = frame.revision;
    send(ws, frameMsg(frame));
  };

  // Drain loop: pending frames flush once the socket buffer clears.
  const flusher = setInterval(() => {
    for (const [ws, sub] of clients) {
      if (sub.pendingFrame && ws.bufferedAmount <= FRAME_HIGH_WATER) {
        deliverFrame(ws, sub, sub.pendingFrame);
      }
    }
  }, 250);
  flusher.unref?.();

  if (browser) {
    browser.onFrame((frame) => {
      for (const [ws, sub] of clients) {
        if (sub.browserSessionId === frame.browserSessionId) deliverFrame(ws, sub, frame);
      }
    });
    browser.onEvent((event) => {
      for (const [ws, sub] of clients) {
        if (sub.browserSessionId === event.browserSessionId) {
          send(ws, { type: "browser/event", browserSessionId: event.browserSessionId, event });
        }
      }
    });
  }

  wss.on("connection", (ws) => {
    const sub: Sub = {
      sessionId: null, afterSeq: 0, caughtUp: true,
      busy: false, pendingSubscribe: null, snapshotScope: null, liveBuffer: [],
      windowStart: Date.now(), windowCount: 0,
      browserSessionId: null, browserAfterRevision: 0, pendingFrame: null,
      audioCount: 0,
    };
    clients.set(ws, sub);
    ws.on("message", async (raw) => {
      let msg: {
        type?: string; sessionId?: string; afterSeq?: number; projectId?: string;
        browserSessionId?: string; afterRevision?: number;
        dictationId?: string; seq?: number; pcm?: string;
      };
      try { msg = JSON.parse(String(raw)); } catch { return; }
      // Audio chunks are cheap in-memory pushes and stream continuously, so
      // they get their own (higher) rate budget; everything else keeps the
      // strict cap that protects gap-fill DB reads.
      const isAudio = msg.type === "dictation/audio";
      const now = Date.now();
      if (now - sub.windowStart >= 1000) {
        sub.windowStart = now;
        sub.windowCount = 0;
        sub.audioCount = 0;
      }
      if (isAudio) {
        sub.audioCount++;
        if (sub.audioCount > MAX_AUDIO_PER_SECOND) {
          ws.close(1008, "audio rate exceeded");
          return;
        }
      } else {
        sub.windowCount++;
        if (sub.windowCount > MAX_MESSAGES_PER_SECOND) {
          ws.close(1008, "message rate exceeded");
          return;
        }
      }
      if (msg.type === "dictation/start" && dictation) {
        const dto = msg.dictationId ? dictation.get(msg.dictationId) : null;
        if (!dto) send(ws, { type: "dictation/error", dictationId: msg.dictationId, code: "not-found" });
        else send(ws, { type: "dictation/state", dictationId: dto.id, session: dto });
        return;
      }
      if (isAudio && dictation) {
        const id = msg.dictationId ?? "";
        try {
          const pcm = new Uint8Array(Buffer.from(String(msg.pcm ?? ""), "base64"));
          const r = await dictation.push(id, Number(msg.seq), pcm);
          send(ws, { type: "dictation/ack", dictationId: id, seq: r.ack, duplicate: r.duplicate });
          if (r.transcript) {
            send(ws, {
              type: "dictation/transcript", dictationId: id,
              revision: r.transcript.revision, text: r.transcript.text, final: r.transcript.final,
            });
          }
        } catch (err) {
          const e = err as Error & { code?: string };
          send(ws, { type: "dictation/error", dictationId: id, code: e.code ?? "internal", message: e.message });
        }
        return;
      }
      if (msg.type === "browser/subscribe" && browser) {
        sub.browserSessionId = msg.browserSessionId ?? null;
        sub.browserAfterRevision = Number(msg.afterRevision ?? 0);
        sub.pendingFrame = null;
        // reconnect resumes at revision: newest frame past the client's is sent
        if (sub.browserSessionId) {
          const latest = browser.latestFrame(sub.browserSessionId, sub.browserAfterRevision);
          if (latest) deliverFrame(ws, sub, latest);
        }
        return;
      }
      if (msg.type !== "subscribe") return;
      // One gap-fill + fan-out at a time per socket: a burst of subscribes
      // (buggy client, rapid session switches) must not spawn overlapping
      // DB reads that pile up faster than they can complete. Requests that
      // land while busy are not dropped — the latest one is kept and processed
      // after the in-flight gap-fill finishes.
      sub.pendingSubscribe = {
        sessionId: msg.sessionId ?? null,
        afterSeq: Number(msg.afterSeq ?? 0),
        projectId: typeof msg.projectId === "string" && msg.projectId ? msg.projectId : null,
      };
      if (sub.busy) return;
      sub.busy = true;
      try {
        while (sub.pendingSubscribe) {
          const cur = sub.pendingSubscribe;
          sub.pendingSubscribe = null;
          sub.sessionId = cur.sessionId;
          sub.afterSeq = cur.afterSeq;
          sub.liveBuffer = [];
          if (sub.sessionId) {
            sub.caughtUp = false;
            try {
              const gap = await sessions.events(sub.sessionId, sub.afterSeq);
              // Batched frames: one envelope per chunk, not one per event.
              for (let i = 0; i < gap.length; i += GAP_FILL_CHUNK) {
                send(ws, { type: "events", events: gap.slice(i, i + GAP_FILL_CHUNK) });
              }
              sub.afterSeq = gap.length ? gap[gap.length - 1]!.seq : sub.afterSeq;
            } catch (err) {
              send(ws, { type: "error", code: "gap-fill", message: String(err) });
            }
            // Flip caughtUp and drain the buffer in one synchronous block:
            // nothing can interleave, so every live event lands exactly once —
            // either via the flush here or via the live path afterwards.
            sub.caughtUp = true;
            const buffered = sub.liveBuffer;
            sub.liveBuffer = [];
            for (const ev of buffered) {
              if (ev.seq <= sub.afterSeq) continue; // already sent by gap-fill
              sub.afterSeq = ev.seq;
              send(ws, { type: "event", event: ev });
            }
          } else {
            sub.caughtUp = true;
          }
          // Projection snapshot so the UI can paint the sidebar immediately —
          // scoped to the subscribed project when the client names one, and
          // skipped when this socket already holds the same scope (live
          // projection broadcasts keep it current afterwards).
          const scope = cur.projectId ?? "*";
          if (sub.snapshotScope !== scope) {
            try {
              const list = await sessions.list(cur.projectId ?? undefined);
              for (let i = 0; i < list.length; i += GAP_FILL_CHUNK) {
                send(ws, { type: "projections", sessions: list.slice(i, i + GAP_FILL_CHUNK) });
              }
              sub.snapshotScope = scope;
            } catch { /* non-fatal */ }
          }
        }
      } finally {
        sub.busy = false;
      }
    });
    ws.on("close", () => clients.delete(ws));
  });

  return {
    event(ev: SessionEvent) {
      for (const [ws, sub] of clients) {
        if (sub.sessionId && ev.sessionId !== sub.sessionId) continue;
        if (!sub.caughtUp) {
          // Gap-fill in flight: buffer instead of dropping. These seqs are
          // above the gap-fill boundary, so skipping them would lose them
          // for good; the flush after gap-fill dedupes and delivers.
          sub.liveBuffer.push(ev);
          continue;
        }
        if (sub.sessionId && ev.seq <= sub.afterSeq) continue; // dedupe vs gap-fill
        send(ws, { type: "event", event: ev });
      }
    },
    projection(p: SessionProjection) {
      for (const [ws] of clients) send(ws, { type: "projection", session: p });
    },
    notification(record: NotificationRecord) {
      // NTF-01: global inbox fan-out — every authenticated socket receives it
      // regardless of its active-session subscription. Never buffered into
      // liveBuffer, never counted against afterSeq, never part of gap-fill;
      // REST `after=<ts>` catch-up owns reconnect delivery.
      for (const [ws] of clients) send(ws, { type: "notification/added", notification: record });
    },
    pluginChanged(plugin: InstalledPluginDto) {
      for (const [ws] of clients) send(ws, { type: "plugin/changed", plugin });
    },
    packageChanged(pkg: PackageDescriptorDto) {
      for (const [ws] of clients) send(ws, { type: "package/changed", package: pkg });
    },
  };
}
