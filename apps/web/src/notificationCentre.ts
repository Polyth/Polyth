// NTF-01 notification-centre slice. DOM-free external store: REST bootstrap +
// reconnect catch-up merge with live WS appends by NotificationRecord.id (never
// by array position), mutations are optimistic with per-row rollback, and every
// logical mutation notifies subscribers exactly once. Records are the server's
// canonical, already-redacted payloads — the browser never re-templates them.
// None of this state belongs in the main session store, URLs, or localStorage.
import { useSyncExternalStore } from "react";
import type { NotificationKind, NotificationRecord } from "@polyth/contracts";
import { api } from "@polyth/session/web-api";
import { tr } from "./i18n/index.ts";

/** Mirror of the server's retention cap (newest 200 FIFO). */
export const NOTIFICATION_CENTRE_CAP = 200;

export interface NotificationCentreState {
  /** Oldest-to-newest, one merge direction with REST and WS; UIs reverse. */
  items: NotificationRecord[];
  unread: number;
  loading: boolean;
  error: string | null;
}

/** Remote seam — the four REST routes. Injected so tests run without fetch. */
export interface NotificationCentreRemote {
  list(after?: number): Promise<{ items: NotificationRecord[]; unread: number }>;
  read(ids: string[]): Promise<{ updated: number; unread: number }>;
  readAll(): Promise<{ updated: number; unread: number }>;
  clear(): Promise<{ cleared: number; unread: number }>;
}

export interface NotificationCentre {
  getState(): NotificationCentreState;
  subscribe(cb: () => void): () => void;
  /** Initial full fetch; merges by id so a racing WS append never duplicates. */
  bootstrap(): Promise<void>;
  /** Gap-fill after every WS (re)connect: fetches `after=max(local ts)`. */
  catchUp(): Promise<void>;
  /** Live `notification/added` ingestion; duplicate ids are a no-op. */
  append(record: NotificationRecord): void;
  markRead(ids: string[]): Promise<void>;
  markAllRead(): Promise<void>;
  clear(): Promise<void>;
}

const RETRYABLE_ERROR = tr("notificationcentre.couldNotUpdateNotifications");
const LOAD_ERROR = tr("notificationcentre.couldNotLoadNotifications");

export function createNotificationCentre(remote: NotificationCentreRemote): NotificationCentre {
  let state: NotificationCentreState = { items: [], unread: 0, loading: false, error: null };
  const listeners = new Set<() => void>();
  let fetching = false; // collapses overlapping bootstrap/catch-up fetches

  const set = (patch: Partial<NotificationCentreState>): void => {
    state = { ...state, ...patch };
    for (const cb of [...listeners]) cb();
  };

  /** Merge incoming rows by id (incoming wins), keep oldest-first order by the
   *  strictly increasing server ts, and cap to the retention window. */
  const mergeRows = (incoming: NotificationRecord[]): NotificationRecord[] => {
    const byId = new Map(state.items.map((r) => [r.id, r]));
    for (const r of incoming) byId.set(r.id, r);
    return [...byId.values()].sort((a, b) => a.ts - b.ts).slice(-NOTIFICATION_CENTRE_CAP);
  };

  const fetchMerge = async (after: number | undefined, showLoading: boolean): Promise<void> => {
    if (fetching) return;
    fetching = true;
    if (showLoading) set({ loading: true, error: null });
    try {
      const r = await remote.list(after);
      // The server's unread covers the full retained inbox and is adopted as
      // truth — it also reflects read/clear changes this browser never saw.
      set({ items: mergeRows(r.items), unread: r.unread, loading: false, error: null });
    } catch {
      set({ loading: false, error: LOAD_ERROR });
    } finally {
      fetching = false;
    }
  };

  return {
    getState: () => state,
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },

    bootstrap: () => fetchMerge(undefined, true),

    catchUp() {
      const last = state.items[state.items.length - 1];
      // An empty inbox catch-up is a full bootstrap-shaped fetch.
      return fetchMerge(last?.ts, state.items.length === 0);
    },

    append(record) {
      if (state.items.some((r) => r.id === record.id)) return; // WS/REST race
      set({
        items: mergeRows([record]),
        unread: state.unread + (record.read ? 0 : 1),
      });
    },

    async markRead(ids) {
      const wanted = new Set(ids);
      // Optimistic flip: fresh row objects mark which rows THIS mutation owns,
      // so a rollback restores only rows still at the optimistic version.
      const flipped = new Map<string, NotificationRecord>();
      const optimistic = state.items.map((r) => {
        if (!wanted.has(r.id) || r.read) return r;
        const next = { ...r, read: true };
        flipped.set(r.id, next);
        return next;
      });
      if (flipped.size === 0 && ids.length === 0) return;
      if (flipped.size > 0) {
        set({ items: optimistic, unread: Math.max(0, state.unread - flipped.size), error: null });
      }
      try {
        const r = await remote.read(ids);
        set({ unread: r.unread, error: null });
      } catch {
        let unread = state.unread;
        const restored = state.items.map((r) => {
          if (flipped.get(r.id) !== r) return r; // superseded by newer truth
          unread++;
          return { ...r, read: false };
        });
        set({ items: restored, unread, error: RETRYABLE_ERROR });
      }
    },

    async markAllRead() {
      const flipped = new Map<string, NotificationRecord>();
      const optimistic = state.items.map((r) => {
        if (r.read) return r;
        const next = { ...r, read: true };
        flipped.set(r.id, next);
        return next;
      });
      set({ items: optimistic, unread: 0, error: null });
      try {
        const r = await remote.readAll();
        set({ unread: r.unread, error: null });
      } catch {
        let unread = state.unread;
        const restored = state.items.map((r) => {
          if (flipped.get(r.id) !== r) return r;
          unread++;
          return { ...r, read: false };
        });
        set({ items: restored, unread, error: RETRYABLE_ERROR });
      }
    },

    async clear() {
      const stashed = state.items;
      set({ items: [], unread: 0, error: null });
      try {
        await remote.clear();
      } catch {
        // Restore the stashed rows but keep anything appended mid-flight;
        // unread is recomputed from the merged truth we actually hold.
        const items = mergeRows(stashed);
        set({
          items,
          unread: items.reduce((n, r) => n + (r.read ? 0 : 1), 0),
          error: RETRYABLE_ERROR,
        });
      }
    },
  };
}

