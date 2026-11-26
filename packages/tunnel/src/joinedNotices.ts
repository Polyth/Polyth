// Relaying a person's notifications from a joined server to them here, as that
// person's device there. A socket on the other server belongs to one Space, so
// every joined Space gets its own for live rows; reading the list on each
// (re)connect and every `noticeMs` recovers what was raised while offline and
// finds what was read or cleared there, which no frame announces.
import type { ServerPersonNotices } from "@polyth/plugins";
import type { NotificationRecord } from "@polyth/contracts";
import { WebSocket } from "ws";
import { proxyJson, type ProxySession } from "./joinedForward.ts";

/** A catch-up delivers at most this many unread rows, none older than this. */
export const NOTICE_CATCH_UP = 50;
export const NOTICE_MAX_AGE_MS = 24 * 60 * 60_000;
const TRACKED_CAP = 500;
const FRAME_LIMIT = 8 * 1024 * 1024;
/** A project the other server cannot have: the socket then hears no chat
 *  updates, only what is addressed to this person. */
const NO_PROJECT = "polyth-link-notices";

/** A delivered notice not yet read there: the other server's row id, its Space
 *  there and our key for it. Saved, so a restart still withdraws it. */
export type SavedNotice = [remoteId: string, spaceId: string, key: string];

export interface NoticeLink {
  connectionId: string;
  session: ProxySession;
  serverLabel: string;
  spaces: ReadonlyArray<{ id: string; name: string; joinedId: string }>;
  /** Reads one Space's list; null when the other server cannot be asked for
   *  that Space now. */
  read(spaceId: string): Promise<Awaited<ReturnType<typeof proxyJson>> | null>;
  /** Makes the Space the one an upgrade lands in and runs `open` while it
   *  stays so; false when it cannot be selected. */
  inSpace(spaceId: string, open: () => Promise<void>): Promise<boolean>;
}

export interface NoticeTiming {
  noticeMs: number;
  retryMinMs: number;
  retryMaxMs: number;
  requestMs: number;
}

interface Watcher {
  socket: WebSocket | null;
  connecting: boolean;
  /** When the unanswered ping was sent; 0 while none is. */
  pingedAt: number;
  failures: number;
  retryAt: number;
  timer?: ReturnType<typeof setTimeout>;
  readAt: number;
  reading: boolean;
  again: boolean;
}

interface RemoteRow extends Record<string, unknown> { id: string; key: string; ts: number; read: boolean }

/** One of this person's own rows there. A row it relays from a third server is
 *  not passed on: two servers joined to each other would echo without end. */
function remoteRow(value: unknown): RemoteRow | null {
  const row = value as Partial<RemoteRow> & { joinedSpace?: unknown } | null;
  if (!row || typeof row !== "object" || row.joinedSpace !== undefined) return null;
  if (typeof row.id !== "string" || !row.id || row.id.length > 128) return null;
  if (typeof row.key !== "string" || !row.key || row.key.length > 360 || row.key.startsWith("rmt:")) return null;
  if (!Number.isSafeInteger(row.ts) || typeof row.read !== "boolean") return null;
  return row as RemoteRow;
}

