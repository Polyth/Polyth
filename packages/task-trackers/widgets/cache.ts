/**
 * Per-document cache of tracker reads (projects, boards, tasks, columns, task
 * details). A window, widget or tab that shows something any view already
 * loaded paints it at once and refreshes behind it, so switching boards,
 * reopening the window or entering the Tasks tab never flashes a spinner.
 *
 * Memory only, never storage: tracker content is tenant data, and a Space
 * switch reloads the document (apps/web/src/spaces.ts), which empties it.
 */

interface Entry {
  value: unknown;
  at: number;
}

/** Reads younger than this skip the network for slow-changing lists. */
export const FRESH_MS = 60_000;
const LIMIT = 240;
const entries = new Map<string, Entry>();

export const cacheKey = (...parts: readonly string[]): string => parts.join("\u0000");

export function readCache<T>(key: string): { value: T; fresh: boolean } | undefined {
  const entry = entries.get(key);
  if (!entry) return undefined;
  // Least recently used goes first when the cache is full.
  entries.delete(key);
  entries.set(key, entry);
  return { value: entry.value as T, fresh: Date.now() - entry.at < FRESH_MS };
}

export function writeCache<T>(key: string, value: T): T {
  entries.delete(key);
  entries.set(key, { value, at: Date.now() });
  while (entries.size > LIMIT) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
  return value;
}

/** Keep a cached value in step with a local change without making it fresh. */
export function reviseCache<T>(key: string, revise: (value: T) => T): void {
  const entry = entries.get(key);
  if (entry) entries.set(key, { value: revise(entry.value as T), at: entry.at });
}

export function dropCache(prefix: string): void {
  for (const key of [...entries.keys()]) if (key.startsWith(prefix)) entries.delete(key);
}

/** Test seam: forget everything between isolated renders. */
export function clearTaskTrackerCache(): void {
  entries.clear();
}

export const projectsKey = (provider: string) => cacheKey("projects", provider);
export const boardsKey = (provider: string, projectId: string) => cacheKey("boards", provider, projectId);
export const tasksKey = (provider: string, boardId: string) => cacheKey("tasks", provider, boardId);
export const columnsKey = (provider: string, boardId: string) => cacheKey("columns", provider, boardId);
export const taskKey = (provider: string, taskId: string) => cacheKey("task", provider, taskId);
export const viewerKey = (provider: string) => cacheKey("viewer", provider);
