// WS client for the /ws gateway. Session event sequence numbers are canonical:
// keeping only the contiguous cursor makes replay memory proportional to active
// sessions, rather than to the lifetime of the browser tab.
import type { ClientSettingsDto, NotificationKind, NotificationRecord, PackageDescriptorDto, SessionEvent, SessionProjection } from "@polyth/contracts";

export type SyncInbound =
  | { type: "event"; event: SessionEvent }
  | { type: "events"; events: SessionEvent[] }
  | { type: "projection"; session: SessionProjection }
  | { type: "projections"; sessions: SessionProjection[] }
  | { type: "notification/added"; notification: NotificationRecord }
  | { type: "plugin/changed"; packageId: string }
  | { type: "package/changed"; package: PackageDescriptorDto }
  | { type: "client-settings/changed"; settings: ClientSettingsDto }
  /** One project's git worktree topology changed (here, or underneath us). */
  | { type: "worktrees/changed"; projectId: string }
  | { type: "error"; code: string; message: string };

export type SyncListener = (msg: SyncInbound) => void;
/** `offline` is only a local transport hint, never an authentication verdict. */
export type SyncStatus = "connecting" | "connected" | "reconnecting" | "suspended" | "offline" | "disconnected";

interface WebSocketLike {
  readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface SyncClientOptions {
  webSocket?: (url: string) => WebSocketLike;
  setTimeout?: (callback: () => void, ms: number) => ReturnType<typeof globalThis.setTimeout>;
  clearTimeout?: (timer: ReturnType<typeof globalThis.setTimeout>) => void;
  random?: () => number;
  now?: () => number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  stableConnectionMs?: number;
  maxSessionCursors?: number;
}

/** Legacy test seam only. SyncClient deliberately does not use this: its
 * cursor map is the authoritative replay dedupe. Keep this helper bounded for
 * older consumers until they can be removed without a public test break. */
export interface SeqDedupe {
  has(sessionId: string, seq: number): boolean;
  add(sessionId: string, seq: number): void;
  size(): number;
}

export function createSeqDedupe(limit = 1_024): SeqDedupe {
  const entries = new Map<string, undefined>();
  const key = (sessionId: string, seq: number) => `${sessionId}:${seq}`;
  return {
    has: (sessionId, seq) => entries.has(key(sessionId, seq)),
    add: (sessionId, seq) => {
      const value = key(sessionId, seq);
      if (entries.has(value)) return;
      entries.set(value, undefined);
      if (entries.size > limit) entries.delete(entries.keys().next().value!);
    },
    size: () => entries.size,
  };
}

const NOTIFICATION_KINDS: readonly NotificationKind[] = ["completed", "failed", "question", "permission", "subagent"];
const WS_OPEN = 1;

const isEventShape = (e: unknown): boolean => {
  const ev = e as Record<string, unknown> | undefined | null;
  return !!ev && typeof ev === "object" && typeof ev.sessionId === "string" && typeof ev.seq === "number";
};

const isProjectionShape = (s: unknown): boolean => {
  const p = s as Record<string, unknown> | undefined | null;
  return !!p && typeof p === "object" && typeof p.id === "string" && typeof p.status === "string";
};

export function isSyncInbound(raw: unknown): raw is SyncInbound {
  if (typeof raw !== "object" || raw === null) return false;
  const m = raw as Record<string, unknown>;
  if (m.type === "event") return isEventShape(m.event);
  if (m.type === "events") return Array.isArray(m.events) && m.events.every(isEventShape);
  if (m.type === "projection") return isProjectionShape(m.session);
  if (m.type === "projections") return Array.isArray(m.sessions) && m.sessions.every(isProjectionShape);
  if (m.type === "notification/added") {
    const n = m.notification as Record<string, unknown> | undefined;
    return !!n
      && typeof n.id === "string" && n.id.length > 0
      && typeof n.key === "string" && n.key.length > 0
      && NOTIFICATION_KINDS.includes(n.kind as NotificationKind)
      && typeof n.sessionId === "string" && n.sessionId.length > 0
      && typeof n.projectId === "string" && n.projectId.length > 0
      && typeof n.title === "string" && typeof n.body === "string"
      && typeof n.ts === "number" && Number.isFinite(n.ts)
      && typeof n.read === "boolean";
  }
  if (m.type === "plugin/changed") return typeof m.packageId === "string" && m.packageId.length > 0;
  if (m.type === "package/changed") {
    const pkg = m.package as Record<string, unknown> | undefined;
    return !!pkg && typeof pkg.id === "string" && typeof pkg.enabled === "boolean";
  }
  if (m.type === "client-settings/changed") {
    const s = m.settings as Record<string, unknown> | undefined;
    return !!s && typeof s.revision === "number"
      && typeof s.settings === "object" && s.settings !== null && !Array.isArray(s.settings);
  }
  if (m.type === "worktrees/changed") {
    return typeof m.projectId === "string" && m.projectId.length > 0;
  }
  return m.type === "error" && typeof m.code === "string" && typeof m.message === "string";
}

export class SyncClient {
  private ws: WebSocketLike | null = null;
  private listeners = new Set<SyncListener>();
  private openListeners = new Set<() => void>();
  private statusListeners = new Set<(status: SyncStatus) => void>();
  private status: SyncStatus = "disconnected";
  private seenSeq = new Map<string, number>();
  private recoveringAt = new Map<string, number>();
  private sub: { sessionId?: string; afterSeq: number; projectId?: string } | null = null;
  private backoff: number;
  private timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private closed = false;
  private url: string | null = null;
  private socketGeneration = 0;
  private reconnectGeneration = 0;
  private subscriptionGeneration = 0;
  private reassertedSubscriptionGeneration = -1;
  private onlineHint = true;
  private foregroundHint = true;
  private openedAt: number | null = null;
  private readonly webSocket: (url: string) => WebSocketLike;
  private readonly schedule: (callback: () => void, ms: number) => ReturnType<typeof globalThis.setTimeout>;
  private readonly cancel: (timer: ReturnType<typeof globalThis.setTimeout>) => void;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly baseDelay: number;
  private readonly maxDelay: number;
  private readonly stableConnectionMs: number;
  private readonly maxSessionCursors: number;

