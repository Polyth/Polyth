export interface CatalogCacheStorage {
  read(): string | null;
  write(value: string): void;
  clear(): void;
}

/** Bounded metadata reuse. Identity must include the route's
 * account/Space/project/runtime scope. Optional storage keeps metadata across
 * page restarts; callers still decide whether fresh or stale data is safe. */
export function createCatalogCache<T>(
  ttlMs = 30_000,
  limit = 64,
  now = Date.now,
  storage?: CatalogCacheStorage,
) {
  type Entry = { value?: T; expiresAt: number; pending?: Promise<T> };
  const entries = new Map<string, Entry>();
  try {
    const saved = JSON.parse(storage?.read() ?? "[]") as Array<[string, { value: T; expiresAt: number }]>;
    if (Array.isArray(saved)) {
      for (const item of saved.slice(-limit)) {
        if (Array.isArray(item) && typeof item[0] === "string" && typeof item[1]?.expiresAt === "number") {
          entries.set(item[0], item[1]);
        }
      }
    }
  } catch { /* corrupt/private storage is just a cold cache */ }
  const persist = () => {
    if (!storage) return;
    try {
      storage.write(JSON.stringify([...entries].flatMap(([key, entry]) => (
        entry.value === undefined ? [] : [[key, { value: entry.value, expiresAt: entry.expiresAt }]]
      ))));
    } catch { /* quota/private mode */ }
  };
  const trim = () => {
    while (entries.size > limit) entries.delete(entries.keys().next().value!);
  };
  return {
    peek(key: string): T | undefined {
      const entry = entries.get(key);
      return entry && entry.expiresAt > now() ? entry.value : undefined;
    },
    peekStale(key: string): T | undefined {
      return entries.get(key)?.value;
    },
    someFresh(predicate?: (key: string, value: T) => boolean): boolean {
      for (const [key, entry] of entries) {
        if (entry.value !== undefined && entry.expiresAt > now()
          && (!predicate || predicate(key, entry.value))) return true;
      }
      return false;
    },
    write(key: string, value: T): T {
      entries.delete(key);
      entries.set(key, { value, expiresAt: now() + ttlMs });
      trim();
      persist();
      return value;
    },
    read(key: string, fetchValue: () => Promise<T>): Promise<T> {
      const existing = entries.get(key);
      if (existing?.value !== undefined && existing.expiresAt > now()) return Promise.resolve(existing.value);
      if (existing?.pending) return existing.pending;
      const entry: Entry = existing ?? { expiresAt: 0 };
      entries.delete(key);
      entries.set(key, entry);
      trim();
      const pending = fetchValue().then((value) => {
        if (entries.get(key) === entry) {
          entry.value = value;
          entry.expiresAt = now() + ttlMs;
          entry.pending = undefined;
          persist();
        }
        return value;
      }, (error: unknown) => {
        if (entries.get(key) === entry) {
          entry.pending = undefined;
          if (entry.value === undefined) entries.delete(key);
        }
        throw error;
      });
      entry.pending = pending;
      return pending;
    },
    clear() { entries.clear(); storage?.clear(); },
  };
}
