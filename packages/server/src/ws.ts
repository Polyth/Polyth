// WS gateway: gap-fill from durable log, then live. No race window.
import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import type { IncomingMessage } from "node:http";
import type {
  AuthPrincipal,
  ClientSettingsDto,
  NotificationRecord,
  PackageDescriptorDto,
  SessionEvent,
  SessionProjection,
  SessionService,
} from "@polyth/contracts";
import { REMOTE_CAPABILITY, isLocalUiPrincipal } from "@polyth/contracts";
import type { BrowserFrame, BrowserService } from "@polyth/browser";
import type { ChatWorkspaceFrameBus, ChatWorkspaceFrame, ChatWorkspaceTabEvent } from "@polyth/contracts";
import type { DictationService } from "@polyth/dictation";
import type { Broadcaster } from "./sessions.ts";
import type { SpaceGateway } from "./spaces.ts";
import { parseSpaceCookie } from "./spaces.ts";
import {
  allowWsCapability,
  claimWsUpgrade,
  closeWs,
  defaultWsIdentity,
  denyUpgrade,
  liveWsPrincipal,
  normalizeWsAttachAuth,
  type WsAttachAuth,
  type WsAuthorize,
} from "@polyth/plugins";

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
  chatTabId: string | null;
  chatAfterRevision: number;
  chatPopupRevisions: Map<string, number>;
  chatVisible: boolean;
  pendingChatFrame: ChatWorkspaceFrame | null;
  audioCount: number;
  principal: AuthPrincipal;
  refreshPrincipal?: (principal: AuthPrincipal) => AuthPrincipal | null;
  /** Tenant this socket is attached to. Null when tenancy is not composed
   *  (bare gateways in tests) — fan-out then behaves as it did pre-tenancy. */
  spaceId: string | null;
  /** Tenant-scoped session service for this socket's gap-fill and snapshots. */
  sessions: SessionService;
}

// WP15: dictation audio gets its own rate window (higher than control msgs).
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

export interface WsGateway extends Broadcaster {
  attach(server: Server, auth?: WsAuthorize | WsAttachAuth): void;
  close(): void;
}

