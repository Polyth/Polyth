// Which device a person is working on right now, per Space. Open pages report
// whether their person is using them (visible and touched lately); the device
// touched most recently wins. While a person works on one device, alerts and
// the phone's Live Activity go only there (docs/mobile/platform-behavior.md
// "Only the device in use"). The registry is memory only: a restart forgets
// it, and with nobody active every device is alerted as before.
import type { AuthPrincipal } from "@polyth/contracts";
import type { NotificationAccount } from "./notifications.ts";

/** A report stays good this long; pages re-report every minute while used. */
export const PRESENCE_LEASE_MS = 150_000;
/** Longest idle time a report may claim (anything older is not "in use"). */
const MAX_IDLE_MS = 24 * 3600_000;
const CLIENT_ID = /^[A-Za-z0-9_-]{16,64}$/;

/** The phone's identity on its Link connection, its native push registration
 *  and its Live Activity registration. */
export const pairedDeviceKey = (deviceEndpointId: string): string => `device:${deviceEndpointId}`;

/** One device's key, from what the server itself knows about the caller where
 *  it can: the paired phone's endpoint, the browser's remembered device. A
 *  loopback page (the desktop app, a browser on the host) has neither, so its
 *  own install id stands in. The key only steers this person's own alerts. */
export function presenceDeviceKey(principal: AuthPrincipal | null | undefined, clientId?: unknown): string | undefined {
  if (!principal) return undefined;
  if (principal.kind === "paired-device") return pairedDeviceKey(principal.deviceEndpointId);
  if (principal.kind === "ui-session") return `browser:${principal.rememberedDeviceId}`;
  if (principal.kind === "local-user") return typeof clientId === "string" && CLIENT_ID.test(clientId) ? `client:${clientId}` : undefined;
  return undefined;
}

export interface DevicePresence {
  /** One connection's report. `idleMs` is how long ago its person last
   *  touched it, measured on that device (a duration, so no clock skew). */
  report(connection: object, account: NotificationAccount, device: string, active: boolean, idleMs: number): void;
  /** The connection closed. */
  drop(connection: object): void;
  /** The device this person is using in that Space now, if any. */
  activeDevice(account: NotificationAccount): string | undefined;
  /** Told once per change of an account's active device. */
  subscribe(listener: (account: NotificationAccount) => void): () => void;
  close(): void;
}

interface Report {
  account: NotificationAccount;
  device: string;
  active: boolean;
  /** Server time of the person's last touch. */
  touchedAt: number;
  /** Server time of the report. */
  at: number;
}

const accountKey = (account: NotificationAccount): string => `${account.userId}\0${account.spaceId}`;

export function createDevicePresence(opts: { now?: () => number; leaseMs?: number } = {}): DevicePresence {
  const now = opts.now ?? Date.now;
  const lease = opts.leaseMs ?? PRESENCE_LEASE_MS;
  const reports = new Map<object, Report>();
  /** The last active device each account's listeners were told about. */
  const known = new Map<string, { account: NotificationAccount; device: string | undefined }>();
  const listeners = new Set<(account: NotificationAccount) => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const activeDevice = (account: NotificationAccount): string | undefined => {
    const key = accountKey(account);
    const at = now();
    let best: Report | undefined;
    for (const report of reports.values()) {
      if (!report.active || at - report.at > lease || accountKey(report.account) !== key) continue;
      if (!best || report.touchedAt > best.touchedAt || (report.touchedAt === best.touchedAt && report.at > best.at)) best = report;
    }
    return best?.device;
  };
  const settle = (account: NotificationAccount) => {
    const key = accountKey(account);
    const device = activeDevice(account);
    const previous = known.get(key);
    if (previous?.device === device) return;
    if (device === undefined && ![...reports.values()].some((report) => accountKey(report.account) === key)) known.delete(key);
    else known.set(key, { account, device });
    for (const listener of [...listeners]) {
      try { listener(account); } catch { /* one listener cannot stop the others */ }
    }
  };
  // A device that stops reporting (a phone suspended without a goodbye) stops
  // counting when its lease runs out, not at its next report.
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (closed) return;
    let next = Infinity;
    const at = now();
    // Only leases still running: a lapsed report stays until its connection
    // reports again or closes, and must not re-arm the timer at once forever.
    for (const report of reports.values()) {
      const expires = report.at + lease + 1;
      if (report.active && expires > at) next = Math.min(next, expires);
    }
    if (next === Infinity) return;
    timer = setTimeout(() => {
      timer = undefined;
      for (const { account } of [...known.values()]) settle(account);
      schedule();
    }, Math.max(0, Math.min(next - now(), 2_147_000_000)));
    timer.unref?.();
  };

  return {
    report(connection, account, device, active, idleMs) {
      if (closed) return;
      const at = now();
      const idle = Number.isFinite(idleMs) ? Math.min(Math.max(0, idleMs), MAX_IDLE_MS) : MAX_IDLE_MS;
      const previous = reports.get(connection);
      reports.set(connection, { account: { userId: account.userId, spaceId: account.spaceId }, device, active, touchedAt: at - idle, at });
      // A connection that moved to another Space (or device) leaves the old one.
      if (previous && accountKey(previous.account) !== accountKey(account)) settle(previous.account);
      settle(account);
      schedule();
    },
    drop(connection) {
      const previous = reports.get(connection);
      if (!previous) return;
      reports.delete(connection);
      settle(previous.account);
      schedule();
    },
    activeDevice,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      reports.clear();
      known.clear();
      listeners.clear();
    },
  };
}