  constructor(options: SyncClientOptions = {}) {
    this.webSocket = options.webSocket ?? ((url) => new WebSocket(url));
    this.schedule = options.setTimeout ?? globalThis.setTimeout;
    this.cancel = options.clearTimeout ?? globalThis.clearTimeout;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
    this.baseDelay = options.baseDelayMs ?? 500;
    this.maxDelay = options.maxDelayMs ?? 5_000;
    this.stableConnectionMs = options.stableConnectionMs ?? 5_000;
    this.maxSessionCursors = Math.max(1, options.maxSessionCursors ?? 256);
    this.backoff = this.baseDelay;
  }

  onEvent(cb: SyncListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  onOpen(cb: () => void): () => void {
    this.openListeners.add(cb);
    return () => this.openListeners.delete(cb);
  }

  onStatus(cb: (status: SyncStatus) => void): () => void {
    this.statusListeners.add(cb);
    cb(this.status);
    return () => this.statusListeners.delete(cb);
  }

  getStatus(): SyncStatus { return this.status; }

  /** Hints only gate automatic retries. A successful socket remains evidence
   * of connectivity; these flags never infer an auth state. */
  setRetryHints(hints: { online?: boolean; foreground?: boolean }): void {
    const wasForeground = this.foregroundHint;
    if (hints.online !== undefined) this.onlineHint = hints.online;
    if (hints.foreground !== undefined) this.foregroundHint = hints.foreground;
    if (!this.canRetry()) {
      this.clearTimer();
      if (wasForeground && !this.foregroundHint) this.suspendSocket();
      if (this.ws === null) this.publishStatus(this.inactiveStatus());
      return;
    }
    if (this.ws === null && this.url !== null) this.startConnect(this.url, true);
  }

  setSubscription(sessionId: string | undefined, afterSeq = 0, projectId?: string): void {
    this.subscriptionGeneration += 1;
    this.sub = { sessionId, afterSeq, ...(projectId ? { projectId } : {}) };
    if (sessionId) {
      this.recoveringAt.delete(sessionId);
      this.setCursor(sessionId, Math.max(this.cursor(sessionId) ?? 0, afterSeq));
    }
    this.sendSubscribe();
  }

  connect(url: string): void {
    if (this.closed) return;
    this.url = url;
    if (!this.canRetry()) {
      this.publishStatus(this.inactiveStatus());
      return;
    }
    this.startConnect(url, this.ws !== null || this.status === "reconnecting");
  }

  reconnect(): void {
    if (this.closed || this.url === null || !this.canRetry()) return;
    this.startConnect(this.url, true);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimer();
    this.socketGeneration += 1;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      try { ws.close(); } catch { /* transport is already gone */ }
    }
    this.publishStatus("disconnected");
    this.listeners.clear();
    this.openListeners.clear();
    this.statusListeners.clear();
    this.seenSeq.clear();
    this.recoveringAt.clear();
    this.sub = null;
  }

