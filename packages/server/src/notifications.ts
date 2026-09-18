// Server-owned, account-scoped notification inbox. NotificationRecord remains
// the public/model-safe DTO; ownership is private durable routing metadata.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { atomicWriteSync } from "@polyth/plugins";
import { dirname } from "node:path";
import type { NotificationKind, NotificationRecord } from "@polyth/contracts";

/** Retain the newest 200 rows independently for each account in each Space. */
export const NOTIFICATION_CAP = 200;

const KINDS: readonly NotificationKind[] = ["completed", "failed", "question", "permission", "subagent"];

/** Private routing identity. Never serialize this in NotificationRecord/WS DTOs. */
export interface NotificationAccount {
  userId: string;
  spaceId: string;
}

export interface NotificationDelivery {
  record: NotificationRecord;
  recipient: NotificationAccount;
}

export interface NotificationStore {
  list(account: NotificationAccount, after?: number): Promise<{ items: NotificationRecord[]; unread: number }>;
  list(after?: number): Promise<{ items: NotificationRecord[]; unread: number }>;
  get(account: NotificationAccount, id: string): Promise<NotificationRecord | undefined>;
  add(account: NotificationAccount, input: Omit<NotificationRecord, "id" | "ts" | "read">): Promise<NotificationRecord | undefined>;
  add(input: Omit<NotificationRecord, "id" | "ts" | "read">): Promise<NotificationRecord>;
  /** Persist immutable creator routing policy after the session itself exists. */
  registerSessionRecipient(sessionId: string, recipient: NotificationAccount): Promise<boolean>;
  /** Forked sessions inherit the parent's recipient; no ambient actor fallback. */
  inheritSessionRecipient(parentSessionId: string, sessionId: string, account: NotificationAccount): Promise<boolean>;
  recipientForSession(sessionId: string, account: Pick<NotificationAccount, "spaceId">): Promise<NotificationAccount | undefined>;
  read(account: NotificationAccount, ids: string[]): Promise<{ updated: number; unread: number }>;
  read(ids: string[]): Promise<{ updated: number; unread: number }>;
  readAll(account: NotificationAccount): Promise<{ updated: number; unread: number }>;
  readAll(): Promise<{ updated: number; unread: number }>;
  clear(account: NotificationAccount): Promise<{ cleared: number; unread: number }>;
  clear(): Promise<{ cleared: number; unread: number }>;
  /** Internal account-deletion hook; removes every Space-scoped row and
   * creator binding so recreating the same stable account id adopts nothing. */
  removeAccount(userId: string): Promise<{ cleared: number; recipients: number }>;
}

interface StoredNotification {
  record: NotificationRecord;
  recipient: NotificationAccount;
}

interface NotificationFile {
  version: 2;
  items: StoredNotification[];
  recipients: Array<{ sessionId: string; recipient: NotificationAccount }>;
}

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const validAccount = (raw: unknown): raw is NotificationAccount => {
  if (!raw || typeof raw !== "object") return false;
  const value = raw as Record<string, unknown>;
  return isNonEmptyString(value.userId) && isNonEmptyString(value.spaceId);
};
const accountKey = (account: NotificationAccount): string => `${account.userId}\0${account.spaceId}`;
const recipientKey = (sessionId: string, spaceId: string): string => `${spaceId}\0${sessionId}`;
const sameAccount = (left: NotificationAccount, right: NotificationAccount): boolean =>
  left.userId === right.userId && left.spaceId === right.spaceId;
const LEGACY_TEST_ACCOUNT: NotificationAccount = { userId: "__isolated_test__", spaceId: "__isolated_test__" };

function validateRecord(raw: unknown): NotificationRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!isNonEmptyString(r.id) || !isNonEmptyString(r.key)) return null;
  if (!KINDS.includes(r.kind as NotificationKind)) return null;
  if (!isNonEmptyString(r.sessionId) || !isNonEmptyString(r.projectId)) return null;
  if (typeof r.title !== "string" || typeof r.body !== "string") return null;
  if (typeof r.ts !== "number" || !Number.isSafeInteger(r.ts) || r.ts < 0) return null;
  if (typeof r.read !== "boolean") return null;
  return {
    id: r.id, key: r.key, kind: r.kind as NotificationKind,
    sessionId: r.sessionId, projectId: r.projectId,
    title: r.title, body: r.body, ts: r.ts, read: r.read,
  };
}

function validateStored(raw: unknown): StoredNotification | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const record = validateRecord(value.record);
  return record && validAccount(value.recipient) ? { record, recipient: value.recipient } : null;
}