export function createWsGateway(
  sessions: SessionService,
  browser?: BrowserService,
  dictation?: DictationService,
  /** Tenancy boundary. When present, every socket is bound to one Space at
   *  upgrade time and both gap-fill and live fan-out are filtered by it. */
  spaces?: SpaceGateway,
  chatWorkspace?: ChatWorkspaceFrameBus,
): WsGateway {
  // noServer + manual upgrade matcher: a WSS bound with {server, path} aborts
  // *every* unmatched upgrade with 400, which would kill the terminal channel's
  // /ws/terminal/:id handshakes. Pass-through matching keeps both channels live.
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Map<WebSocket, Sub>();
  const attached = new WeakSet<Server>();
  const browserDisposals: Array<{ dispose(): void }> = [];
  const chatDisposals: Array<{ dispose(): void }> = [];
  const upgradeReleases: Array<() => void> = [];
  let closed = false;

  const send = (ws: WebSocket, msg: unknown) => {
    if (closed || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(msg));
  };

  /** Owning Space of `sessionId`, looked up once per fan-out rather than once
   *  per socket. With no tenancy composed every socket sees everything, which
   *  is the pre-tenancy behavior bare gateways in tests rely on. */
  const spaceOf = (sessionId: string): (() => string | undefined) => {
    let resolved: string | undefined;
    let looked = false;
    return () => {
      if (!looked) { looked = true; resolved = spaces?.spaceOfSession(sessionId); }
      return resolved;
    };
  };
  const inSpace = (sub: Sub, owner: () => string | undefined): boolean =>
    sub.spaceId === null || !spaces || owner() === sub.spaceId;

  const currentPrincipal = (ws: WebSocket, sub: Sub): AuthPrincipal | null => {
    const live = liveWsPrincipal(sub.principal, sub.refreshPrincipal);
    if (!live) {
      closeWs(ws);
      clients.delete(ws);
      return null;
    }
    sub.principal = live;
    return live;
  };

  const requireCap = (ws: WebSocket, sub: Sub, capability: string): boolean => {
    const live = currentPrincipal(ws, sub);
    if (!allowWsCapability(live, capability)) {
      send(ws, { type: "error", code: "forbidden", message: "missing capability" });
      return false;
    }
    return true;
  };

  const chatFrameMsg = (f: ChatWorkspaceFrame) => ({
    type: "chat-workspace/frame",
    spaceId: f.spaceId,
    tabId: f.tabId,
    revision: f.revision,
    mime: f.mime,
    data: Buffer.from(f.data).toString("base64"),
    width: f.width,
    height: f.height,
    ...(f.popupId ? { popupId: f.popupId } : {}),
  });

  const deliverChatFrame = (ws: WebSocket, sub: Sub, frame: ChatWorkspaceFrame): void => {
    const live = currentPrincipal(ws, sub);
    if (!allowWsCapability(live, REMOTE_CAPABILITY.browserUse)) return;
    if (sub.spaceId !== null && frame.spaceId !== sub.spaceId) return;
    if (frame.popupId) {
      const afterPopup = sub.chatPopupRevisions.get(frame.popupId) ?? 0;
      if (frame.revision <= afterPopup) return;
    } else if (frame.revision <= sub.chatAfterRevision) {
      return;
    }
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > FRAME_HIGH_WATER) {
      sub.pendingChatFrame = frame;
      return;
    }
    sub.pendingChatFrame = null;
    if (frame.popupId) sub.chatPopupRevisions.set(frame.popupId, frame.revision);
    else sub.chatAfterRevision = frame.revision;
    send(ws, chatFrameMsg(frame));
  };

  const chatEventMsg = (event: ChatWorkspaceTabEvent, includeClipboardText: boolean) => ({
    type: "chat-workspace/event",
    spaceId: event.spaceId,
    tabId: event.tabId,
    kind: event.kind,
    ...(event.origin ? { origin: event.origin } : {}),
    ...(event.reason ? { reason: event.reason } : {}),
    ...(event.message ? { message: event.message } : {}),
    ...(event.url ? { url: event.url } : {}),
    ...(event.popupId ? { popupId: event.popupId } : {}),
    ...(includeClipboardText && event.text ? { text: event.text } : {}),
  });

  const deliverChatEvent = (ws: WebSocket, sub: Sub, event: ChatWorkspaceTabEvent): void => {
    const live = currentPrincipal(ws, sub);
    if (!allowWsCapability(live, REMOTE_CAPABILITY.browserUse)) return;
    if (sub.spaceId !== null && event.spaceId !== sub.spaceId) return;
    if (sub.chatTabId !== event.tabId) return;
    if (ws.readyState !== WebSocket.OPEN) return;
    const includeClipboardText = event.kind === "clipboard-written";
    send(ws, chatEventMsg(event, includeClipboardText));
  };
  const frameMsg = (f: BrowserFrame) => ({
    type: "browser/frame",
    browserSessionId: f.browserSessionId,
    revision: f.revision,
    mime: f.mime,
    data: Buffer.from(f.data).toString("base64"),
  });

  const deliverFrame = (ws: WebSocket, sub: Sub, frame: BrowserFrame): void => {
    const live = currentPrincipal(ws, sub);
    if (!allowWsCapability(live, REMOTE_CAPABILITY.browserUse)) return;
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
      if (sub.pendingChatFrame && ws.bufferedAmount <= FRAME_HIGH_WATER) {
        deliverChatFrame(ws, sub, sub.pendingChatFrame);
      }
    }
  }, 250);
  flusher.unref?.();

  if (browser) {
    const onFrame = browser.onFrame((frame) => {
      if (closed) return;
      for (const [ws, sub] of clients) {
        if (sub.browserSessionId === frame.browserSessionId) deliverFrame(ws, sub, frame);
      }
    });
    const onEvent = browser.onEvent((event) => {
      if (closed) return;
      for (const [ws, sub] of clients) {
        if (sub.browserSessionId === event.browserSessionId) {
          const live = currentPrincipal(ws, sub);
          if (!allowWsCapability(live, REMOTE_CAPABILITY.browserUse)) continue;
          send(ws, { type: "browser/event", browserSessionId: event.browserSessionId, event });
        }
      }
    });
    if (onFrame) browserDisposals.push(onFrame);
    if (onEvent) browserDisposals.push(onEvent);
  }

  if (chatWorkspace) {
    const onChatFrame = chatWorkspace.onFrame((frame) => {
      if (closed) return;
      for (const [ws, sub] of clients) {
        if (sub.chatTabId === frame.tabId) deliverChatFrame(ws, sub, frame);
      }
    });
    const onChatEvent = chatWorkspace.onEvent((event) => {
      if (closed) return;
      for (const [ws, sub] of clients) {
        deliverChatEvent(ws, sub, event);
      }
    });
    chatDisposals.push(onChatFrame);
    chatDisposals.push(onChatEvent);
  }

  wss.on("connection", (ws, req: IncomingMessage) => {
    const attachAuth = (ws as WebSocket & { _polythAuth?: WsAttachAuth })._polythAuth ?? {};
    const resolution = defaultWsIdentity(attachAuth, req);
    // The socket's Space is resolved ONCE, from the authenticated principal
    // and the remembered-space hint, exactly like an HTTP request. Switching
    // Space reconnects the socket rather than re-scoping a live one, so a
    // stream can never straddle two tenants.
    let socketSpaceId: string | null = null;
    let socketSessions = sessions;
    if (spaces) {
      try {
        const ctx = spaces.resolve(resolution.principal, {
          remembered: parseSpaceCookie(req.headers.cookie, spaces.cookieName),
        });
        socketSpaceId = ctx.spaceId;
        socketSessions = spaces.services(ctx).sessions;
      } catch {
        // No usable tenant: the socket stays connected but subscribes to
        // nothing. Closing here would fight the client's reconnect loop.
        socketSpaceId = null;
        socketSessions = {
          ...sessions,
          events: async () => [],
          list: async () => [],
        };
      }
    }
    const sub: Sub = {
      spaceId: socketSpaceId,
      sessions: socketSessions,
      sessionId: null, afterSeq: 0, caughtUp: true,
      busy: false, pendingSubscribe: null, snapshotScope: null, liveBuffer: [],
      windowStart: Date.now(), windowCount: 0,
      browserSessionId: null, browserAfterRevision: 0, pendingFrame: null,
      chatTabId: null, chatAfterRevision: 0, chatPopupRevisions: new Map(), chatVisible: true, pendingChatFrame: null,
      audioCount: 0,
      principal: resolution.principal,
      refreshPrincipal: attachAuth.refreshPrincipal,
    };
    clients.set(ws, sub);
    attachAuth.pairedSockets?.bind(ws, resolution.principal, () => closeWs(ws));
    ws.on("close", () => {
      attachAuth.pairedSockets?.unbind(ws);
      clients.delete(ws);
    });
    ws.on("message", async (raw) => {
      if (closed) return;
      let msg: {
        type?: string; sessionId?: string; afterSeq?: number; projectId?: string;
        browserSessionId?: string; afterRevision?: number;
        tabId?: string; visible?: boolean; quality?: number;
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
        if (!requireCap(ws, sub, REMOTE_CAPABILITY.dictationUse)) return;
        const dto = msg.dictationId ? dictation.get(msg.dictationId) : null;
        if (!dto) send(ws, { type: "dictation/error", dictationId: msg.dictationId, code: "not-found" });
        else send(ws, { type: "dictation/state", dictationId: dto.id, session: dto });
        return;
      }
      if (isAudio && dictation) {
        if (!requireCap(ws, sub, REMOTE_CAPABILITY.dictationUse)) return;
        const id = msg.dictationId ?? "";
        try {
          const pcm = new Uint8Array(Buffer.from(String(msg.pcm ?? ""), "base64"));
          const r = await dictation.push(id, Number(msg.seq), pcm);
          if (closed) return;
          if (!requireCap(ws, sub, REMOTE_CAPABILITY.dictationUse)) return;
          send(ws, { type: "dictation/ack", dictationId: id, seq: r.ack, duplicate: r.duplicate });
          if (r.transcript) {
            send(ws, {
              type: "dictation/transcript", dictationId: id,
              revision: r.transcript.revision, text: r.transcript.text, final: r.transcript.final,
            });
          }
        } catch (err) {
          if (!requireCap(ws, sub, REMOTE_CAPABILITY.dictationUse)) return;
          const e = err as Error & { code?: string };
          send(ws, { type: "dictation/error", dictationId: id, code: e.code ?? "internal", message: e.message });
        }
        return;
      }
      if (msg.type === "chat-workspace/subscribe" && chatWorkspace) {
        if (!requireCap(ws, sub, REMOTE_CAPABILITY.browserUse)) return;
        sub.chatTabId = msg.tabId ?? null;
        sub.chatAfterRevision = Number(msg.afterRevision ?? 0);
        sub.chatVisible = msg.visible !== false;
        sub.pendingChatFrame = null;
        sub.chatPopupRevisions.clear();
        if (sub.chatTabId) {
          chatWorkspace.setTabStream(sub.spaceId, sub.chatTabId, sub.chatVisible, Number(msg.quality ?? 60));
          const latest = chatWorkspace.latestFrame(sub.spaceId ?? "", sub.chatTabId, sub.chatAfterRevision);
          if (latest && (sub.spaceId === null || latest.spaceId === sub.spaceId)) {
            deliverChatFrame(ws, sub, latest);
          }
        }
        return;
      }
      if (msg.type === "browser/subscribe" && browser) {
        if (!requireCap(ws, sub, REMOTE_CAPABILITY.browserUse)) return;
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
      if (!requireCap(ws, sub, REMOTE_CAPABILITY.coreSessionsRead)) return;
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
        subscriptions: while (sub.pendingSubscribe) {
          if (closed) {
            sub.pendingSubscribe = null;
            sub.liveBuffer = [];
            break;
          }
          if (!requireCap(ws, sub, REMOTE_CAPABILITY.coreSessionsRead)) {
            sub.pendingSubscribe = null;
            sub.liveBuffer = [];
            break;
          }
          const cur = sub.pendingSubscribe;
          sub.pendingSubscribe = null;
          sub.sessionId = cur.sessionId;
          sub.afterSeq = cur.afterSeq;
          sub.liveBuffer = [];
          if (sub.sessionId) {
            sub.caughtUp = false;
            try {
              const gap = await sub.sessions.events(sub.sessionId, sub.afterSeq);
              if (closed) return;
              if (!requireCap(ws, sub, REMOTE_CAPABILITY.coreSessionsRead)) {
                sub.caughtUp = true;
                sub.liveBuffer = [];
                sub.pendingSubscribe = null;
                break subscriptions;
              }
              // Batched frames: one envelope per chunk, not one per event.
              for (let i = 0; i < gap.length; i += GAP_FILL_CHUNK) {
                if (!requireCap(ws, sub, REMOTE_CAPABILITY.coreSessionsRead)) break subscriptions;
                send(ws, { type: "events", events: gap.slice(i, i + GAP_FILL_CHUNK) });
              }
              sub.afterSeq = gap.length ? gap[gap.length - 1]!.seq : sub.afterSeq;
            } catch (err) {
              if (!requireCap(ws, sub, REMOTE_CAPABILITY.coreSessionsRead)) {
                sub.caughtUp = true;
                sub.liveBuffer = [];
                sub.pendingSubscribe = null;
                break subscriptions;
              }
              send(ws, { type: "error", code: "gap-fill", message: String(err) });
            }
            // Flip caughtUp and drain the buffer in one synchronous block:
            // nothing can interleave, so every live event lands exactly once —
            // either via the flush here or via the live path afterwards.
            sub.caughtUp = true;
            const buffered = sub.liveBuffer;
            sub.liveBuffer = [];
            for (const ev of buffered) {
              if (!requireCap(ws, sub, REMOTE_CAPABILITY.coreSessionsRead)) break subscriptions;
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
              if (!requireCap(ws, sub, REMOTE_CAPABILITY.coreSessionsRead)) break subscriptions;
              const list = await sub.sessions.list(cur.projectId ?? undefined);
              if (closed) return;
              if (!requireCap(ws, sub, REMOTE_CAPABILITY.coreSessionsRead)) break subscriptions;
              for (let i = 0; i < list.length; i += GAP_FILL_CHUNK) {
                if (!requireCap(ws, sub, REMOTE_CAPABILITY.coreSessionsRead)) break subscriptions;
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
  });

  return {
    attach(server, authArg) {
      if (closed || attached.has(server)) return;
      attached.add(server);
      const auth = normalizeWsAttachAuth(authArg);
      const stopClaim = claimWsUpgrade(server, (req, socket, head) => {
        if (closed) return false;
        if (new URL(req.url ?? "/", "http://x").pathname !== "/ws") return false;
        const resolution = defaultWsIdentity(auth, req);
        if (auth.authorize ? !auth.authorize(req) : !resolution.authenticated) {
          denyUpgrade(socket, 401);
          return true;
        }
        if (!allowWsCapability(resolution.principal, REMOTE_CAPABILITY.coreSessionsRead)) {
          denyUpgrade(socket, 403);
          return true;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          (ws as WebSocket & { _polythAuth?: WsAttachAuth })._polythAuth = auth;
          wss.emit("connection", ws, req);
        });
        return true;
      });
      const onServerClose = () => { stopClaim(); };
      upgradeReleases.push(() => {
        server.off("close", onServerClose);
        stopClaim();
      });
      server.on("close", onServerClose);
    },
    event(ev: SessionEvent) {
      if (closed) return;
      const owner = spaceOf(ev.sessionId);
      for (const [ws, sub] of clients) {
        const live = currentPrincipal(ws, sub);
        if (!allowWsCapability(live, REMOTE_CAPABILITY.coreSessionsRead)) continue;
        // Tenant filter comes first: a socket must never observe even the
        // existence of another Space's session traffic.
        if (!inSpace(sub, owner)) continue;
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
      if (closed) return;
      for (const [ws, sub] of clients) {
        const live = currentPrincipal(ws, sub);
        if (!allowWsCapability(live, REMOTE_CAPABILITY.coreSessionsRead)) continue;
        // The projection carries its own owner, so no lookup is needed.
        if (sub.spaceId !== null && p.spaceId !== sub.spaceId) continue;
        send(ws, { type: "projection", session: p });
      }
    },
    notification(record: NotificationRecord) {
      if (closed) return;
      // NTF-01: global inbox fan-out — every authenticated socket receives it
      // regardless of its active-session subscription. Never buffered into
      // liveBuffer, never counted against afterSeq, never part of gap-fill;
      // REST `after=<ts>` catch-up owns reconnect delivery.
      const owner = spaceOf(record.sessionId);
      for (const [ws, sub] of clients) {
        const live = currentPrincipal(ws, sub);
        if (!allowWsCapability(live, REMOTE_CAPABILITY.coreNotificationsRead)) continue;
        if (!inSpace(sub, owner)) continue;
        send(ws, { type: "notification/added", notification: record });
      }
    },
    pluginChanged(packageId: string) {
      if (closed) return;
      for (const [ws, sub] of clients) {
        const live = currentPrincipal(ws, sub);
        if (!live || !isLocalUiPrincipal(live)) continue;
        send(ws, { type: "plugin/changed", packageId });
      }
    },
    packageChanged(pkg: PackageDescriptorDto) {
      if (closed) return;
      for (const [ws, sub] of clients) {
        const live = currentPrincipal(ws, sub);
        if (!live || !isLocalUiPrincipal(live)) continue;
        send(ws, { type: "package/changed", package: pkg });
      }
    },
    clientSettingsChanged(settings: ClientSettingsDto) {
      if (closed) return;
      // Every socket hears it, including the author's — the client drops the
      // echo by revision. Never buffered, never part of gap-fill.
      for (const [ws, sub] of clients) {
        const live = currentPrincipal(ws, sub);
        if (!live || !isLocalUiPrincipal(live)) continue;
        send(ws, { type: "client-settings/changed", settings });
      }
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(flusher);
      for (const disposal of browserDisposals.splice(0)) {
        try { disposal.dispose(); } catch { /* already disposed */ }
      }
      for (const disposal of chatDisposals.splice(0)) {
        try { disposal.dispose(); } catch { /* already disposed */ }
      }
      for (const release of upgradeReleases.splice(0)) {
        try { release(); } catch { /* already released */ }
      }
      for (const ws of clients.keys()) {
        try { ws.terminate(); } catch { /* already closing */ }
      }
      clients.clear();
      wss.close();
    },
  };
}

export function attachWs(
  server: Server,
  sessions: SessionService,
  browser?: BrowserService,
  dictation?: DictationService,
  authorize?: WsAuthorize | WsAttachAuth,
): WsGateway {
  const gateway = createWsGateway(sessions, browser, dictation);
  gateway.attach(server, authorize);
  return gateway;
}
