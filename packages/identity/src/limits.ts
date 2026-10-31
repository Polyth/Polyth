import { controlError, type ControlPlane } from '@polyth/control-plane';
import type { SessionService } from './sessions.ts';

/** Account limits as stored. The shape is owned by `@polyth/contracts`
 *  (`AccountLimits`); identity persists it opaquely through the host's
 *  normalizer so this package stays contract-free. */
export interface StoredLimits {
  userId: string;
  limits: unknown | null;
  /** 0 before the first write. */
  revision: number;
}
export interface UsageToday { day: string; messages: number; chats: number }
export type UsageMetric = 'messages' | 'chats';
/** Validates untrusted input into canonical limits (throws `invalid-input`).
 *  Returns null when the input restricts nothing. */
export type LimitsNormalizer = (raw: unknown) => unknown | null;

/** What a corrupt stored row degrades to: everything closed, never open. */
const FAIL_CLOSED = Object.freeze({ projects: [], harnesses: [], messagesPerDay: 0, chatsPerDay: 0 });

/** Server-local calendar day; the household's "today", not UTC's. */
export const usageDay = (ms: number): string => {
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

export function createLimits(
  control: ControlPlane,
  sessions: SessionService,
  now: () => number,
  normalize: LimitsNormalizer,
) {
  const isInstanceOwner = (userId: string): boolean => !!control.get(
    "SELECT 1 FROM instance_roles WHERE user_id=? AND role='owner'",
    userId,
  );
  const requireUser = (userId: string): void => {
    if (!control.get("SELECT 1 FROM users u JOIN principals p ON p.id=u.id WHERE u.id=? AND p.kind='user'", userId)) {
      throw controlError('not-found', 'Account not found');
    }
  };
  // Every request (and every visible resource in a listing) asks; a write is
  // always this process's own `set`, so a per-user cache stays exact.
  const cache = new Map<string, StoredLimits>();
  const forUser = (userId: string): StoredLimits => {
    const cached = cache.get(userId);
    if (cached) return cached;
    const row = control.get<{ limits_json: string | null; revision: number }>(
      'SELECT limits_json,revision FROM account_limits WHERE user_id=?',
      userId,
    );
    let stored: StoredLimits;
    if (!row) stored = { userId, limits: null, revision: 0 };
    else if (row.limits_json === null) stored = { userId, limits: null, revision: row.revision };
    else {
      let limits: unknown;
      try { limits = normalize(JSON.parse(row.limits_json)) ?? null; }
      catch { limits = FAIL_CLOSED; }
      stored = { userId, limits, revision: row.revision };
    }
    cache.set(userId, stored);
    return stored;
  };
  const usage = (userId: string, day = usageDay(now())): UsageToday => {
    const row = control.get<{ messages: number; chats: number }>(
      'SELECT messages,chats FROM account_usage WHERE user_id=? AND day=?',
      userId, day,
    );
    return { day, messages: row?.messages ?? 0, chats: row?.chats ?? 0 };
  };
  return {
    /** Trusted host lookup for request enforcement. Never takes request input. */
    forUser,
    usage,
    /** The account itself or the instance owner. Anyone else: not-found. */
    get(token: string, userId: string): StoredLimits & { usage: UsageToday } {
      const actor = sessions.require(token);
      if (actor.userId !== userId && !isInstanceOwner(actor.userId)) throw controlError('not-found', 'Account not found');
      requireUser(userId);
      return { ...forUser(userId), usage: usage(userId) };
    },
    /** Instance owner only, elevated. `raw === null` (or limits that restrict
     *  nothing) removes the limits. */
    set(token: string, userId: string, raw: unknown, expectedRevision: number): StoredLimits & { usage: UsageToday } {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw controlError('invalid-input', 'Expected revision is required');
      }
      const limits = raw === null ? null : normalize(raw) ?? null;
      const stored = control.transaction(() => {
        const actor = sessions.require(token, true);
        if (!isInstanceOwner(actor.userId)) throw controlError('forbidden', 'Instance owner access required');
        requireUser(userId);
        // Limits answer to the instance owner; limiting one would let the
        // owner lock themselves out of administration.
        if (isInstanceOwner(userId)) throw controlError('invalid-input', 'Instance owners cannot be limited');
        cache.delete(userId);
        const current = forUser(userId);
        if (current.revision !== expectedRevision) throw controlError('conflict', 'Limits changed; refresh before saving');
        control.run(
          `INSERT INTO account_limits(user_id,limits_json,revision,updated_by,updated_at_ms) VALUES(?,?,1,?,?)
           ON CONFLICT(user_id) DO UPDATE SET limits_json=excluded.limits_json,
             revision=account_limits.revision+1,updated_by=excluded.updated_by,updated_at_ms=excluded.updated_at_ms`,
          userId, limits === null ? null : JSON.stringify(limits), actor.userId, now(),
        );
        cache.delete(userId);
        control.bumpEpoch();
        control.audit(actor.userId, limits === null ? 'identity.limits-removed' : 'identity.limits-updated', userId);
        return forUser(userId);
      });
      return { ...stored, usage: usage(userId) };
    },
    /**
     * Count one use against today's cap. Returns the day it was counted on
     * (for `refund`), or null when the cap is already reached. `cap === null`
     * still counts, so the owner sees usage before setting a limit.
     */
    consume(userId: string, metric: UsageMetric, cap: number | null): string | null {
      const day = usageDay(now());
      return control.transaction(() => {
        if (cap !== null && usage(userId, day)[metric] >= cap) return null;
        // System/debug principals have no users row and are never counted.
        control.run(
          `INSERT INTO account_usage(user_id,day,${metric}) SELECT ?,?,1 WHERE EXISTS(SELECT 1 FROM users WHERE id=?)
           ON CONFLICT(user_id,day) DO UPDATE SET ${metric}=${metric}+1`,
          userId, day, userId,
        );
        return day;
      });
    },
    /** Return a use whose operation failed before it took effect. */
    refund(userId: string, metric: UsageMetric, day: string): void {
      control.transaction(() => control.run(
        `UPDATE account_usage SET ${metric}=${metric}-1 WHERE user_id=? AND day=? AND ${metric}>0`,
        userId, day,
      ));
    },
  };
}
export type LimitsService = ReturnType<typeof createLimits>;
