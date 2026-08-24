// WS client for the /ws gateway (PLAN §5). Reconnect-safe: resends the last
// subscription (per-session afterSeq) on open and dedupes by (sessionId, seq)
// so replay/gap-fill never double-applies an event. DOM-free apart from the
// browser's native WebSocket, which is only touched inside connect().
import type { InstalledPluginDto, NotificationKind, NotificationRecord, PackageDescriptorDto, SessionEvent, SessionProjection } from "@polyth/contracts";

export type SyncInbound =
  | { type: "event"; event: SessionEvent }
  | { type: "projection"; session: SessionProjection }
  | { type: "notification/added"; notification: NotificationRecord }
  | { type: "plugin/changed"; plugin: InstalledPluginDto }
  | { type: "package/changed"; package: PackageDescriptorDto }
  | { type: "error"; code: string; message: string };

export type SyncListener = (msg: SyncInbound) => void;
export type SyncStatus = "connecting" | "connected" | "disconnected";

export interface SeqDedupe {
  has(sessionId: string, seq: number): boolean;
  add(sessionId: string, seq: number): void;
  size(): number;
}

export function createSeqDedupe(): SeqDedupe {
  const seen = new Set<string>();
  return {
    has: (sessionId, seq) => seen.has(`${sessionId}:${seq}`),
    add: (sessionId, seq) => {
      seen.add(`${sessionId}:${seq}`);
    },
    size: () => seen.size,
  };
}

const NOTIFICATION_KINDS: readonly NotificationKind[] = ["completed", "failed", "question", "permission", "subagent"];

export function isSyncInbound(raw: unknown): raw is SyncInbound {
  if (typeof raw !== "object" || raw === null) return false;
  const m = raw as Record<string, unknown>;
  if (m.type === "event") {
    const e = m.event as Record<string, unknown> | undefined;
    return !!e && typeof e.sessionId === "string" && typeof e.seq === "number";
  }
  if (m.type === "projection") {
    const s = m.session as Record<string, unknown> | undefined;
    return !!s && typeof s.id === "string" && typeof s.status === "string";
  }
  if (m.type === "notification/added") {
    // NTF-01: every required record field is validated; a malformed envelope
    // is dropped silently like any other unknown message.
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
  if (m.type === "plugin/changed") {
    const plugin = m.plugin as Record<string, unknown> | undefined;
    return !!plugin
      && typeof plugin.id === "string"
      && typeof plugin.enabled === "boolean"
      && typeof plugin.status === "string"
      && Array.isArray(plugin.contributions);
  }
  if (m.type === "package/changed") {
    const pkg = m.package as Record<string, unknown> | undefined;
    return !!pkg
      && typeof pkg.id === "string"
      && typeof pkg.enabled === "boolean";
  }
  return m.type === "error" && typeof m.code === "string" && typeof m.message === "string";
}

export class SyncClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<SyncListener>();
  private openListeners = new Set<() => void>();
  private statusListeners = new Set<(status: SyncStatus) => void>();
  private status: SyncStatus = "disconnected";
  private dedupe = createSeqDedupe();
  private seenSeq = new Map<string, number>(); // sessionId -> last applied seq
  private sub: { sessionId?: string; afterSeq: number } | null = null;
  private backoff = 500; // ms, 500 → 5000
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private url: string | null = null;

  onEvent(cb: SyncListener): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** Fires after every successful connection (first open AND each reconnect)
   *  so callers can run REST catch-up (NTF-01) instead of polling. */
  onOpen(cb: () => void): () => void {
    this.openListeners.add(cb);
    return () => {
      this.openListeners.delete(cb);
    };
  }

  onStatus(cb: (status: SyncStatus) => void): () => void {
    this.statusListeners.add(cb);
    cb(this.status);
    return () => {
      this.statusListeners.delete(cb);
    };
  }

  getStatus(): SyncStatus {
    return this.status;
  }


  setSubscription(sessionId: string | undefined, afterSeq = 0): void {
    this.sub = { sessionId, afterSeq };
    this.sendSubscribe();
  }

  connect(url: string): void {
    if (this.closed) return;
    this.url = url;
    this.publishStatus("connecting");
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 500;
      this.publishStatus("connected");
      this.sendSubscribe();
      for (const cb of [...this.openListeners]) cb();
    };
    ws.onmessage = (e: MessageEvent) => {
      this.handle(String(e.data));
    };
    ws.onclose = () => {
      if (this.ws === ws) {
        this.ws = null;
        this.publishStatus("disconnected");
        this.scheduleReconnect(url);
      }
    };
    ws.onerror = () => {
      ws.close(); // onclose fires → reconnect
    };
  }

  /** Immediately replace the current transport while preserving subscription
   * and replay state. The superseded socket cannot schedule a second retry. */
  reconnect(): void {
    const url = this.url;
    if (this.closed || url === null) return;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const previous = this.ws;
    this.ws = null;
    previous?.close();
    this.connect(url);
  }

  close(): void {
    this.closed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
    this.publishStatus("disconnected");
  }

  private publishStatus(status: SyncStatus): void {
    if (status === this.status) return;
    this.status = status;
    for (const listener of [...this.statusListeners]) listener(status);
  }

  private scheduleReconnect(url: string): void {
    if (this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect(url);
    }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, 5000);
  }

  private sendSubscribe(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || !this.sub) return;
    const { sessionId } = this.sub;
    const afterSeq = sessionId ? (this.seenSeq.get(sessionId) ?? this.sub.afterSeq) : this.sub.afterSeq;
    ws.send(JSON.stringify({ type: "subscribe", ...(sessionId ? { sessionId } : {}), afterSeq }));
  }

  private handle(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isSyncInbound(parsed)) return;
    if (parsed.type === "event") {
      const ev = parsed.event;
      if (this.dedupe.has(ev.sessionId, ev.seq)) return;
      this.dedupe.add(ev.sessionId, ev.seq);
      this.seenSeq.set(ev.sessionId, Math.max(this.seenSeq.get(ev.sessionId) ?? 0, ev.seq));
    }
    for (const l of [...this.listeners]) l(parsed);
  }
}