  private canRetry(): boolean { return !this.closed && this.onlineHint && this.foregroundHint; }

  private inactiveStatus(): SyncStatus {
    if (!this.foregroundHint) return "suspended";
    return this.onlineHint ? "disconnected" : "offline";
  }

  private suspendSocket(): void {
    const ws = this.ws;
    this.ws = null;
    this.socketGeneration += 1;
    this.openedAt = null;
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    try { ws.close(); } catch { /* already gone */ }
  }

  /** Map insertion order is the cursor LRU. The active subscription is always
   * retained; a revisited evicted session starts from setSubscription's caller
   * supplied durable cursor rather than guessed local history. */
  private cursor(sessionId: string): number | undefined {
    const value = this.seenSeq.get(sessionId);
    if (value !== undefined) {
      this.seenSeq.delete(sessionId);
      this.seenSeq.set(sessionId, value);
    }
    return value;
  }

  private setCursor(sessionId: string, seq: number): void {
    this.seenSeq.delete(sessionId);
    this.seenSeq.set(sessionId, seq);
    const active = this.sub?.sessionId;
    while (this.seenSeq.size > this.maxSessionCursors) {
      const oldest = this.seenSeq.keys().next().value!;
      if (oldest === active) {
        const cursor = this.seenSeq.get(oldest)!;
        this.seenSeq.delete(oldest);
        this.seenSeq.set(oldest, cursor);
        continue;
      }
      this.seenSeq.delete(oldest);
      this.recoveringAt.delete(oldest);
    }
    for (const session of this.recoveringAt.keys()) {
      if (!this.seenSeq.has(session)) this.recoveringAt.delete(session);
    }
  }

  private clearTimer(): void {
    this.reconnectGeneration += 1;
    if (this.timer !== null) {
      this.cancel(this.timer);
      this.timer = null;
    }
  }

  private startConnect(url: string, retry: boolean): void {
    this.clearTimer();
    this.reassertedSubscriptionGeneration = -1;
    const previous = this.ws;
    this.ws = null;
    this.openedAt = null;
    const generation = ++this.socketGeneration;
    try { previous?.close(); } catch { /* superseded transport */ }
    this.publishStatus(retry ? "reconnecting" : "connecting", retry);
    let ws: WebSocketLike;
    try {
      ws = this.webSocket(url);
    } catch {
      if (generation === this.socketGeneration) this.scheduleReconnect(url, generation);
      return;
    }
    if (this.closed || generation !== this.socketGeneration) {
      try { ws.close(); } catch { /* stale construction */ }
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (!this.isCurrent(ws, generation)) return;
      this.openedAt = this.now();
      this.publishStatus("connected");
      this.sendSubscribe(ws, generation);
      for (const cb of [...this.openListeners]) {
        if (!this.isCurrent(ws, generation)) return;
        cb();
      }
    };
    ws.onmessage = (event) => {
      if (!this.isCurrent(ws, generation)) return;
      this.handle(String(event.data), ws, generation);
    };
    ws.onerror = () => {
      if (!this.isCurrent(ws, generation)) return;
      try { ws.close(); } catch {
        if (!this.isCurrent(ws, generation)) return;
        this.ws = null;
        this.publishStatus("reconnecting");
        this.scheduleReconnect(url, generation);
      }
    };
    ws.onclose = (event) => {
      if (!this.isCurrent(ws, generation)) return;
      this.ws = null;
      // The gateway uses 1009 when a durable record exceeds its canonical
      // frame ceiling. Retrying that same cursor would be a permanent loop;
      // leave recovery explicit rather than claiming an auth conclusion.
      if (event.code === 1009) {
        this.publishStatus("disconnected");
        return;
      }
      if (!this.canRetry()) {
        this.publishStatus(this.inactiveStatus());
        return;
      }
      this.publishStatus("reconnecting");
      this.scheduleReconnect(url, generation);
    };
  }

  private isCurrent(ws: WebSocketLike, generation: number): boolean {
    return !this.closed && generation === this.socketGeneration && this.ws === ws;
  }

  private publishStatus(status: SyncStatus, repeat = false): void {
    if (status === this.status && !repeat) return;
    this.status = status;
    for (const listener of [...this.statusListeners]) listener(status);
  }