export function createNotificationStore(opts: {
  file: string;
  /** Rechecked on every persisted/read operation; false is fail-closed. */
  hasAccess?: (account: NotificationAccount) => boolean;
  now?: () => number;
}): NotificationStore {
  const now = opts.now ?? Date.now;
  // Omitting the authority is intentionally useful only for isolated unit
  // stores. Production always supplies tenancy's durable membership check.
  const hasAccess = opts.hasAccess ?? (() => true);
  let items: StoredNotification[] = [];
  const recipients = new Map<string, NotificationAccount>();
  try {
    const raw = JSON.parse(readFileSync(opts.file, "utf8")) as Partial<NotificationFile>;
    // v1 had no trustworthy owner. Never adopt it into any account.
    if (raw && raw.version === 2 && Array.isArray(raw.items) && Array.isArray(raw.recipients)) {
      const seen = new Set<string>();
      let previousTs = -1;
      for (const candidate of raw.items) {
        const entry = validateStored(candidate);
        if (!entry) continue;
        const idKey = `${accountKey(entry.recipient)}\0${entry.record.id}`;
        if (seen.has(idKey) || entry.record.ts <= previousTs) continue;
        seen.add(idKey);
        previousTs = entry.record.ts;
        items.push(entry);
      }
      for (const rawRecipient of raw.recipients) {
        if (!rawRecipient || typeof rawRecipient !== "object") continue;
        const candidate = rawRecipient as { sessionId?: unknown; recipient?: unknown };
        if (isNonEmptyString(candidate.sessionId) && validAccount(candidate.recipient)) {
          recipients.set(recipientKey(candidate.sessionId, candidate.recipient.spaceId), candidate.recipient);
        }
      }
      const counts = new Map<string, number>();
      items = items.slice().reverse().filter((entry) => {
        const key = accountKey(entry.recipient);
        const count = counts.get(key) ?? 0;
        counts.set(key, count + 1);
        return count < NOTIFICATION_CAP;
      }).reverse();
    } else {
      console.warn("[polyth] notifications.json has an unsupported shape; starting with an empty inbox");
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[polyth] notifications.json is unreadable; starting with an empty inbox");
    }
  }

  let lastTs = items.reduce((max, entry) => Math.max(max, entry.record.ts), 0);
  const unreadCount = (account: NotificationAccount): number =>
    items.reduce((count, entry) => count + (!entry.record.read && sameAccount(entry.recipient, account) ? 1 : 0), 0);
  const authorized = (account: NotificationAccount): boolean => validAccount(account) && hasAccess(account);
  const snapshotRecipients = () => [...recipients.entries()].map(([key, recipient]) => ({
    sessionId: key.slice(recipient.spaceId.length + 1), recipient,
  }));
  const persist = (nextItems: StoredNotification[]): void => {
    mkdirSync(dirname(opts.file), { recursive: true });
    const body: NotificationFile = { version: 2, items: nextItems, recipients: snapshotRecipients() };
    atomicWriteSync(opts.file, `${JSON.stringify(body, null, 2)}\n`, 0o600);
  };

  let chain: Promise<unknown> = Promise.resolve();
  const serialized = <T>(fn: () => T): Promise<T> => {
    const next = chain.then(fn);
    chain = next.catch(() => undefined);
    return next;
  };
  const evictFor = (next: StoredNotification[], account: NotificationAccount): StoredNotification[] => {
    let excess = next.reduce((count, entry) => count + (sameAccount(entry.recipient, account) ? 1 : 0), 0) - NOTIFICATION_CAP;
    return excess <= 0 ? next : next.filter((entry) => {
      if (excess > 0 && sameAccount(entry.recipient, account)) {
        excess--;
        return false;
      }
      return true;
    });
  };

  return {
    list: (first?: NotificationAccount | number, second: number = 0) => serialized(() => {
      const account = typeof first === "number" || first === undefined ? LEGACY_TEST_ACCOUNT : first;
      const after = typeof first === "number" ? first : second;
      if (!authorized(account)) return { items: [], unread: 0 };
      return {
        items: items.filter((entry) => sameAccount(entry.recipient, account) && entry.record.ts > after).map((entry) => entry.record),
        unread: unreadCount(account),
      };
    }),
    get: (account, id) => serialized(() => {
      if (!authorized(account)) return undefined;
      return items.find((entry) => entry.record.id === id && sameAccount(entry.recipient, account))?.record;
    }),
    add: (first: NotificationAccount | Omit<NotificationRecord, "id" | "ts" | "read">, second?: Omit<NotificationRecord, "id" | "ts" | "read">) => serialized(() => {
      const account = second === undefined ? LEGACY_TEST_ACCOUNT : first as NotificationAccount;
      const input = second === undefined ? first as Omit<NotificationRecord, "id" | "ts" | "read"> : second;
      if (!authorized(account)) return undefined;
      if (!isNonEmptyString(input.key) || !isNonEmptyString(input.sessionId) || !isNonEmptyString(input.projectId)) {
        throw Object.assign(new Error("notification needs key, sessionId, and projectId"), { code: "invalid-input" });
      }
      if (!KINDS.includes(input.kind)) throw Object.assign(new Error("unknown notification kind"), { code: "invalid-input" });
      const ts = Math.max(now(), lastTs + 1);
      const record: NotificationRecord = {
        id: randomUUID(), key: input.key, kind: input.kind, sessionId: input.sessionId, projectId: input.projectId,
        title: String(input.title ?? ""), body: String(input.body ?? ""), ts, read: false,
      };
      const nextItems = evictFor([...items, { record, recipient: { ...account } }], account);
      persist(nextItems);
      items = nextItems;
      lastTs = ts;
      return record;
    }),
    registerSessionRecipient: (sessionId, recipient) => serialized(() => {
      if (!isNonEmptyString(sessionId) || !authorized(recipient)) return false;
      const key = recipientKey(sessionId, recipient.spaceId);
      const existing = recipients.get(key);
      if (existing) return sameAccount(existing, recipient);
      recipients.set(key, { ...recipient });
      try { persist(items); } catch (error) { recipients.delete(key); throw error; }
      return true;
    }),
    inheritSessionRecipient: (parentSessionId, sessionId, account) => serialized(() => {
      const parent = recipients.get(recipientKey(parentSessionId, account.spaceId));
      if (!parent || !sameAccount(parent, account) || !authorized(parent) || !isNonEmptyString(sessionId)) return false;
      const key = recipientKey(sessionId, account.spaceId);
      const existing = recipients.get(key);
      if (existing) return sameAccount(existing, parent);
      recipients.set(key, { ...parent });
      try { persist(items); } catch (error) { recipients.delete(key); throw error; }
      return true;
    }),
    recipientForSession: (sessionId, account) => serialized(() => {
      const recipient = recipients.get(recipientKey(sessionId, account.spaceId));
      return recipient && authorized(recipient) ? { ...recipient } : undefined;
    }),
    read: (first: NotificationAccount | string[], second?: string[]) => serialized(() => {
      const account = second === undefined ? LEGACY_TEST_ACCOUNT : first as NotificationAccount;
      const ids = second === undefined ? first as string[] : second;
      if (!authorized(account)) return { updated: 0, unread: 0 };
      const wanted = new Set(ids);
      let updated = 0;
      const nextItems = items.map((entry) => {
        if (sameAccount(entry.recipient, account) && !entry.record.read && wanted.has(entry.record.id)) {
          updated++;
          return { ...entry, record: { ...entry.record, read: true } };
        }
        return entry;
      });
      if (updated) { persist(nextItems); items = nextItems; }
      return { updated, unread: unreadCount(account) };
    }),
    readAll: (account: NotificationAccount = LEGACY_TEST_ACCOUNT) => serialized(() => {
      if (!authorized(account)) return { updated: 0, unread: 0 };
      let updated = 0;
      const nextItems = items.map((entry) => {
        if (sameAccount(entry.recipient, account) && !entry.record.read) {
          updated++;
          return { ...entry, record: { ...entry.record, read: true } };
        }
        return entry;
      });
      if (updated) { persist(nextItems); items = nextItems; }
      return { updated, unread: unreadCount(account) };
    }),
    clear: (account: NotificationAccount = LEGACY_TEST_ACCOUNT) => serialized(() => {
      if (!authorized(account)) return { cleared: 0, unread: 0 };
      const nextItems = items.filter((entry) => !sameAccount(entry.recipient, account));
      const cleared = items.length - nextItems.length;
      if (cleared) { persist(nextItems); items = nextItems; }
      return { cleared, unread: 0 };
    }),
    removeAccount: (userId) => serialized(() => {
      if (!isNonEmptyString(userId)) return { cleared: 0, recipients: 0 };
      const nextItems = items.filter((entry) => entry.recipient.userId !== userId);
      const beforeRecipients = [...recipients.entries()];
      let recipientCount = 0;
      for (const [key, recipient] of beforeRecipients) {
        if (recipient.userId !== userId) continue;
        recipients.delete(key);
        recipientCount++;
      }
      const cleared = items.length - nextItems.length;
      if (!cleared && !recipientCount) return { cleared: 0, recipients: 0 };
      try { persist(nextItems); }
      catch (error) {
        recipients.clear();
        for (const [key, recipient] of beforeRecipients) recipients.set(key, recipient);
        throw error;
      }
      items = nextItems;
      return { cleared, recipients: recipientCount };
    }),
  } as NotificationStore;
}
