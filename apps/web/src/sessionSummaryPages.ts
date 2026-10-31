import type { SessionProjection, SessionSummaryPage, SessionSummaryQuery } from "@polyth/contracts";

export interface SummaryPageState { busy: boolean; hasMore: boolean }

/** One bounded request per navigator. Replaced queries cannot publish; a
 * revision conflict restarts once at the newest page, never skips a moved row. */
export function createSummaryPager(
  read: (query: SessionSummaryQuery, signal?: AbortSignal) => Promise<SessionSummaryPage>,
  publish: (rows: SessionProjection[]) => void,
  changed: (state: SummaryPageState) => void,
) {
  let query: SessionSummaryQuery = {};
  let cursor: SessionSummaryQuery["cursor"];
  let revision: number | undefined;
  let request: AbortController | undefined;
  let generation = 0;
  let complete = false;
  return {
    reset(next: SessionSummaryQuery): void {
      request?.abort(); request = undefined; generation++;
      query = next; cursor = undefined; revision = undefined; complete = false;
      changed({ busy: false, hasMore: true });
    },
    cancel(): void { request?.abort(); request = undefined; generation++; },
    async more(): Promise<void> {
      if (request || complete) return;
      const controller = new AbortController();
      request = controller;
      const epoch = generation;
      changed({ busy: true, hasMore: true });
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const page = await read({ ...query, cursor, revision }, controller.signal);
            if (controller.signal.aborted || epoch !== generation) return;
            if (revision !== undefined && revision !== page.revision) throw Object.assign(new Error("session catalog changed"), { code: "catalog-changed" });
            if (!page.complete && (!page.next || (cursor && page.next.updatedAt === cursor.updatedAt && page.next.id === cursor.id))) throw new Error("session page did not advance");
            publish(page.sessions);
            revision = page.revision; cursor = page.next; complete = page.complete;
            return;
          } catch (error) {
            if (controller.signal.aborted || epoch !== generation) return;
            if ((error as { code?: string }).code !== "catalog-changed" || attempt > 0) throw error;
            cursor = undefined; revision = undefined;
          }
        }
      } finally {
        if (epoch === generation) { request = undefined; changed({ busy: false, hasMore: !complete }); }
      }
    },
  };
}

/** Complete an explicit bulk-action selection without trusting the navigator's
 * partial cache. Churn aborts the selection; it never authorizes a partial delete. */
export async function collectSessionSummaries(
  read: (query: SessionSummaryQuery, signal?: AbortSignal) => Promise<SessionSummaryPage>,
  query: SessionSummaryQuery,
  signal: AbortSignal,
): Promise<SessionProjection[]> {
  const sessions = new Map<string, SessionProjection>();
  let cursor: SessionSummaryQuery["cursor"];
  let revision: number | undefined;
  for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
    signal.throwIfAborted();
    const page = await read({ ...query, limit: 100, cursor, revision }, signal);
    signal.throwIfAborted();
    revision ??= page.revision;
    if (page.revision !== revision) throw Object.assign(new Error("session catalog changed; reopen the action"), { code: "catalog-changed" });
    for (const row of page.sessions) sessions.set(row.id, row);
    if (page.complete) return [...sessions.values()];
    if (!page.next || (cursor?.id === page.next.id && cursor.updatedAt === page.next.updatedAt)) throw new Error("session page did not advance");
    cursor = page.next;
  }
  throw new Error("session selection exceeds the bulk-action limit");
}