  private scheduleReconnect(url: string, generation: number): void {
    if (!this.canRetry() || generation !== this.socketGeneration || this.ws !== null) return;
    this.clearTimer();
    if (this.openedAt !== null && this.now() - this.openedAt >= this.stableConnectionMs) this.backoff = this.baseDelay;
    this.openedAt = null;
    const reconnectGeneration = ++this.reconnectGeneration;
    const delay = Math.min(this.maxDelay, Math.max(0, Math.floor(this.backoff * (0.5 + this.random()))));
    this.backoff = Math.min(this.maxDelay, this.backoff * 2);
    this.timer = this.schedule(() => {
      if (reconnectGeneration !== this.reconnectGeneration) return;
      this.timer = null;
      if (this.closed || generation !== this.socketGeneration || !this.canRetry() || this.ws !== null) return;
      this.startConnect(url, true);
    }, delay);
  }

  private sendSubscribe(ws = this.ws, generation = this.socketGeneration): void {
    if (!ws || !this.isCurrent(ws, generation) || ws.readyState !== WS_OPEN || !this.sub) return;
    const { sessionId, projectId } = this.sub;
    const afterSeq = sessionId ? (this.cursor(sessionId) ?? this.sub.afterSeq) : this.sub.afterSeq;
    try {
      ws.send(JSON.stringify({ type: "subscribe", ...(sessionId ? { sessionId } : {}), afterSeq, ...(projectId ? { projectId } : {}) }));
    } catch {
      if (this.isCurrent(ws, generation)) {
        try { ws.close(); } catch {
          if (!this.isCurrent(ws, generation)) return;
          this.ws = null;
          this.publishStatus("reconnecting");
          this.scheduleReconnect(this.url ?? "", generation);
        }
      }
    }
  }

  private recover(sessionId: string, ws: WebSocketLike, generation: number): void {
    const cursor = this.cursor(sessionId) ?? 0;
    this.setCursor(sessionId, cursor);
    if (this.recoveringAt.get(sessionId) === cursor) return;
    this.recoveringAt.set(sessionId, cursor);
    // The gateway subscribes one session at a time. Do not mutate a different
    // active subscription to repair unsolicited/stale traffic.
    if (this.sub?.sessionId === sessionId) this.sendSubscribe(ws, generation);
  }

  private reassertSubscription(ws: WebSocketLike, generation: number): void {
    if (this.reassertedSubscriptionGeneration === this.subscriptionGeneration) return;
    this.reassertedSubscriptionGeneration = this.subscriptionGeneration;
    this.sendSubscribe(ws, generation);
  }

  private acceptsSession(sessionId: string): boolean {
    return this.sub !== null && (this.sub.sessionId === undefined || this.sub.sessionId === sessionId);
  }

  private accept(ev: SessionEvent, ws: WebSocketLike, generation: number): boolean {
    const cursor = this.cursor(ev.sessionId) ?? 0;
    if (ev.seq <= cursor) return false;
    if (ev.seq !== cursor + 1) {
      this.recover(ev.sessionId, ws, generation);
      return false;
    }
    this.setCursor(ev.sessionId, ev.seq);
    this.recoveringAt.delete(ev.sessionId);
    return true;
  }

  private handle(raw: string, ws: WebSocketLike, generation: number): void {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return; }
    if (!isSyncInbound(parsed) || !this.isCurrent(ws, generation)) return;
    if (parsed.type === "event") {
      if (!this.acceptsSession(parsed.event.sessionId)) {
        this.reassertSubscription(ws, generation);
        return;
      }
      if (!this.accept(parsed.event, ws, generation)) return;
    } else if (parsed.type === "events") {
      if (parsed.events.some((event) => !this.acceptsSession(event.sessionId))) {
        this.reassertSubscription(ws, generation);
        return;
      }
      const accepted: SessionEvent[] = [];
      for (const event of parsed.events) {
        if (!this.isCurrent(ws, generation)) return;
        // A gap invalidates the remainder of this ordered replay frame. Do
        // not mine a later entry from it: recovery must establish the missing
        // boundary before any subsequent evidence advances the cursor.
        if (event.seq > (this.cursor(event.sessionId) ?? 0) + 1) {
          this.recover(event.sessionId, ws, generation);
          break;
        }
        if (this.accept(event, ws, generation)) accepted.push(event);
      }
      if (accepted.length === 0) return;
      parsed = { type: "events", events: accepted } satisfies SyncInbound;
    }
    if (!this.isCurrent(ws, generation)) return;
    for (const listener of [...this.listeners]) {
      if (!this.isCurrent(ws, generation)) return;
      listener(parsed as SyncInbound);
    }
  }
}
