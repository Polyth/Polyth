// WS gateway: gap-fill from durable log, then live. No race window.
import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import type { IncomingMessage } from "node:http";
import type {
  AuthPrincipal,
  ClientSettingsDto,
  NotificationRecord,
  PackageDescriptorDto,
  ProjectPresentationSettingsDto,
  SessionEvent,
  SessionProjection,
  SessionReplayPage,
  SessionService,
} from "@polyth/contracts";
import { REMOTE_CAPABILITY, isLocalUiPrincipal } from "@polyth/contracts";
import { projectVisibleToUser } from "./accountLimits.ts";
import type { Broadcaster } from "./sessions.ts";
import type { SpaceGateway } from "./spaces.ts";
import type { NotificationAccount } from "./notifications.ts";
import { parseSpaceCookie } from "./spaces.ts";
import { sessionSummary } from "./sessionSummary.ts";
import { BROADCAST_LIFECYCLES, rowForReader, sessionAccess } from "./sessionSharing.ts";
import { canonicalSecurity } from "./runtimeSecurity.ts";
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

/** Structural feature seam: the core gateway knows browser frame/session
 * semantics, not the removable Browser package or its DTOs. */
export interface BrowserFrameForWs {
  browserSessionId: string;
  revision: number;
  mime: string;
  data: Uint8Array;
}

/** Browser runtime events are forwarded as opaque JSON; the gateway only reads
 * the session they belong to. */
export interface BrowserEventForWs {
  browserSessionId: string;
  kind?: string;
  message?: string;
  url?: string;
  level?: string;
  actor?: string;
  actionId?: string;
  targetRect?: unknown;
}

export interface BrowserServiceForWs {
  get(id: string): { projectId: string; sessionId?: string } | null;
  setViewerVisible(id: string, visible: boolean): void;
  onFrame(cb: (frame: BrowserFrameForWs) => void): { dispose(): void };
  onEvent(cb: (event: BrowserEventForWs) => void): { dispose(): void };
  latestFrame(id: string, afterRevision?: number): BrowserFrameForWs | null;
  /** The person a browser belongs to; absent for chat and project browsers. */
  ownerOf?(id: string): string | undefined;
}

interface Sub {
  sessionId: string | null;
  afterSeq: number;
  caughtUp: boolean;
  busy: boolean;
  pendingSubscribe: {
    sessionId: string | null;
    afterSeq: number;
    projectId: string | null;
    liveEventBatches: boolean;
    summaryProjections: boolean;
    /** Client-chosen token echoed on `synced` receipts; absent = no receipts. */
    syncToken: number | null;
    /** Rows the client still shows as active; the snapshot re-reads them. */
    refreshSessionIds: string[];
  } | null;
  snapshotScope: string | null;
  liveBuffer: SessionEvent[];
  liveBufferBytes: number;
  liveBufferSeq: Set<number>;
  streamBuffer: SessionEvent[];
  streamBufferBytes: number;
  streamTimer: ReturnType<typeof setTimeout> | null;
  liveEventBatches: boolean;
  summaryProjections: boolean;
  windowStart: number;
  windowCount: number;
  browserSessionId: string | null;
  browserAfterRevision: number;
  browserVisible: boolean;
  pendingFrame: BrowserFrameForWs | null;
  /** Audio frame token bucket (see AUDIO_FRAMES_PER_SECOND). */
  audioTokens: number;
  audioRefilledAt: number;
  principal: AuthPrincipal;
  refreshPrincipal?: (principal: AuthPrincipal) => AuthPrincipal | null;
  spaceId: string | null;
  /** Immutable identity resolved at WS attach; never a client-provided id. */
  notificationAccount: NotificationAccount | null;
  sessions: SessionService;
}

const MAX_MESSAGES_PER_SECOND = 20;
/** Dictation audio is metered by a token bucket, not the 1 s message window:
 * after a network stall (a phone on the Link relay) the client replays every
 * unacked 40 ms frame at once, and a fixed 100-per-second window closed the
 * socket on each replay, so the reconnect loop never delivered any audio. The
 * burst covers the client's 2 MiB replay buffer (~1640 frames); the refill is
 * 4x real time, so a sustained flood is still refused. */
const AUDIO_FRAMES_PER_SECOND = 100;
const AUDIO_FRAME_BURST = 2_000;
const FRAME_HIGH_WATER = 1_000_000;
const GAP_FILL_CHUNK = 500;
/** A subscribe's `refreshSessionIds` hint: bounded like one summary page. */
const REFRESH_IDS_MAX = 100;
const SESSION_ID_SHAPE = /^[A-Za-z0-9._:-]{1,160}$/u;

/** Untrusted hint, so only well-formed ids, deduped and capped. Access is
 *  still decided by the scoped summary read, never by this list. */
function refreshIdsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  for (const id of value) {
    if (ids.size >= REFRESH_IDS_MAX) break;
    if (typeof id === "string" && SESSION_ID_SHAPE.test(id)) ids.add(id);
  }
  return [...ids];
}
/** A replay read can race a busy producer. Bound that race per client; a
 * canonical event is never silently discarded -- overflow closes for replay. */
const LIVE_BUFFER_MAX_EVENTS = 2_048;
const LIVE_BUFFER_MAX_BYTES = 4 * 1024 * 1024;
const STREAM_BATCH_MS = 50;
const STREAM_BATCH_MAX_EVENTS = 256;
const STREAM_BATCH_MAX_BYTES = 512 * 1024;
const RESYNC_CLOSE_CODE = 1013;
const RESYNC_CLOSE_REASON = "resync-required: slow reader";
const MAX_CANONICAL_FRAME_BYTES = 8 * 1024 * 1024;

/** Older service adapters only know newest/older windows. Restrict both seq
 * boundaries to a single page before applying their DESC limit. */
export async function legacyReplayPage(sessions: SessionService, id: string, cursor: number, highWater?: number): Promise<SessionReplayPage> {
  const boundary = highWater ?? (await sessions.events(id, 0, { limit: 1 })).at(-1)?.seq ?? 0;
  if (cursor > boundary) throw Object.assign(new Error("replay cursor is beyond history"), { code: "conflict" });
  const through = Math.min(boundary, cursor + GAP_FILL_CHUNK);
  const events = through === cursor ? [] : await sessions.events(id, cursor, { beforeSeq: through + 1, limit: GAP_FILL_CHUNK });
  const next = events.at(-1)?.seq ?? cursor;
  return { events, cursor: next, highWater: boundary, complete: next === boundary };
}

/** Test-only transport observation remains optional; production uses ws's
 * bufferedAmount directly. Canonical frame size is capped separately so one
 * pathological durable event cannot allocate an unbounded outbound frame. */
export interface WsGatewayOptions {
  frameHighWater?: number;
  bufferedAmount?: (ws: WebSocket) => number;
  maxCanonicalFrameBytes?: number;
  streamBatchMs?: number;
}

export interface WsGateway extends Broadcaster {
  attach(server: Server, auth?: WsAuthorize | WsAttachAuth): void;
  close(): void;
}