/** The relay of one joined connection. */
export function createNoticeRelay(options: {
  userId: string;
  sink: () => Pick<ServerPersonNotices, "deliver" | "withdraw"> | undefined;
  timing: NoticeTiming;
  saved?: unknown;
  /** The saved list changed. */
  changed(): void;
}) {
  const { timing, userId } = options;
  /** By the other server's row id. `sent` is false for rows restored from disk,
   *  which the next catch-up hands over once more (the host ignores repeats). */
  const tracked = new Map<string, { spaceId: string; key: string; sent: boolean }>();
  for (const entry of Array.isArray(options.saved) ? options.saved.slice(-TRACKED_CAP) : []) {
    if (Array.isArray(entry) && entry.length === 3 && entry.every((part) => typeof part === "string" && part)) {
      tracked.set(entry[0] as string, { spaceId: entry[1] as string, key: entry[2] as string, sent: false });
    }
  }
  const watchers = new Map<string, Watcher>();
  let link: NoticeLink | null = null;

  const end = (watcher: Watcher): void => {
    clearTimeout(watcher.timer);
    const socket = watcher.socket;
    watcher.socket = null;
    socket?.terminate();
  };

  /** Withdraws the keys of these rows that no other tracked row still holds. */
  const forgetRows = (ids: string[]): boolean => {
    const sink = options.sink();
    if (!sink || !ids.length) return false;
    const keys = new Set<string>();
    for (const id of ids) {
      const row = tracked.get(id);
      if (row) keys.add(row.key);
      tracked.delete(id);
    }
    for (const row of tracked.values()) keys.delete(row.key);
    for (const key of keys) sink.withdraw(userId, key);
    return true;
  };

  const deliver = (spaceId: string, rows: RemoteRow[]): boolean => {
    const sink = options.sink();
    const space = link?.spaces.find((candidate) => candidate.id === spaceId);
    if (!sink || !link || !space) return false;
    const oldest = Date.now() - NOTICE_MAX_AGE_MS;
    const fresh = rows.filter((row) => !row.read && row.ts >= oldest)
      .sort((a, b) => a.ts - b.ts).slice(-NOTICE_CATCH_UP);
    // A key repeats (each finished turn of one chat): only its newest row is
    // news, the older ones are tracked so the key is withdrawn with the last.
    const newest = new Map(fresh.map((row) => [row.key, row.id]));
    let changed = false;
    for (const row of fresh) {
      if (tracked.get(row.id)?.sent) continue;
      const key = `rmt:${link.connectionId}:${row.key}`;
      changed ||= !tracked.has(row.id);
      if (newest.get(row.key) === row.id) {
        sink.deliver(userId, {
          ...row as unknown as NotificationRecord,
          key,
          joinedSpace: { id: space.joinedId, name: space.name, serverLabel: link.serverLabel },
        });
      }
      tracked.set(row.id, { spaceId, key, sent: true });
    }
    while (tracked.size > TRACKED_CAP) tracked.delete(tracked.keys().next().value!);
    return changed;
  };

  const catchUp = async (spaceId: string, watcher: Watcher): Promise<void> => {
    if (watcher.reading) {
      watcher.again = true;
      return;
    }
    watcher.reading = true;
    try {
      do {
        watcher.again = false;
        const asked = link;
        if (!asked) return;
        // Only rows known before asking can be missing because they are gone.
        const known = [...tracked].filter(([, row]) => row.spaceId === spaceId).map(([id]) => id);
        const answer = await asked.read(spaceId);
        const items = (answer?.body as { items?: unknown } | null)?.items;
        if (link?.session !== asked.session || answer?.status !== 200 || !Array.isArray(items)) return;
        watcher.readAt = Date.now();
        const rows = items.flatMap((item) => remoteRow(item) ?? []);
        const unread = new Set(rows.filter((row) => !row.read).map((row) => row.id));
        const added = deliver(spaceId, rows);
        const removed = forgetRows(known.filter((id) => !unread.has(id)));
        if (added || removed) options.changed();
      } while (watcher.again);
    } catch {
      // The next one reads it all again.
    } finally {
      watcher.reading = false;
    }
  };

  const retryLater = (watcher: Watcher): void => {
    watcher.failures += 1;
    const delay = Math.min(timing.retryMinMs * 2 ** Math.min(watcher.failures - 1, 20), timing.retryMaxMs);
    watcher.retryAt = Date.now() + delay;
    clearTimeout(watcher.timer);
    watcher.timer = setTimeout(() => {
      const current = [...watchers].find(([, candidate]) => candidate === watcher);
      if (current) void listen(current[0], watcher);
    }, delay);
    watcher.timer.unref?.();
  };

  const listen = async (spaceId: string, watcher: Watcher): Promise<void> => {
    const asked = link;
    if (!asked || watcher.socket || watcher.connecting || Date.now() < watcher.retryAt) return;
    watcher.connecting = true;
    const current = (): boolean => link?.session === asked.session && watchers.get(spaceId) === watcher;
    try {
      const selected = await asked.inSpace(spaceId, () => new Promise<void>((resolve) => {
        if (!current()) return resolve();
        const socket = new WebSocket(`ws://127.0.0.1:${asked.session.port}/ws`, {
          headers: { cookie: asked.session.cookie }, handshakeTimeout: timing.requestMs, maxPayload: FRAME_LIMIT,
        });
        watcher.socket = socket;
        socket.on("error", () => {});
        socket.once("open", () => {
          watcher.pingedAt = 0;
          watcher.failures = 0;
          socket.send(JSON.stringify({ type: "subscribe", projectId: NO_PROJECT }));
          resolve();
          void catchUp(spaceId, watcher);
        });
        socket.on("pong", () => { watcher.pingedAt = 0; });
        socket.on("message", (data) => {
          if (watcher.socket !== socket || !current()) return;
          let frame: { type?: unknown; notification?: unknown };
          try { frame = JSON.parse(String(data)) as typeof frame; } catch { return; }
          if (frame?.type !== "notification/added") return;
          const row = remoteRow(frame.notification);
          if (row && deliver(spaceId, [row])) options.changed();
        });
        socket.once("close", () => {
          resolve();
          if (watcher.socket !== socket) return;
          watcher.socket = null;
          if (current()) retryLater(watcher);
        });
      }));
      if (!selected && current()) retryLater(watcher);
    } catch {
      if (current()) retryLater(watcher);
    } finally {
      watcher.connecting = false;
    }
  };

  const offline = (): void => {
    link = null;
    for (const watcher of watchers.values()) end(watcher);
    watchers.clear();
  };

  return {
    saved: (): SavedNotice[] => [...tracked].map(([id, row]) => [id, row.spaceId, row.key]),

    /** One step while the connection is up: sockets opened and checked, lists
     *  read when due, Spaces the person left withdrawn. */
    sync(next: NoticeLink): void {
      if (link && link.session !== next.session) offline();
      link = next;
      const present = new Set(next.spaces.map((space) => space.id));
      for (const [id, watcher] of watchers) {
        if (present.has(id)) continue;
        end(watcher);
        watchers.delete(id);
      }
      if (forgetRows([...tracked].filter(([, row]) => !present.has(row.spaceId)).map(([id]) => id))) options.changed();
      for (const spaceId of present) {
        let watcher = watchers.get(spaceId);
        if (!watcher) {
          watcher = { socket: null, connecting: false, pingedAt: 0, failures: 0, retryAt: 0, readAt: 0, reading: false, again: false };
          watchers.set(spaceId, watcher);
        }
        const socket = watcher.socket;
        if (socket?.readyState === WebSocket.OPEN) {
          if (!watcher.pingedAt) {
            watcher.pingedAt = Date.now();
            socket.ping();
          } else if (Date.now() - watcher.pingedAt > timing.requestMs) socket.terminate();
        } else void listen(spaceId, watcher);
        // The list does not wait for the socket: a device that may not switch
        // Spaces still catches up.
        if (Date.now() - watcher.readAt >= timing.noticeMs) void catchUp(spaceId, watcher);
      }
    },

    /** Read one Space again now (the person just read something there). */
    refresh(spaceId: string): void {
      const watcher = watchers.get(spaceId);
      if (watcher) void catchUp(spaceId, watcher);
    },

    /** Stops listening; what was delivered stays. */
    offline,

    /** The person left this server: nothing of it can be opened any more. */
    leave(): void {
      offline();
      if (forgetRows([...tracked.keys()])) options.changed();
    },
  };
}

export type NoticeRelay = ReturnType<typeof createNoticeRelay>;
