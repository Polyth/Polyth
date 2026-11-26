// Server-owned, account-scoped notification inbox. NotificationRecord remains
// the public/model-safe DTO; ownership is private durable routing metadata.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { atomicWriteSync } from "@polyth/plugins";
import { dirname } from "node:path";
import type { NotificationKind, NotificationRecord } from "@polyth/contracts";

/** Retain the newest 200 rows independently for each account in each Space. */
export const NOTIFICATION_CAP = 200;

const KINDS: readonly NotificationKind[] = ["completed", "failed", "question", "permission", "subagent", "mention", "message"];

/** Private routing identity. Never serialize this in NotificationRecord/WS DTOs. */
export interface NotificationAccount {
  userId: string;
  spaceId: string;
}

export interface NotificationDelivery {
  record: NotificationRecord;
  recipient: NotificationAccount;
}

/** A notice relayed from a Space the person joined on another server. It
 *  belongs to the person, not to one of their Spaces here. */
export type JoinedNotice = NotificationRecord & { joinedSpace: NonNullable<NotificationRecord["joinedSpace"]> };

/** Storage scope of a person's joined notices; no real Space has this id. Each
 *  is one row, listed, read and cleared from any Space the person is in. */
const PERSON_SCOPE = "@person";
/** Cleared or evicted joined notices remembered per person, so the other
 *  server still listing one does not bring it back. */
const DISMISSED_CAP = 500;

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
  /** Drop a permanently deleted session's creator bindings in every Space.
   * Inbox items stay; nothing is written when the session had none. */
  forgetSession(sessionId: string): Promise<number>;
  /** File a joined notice for one person; `record.ts` is the other server's.
   *  A later notice with the same key replaces the row. Returns the row only
   *  when there is something new to announce: a read or malformed record, and
   *  one no newer than what was filed or cleared under its key, return nothing. */
  deliverPerson(userId: string, record: JoinedNotice): Promise<NotificationRecord | undefined>;
  /** Remove that person's joined notice; returns how many rows went. */
  withdrawPerson(userId: string, key: string): Promise<number>;
}

interface StoredNotification {
  record: NotificationRecord;
  recipient: NotificationAccount;
  /** Joined notices only: the other server's own timestamp. */
  sourceTs?: number;
}

interface NotificationFile {
  version: 2;
  items: StoredNotification[];
  recipients: Array<{ sessionId: string; recipient: NotificationAccount }>;
  dismissed?: Array<{ userId: string; key: string; sourceTs: number }>;
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
const isPersonEntry = (entry: StoredNotification): boolean => entry.recipient.spaceId === PERSON_SCOPE;
/** An account sees its own Space's rows and its person's joined notices. */
const visibleTo = (entry: StoredNotification, account: NotificationAccount): boolean =>
  sameAccount(entry.recipient, account) || (isPersonEntry(entry) && entry.recipient.userId === account.userId);
const LEGACY_TEST_ACCOUNT: NotificationAccount = { userId: "__isolated_test__", spaceId: "__isolated_test__" };

function validateRecord(raw: unknown): NotificationRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!isNonEmptyString(r.id) || !isNonEmptyString(r.key)) return null;
  if (!KINDS.includes(r.kind as NotificationKind)) return null;
  const settings = settingsOf(r.settings);
  if (typeof r.sessionId !== "string" || typeof r.projectId !== "string") return null;
  if (!settings && (!isNonEmptyString(r.sessionId) || !isNonEmptyString(r.projectId))) return null;
  if (typeof r.title !== "string" || typeof r.body !== "string") return null;
  if (typeof r.ts !== "number" || !Number.isSafeInteger(r.ts) || r.ts < 0) return null;
  if (typeof r.read !== "boolean") return null;
  return {
    id: r.id, key: r.key, kind: r.kind as NotificationKind,
    sessionId: r.sessionId, projectId: r.projectId,
    title: r.title, body: r.body, ts: r.ts, read: r.read,
    ...peopleFields(r),
    ...(settings ? { settings } : {}),
  };
}

/** Where a notice about this server leads, when well formed. */
function settingsOf(raw: unknown): NotificationRecord["settings"] {
  const value = raw as { pageId?: unknown; itemId?: unknown } | null | undefined;
  if (!value || typeof value !== "object" || !isNonEmptyString(value.pageId) || value.pageId.length > 64) return undefined;
  return { pageId: value.pageId, ...(isNonEmptyString(value.itemId) ? { itemId: value.itemId.slice(0, 128) } : {}) };
}