export function createWsGateway(
  sessions: SessionService,
  browser?: BrowserServiceForWs,
  dictation?: DictationForWs,
  spaces?: SpaceGateway,
  options?: WsGatewayOptions,
): WsGateway {
  // Session history, projections and package lists are repetitive JSON: a
  // browser that offers permessage-deflate gets them ~5-10x smaller. Small
  // frames (streamed token deltas) stay uncompressed, so live typing costs no
  // zlib work; best-speed level keeps large replays off the CPU. Polyth Link
  // never offers the extension, so its frames are unchanged.
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: {
      threshold: 1024,
      zlibDeflateOptions: { level: 1 },
      clientNoContextTakeover: true,
    },
  });
  const clients = new Map<WebSocket, Sub>();
  const attached = new WeakSet<Server>();
  const browserDisposals: Array<{ dispose(): void }> = [];
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
  const send = (ws: WebSocket, msg: unknown, visual = false, onWritten?: () => void): boolean => {
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
      // Visual frames carry already-compressed image data.
      if (onWritten) ws.send(payload, { compress: !visual }, () => onWritten());
      else ws.send(payload, { compress: !visual });
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

  const isStreamingEvent = (event: SessionEvent): boolean =>
    event.type === "assistant/chunk" || event.type === "assistant/reasoning-chunk";

  const clearStreamBuffer = (sub: Sub): void => {
    if (sub.streamTimer !== null) clearTimeout(sub.streamTimer);
    sub.streamTimer = null;
    sub.streamBuffer = [];
    sub.streamBufferBytes = 0;
  };

  const flushStreamBuffer = (ws: WebSocket, sub: Sub): boolean => {
    if (sub.streamTimer !== null) clearTimeout(sub.streamTimer);
    sub.streamTimer = null;
    if (sub.streamBuffer.length === 0) return true;
    if (!requireCap(ws, sub, REMOTE_CAPABILITY.coreSessionsRead)) { clearStreamBuffer(sub); return false; }
    const events = sub.streamBuffer;
    sub.streamBuffer = [];
    sub.streamBufferBytes = 0;
    return send(ws, { type: "events", events, live: true });
  };

  const queueStreamEvent = (ws: WebSocket, sub: Sub, event: SessionEvent): boolean => {
    const bytes = liveEventBytes(event);
    if (
      sub.streamBuffer.length > 0
      && (
        sub.streamBuffer.length >= STREAM_BATCH_MAX_EVENTS
        || sub.streamBufferBytes + bytes > STREAM_BATCH_MAX_BYTES
      )
      && !flushStreamBuffer(ws, sub)
    ) return false;

    sub.streamBuffer.push(event);
    sub.streamBufferBytes += bytes;

    const batchMs = options?.streamBatchMs ?? STREAM_BATCH_MS;
    if (batchMs <= 0) return flushStreamBuffer(ws, sub);
    if (sub.streamTimer === null) {
      sub.streamTimer = setTimeout(() => {
        sub.streamTimer = null;
        flushStreamBuffer(ws, sub);
      }, batchMs);
      sub.streamTimer.unref?.();
    }
    return true;
  };

  /**
   * Each person sees their own draft, pin and unread count, and only the chats
   * they can open, with their own sharing view (Spaces §14.3). Computed once
   * per person and synchronously, so broadcasts never reorder; null when that
   * person cannot open the chat.
   */
  const readerViews = (p: SessionProjection) => {
    const views = new Map<string, SessionProjection | null>();
    return (userId: string | undefined): SessionProjection | null => {
      if (!userId || !spaces) return p;
      if (views.has(userId)) return views.get(userId)!;
      let view: SessionProjection | null;
      try {
        view = spaces.people ? spaces.people.personalize([p], userId)[0] ?? p : p;
      } catch (error) {
        console.error("[polyth] per-person projection view failed", error);
        const { draft: _draft, draftUpdatedAt: _stamp, ...shared } = p;
        view = shared;
      }
      try {
        view = rowForReader(view, userId, p.spaceId ?? "", BROADCAST_LIFECYCLES) ?? null;
      } catch (error) {
        // Fail closed: an access decision that cannot be made reveals nothing.
        console.error("[polyth] per-person access check failed", error);
        view = null;
      }
      views.set(userId, view);
      return view;
    };
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

  const canViewBrowser = (sub: Sub, id: string): boolean => {
    const dto = browser?.get(id);
    if (!dto) return false;
    if (!spaces) return true;
    if (!sub.spaceId) return false;
    // A person's browser is theirs alone (§14.6), and a chat's browser shows
    // only to people who can open that chat, as on `/api/browser/*`.
    const account = sub.notificationAccount?.userId;
    const person = account && !account.startsWith("system:") ? account : undefined;
    const owner = browser?.ownerOf?.(id);
    if (owner && owner !== person) return false;
    try {
      spaces.guard.assertProject({ spaceId: sub.spaceId }, dto.projectId);
      if (dto.sessionId) {
        spaces.guard.assertSession({ spaceId: sub.spaceId }, dto.sessionId);
        if (person && canonicalSecurity() && !sessionAccess(person, sub.spaceId, dto.sessionId, BROADCAST_LIFECYCLES)) return false;
      }
      return true;
    } catch { return false; }
  };
  const syncBrowserVisibility = (id: string | null): void => {
    if (!id || !browser?.get(id)) return;
    const visible = [...clients].some(([ws, sub]) =>
      ws.readyState === WebSocket.OPEN && sub.browserSessionId === id && sub.browserVisible
      && canViewBrowser(sub, id)
      && allowWsCapability(liveWsPrincipal(sub.principal, sub.refreshPrincipal), REMOTE_CAPABILITY.browserUse));
    browser.setViewerVisible(id, visible);
  };

  const currentPrincipal = (ws: WebSocket, sub: Sub): AuthPrincipal | null => {
    let live = liveWsPrincipal(sub.principal, sub.refreshPrincipal);
    if (live && spaces) {
      try {
        // The attach-time scope is fixed. Membership loss must also fence
        // buffered replay/live delivery, even while the login remains valid.
        if (!sub.spaceId || spaces.resolve(live, { explicit: sub.spaceId }).spaceId !== sub.spaceId) live = null;
      } catch { live = null; }
    }
    if (!live) {
      clearStreamBuffer(sub);
      clearLiveBuffer(sub);
      sub.pendingSubscribe = null;
      closeWs(ws);
      clients.delete(ws);
      syncBrowserVisibility(sub.browserSessionId);
      return null;
    }
    sub.principal = live;
    return live;
  };
  const currentNotificationAccount = (ws: WebSocket, sub: Sub): NotificationAccount | null => {
    const live = currentPrincipal(ws, sub);
    if (!live || !spaces || !sub.notificationAccount) return null;
    try {
      // Re-check the subscription's original Space instead of whatever Space
      // the user selected later. A removed member has no inbox fan-out.
      const current = spaces.resolve(live, { explicit: sub.notificationAccount.spaceId });
      return current.userId === sub.notificationAccount.userId
        && current.spaceId === sub.notificationAccount.spaceId
        ? sub.notificationAccount
        : null;
    } catch {
      return null;
    }
  };

  const requireCap = (ws: WebSocket, sub: Sub, capability: string): boolean => {
    const live = currentPrincipal(ws, sub);
    if (!allowWsCapability(live, capability)) {
      send(ws, { type: "error", code: "forbidden", message: "missing capability" });
      return false;
    }
    return true;
  };

  const frameMsg = (f: BrowserFrameForWs) => ({
    type: "browser/frame",
    browserSessionId: f.browserSessionId,
    revision: f.revision,
    mime: f.mime,
    data: Buffer.from(f.data).toString("base64"),
  });

  const deliverFrame = (ws: WebSocket, sub: Sub, frame: BrowserFrameForWs): void => {
    const live = currentPrincipal(ws, sub);
    if (!allowWsCapability(live, REMOTE_CAPABILITY.browserUse)) return;
    if (!sub.browserVisible || !canViewBrowser(sub, frame.browserSessionId)) return;
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
    for (const id of new Set([...clients.values()].map((sub) => sub.browserSessionId))) syncBrowserVisibility(id);
    for (const [ws, sub] of clients) {
      if (sub.pendingFrame && ws.bufferedAmount <= FRAME_HIGH_WATER) deliverFrame(ws, sub, sub.pendingFrame);
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
          if (!allowWsCapability(live, REMOTE_CAPABILITY.browserUse) || !canViewBrowser(sub, event.browserSessionId)) continue;
          send(ws, { type: "browser/event", browserSessionId: event.browserSessionId, event });
        }
      }
    });
    if (onFrame) browserDisposals.push(onFrame);
    if (onEvent) browserDisposals.push(onEvent);
  }

  wss.on("connection", (ws, req: IncomingMessage) => {
    const attachAuth = (ws as WebSocket & { _polythAuth?: WsAttachAuth })._polythAuth ?? {};
    const resolution = defaultWsIdentity(attachAuth, req);
    let socketSpaceId: string | null = null;
    let notificationAccount: NotificationAccount | null = null;
    let socketSessions = sessions;
    if (spaces) {
      try {
        const ctx = spaces.resolve(resolution.principal, {
          remembered: parseSpaceCookie(req.headers.cookie, spaces.cookieName),
        });
        socketSpaceId = ctx.spaceId;
        notificationAccount = { userId: ctx.userId, spaceId: ctx.spaceId };
        socketSessions = spaces.services(ctx).sessions;
      } catch {
        // Never leave an unscoped service on a socket after failed tenancy
        // resolution: new read methods must not bypass an empty legacy list.
        closeWs(ws);
        return;
      }
    }
    const sub: Sub = {
      spaceId: socketSpaceId,
      notificationAccount,
      sessions: socketSessions,
      sessionId: null, afterSeq: 0, caughtUp: true,
      busy: false, pendingSubscribe: null, snapshotScope: null, liveBuffer: [], liveBufferBytes: 0, liveBufferSeq: new Set(),
      streamBuffer: [], streamBufferBytes: 0, streamTimer: null, liveEventBatches: false, summaryProjections: false,
      windowStart: Date.now(), windowCount: 0,
      browserSessionId: null, browserAfterRevision: 0, browserVisible: false, pendingFrame: null,
      audioTokens: AUDIO_FRAME_BURST, audioRefilledAt: Date.now(),
      principal: resolution.principal,
      refreshPrincipal: attachAuth.refreshPrincipal,
    };
    clients.set(ws, sub);
    attachAuth.pairedSockets?.bind(ws, resolution.principal, () => closeWs(ws));
    ws.on("close", () => {
      attachAuth.pairedSockets?.unbind(ws);
      clearStreamBuffer(sub);
      clients.delete(ws);
      syncBrowserVisibility(sub.browserSessionId);
    });
    ws.on("message", async (raw) => {
      if (closed) return;
      const data = Array.isArray(raw) ? Buffer.concat(raw) : raw;
      let audioFrame: DictationAudioFrame | null = null;
      let msg: {
        type?: string; sessionId?: string; afterSeq?: number; projectId?: string; liveEventBatches?: boolean; summaryProjections?: boolean;
        syncToken?: number; refreshSessionIds?: unknown;
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
      }
      if (isAudio) {
        sub.audioTokens = Math.min(
          AUDIO_FRAME_BURST,
          sub.audioTokens + (now - sub.audioRefilledAt) * AUDIO_FRAMES_PER_SECOND / 1000,
        );
        sub.audioRefilledAt = now;
        if (--sub.audioTokens < 0) {
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
      }      if (msg.type === "browser/subscribe" && browser) {
        if (!requireCap(ws, sub, REMOTE_CAPABILITY.browserUse)) return;
        const nextId = msg.browserSessionId ?? null;
        if (nextId && !canViewBrowser(sub, nextId)) {
          send(ws, { type: "error", code: "not-found", message: "browser session not found" });
          return;
        }
        const previousId = sub.browserSessionId;
        sub.browserSessionId = nextId;
        sub.browserVisible = msg.visible !== false && nextId !== null;
        syncBrowserVisibility(previousId);
        syncBrowserVisibility(nextId);
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
      if (!Number.isSafeInteger(Number(msg.afterSeq ?? 0)) || Number(msg.afterSeq ?? 0) < 0) {
        send(ws, { type: "error", code: "invalid-input", message: "invalid replay cursor" });
        return;
      }
      sub.pendingSubscribe = {
        sessionId: msg.sessionId ?? null,
        afterSeq: Number(msg.afterSeq ?? 0),
        projectId: typeof msg.projectId === "string" && msg.projectId ? msg.projectId : null,
        liveEventBatches: msg.liveEventBatches === true,
        summaryProjections: msg.summaryProjections === true,
        syncToken: Number.isSafeInteger(msg.syncToken) ? Number(msg.syncToken) : null,
        refreshSessionIds: refreshIdsOf(msg.refreshSessionIds),
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
          sub.liveEventBatches = cur.liveEventBatches;
          sub.summaryProjections = cur.summaryProjections;
          clearLiveBuffer(sub);
          clearStreamBuffer(sub);
          if (sub.sessionId) {
            sub.caughtUp = false;
            try {
              let highWater: number | undefined;
              for (;;) {
                if (closed || ws.readyState !== WebSocket.OPEN) break subscriptions;
                if (sub.pendingSubscribe) continue subscriptions;
                if (!requireCap(ws, sub, REMOTE_CAPABILITY.coreSessionsRead)) break subscriptions;
                const page = sub.sessions.replayPage
                  ? await sub.sessions.replayPage(sub.sessionId, sub.afterSeq, highWater)
                  : await legacyReplayPage(sub.sessions, sub.sessionId, sub.afterSeq, highWater);
                if (closed || ws.readyState !== WebSocket.OPEN) break subscriptions;
                if (sub.pendingSubscribe) continue subscriptions;
                if (!requireCap(ws, sub, REMOTE_CAPABILITY.coreSessionsRead)) break subscriptions;
                if (highWater !== undefined && page.highWater !== highWater) throw Object.assign(new Error("replay boundary changed"), { code: "conflict" });
                highWater = page.highWater;
                const gap = page.events;
                let gapCursor = sub.afterSeq;
                for (let i = 0; i < gap.length; i += GAP_FILL_CHUNK) {
                  const chunk = gap.slice(i, i + GAP_FILL_CHUNK);
                  if (chunk.some((event, index) => event.sessionId !== sub.sessionId
                    || event.seq !== gapCursor + index + 1)) {
                    closeForResync(ws);
                    break subscriptions;
                  }
                  let sent = false;
                  // Pace pages by the socket: the next page is read only once
                  // this one is compressed and written. Queuing a whole long
                  // replay ahead of the compressor would cross the high-water
                  // mark and force a resync. The wait also yields I/O, so the
                  // producer/socket/control path runs before the next SQLite read.
                  await new Promise<void>((resolve) => {
                    const done = () => { ws.off("close", done); resolve(); };
                    ws.once("close", done);
                    sent = send(ws, { type: "events", events: chunk }, false, done);
                    if (!sent) done();
                  });
                  if (!sent) break subscriptions;
                  gapCursor = chunk.at(-1)?.seq ?? gapCursor;
                  if (sub.pendingSubscribe) continue subscriptions;
                  if (closed || ws.readyState !== WebSocket.OPEN || !requireCap(ws, sub, REMOTE_CAPABILITY.coreSessionsRead)) break subscriptions;
                }
                sub.afterSeq = gapCursor;
                if (page.complete) break;
                if (!gap.length) { closeForResync(ws); break subscriptions; }
              }
            } catch (err) {
              if ((err as { code?: string }).code === "payload-too-large") {
                clearLiveBuffer(sub);
                closeOversizedFrame(ws);
                break subscriptions;
              }
              if (!requireCap(ws, sub, REMOTE_CAPABILITY.coreSessionsRead)) {
                sub.caughtUp = true;
                clearLiveBuffer(sub);
                sub.pendingSubscribe = null;
                break subscriptions;
              }
              if ((err as { code?: string }).code === "not-found") {
                // Deleted, or no longer open to this person: say so once and
                // keep the socket. A resync would only resubscribe to it.
                clearLiveBuffer(sub);
                clearStreamBuffer(sub);
                send(ws, { type: "session/removed", sessionId: sub.sessionId });
                sub.sessionId = null;
                sub.afterSeq = 0;
              } else {
                send(ws, { type: "error", code: "gap-fill", message: String(err) });
                clearLiveBuffer(sub);
                closeForResync(ws);
                break subscriptions;
              }
            }
            sub.caughtUp = true;
            const buffered = sub.liveBuffer.slice();
            clearLiveBuffer(sub);
            const liveTail: SessionEvent[] = [];
            for (const ev of buffered) {
              if (!requireCap(ws, sub, REMOTE_CAPABILITY.coreSessionsRead)) break subscriptions;
              if (ev.seq <= sub.afterSeq) continue;
              if (ev.sessionId !== sub.sessionId || ev.seq !== sub.afterSeq + 1) {
                closeForResync(ws);
                break subscriptions;
              }
              liveTail.push(ev);
              sub.afterSeq = ev.seq;
            }
            if (liveTail.length > 0) {
              if (sub.liveEventBatches) {
                if (!send(ws, { type: "events", events: liveTail, live: true })) break subscriptions;
              } else {
                for (const event of liveTail) {
                  if (!send(ws, { type: "event", event })) break subscriptions;
                }
              }
            }
          } else {
            sub.caughtUp = true;
          }
          const scope = cur.projectId ?? "*";
          // Receipts tell the client which part of what it shows is confirmed
          // current. Priority order: the open session's history (above), then
          // its own row, then the navigator list — so the screen the person is
          // looking at is never queued behind fifty list rows.
          const receipt = (phase: "session" | "sessions") => {
            if (cur.syncToken !== null) send(ws, { type: "synced", phase, token: cur.syncToken });
          };
          try {
            if (!requireCap(ws, sub, REMOTE_CAPABILITY.coreSessionsRead)) break subscriptions;
            // A navigator summary intentionally omits drafts/runtime details.
            // Refresh the explicitly selected row after replay on every
            // subscription, including reconnect and same-project navigation.
            const selected = cur.summaryProjections && sub.sessionId
              ? await sub.sessions.snapshot(sub.sessionId) : undefined;
            if (closed) return;
            if (sub.pendingSubscribe) continue subscriptions;
            if (!requireCap(ws, sub, REMOTE_CAPABILITY.coreSessionsRead)) break subscriptions;
            if (selected) send(ws, { type: "projection", session: selected });
            receipt("session");
            if (sub.snapshotScope !== scope) {
              let list = sub.summaryProjections && sub.sessions.summaries
                ? (await sub.sessions.summaries({ projectId: cur.projectId ?? undefined, limit: 50 })).sessions
                : await sub.sessions.list(cur.projectId ?? undefined);
              // A pinned chat stays in the navigator however old it is; the
              // recency page above holds only the newest fifty.
              if (sub.summaryProjections && sub.sessions.summaries) {
                const recent = new Set(list.map((row) => row.id));
                const pinned = (await sub.sessions.summaries({ projectId: cur.projectId ?? undefined, pinned: true, limit: 100 })).sessions;
                list = [...list, ...pinned.filter((row) => !recent.has(row.id))];
              }
              if (closed) return;
              if (sub.pendingSubscribe) continue subscriptions;
              if (!requireCap(ws, sub, REMOTE_CAPABILITY.coreSessionsRead)) break subscriptions;
              // The selected row already went out in full; a summary of it
              // here would only overwrite fresher detail.
              if (selected) list = list.filter((row) => row.id !== selected.id);
              for (let i = 0; i < list.length; i += GAP_FILL_CHUNK) {
                if (!requireCap(ws, sub, REMOTE_CAPABILITY.coreSessionsRead)) break subscriptions;
                send(ws, { type: "projections", sessions: list.slice(i, i + GAP_FILL_CHUNK) });
              }
              sub.snapshotScope = scope;
              const sent = new Set(list.map((row) => row.id));
              if (selected) sent.add(selected.id);
              // The project rail shows activity from every project while the
              // navigator list above stays scoped to the open one. A summary
              // subscriber therefore also gets the Space's active rows, so a
              // status dot is correct before its project is opened; live
              // summary projections keep it current afterwards.
              if (cur.projectId && cur.summaryProjections && sub.sessions.summaries) {
                try {
                  const active = (await sub.sessions.summaries({ attentionOnly: true, archived: false, limit: 100 })).sessions
                    .filter((row) => row.projectId !== cur.projectId);
                  if (closed) return;
                  if (sub.pendingSubscribe) continue subscriptions;
                  if (!requireCap(ws, sub, REMOTE_CAPABILITY.coreSessionsRead)) break subscriptions;
                  for (let i = 0; i < active.length; i += GAP_FILL_CHUNK) {
                    send(ws, { type: "projections", sessions: active.slice(i, i + GAP_FILL_CHUNK) });
                  }
                  for (const row of active) sent.add(row.id);
                } catch { /* status stays as last known; live updates still follow */ }
              }
              // Active rows cover what started while the link was down, not
              // what ended: a turn that finished or a question answered
              // elsewhere leaves the row out of them, and the client would
              // keep showing it as working or waiting (on the rail and in the
              // phone's Live Activity). Re-read the rows it still shows that
              // way through the same scoped summaries, so access rules match.
              const refresh = cur.refreshSessionIds.filter((id) => !sent.has(id));
              if (refresh.length > 0 && cur.summaryProjections && sub.sessions.summaries) {
                try {
                  const wanted = new Set(refresh);
                  const rows = (await sub.sessions.summaries({ ids: refresh, limit: REFRESH_IDS_MAX })).sessions
                    .filter((row) => wanted.has(row.id));
                  if (closed) return;
                  if (sub.pendingSubscribe) continue subscriptions;
                  if (!requireCap(ws, sub, REMOTE_CAPABILITY.coreSessionsRead)) break subscriptions;
                  for (let i = 0; i < rows.length; i += GAP_FILL_CHUNK) {
                    send(ws, { type: "projections", sessions: rows.slice(i, i + GAP_FILL_CHUNK) });
                  }
                } catch { /* status stays as last known; live updates still follow */ }
              }
            }
          } catch { /* non-fatal; history replay and persisted HTTP reads remain available */ }
          if (closed) return;
          if (sub.pendingSubscribe) continue subscriptions;
          receipt("sessions");
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
        if (!sub.sessionId || ev.sessionId !== sub.sessionId) continue;
        if (!sub.caughtUp) {
          bufferLiveEvent(ws, sub, ev);
          continue;
        }
        if (sub.sessionId && ev.seq <= sub.afterSeq) continue;
        if (sub.sessionId && ev.seq !== sub.afterSeq + 1) {
          closeForResync(ws);
          continue;
        }
        if (isStreamingEvent(ev) && sub.liveEventBatches) {
          if (queueStreamEvent(ws, sub, ev) && sub.sessionId) sub.afterSeq = ev.seq;
          continue;
        }
        if (!flushStreamBuffer(ws, sub)) continue;
        if (send(ws, { type: "event", event: ev }) && sub.sessionId) sub.afterSeq = ev.seq;
      }
    },
    projection(p: SessionProjection) {
      if (closed) return;
      const viewFor = readerViews(p);
      for (const [ws, sub] of clients) {
        const live = currentPrincipal(ws, sub);
        if (!allowWsCapability(live, REMOTE_CAPABILITY.coreSessionsRead)) continue;
        if (sub.spaceId !== null && p.spaceId !== sub.spaceId) continue;
        // An owner-set project list hides other projects' chats from this
        // account; live updates must not reveal them either.
        if (!projectVisibleToUser(sub.notificationAccount?.userId, p.projectId)) continue;
        // A navigator summary is already the restricted row the rail needs,
        // and project visibility above is the authority. Keep other projects'
        // live status flowing to summary subscribers; legacy subscribers stay
        // project-scoped.
        if (sub.snapshotScope && sub.snapshotScope !== "*" && p.projectId !== sub.snapshotScope && p.id !== sub.sessionId && !sub.summaryProjections) continue;
        // A chat this person cannot open is never announced to them.
        const view = viewFor(sub.notificationAccount?.userId);
        if (!view) continue;
        if (p.id === sub.sessionId && !flushStreamBuffer(ws, sub)) continue;
        send(ws, { type: "projection", session: sub.summaryProjections && sub.sessionId !== p.id ? sessionSummary(view) : view });
      }
    },
    sessionAccessChanged(projections: SessionProjection[], formerReaders?: ReadonlyMap<string, ReadonlySet<string>>) {
      if (closed) return;
      for (const p of projections) {
        const viewFor = readerViews(p);
        for (const [ws, sub] of clients) {
          const live = currentPrincipal(ws, sub);
          if (!allowWsCapability(live, REMOTE_CAPABILITY.coreSessionsRead)) continue;
          if (sub.spaceId !== null && p.spaceId !== sub.spaceId) continue;
          const view = viewFor(sub.notificationAccount?.userId);
          if (!view || !projectVisibleToUser(sub.notificationAccount?.userId, p.projectId)) {
            // Lost access: drop the row and end this socket's live history of it.
            if (sub.sessionId === p.id) {
              clearStreamBuffer(sub);
              clearLiveBuffer(sub);
              sub.sessionId = null;
              sub.afterSeq = 0;
              sub.caughtUp = true;
            }
            // Only someone who could open it before hears that it is gone.
            const userId = sub.notificationAccount?.userId;
            if (!formerReaders || (userId !== undefined && formerReaders.get(p.id)?.has(userId))) {
              send(ws, { type: "session/removed", sessionId: p.id });
            }
            continue;
          }
          // Summary rows for other projects keep the rail's status live.
          if (sub.snapshotScope && sub.snapshotScope !== "*" && p.projectId !== sub.snapshotScope && p.id !== sub.sessionId && !sub.summaryProjections) continue;
          if (p.id === sub.sessionId && !flushStreamBuffer(ws, sub)) continue;
          send(ws, { type: "projection", session: sub.summaryProjections && sub.sessionId !== p.id ? sessionSummary(view) : view });
        }
      }
    },
    notification(record: NotificationRecord, recipient?: NotificationAccount) {
      if (closed) return;
      // Production always composes a Space gateway. Older/unowned rows then
      // fail closed; the no-gateway branch preserves the isolated legacy WS
      // harness contract without becoming a tenant-serving path.
      if (!recipient) {
        if (spaces) return;
        for (const [ws, sub] of clients) {
          const live = currentPrincipal(ws, sub);
          if (allowWsCapability(live, REMOTE_CAPABILITY.coreNotificationsRead)) {
            send(ws, { type: "notification/added", notification: record });
          }
        }
        return;
      }
      for (const [ws, sub] of clients) {
        const account = currentNotificationAccount(ws, sub);
        if (!account || account.userId !== recipient.userId || account.spaceId !== recipient.spaceId) continue;
        if (!allowWsCapability(sub.principal, REMOTE_CAPABILITY.coreNotificationsRead)) continue;
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
    worktreesChanged(projectId: string) {
      if (closed) return;
      for (const [ws, sub] of clients) {
        const live = currentPrincipal(ws, sub);
        if (!allowWsCapability(live, REMOTE_CAPABILITY.gitRead)) continue;
        if (sub.spaceId !== null && spaces) {
          try { spaces.guard.assertProject({ spaceId: sub.spaceId }, projectId); }
          catch { continue; } // Not this tenant's project — its existence stays unknown.
          if (!projectVisibleToUser(sub.notificationAccount?.userId, projectId)) continue;
        }
        send(ws, { type: "worktrees/changed", projectId });
      }
    },
    clientSettingsChanged(userId: string, settings: ClientSettingsDto) {
      if (closed) return;
      for (const [ws, sub] of clients) {
        const live = currentPrincipal(ws, sub);
        // The settings blob is account-owned, not local-UI-only. A paired
        // client with the normal read grant must observe the same choices.
        if (!allowWsCapability(live, REMOTE_CAPABILITY.coreSessionsRead)) continue;
        if (spaces) {
          const account = currentNotificationAccount(ws, sub);
          if (!account || account.userId !== userId) continue;
        }
        send(ws, { type: "client-settings/changed", settings });
      }
    },
    projectPresentationChanged(spaceId: string, projectId: string, settings: ProjectPresentationSettingsDto) {
      if (closed) return;
      for (const [ws, sub] of clients) {
        const live = currentPrincipal(ws, sub);
        if (!allowWsCapability(live, REMOTE_CAPABILITY.coreProjectsRead)) continue;
        if (spaces) {
          const account = currentNotificationAccount(ws, sub);
          if (!account || account.spaceId !== spaceId) continue;
          try { spaces.guard.assertProject({ spaceId }, projectId); }
          catch { continue; }
          if (!projectVisibleToUser(account.userId, projectId)) continue;
        } else if (sub.spaceId !== null && sub.spaceId !== spaceId) {
          continue;
        }
        send(ws, { type: "project-presentation/changed", projectId, settings });
      }
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(flusher);
      for (const disposal of browserDisposals.splice(0)) {
        try { disposal.dispose(); } catch { /* already disposed */ }
      }
      for (const release of upgradeReleases.splice(0)) {
        try { release(); } catch { /* already released */ }
      }
      for (const [ws, sub] of clients) {
        clearStreamBuffer(sub);
        try { ws.terminate(); } catch { /* already closing */ }
      }
      const browserIds = new Set([...clients.values()].map((sub) => sub.browserSessionId));
      clients.clear();
      for (const id of browserIds) syncBrowserVisibility(id);
      wss.close();
    },
  };
}

export function attachWs(
  server: Server,
  sessions: SessionService,
  browser?: BrowserServiceForWs,
  dictation?: DictationForWs,
  authorize?: WsAuthorize | WsAttachAuth,
): WsGateway {
  const gateway = createWsGateway(sessions, browser, dictation);
  gateway.attach(server, authorize);
  return gateway;
}
