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

interface DictationAudioFrame {
  format: "pcm_s16le";
  dictationId: string;
  seq: number;
  sampleRate: number;
  channels: number;
  payload: Uint8Array;
}

/** Structural feature seam: the core gateway knows dictation session semantics,
 * not the feature package or its binary framing implementation. */
export interface DictationForWs {
  decodeAudioFrame(value: ArrayBuffer | ArrayBufferView): DictationAudioFrame | null;
  get(id: string): {
    id: string;
    format: { encoding: "pcm_s16le"; sampleRate: number; channels: number };
  } | null;
  push(id: string, seq: number, pcm: Uint8Array): Promise<{
    ack: number;
    duplicate: boolean;
    buffered?: boolean;
    transcript?: { revision: number; text: string; final: boolean };
  }>;
}

interface Sub {
  sessionId: string | null;
  afterSeq: number;
  caughtUp: boolean;
  busy: boolean;
  pendingSubscribe: { sessionId: string | null; afterSeq: number; projectId: string | null } | null;
  snapshotScope: string | null;
  liveBuffer: SessionEvent[];
  liveBufferBytes: number;
  liveBufferSeq: Set<number>;
  windowStart: number;
  windowCount: number;
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
  spaceId: string | null;
  sessions: SessionService;
}

const MAX_MESSAGES_PER_SECOND = 20;
const MAX_AUDIO_PER_SECOND = 100;
const FRAME_HIGH_WATER = 1_000_000;
const GAP_FILL_CHUNK = 500;
/** A replay read can race a busy producer. Bound that race per client; a
 * canonical event is never silently discarded -- overflow closes for replay. */
const LIVE_BUFFER_MAX_EVENTS = 2_048;
const LIVE_BUFFER_MAX_BYTES = 4 * 1024 * 1024;
const RESYNC_CLOSE_CODE = 1013;
const RESYNC_CLOSE_REASON = "resync-required: slow reader";
const MAX_CANONICAL_FRAME_BYTES = 8 * 1024 * 1024;

/** Test-only transport observation remains optional; production uses ws's
 * bufferedAmount directly. Canonical frame size is capped separately so one
 * pathological durable event cannot allocate an unbounded outbound frame. */
export interface WsGatewayOptions {
  frameHighWater?: number;
  bufferedAmount?: (ws: WebSocket) => number;
  maxCanonicalFrameBytes?: number;
}

export interface WsGateway extends Broadcaster {
  attach(server: Server, auth?: WsAuthorize | WsAttachAuth): void;
  close(): void;
}