/** The optional people fields, kept only when well formed. */
function peopleFields(r: Record<string, unknown>): Pick<NotificationRecord, "author" | "chat" | "accessRequest"> {
  const author = r.author as Record<string, unknown> | undefined;
  const asked = r.accessRequest as { messageSeq?: unknown; people?: unknown } | undefined;
  const askedPeople = asked && typeof asked === "object" && Array.isArray(asked.people)
    ? asked.people.flatMap((raw) => {
        const person = raw as { userId?: unknown; name?: unknown } | null;
        return person && isNonEmptyString(person.userId) && typeof person.name === "string"
          ? [{ userId: person.userId, name: person.name }]
          : [];
      })
    : [];
  return {
    ...(author && typeof author === "object" && isNonEmptyString(author.userId) && typeof author.name === "string"
      ? { author: { userId: author.userId, name: author.name } }
      : {}),
    ...(typeof r.chat === "string" ? { chat: r.chat } : {}),
    ...(asked && Number.isSafeInteger(asked.messageSeq) && askedPeople.length > 0
      ? { accessRequest: { messageSeq: asked.messageSeq as number, people: askedPeople } }
      : {}),
  };
}

const bounded = (value: unknown, max: number): string => typeof value === "string" ? value.slice(0, max) : "";

function joinedSpaceOf(raw: unknown): JoinedNotice["joinedSpace"] | null {
  const value = raw as { id?: unknown; name?: unknown; serverLabel?: unknown } | null | undefined;
  if (!value || typeof value !== "object" || !isNonEmptyString(value.id)) return null;
  return { id: bounded(value.id, 128), name: bounded(value.name, 200), serverLabel: bounded(value.serverLabel, 200) };
}

function validateStored(raw: unknown): StoredNotification | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const record = validateRecord(value.record);
  if (!record || !validAccount(value.recipient)) return null;
  const entry = { record, recipient: value.recipient };
  if (!isPersonEntry(entry)) return entry;
  const joinedSpace = joinedSpaceOf((value.record as { joinedSpace?: unknown }).joinedSpace);
  const sourceTs = Number.isSafeInteger(value.sourceTs) ? value.sourceTs as number : 0;
  return joinedSpace ? { ...entry, record: { ...record, joinedSpace }, sourceTs } : null;
}

/** Another server's data, rebuilt field by field with bounded text. An access
 *  request is dropped: it can only be answered on the server that asked. */