/** The app-wide singleton, bound to the typed REST client. */
export const notificationCentre: NotificationCentre = createNotificationCentre({
  list: (after) => api.listNotifications(after),
  read: (ids) => api.notificationsRead(ids),
  readAll: () => api.notificationsReadAll(),
  clear: () => api.notificationsClear(),
});

export function useNotificationCentre(centre: NotificationCentre = notificationCentre): NotificationCentreState {
  return useSyncExternalStore(centre.subscribe, centre.getState);
}

// ---- pure presentation helpers (shared by bell + panel, DOM-free tested) ----

/** Human labels so kind is never communicated by color alone. */
export const NOTIFICATION_KIND_LABELS: Record<NotificationKind, string> = {
  completed: tr("notificationcentre.completed"),
  failed: tr("notificationcentre.failed"),
  question: tr("notificationcentre.question"),
  permission: tr("notificationcentre.permission"),
  subagent: tr("notificationcentre.delegatedAgent"),
};

/** Accessible bell name always carries the EXACT count, even above 99. */
export function bellName(unread: number): string {
  return unread > 0
    ? tr("notificationcentre.notificationsUnreadCount", { count: unread })
    : tr("notificationcentre.notificationsNoneUnread");
}

/** Badge text: absent at zero, capped display above 99 (name keeps the count). */
export function bellBadge(unread: number): string | null {
  if (unread <= 0) return null;
  return unread > 99 ? "99+" : String(unread);
}

/** Panel rows, newest first. History off keeps unread rows only — a pure
 *  display filter that never touches server read state or retained data. */
export function centreRows(items: NotificationRecord[], historyOn: boolean): NotificationRecord[] {
  const shown = historyOn ? items : items.filter((r) => !r.read);
  return [...shown].reverse();
}

/** A row navigates only when the session registry still contains the target
 *  session AND its project matches the record. Deleted or project-mismatched
 *  sessions stay visible but disabled ("Session no longer available");
 *  archived sessions remain in the registry and stay openable. */
export function canOpenNotification(
  record: Pick<NotificationRecord, "sessionId" | "projectId">,
  sessions: ReadonlyArray<{ id: string; projectId: string }>,
): boolean {
  return sessions.some((s) => s.id === record.sessionId && s.projectId === record.projectId);
}
