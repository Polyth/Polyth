// NTF-01 notification-centre slice. DOM-free external store: REST bootstrap +
// reconnect catch-up merge with live WS appends by NotificationRecord.id (never
// by array position), mutations are optimistic with per-row rollback, and every
// logical mutation notifies subscribers exactly once. Records are the server's
// canonical, already-redacted payloads — the browser never re-templates them.
// None of this state belongs in the main session store, URLs, or localStorage.
import { useSyncExternalStore } from "react";
import type { NotificationKind, NotificationRecord } from "@polyth/contracts";
import { api } from "@polyth/session/web-api";
import { dateTimeFormatter, getLocale, tr } from "./i18n/index.ts";

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
    const rows = [...byId.values()].sort((a, b) => a.ts - b.ts);
    // Another server's notice is one row per key: a later one replaces it.
    const latest = new Map(rows.flatMap((r) => r.joinedSpace ? [[r.key, r.id] as const] : []));
    return rows.filter((r) => !r.joinedSpace || latest.get(r.key) === r.id).slice(-NOTIFICATION_CENTRE_CAP);
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
      const replaced = record.joinedSpace
        ? state.items.filter((r) => r.joinedSpace && r.key === record.key && !r.read).length
        : 0;
      set({
        items: mergeRows([record]),
        unread: state.unread + (record.read ? 0 : 1) - replaced,
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
// Getters: a non-English catalog lands after this module loads, so each label
// is translated when it is read.
export const NOTIFICATION_KIND_LABELS: Record<NotificationKind, string> = {
  get completed() { return tr("notificationcentre.completed"); },
  get failed() { return tr("notificationcentre.failed"); },
  get question() { return tr("notificationcentre.question"); },
  get permission() { return tr("notificationcentre.permission"); },
  get subagent() { return tr("notificationcentre.delegatedAgent"); },
  get mention() { return tr("notificationcentre.mention"); },
  get message() { return tr("notificationcentre.message"); },
};

/** The server keys a provider-limit notice by its limit window (`limitEpisode`
 *  in push.ts), not by the chat's turn. Such a row is a limit that was reached,
 *  not a broken run. */
export function isLimitNotice(record: Pick<NotificationRecord, "kind" | "key">): boolean {
  return record.kind === "failed" && record.key.startsWith("limit:");
}

export function notificationKindLabel(record: Pick<NotificationRecord, "kind" | "key">): string {
  return isLimitNotice(record) ? tr("notificationcentre.limitReached") : NOTIFICATION_KIND_LABELS[record.kind];
}

/** Same-day rows show the time; older ones add the date. Both use the locale's
 *  own clock. */
export function notificationWhen(ts: number, locale: string = getLocale(), now = Date.now()): string {
  const sameDay = new Date(ts).toDateString() === new Date(now).toDateString();
  return dateTimeFormatter(locale, sameDay
    ? { timeStyle: "short" }
    : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(ts);
}

const MERIDIEM_CLOCK = /\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s?([ap])(?:\.m\.|m\b)/gi;

/** A provider words its reset on its own 12-hour clock ("resets 8:40pm
 *  (Europe/Kyiv)"), which put two time formats on one card. In a limit notice
 *  only that clock reading is rewritten in the reader's format: it is not
 *  converted, so the zone the provider names after it stays true. */
export function notificationBody(
  record: Pick<NotificationRecord, "kind" | "key" | "body">,
  locale: string = getLocale(),
): string {
  if (!isLimitNotice(record)) return record.body;
  const clock = dateTimeFormatter(locale, { timeStyle: "short", timeZone: "UTC" });
  return record.body.replace(MERIDIEM_CLOCK, (_, hour: string, minute: string | undefined, half: string) =>
    clock.format(Date.UTC(2000, 0, 1, (Number(hour) % 12) + (half.toLowerCase() === "p" ? 12 : 0), Number(minute ?? 0))));
}

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
 *  archived sessions remain in the registry and stay openable. A joined
 *  Space's session lives on another server, so its row always navigates. */
export function canOpenNotification(
  record: Pick<NotificationRecord, "sessionId" | "projectId" | "joinedSpace" | "settings">,
  sessions: ReadonlyArray<{ id: string; projectId: string }>,
): boolean {
  return record.joinedSpace !== undefined || record.settings !== undefined || sessions.some((s) => s.id === record.sessionId && s.projectId === record.projectId);
}
