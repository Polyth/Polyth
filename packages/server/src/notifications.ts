// NTF-01 notification centre store: server-owned derived inbox persisted at
// ${dataDir}/notifications.json. Rows are DERIVED state — they never enter a
// session event log and are never model-visible. Same ownership pattern as
// the auto-accept store (load/validate into memory, expose DTOs, persist only
// normalized values), plus what an inbox needs: unique IDs, strictly
// increasing timestamps, read state, a 200-row FIFO cap, and atomic writes.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { atomicWriteSync } from "@polyth/plugins";
import { dirname } from "node:path";
import type { NotificationKind, NotificationRecord } from "@polyth/contracts";

/** Retention cap: after every append only the newest rows survive, evicted
 *  FIFO regardless of read state. */
export const NOTIFICATION_CAP = 200;

const KINDS: readonly NotificationKind[] = ["completed", "failed", "question", "permission", "subagent"];

export interface NotificationStore {
  /** All retained rows oldest-first (only `ts > after` when given); `unread`
   *  always counts the FULL retained inbox, not the filtered slice. */
  list(after?: number): Promise<{ items: NotificationRecord[]; unread: number }>;
  add(input: Omit<NotificationRecord, "id" | "ts" | "read">): Promise<NotificationRecord>;
  /** Mark matching unread rows read. Duplicate/unknown/already-read IDs no-op. */
  read(ids: string[]): Promise<{ updated: number; unread: number }>;
  readAll(): Promise<{ updated: number; unread: number }>;
  clear(): Promise<{ cleared: number; unread: number }>;
}

interface NotificationFile {
  version: 1;
  items: NotificationRecord[];
}

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** Validate one raw row into an exact normalized record, or reject it. */
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

export function createNotificationStore(opts: {
  file: string;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}): NotificationStore {
  const now = opts.now ?? Date.now;

  // Startup load fails closed to an empty inbox: a missing, malformed, or
  // unsupported-version file logs ONE bounded warning without file content.
  let items: NotificationRecord[] = [];
  try {
    const raw = JSON.parse(readFileSync(opts.file, "utf8")) as Partial<NotificationFile>;
    if (raw && raw.version === 1 && Array.isArray(raw.items)) {
      const seen = new Set<string>();
      let previousTs = -1;
      for (const candidate of raw.items) {
        const rec = validateRecord(candidate);
        // The on-disk contract is oldest-first with strictly increasing
        // integer cursors. Drop rows that would make `after=<ts>` lossy.
        if (!rec || seen.has(rec.id) || rec.ts <= previousTs) continue;
        seen.add(rec.id);
        previousTs = rec.ts;
        items.push(rec);
      }
      if (items.length > NOTIFICATION_CAP) items = items.slice(-NOTIFICATION_CAP);
    } else {
      console.warn("[polyth] notifications.json has an unsupported shape; starting with an empty inbox");
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[polyth] notifications.json is unreadable; starting with an empty inbox");
    }
  }

  // Timestamps stay strictly increasing across restarts so an `after=<ts>`
  // cursor can never skip two records created in the same millisecond.
  let lastTs = items.reduce((max, r) => Math.max(max, r.ts), 0);

  const unreadCount = (): number => items.reduce((n, r) => n + (r.read ? 0 : 1), 0);

  // Atomic snapshot write: full pretty-printed file to a sibling temp path,
  // then rename over the target — a crash mid-write never truncates the inbox.
  const persist = (nextItems: NotificationRecord[]): void => {
    mkdirSync(dirname(opts.file), { recursive: true });
    const body: NotificationFile = { version: 1, items: nextItems };
    atomicWriteSync(opts.file, `${JSON.stringify(body, null, 2)}\n`);
  };

  // One in-process promise chain serializes every operation so concurrent
  // add/read/clear can never interleave and resurrect an older snapshot.
  let chain: Promise<unknown> = Promise.resolve();
  const serialized = <T>(fn: () => T): Promise<T> => {
    const next = chain.then(fn);
    chain = next.catch(() => undefined);
    return next;
  };

  return {
    list: (after) => serialized(() => {
      const floor = after ?? 0;
      return {
        items: floor > 0 ? items.filter((r) => r.ts > floor) : [...items],
        unread: unreadCount(),
      };
    }),

    add: (input) => serialized(() => {
      if (!isNonEmptyString(input.key) || !isNonEmptyString(input.sessionId) || !isNonEmptyString(input.projectId)) {
        throw Object.assign(new Error("notification needs key, sessionId, and projectId"), { code: "invalid-input" });
      }
      if (!KINDS.includes(input.kind)) {
        throw Object.assign(new Error("unknown notification kind"), { code: "invalid-input" });
      }
      const ts = Math.max(now(), lastTs + 1);
      const record: NotificationRecord = {
        id: randomUUID(),
        key: input.key, kind: input.kind,
        sessionId: input.sessionId, projectId: input.projectId,
        title: String(input.title ?? ""), body: String(input.body ?? ""),
        ts, read: false,
      };
      const nextItems = [...items, record].slice(-NOTIFICATION_CAP);
      // Publish new in-memory truth only after the atomic snapshot commits.
      // A failed write must not expose a non-durable row through REST.
      persist(nextItems);
      items = nextItems;
      lastTs = ts;
      return record;
    }),

    read: (ids) => serialized(() => {
      const wanted = new Set(ids);
      let updated = 0;
      const nextItems = items.map((record) => {
        if (!record.read && wanted.has(record.id)) {
          updated++;
          return { ...record, read: true };
        }
        return record;
      });
      if (updated > 0) {
        persist(nextItems);
        items = nextItems;
      }
      return { updated, unread: unreadCount() };
    }),

    readAll: () => serialized(() => {
      let updated = 0;
      const nextItems = items.map((record) => {
        if (!record.read) {
          updated++;
          return { ...record, read: true };
        }
        return record;
      });
      if (updated > 0) {
        persist(nextItems);
        items = nextItems;
      }
      return { updated, unread: 0 };
    }),

    clear: () => serialized(() => {
      const cleared = items.length;
      if (cleared > 0) {
        persist([]);
        items = [];
      }
      return { cleared, unread: 0 };
    }),
  };
}