function joinedInput(raw: JoinedNotice): Omit<JoinedNotice, "id" | "ts" | "read"> | null {
  const joinedSpace = joinedSpaceOf(raw?.joinedSpace);
  if (!joinedSpace || !KINDS.includes(raw.kind)) return null;
  const { key, sessionId, projectId } = raw;
  if (![key, sessionId, projectId].every((id) => isNonEmptyString(id) && id.length <= 512)) return null;
  const { author, chat } = peopleFields(raw as unknown as Record<string, unknown>);
  return {
    key, kind: raw.kind, sessionId, projectId,
    title: bounded(raw.title, 200), body: bounded(raw.body, 1000),
    ...(author ? { author: { userId: bounded(author.userId, 128), name: bounded(author.name, 200) } } : {}),
    ...(chat !== undefined ? { chat: bounded(chat, 200) } : {}),
    joinedSpace,
  };
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
  /** userId → joined key → the newest source time that must not come back,
   *  oldest first. */
  const dismissed = new Map<string, Map<string, number>>();
  const dismiss = (userId: string, key: string, sourceTs: number): void => {
    const keys = dismissed.get(userId) ?? new Map<string, number>();
    dismissed.set(userId, keys);
    keys.delete(key);
    keys.set(key, sourceTs);
    if (keys.size > DISMISSED_CAP) keys.delete(keys.keys().next().value!);
  };
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
      for (const candidate of Array.isArray(raw.dismissed) ? raw.dismissed : []) {
        if (isNonEmptyString(candidate?.userId) && isNonEmptyString(candidate.key) && Number.isSafeInteger(candidate.sourceTs)) {
          dismiss(candidate.userId, candidate.key, candidate.sourceTs);
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
    items.reduce((count, entry) => count + (!entry.record.read && visibleTo(entry, account) ? 1 : 0), 0);
  const authorized = (account: NotificationAccount): boolean => validAccount(account) && hasAccess(account);
  const snapshotRecipients = () => [...recipients.entries()].map(([key, recipient]) => ({
    sessionId: key.slice(recipient.spaceId.length + 1), recipient,
  }));
  const persist = (nextItems: StoredNotification[]): void => {
    mkdirSync(dirname(opts.file), { recursive: true });
    const gone = [...dismissed].flatMap(([userId, keys]) => [...keys].map(([key, sourceTs]) => ({ userId, key, sourceTs })));
    const body: NotificationFile = {
      version: 2, items: nextItems, recipients: snapshotRecipients(),
      ...(gone.length ? { dismissed: gone } : {}),
    };
    atomicWriteSync(opts.file, `${JSON.stringify(body)}\n`, 0o600);
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
      const after: number = typeof first === "number" ? first : second;
      if (!authorized(account)) return { items: [], unread: 0 };
      return {
        items: items.filter((entry) => visibleTo(entry, account) && entry.record.ts > after).map((entry) => entry.record),
        unread: unreadCount(account),
      };
    }),
    get: (account, id) => serialized(() => {
      if (!authorized(account)) return undefined;
      return items.find((entry) => entry.record.id === id && visibleTo(entry, account))?.record;
    }),
    add: (first: NotificationAccount | Omit<NotificationRecord, "id" | "ts" | "read">, second?: Omit<NotificationRecord, "id" | "ts" | "read">) => serialized(() => {
      const account = second === undefined ? LEGACY_TEST_ACCOUNT : first as NotificationAccount;
      const input = second === undefined ? first as Omit<NotificationRecord, "id" | "ts" | "read"> : second;
      if (!authorized(account)) return undefined;
      const settings = settingsOf(input.settings);
      if (!isNonEmptyString(input.key) || (!settings && (!isNonEmptyString(input.sessionId) || !isNonEmptyString(input.projectId)))) {
        throw Object.assign(new Error("notification needs key, sessionId, and projectId"), { code: "invalid-input" });
      }
      if (!KINDS.includes(input.kind)) throw Object.assign(new Error("unknown notification kind"), { code: "invalid-input" });
      const ts = Math.max(now(), lastTs + 1);
      const record: NotificationRecord = {
        id: randomUUID(), key: input.key, kind: input.kind,
        sessionId: settings ? "" : input.sessionId, projectId: settings ? "" : input.projectId,
        title: String(input.title ?? ""), body: String(input.body ?? ""), ts, read: false,
        ...peopleFields(input as unknown as Record<string, unknown>),
        ...(settings ? { settings } : {}),
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
        if (visibleTo(entry, account) && !entry.record.read && wanted.has(entry.record.id)) {
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
        if (visibleTo(entry, account) && !entry.record.read) {
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
      const nextItems = items.filter((entry) => !visibleTo(entry, account));
      const cleared = items.length - nextItems.length;
      if (cleared) {
        for (const entry of items) {
          if (isPersonEntry(entry) && visibleTo(entry, account)) dismiss(account.userId, entry.record.key, entry.sourceTs ?? 0);
        }
        persist(nextItems);
        items = nextItems;
      }
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
      const gone = dismissed.get(userId);
      if (!cleared && !recipientCount && !gone) return { cleared: 0, recipients: 0 };
      dismissed.delete(userId);
      try { persist(nextItems); }
      catch (error) {
        if (gone) dismissed.set(userId, gone);
        recipients.clear();
        for (const [key, recipient] of beforeRecipients) recipients.set(key, recipient);
        throw error;
      }
      items = nextItems;
      return { cleared, recipients: recipientCount };
    }),
    forgetSession: (sessionId) => serialized(() => {
      if (!isNonEmptyString(sessionId)) return 0;
      const before = [...recipients.entries()];
      const doomed = before.filter(([key]) => key.slice(key.indexOf("\0") + 1) === sessionId);
      if (!doomed.length) return 0;
      for (const [key] of doomed) recipients.delete(key);
      try { persist(items); }
      catch (error) {
        recipients.clear();
        for (const [key, recipient] of before) recipients.set(key, recipient);
        throw error;
      }
      return doomed.length;
    }),
    deliverPerson: (userId, raw) => serialized(() => {
      const input = isNonEmptyString(userId) ? joinedInput(raw) : null;
      if (!input || raw.read === true) return undefined;
      const sourceTs = Number.isSafeInteger(raw.ts) ? raw.ts : 0;
      if (sourceTs <= (dismissed.get(userId)?.get(input.key) ?? -1)) return undefined;
      const account = { userId, spaceId: PERSON_SCOPE };
      const mine = (entry: StoredNotification): boolean => sameAccount(entry.recipient, account) && entry.record.key === input.key;
      const previous = items.find(mine);
      if (previous && sourceTs <= (previous.sourceTs ?? 0)) return undefined;
      const ts = Math.max(now(), lastTs + 1);
      const record: NotificationRecord = { id: randomUUID(), ...input, ts, read: false };
      const added = [...items.filter((entry) => !mine(entry)), { record, recipient: account, sourceTs }];
      const nextItems = evictFor(added, account);
      if (nextItems !== added) {
        const kept = new Set(nextItems);
        for (const entry of added) if (!kept.has(entry)) dismiss(userId, entry.record.key, entry.sourceTs ?? 0);
      }
      persist(nextItems);
      items = nextItems;
      lastTs = ts;
      return record;
    }),
    withdrawPerson: (userId, key) => serialized(() => {
      const nextItems = items.filter((entry) =>
        !(isPersonEntry(entry) && entry.recipient.userId === userId && entry.record.key === key));
      const removed = items.length - nextItems.length;
      if (removed) { persist(nextItems); items = nextItems; }
      return removed;
    }),
  } as NotificationStore;
}
