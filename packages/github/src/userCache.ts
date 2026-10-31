// Who is signed in to GitHub is a property of the account Polyth acts as for a
// person, not of a project. This remembers it per key (Space + person +
// account, built by the caller) so the header avatar and the Git view's
// "GitHub · @login" do not depend on which surface happened to ask first.
//
//   - a fresh answer is served from memory; an older one is still served while
//     a single refresh runs behind it, so asking never waits on `gh` twice;
//   - a failed lookup never replaces a good answer, except when `gh` itself
//     says there is no account (`signedOut`), and a failure is not retried for
//     `retryMs` so an offline machine does not spawn `gh` per request;
//   - concurrent lookups for one key share one `gh` call;
//   - `clear()` (package disable) also discards lookups still in flight.
import type { GithubUser } from "./index.ts";

export type UserLoad = { ok: true; user: GithubUser } | { ok: false; signedOut: boolean };

export interface UserCacheOptions {
  now?: () => number;
  /** Age after which a remembered user is refreshed behind the answer. */
  freshMs?: number;
  /** Age after which a remembered user is no longer served. */
  maxStaleMs?: number;
  /** Quiet period after a failed lookup. */
  retryMs?: number;
  /** How long a lookup with nothing to show waits for `gh` before answering "unknown". */
  coldWaitMs?: number;
}

export interface UserCache {
  /** The user for `key`, or null when none is known (yet). */
  lookup(key: string, load: () => Promise<UserLoad>): Promise<GithubUser | null>;
  /** Remember a user a live status call has just seen. */
  remember(key: string, user: GithubUser): void;
  clear(): void;
}

export const USER_FRESH_MS = 10 * 60_000;
export const USER_MAX_STALE_MS = 24 * 60 * 60_000;
export const USER_RETRY_MS = 30_000;
export const USER_COLD_WAIT_MS = 5_000;

export function createUserCache(options: UserCacheOptions = {}): UserCache {
  const now = options.now ?? Date.now;
  const freshMs = options.freshMs ?? USER_FRESH_MS;
  const maxStaleMs = options.maxStaleMs ?? USER_MAX_STALE_MS;
  const retryMs = options.retryMs ?? USER_RETRY_MS;
  const coldWaitMs = options.coldWaitMs ?? USER_COLD_WAIT_MS;

  const known = new Map<string, { user: GithubUser; at: number }>();
  const failedAt = new Map<string, number>();
  const inflight = new Map<string, Promise<void>>();
  let epoch = 0;

  const refresh = (key: string, load: () => Promise<UserLoad>): Promise<void> => {
    const running = inflight.get(key);
    if (running) return running;
    const started = epoch;
    const run = (async () => {
      let result: UserLoad;
      try {
        result = await load();
      } catch {
        result = { ok: false, signedOut: false };
      }
      if (started !== epoch) return;
      if (result.ok) {
        known.set(key, { user: result.user, at: now() });
        failedAt.delete(key);
        return;
      }
      failedAt.set(key, now());
      if (result.signedOut) known.delete(key);
    })();
    const shared: Promise<void> = run.finally(() => {
      if (inflight.get(key) === shared) inflight.delete(key);
    });
    inflight.set(key, shared);
    return shared;
  };

  return {
    async lookup(key, load) {
      const entry = known.get(key);
      if (entry && now() - entry.at <= maxStaleMs) {
        const failed = failedAt.get(key);
        if (now() - entry.at >= freshMs && (failed === undefined || now() - failed >= retryMs)) void refresh(key, load);
        return entry.user;
      }
      known.delete(key);
      const failed = failedAt.get(key);
      if (failed !== undefined && now() - failed < retryMs) return null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const patience = new Promise<void>((resolve) => { timer = setTimeout(resolve, coldWaitMs); });
      try {
        await Promise.race([refresh(key, load), patience]);
      } finally {
        clearTimeout(timer);
      }
      return known.get(key)?.user ?? null;
    },
    remember(key, user) {
      known.set(key, { user, at: now() });
      failedAt.delete(key);
    },
    clear() {
      epoch += 1;
      known.clear();
      failedAt.clear();
      inflight.clear();
    },
  };
}
