/** Bounded, memory-only metadata reuse. Identity must include the route's
 * account/Space/project/runtime scope; entries never survive a page reload. */
export function createCatalogCache<T>(ttlMs = 30_000, limit = 64, now = Date.now) {
  type Entry = { value?: T; expiresAt: number; pending?: Promise<T> };
  const entries = new Map<string, Entry>();
  return {
    peek(key: string): T | undefined {
      const entry = entries.get(key);
      return entry && entry.expiresAt > now() ? entry.value : undefined;
    },
    read(key: string, fetchValue: () => Promise<T>): Promise<T> {
      const existing = entries.get(key);
      if (existing?.value !== undefined && existing.expiresAt > now()) return Promise.resolve(existing.value);
      if (existing?.pending) return existing.pending;
      const entry: Entry = { expiresAt: 0 };
      entries.delete(key);
      entries.set(key, entry);
      while (entries.size > limit) entries.delete(entries.keys().next().value!);
      const pending = fetchValue().then((value) => {
        if (entries.get(key) === entry) {
          entry.value = value;
          entry.expiresAt = now() + ttlMs;
          entry.pending = undefined;
        }
        return value;
      }, (error: unknown) => {
        if (entries.get(key) === entry) entries.delete(key);
        throw error;
      });
      entry.pending = pending;
      return pending;
    },
    clear() { entries.clear(); },
  };
}
