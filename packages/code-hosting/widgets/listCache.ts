import type { ChangeRequest, HostingIssue, HostingStatus } from "@polyth/code-hosting";

/** What the list view last loaded for one provider, project and query. */
export interface HostingListSnapshot {
  status: HostingStatus;
  issues: HostingIssue[];
  changes: ChangeRequest[];
  reason: string;
}

/** A cached list younger than this is shown without asking the provider again;
 *  an older one is shown at once and refreshed in the background. */
export const HOSTING_LIST_FRESH_MS = 60_000;
const MAX_ENTRIES = 40;

// Module-level so the lists survive closing and reopening the panel. Keys carry
// the provider's API base and the project id; the browser tab is one person.
const entries = new Map<string, { at: number; apiBase: string; projectId: string; value: HostingListSnapshot }>();

export const hostingListKey = (apiBase: string, projectId: string, query: { tab: string; state: string; search: string }): string =>
  JSON.stringify([apiBase, projectId, query.tab, query.state, query.search]);

export function readHostingList(key: string, now = Date.now()): { value: HostingListSnapshot; fresh: boolean } | null {
  const entry = entries.get(key);
  if (!entry) return null;
  return { value: entry.value, fresh: now - entry.at < HOSTING_LIST_FRESH_MS };
}

export function writeHostingList(key: string, apiBase: string, projectId: string, value: HostingListSnapshot, now = Date.now()): void {
  entries.delete(key);
  entries.set(key, { at: now, apiBase, projectId, value });
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
}

/** A write through the provider can change any list of that project. */
export function invalidateHostingLists(apiBase: string, projectId?: string): void {
  for (const [key, entry] of entries) {
    if (entry.apiBase === apiBase && (projectId === undefined || entry.projectId === projectId)) entries.delete(key);
  }
}

export function clearHostingLists(): void {
  entries.clear();
}
