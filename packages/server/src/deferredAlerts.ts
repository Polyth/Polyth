// Alerts a person's other devices were spared, kept for a while in case the
// device in use never shows them to anyone. While a person works on one
// device only that one is alerted (devicePresence.ts); this is what keeps
// that from losing an alert when they walk away:
//
// - the device in use goes quiet (idle, closed, its lease ran out) with the
//   inbox row still unread: the other devices are alerted, once it has stayed
//   quiet for a moment (a page reload or a dropped socket is not leaving);
// - the device counts only because its page was in use when the person left
//   it for another tab or window (`hidden`), and the row is still unread some
//   minutes after both the alert and their leaving: the others are alerted;
// - the person moves to another device: that one shows the inbox, nothing is
//   sent;
// - the row was read: nothing is sent.
//
// Memory only, like presence itself: a restart forgets what was held and the
// inbox rows stay. Contract: docs/mobile/platform-behavior.md "Only the
// device in use".
import type { DeviceUse } from "./devicePresence.ts";
import type { NotificationAccount } from "./notifications.ts";

/** An unread alert is sent on this long after it, and after the person left
 *  the page, when the device in use is only a hidden page. */
export const DEFERRED_ALERT_UNREAD_MS = 2 * 60_000;
/** Nobody in use for this long counts as the device having gone quiet; a
 *  reloading page or a reconnecting socket is back sooner. */
export const DEFERRED_ALERT_QUIET_MS = 20_000;
/** An alert older than this is never sent on: it stays an inbox row. */
export const DEFERRED_ALERT_MAX_MS = 15 * 60_000;
/** Held alerts per person and Space; the oldest go first. */
const PER_ACCOUNT = 20;

export interface DeferredAlerts<T> {
  /** `device` was alerted alone; keep `alert` for the person's other devices. */
  hold(account: NotificationAccount, id: string, alert: T, device: string): void;
  /** The account's device in use changed (devicePresence `subscribe`). */
  presenceChanged(account: NotificationAccount): void;
  /** Check every held alert now and wait for what that sends (timer; tests). */
  flush(): Promise<void>;
  close(): void;
}

interface Held<T> {
  account: NotificationAccount;
  id: string;
  alert: T;
  device: string;
  at: number;
  checkAt: number;
  /** Since when nobody has been in use, while that lasts. */
  quietAt?: number;
}

const accountKey = (account: NotificationAccount): string => `${account.userId}\0${account.spaceId}`;

export function createDeferredAlerts<T>(opts: {
  activeUse: (account: NotificationAccount) => DeviceUse | undefined;
  /** The inbox row still exists and nobody has read it. */
  unread: (account: NotificationAccount, id: string) => Promise<boolean>;
  /** Alert every device of the person except `exceptDevice`. */
  deliver: (account: NotificationAccount, alert: T, exceptDevice: string) => Promise<void>;
  now?: () => number;
  unreadMs?: number;
  quietMs?: number;
  maxMs?: number;
}): DeferredAlerts<T> {
  const now = opts.now ?? Date.now;
  const unreadMs = opts.unreadMs ?? DEFERRED_ALERT_UNREAD_MS;
  const quietMs = opts.quietMs ?? DEFERRED_ALERT_QUIET_MS;
  const maxMs = opts.maxMs ?? DEFERRED_ALERT_MAX_MS;
  let held: Held<T>[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const sending = new Set<Promise<void>>();

  const release = (entry: Held<T>): void => {
    const run = (async () => {
      try {
        if (await opts.unread(entry.account, entry.id)) await opts.deliver(entry.account, entry.alert, entry.device);
      } catch { /* a failed leg keeps the inbox row; nothing is retried */ }
    })();
    sending.add(run);
    void run.finally(() => { sending.delete(run); });
  };

  /** Decide one alert: true keeps holding it. */
  const keep = (entry: Held<T>, at: number): boolean => {
    if (at - entry.at > maxMs) return false;
    const use = opts.activeUse(entry.account);
    if (!use) {
      entry.quietAt ??= at;
      if (at - entry.quietAt < quietMs) { entry.checkAt = Math.min(entry.checkAt, entry.quietAt + quietMs); return true; }
      release(entry);
      return false;
    }
    if (entry.quietAt !== undefined) {
      // Back in use: the wait starts over rather than firing at once.
      entry.quietAt = undefined;
      entry.checkAt = Math.max(entry.checkAt, at + quietMs);
    }
    // The person is on another device now: it shows the inbox row itself.
    if (use.device !== entry.device) return false;
    if (at < entry.checkAt) return true;
    if (!use.hidden) { entry.checkAt = at + unreadMs; return true; }
    // A hidden page: wait until the person has been away from it this long.
    const due = Math.max(entry.at, use.touchedAt) + unreadMs;
    if (at < due) { entry.checkAt = due; return true; }
    release(entry);
    return false;
  };

  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (closed || held.length === 0) return;
    const next = Math.min(...held.map((entry) => Math.min(entry.checkAt, entry.at + maxMs + 1)));
    timer = setTimeout(() => { timer = undefined; sweep(); }, Math.max(0, Math.min(next - now(), 2_147_000_000)));
    timer.unref?.();
  };
  const sweep = (only?: string): void => {
    const at = now();
    held = held.filter((entry) => (only !== undefined && accountKey(entry.account) !== only) || keep(entry, at));
    schedule();
  };

  return {
    hold(account, id, alert, device) {
      if (closed) return;
      const at = now();
      held.push({ account: { userId: account.userId, spaceId: account.spaceId }, id, alert, device, at, checkAt: at + unreadMs });
      const key = accountKey(account);
      const own = held.filter((entry) => accountKey(entry.account) === key);
      if (own.length > PER_ACCOUNT) {
        const dropped = new Set(own.slice(0, own.length - PER_ACCOUNT));
        held = held.filter((entry) => !dropped.has(entry));
      }
      schedule();
    },
    presenceChanged(account) {
      if (closed) return;
      sweep(accountKey(account));
    },
    async flush() {
      if (!closed) sweep();
      while (sending.size) await Promise.all([...sending]);
    },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      held = [];
    },
  };
}