export function createWsGateway(
  sessions: SessionService,
  browser?: BrowserService,
  dictation?: DictationForWs,
  spaces?: SpaceGateway,
  chatWorkspace?: ChatWorkspaceFrameBus,
  options?: WsGatewayOptions,
): WsGateway {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Map<WebSocket, Sub>();
  const attached = new WeakSet<Server>();
  const browserDisposals: Array<{ dispose(): void }> = [];
  const chatDisposals: Array<{ dispose(): void }> = [];
  const upgradeReleases: Array<() => void> = [];
  let closed = false;

  const closeForResync = (ws: WebSocket) => {
    clients.delete(ws);
    try { ws.close(RESYNC_CLOSE_CODE, RESYNC_CLOSE_REASON); } catch { /* already closing */ }
  };

  const closeOversizedFrame = (ws: WebSocket) => {
    clients.delete(ws);
    // A record above this protocol ceiling cannot be replayed over this
    // gateway. Do not auto-resync it forever; surface a terminal size failure
    // for an explicit user/server recovery path instead.
    const highWater = options?.frameHighWater ?? FRAME_HIGH_WATER;
    if (ws.readyState === WebSocket.OPEN && (options?.bufferedAmount?.(ws) ?? ws.bufferedAmount) <= highWater) {
      try {
        ws.send(JSON.stringify({
          type: "error",
          code: "canonical-frame-too-large",
          message: "durable event exceeds WebSocket frame limit; explicit recovery required",
        }));
      } catch { /* close reason remains the durable signal */ }
    }
    try { ws.close(1009, "resync-required: canonical frame too large"); } catch { /* already closing */ }
  };

  /** Canonical state must be replayable, never best-effort. Once a reader is
   * behind the general high-water mark, force it to reconnect from its cursor. */
  const send = (ws: WebSocket, msg: unknown, visual = false): boolean => {
    if (closed || ws.readyState !== WebSocket.OPEN) return false;
    if (!visual) {
      // Check before serializing the next canonical frame: a slow reader must
      // not force allocation of another potentially large JSON payload.
      if ((options?.bufferedAmount?.(ws) ?? ws.bufferedAmount) > (options?.frameHighWater ?? FRAME_HIGH_WATER)) {
        closeForResync(ws);
        return false;
      }
    }
    const payload = JSON.stringify(msg);
    if (!visual) {
      if (Buffer.byteLength(payload) > (options?.maxCanonicalFrameBytes ?? MAX_CANONICAL_FRAME_BYTES)) {
        closeOversizedFrame(ws);
        return false;
      }
    }
    try {
      ws.send(payload);
      return true;
    } catch {
      closeForResync(ws);
      return false;
    }
  };

  const clearLiveBuffer = (sub: Sub): void => {
    sub.liveBuffer = [];
    sub.liveBufferBytes = 0;
    sub.liveBufferSeq.clear();
  };

  const liveEventBytes = (ev: SessionEvent): number => Buffer.byteLength(JSON.stringify({ type: "event", event: ev }));

  const bufferLiveEvent = (ws: WebSocket, sub: Sub, ev: SessionEvent): boolean => {
    if (sub.liveBufferSeq.has(ev.seq)) return true;
    const bytes = liveEventBytes(ev);
    if (sub.liveBuffer.length >= LIVE_BUFFER_MAX_EVENTS || sub.liveBufferBytes + bytes > LIVE_BUFFER_MAX_BYTES) {
      clearLiveBuffer(sub);
      closeForResync(ws);
      return false;
    }
    sub.liveBuffer.push(ev);
    sub.liveBufferBytes += bytes;
    sub.liveBufferSeq.add(ev.seq);
    return true;
  };

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
    send(ws, chatFrameMsg(frame), true);
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
    if (frame.revision <= sub.browserAfterRevision) return;
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > FRAME_HIGH_WATER) {
      sub.pendingFrame = frame;
      return;
    }
    sub.pendingFrame = null;
    sub.browserAfterRevision = frame.revision;
    send(ws, frameMsg(frame), true);
  };

  const flusher = setInterval(() => {
    for (const [ws, sub] of clients) {
      if (sub.pendingFrame && ws.bufferedAmount <= FRAME_HIGH_WATER) deliverFrame(ws, sub, sub.pendingFrame);
      if (sub.pendingChatFrame && ws.bufferedAmount <= FRAME_HIGH_WATER) deliverChatFrame(ws, sub, sub.pendingChatFrame);
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
      for (const [ws, sub] of clients) deliverChatEvent(ws, sub, event);
    });
    chatDisposals.push(onChatFrame);
    chatDisposals.push(onChatEvent);
  }

  wss.on("connection", (ws, req: IncomingMessage) => {
    const attachAuth = (ws as WebSocket & { _polythAuth?: WsAttachAuth })._polythAuth ?? {};
    const resolution = defaultWsIdentity(attachAuth, req);
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
      busy: false, pendingSubscribe: null, snapshotScope: null, liveBuffer: [], liveBufferBytes: 0, liveBufferSeq: new Set(),
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
      const data = Array.isArray(raw) ? Buffer.concat(raw) : raw;
      let audioFrame: DictationAudioFrame | null = null;
      let msg: {
        type?: string; sessionId?: string; afterSeq?: number; projectId?: string;
        browserSessionId?: string; afterRevision?: number;
        tabId?: string; visible?: boolean; quality?: number;
        dictationId?: string;
      } = {};

      try {
        audioFrame = dictation?.decodeAudioFrame(data) ?? null;
      } catch (error) {
        const failure = error as Error & { code?: string };
        send(ws, { type: "dictation/error", code: failure.code ?? "protocol_error", message: failure.message });
        return;
      }
      if (!audioFrame) {
        try { msg = JSON.parse(String(data)); } catch { return; }
      }

      const isAudio = audioFrame !== null;
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

      const pushDictation = async (id: string, seq: number, pcm: Uint8Array) => {
        if (!dictation || !requireCap(ws, sub, REMOTE_CAPABILITY.dictationUse)) return;
        try {
          const r = await dictation.push(id, seq, pcm);
          if (closed) return;
          if (!requireCap(ws, sub, REMOTE_CAPABILITY.dictationUse)) return;
          send(ws, {
            type: "dictation/ack", dictationId: id, seq: r.ack,
            duplicate: r.duplicate, ...(r.buffered ? { buffered: true } : {}),
          });
          if (r.transcript) {
            send(ws, {
              type: "dictation/transcript", dictationId: id,
              revision: r.transcript.revision, text: r.transcript.text, final: r.transcript.final,
            });
          }
        } catch (error) {
          if (!requireCap(ws, sub, REMOTE_CAPABILITY.dictationUse)) return;
          const failure = error as Error & { code?: string };
          send(ws, {
            type: "dictation/error", dictationId: id,
            code: failure.code ?? "internal", message: failure.message,
          });
        }
      };

      if (audioFrame) {
        if (!dictation || !requireCap(ws, sub, REMOTE_CAPABILITY.dictationUse)) return;
        const current = dictation.get(audioFrame.dictationId);
        if (!current) {
          send(ws, { type: "dictation/error", dictationId: audioFrame.dictationId, code: "not-found" });
          return;
        }
        if (
          audioFrame.format !== current.format.encoding
          || audioFrame.sampleRate !== current.format.sampleRate
          || audioFrame.channels !== current.format.channels
        ) {
          send(ws, {
            type: "dictation/error", dictationId: audioFrame.dictationId, code: "audio_format_error",
            message: `expected ${current.format.encoding}/${current.format.sampleRate}/${current.format.channels}`,
          });
          return;
        }
        await pushDictation(audioFrame.dictationId, audioFrame.seq, audioFrame.payload);
        return;
      }

      if (msg.type === "dictation/start" && dictation) {
        if (!requireCap(ws, sub, REMOTE_CAPABILITY.dictationUse)) return;
        const dto = msg.dictationId ? dictation.get(msg.dictationId) : null;
        if (!dto) send(ws, { type: "dictation/error", dictationId: msg.dictationId, code: "not-found" });
        else send(ws, { type: "dictation/state", dictationId: dto.id, session: dto });
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
          if (latest && (sub.spaceId === null || latest.spaceId === sub.spaceId)) deliverChatFrame(ws, sub, latest);
        }
        return;
      }
      if (msg.type === "browser/subscribe" && browser) {
        if (!requireCap(ws, sub, REMOTE_CAPABILITY.browserUse)) return;
        sub.browserSessionId = msg.browserSessionId ?? null;
        sub.browserAfterRevision = Number(msg.afterRevision ?? 0);
        sub.pendingFrame = null;
        if (sub.browserSessionId) {
          const latest = browser.latestFrame(sub.browserSessionId, sub.browserAfterRevision);
          if (latest) deliverFrame(ws, sub, latest);
        }
        return;
      }
      if (msg.type !== "subscribe") return;
      if (!requireCap(ws, sub, REMOTE_CAPABILITY.coreSessionsRead)) return;
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
            clearLiveBuffer(sub);
            break;
          }
          if (!requireCap(ws, sub, REMOTE_CAPABILITY.coreSessionsRead)) {
            sub.pendingSubscribe = null;
            clearLiveBuffer(sub);
            break;
          }
          const cur = sub.pendingSubscribe;
          sub.pendingSubscribe = null;
          sub.sessionId = cur.sessionId;
          sub.afterSeq = cur.afterSeq;
          clearLiveBuffer(sub);
          if (sub.sessionId) {
            sub.caughtUp = false;
            try {
              const gap = await sub.sessions.events(sub.sessionId, sub.afterSeq);
              if (closed) return;
              if (!requireCap(ws, sub, REMOTE_CAPABILITY.coreSessionsRead)) {
                sub.caughtUp = true;
                clearLiveBuffer(sub);
                sub.pendingSubscribe = null;
                break subscriptions;
              }
              let gapCursor = sub.afterSeq;
              for (let i = 0; i < gap.length; i += GAP_FILL_CHUNK) {
                if (!requireCap(ws, sub, REMOTE_CAPABILITY.coreSessionsRead)) break subscriptions;
                const chunk = gap.slice(i, i + GAP_FILL_CHUNK);
                if (chunk.some((event, index) => event.sessionId !== sub.sessionId
                  || event.seq !== gapCursor + index + 1)) {
                  closeForResync(ws);
                  break subscriptions;
                }
                if (!send(ws, { type: "events", events: chunk })) break subscriptions;
                gapCursor = chunk.at(-1)?.seq ?? gapCursor;
              }
              sub.afterSeq = gapCursor;
            } catch (err) {
              if (!requireCap(ws, sub, REMOTE_CAPABILITY.coreSessionsRead)) {
                sub.caughtUp = true;
                clearLiveBuffer(sub);
                sub.pendingSubscribe = null;
                break subscriptions;
              }
              send(ws, { type: "error", code: "gap-fill", message: String(err) });
              clearLiveBuffer(sub);
              closeForResync(ws);
              break subscriptions;
            }
            sub.caughtUp = true;
            const buffered = sub.liveBuffer.slice();
            clearLiveBuffer(sub);
            for (const ev of buffered) {
              if (!requireCap(ws, sub, REMOTE_CAPABILITY.coreSessionsRead)) break subscriptions;
              if (ev.seq <= sub.afterSeq) continue;
              if (ev.sessionId !== sub.sessionId || ev.seq !== sub.afterSeq + 1) {
                closeForResync(ws);
                break subscriptions;
              }
              if (!send(ws, { type: "event", event: ev })) break subscriptions;
              sub.afterSeq = ev.seq;
            }
          } else {
            sub.caughtUp = true;
          }
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
        if (!inSpace(sub, owner)) continue;
        if (sub.sessionId && ev.sessionId !== sub.sessionId) continue;
        if (!sub.caughtUp) {
          bufferLiveEvent(ws, sub, ev);
          continue;
        }
        if (sub.sessionId && ev.seq <= sub.afterSeq) continue;
        if (sub.sessionId && ev.seq !== sub.afterSeq + 1) {
          closeForResync(ws);
          continue;
        }
        if (send(ws, { type: "event", event: ev }) && sub.sessionId) sub.afterSeq = ev.seq;
      }
    },
    projection(p: SessionProjection) {
      if (closed) return;
      for (const [ws, sub] of clients) {
        const live = currentPrincipal(ws, sub);
        if (!allowWsCapability(live, REMOTE_CAPABILITY.coreSessionsRead)) continue;
        if (sub.spaceId !== null && p.spaceId !== sub.spaceId) continue;
        send(ws, { type: "projection", session: p });
      }
    },
    notification(record: NotificationRecord) {
      if (closed) return;
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
  dictation?: DictationForWs,
  authorize?: WsAuthorize | WsAttachAuth,
): WsGateway {
  const gateway = createWsGateway(sessions, browser, dictation);
  gateway.attach(server, authorize);
  return gateway;
}
