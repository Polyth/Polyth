// Live views built on long-poll reads: one session's event tail, and a
// cross-session feed of state changes for scripts (`events`, `on`, `wait`).
import type { Client } from "./client.ts";
import { replay, summaries, type SessionEvent, type SessionSummary } from "./api.ts";

const LONG_POLL_MS = 25_000;

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  if (signal?.aborted) return resolve();
  const timer = setTimeout(done, ms);
  function done() { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); }
  signal?.addEventListener("abort", done, { once: true });
});

/**
 * Yield every event of `sessionId` after `afterSeq`, in order, forever (until
 * aborted). Transient failures back off and resume from the last delivered
 * sequence, so nothing is skipped or repeated.
 */
export async function* followSession(
  client: Client,
  sessionId: string,
  afterSeq: number,
  signal?: AbortSignal,
): AsyncGenerator<SessionEvent> {
  let cursor = afterSeq;
  let failures = 0;
  while (!signal?.aborted) {
    try {
      const page = await replay(client, sessionId, cursor, LONG_POLL_MS, signal);
      failures = 0;
      for (const event of page.events) {
        if (event.seq <= cursor) continue;
        cursor = event.seq;
        yield event;
      }
    } catch (error) {
      if (signal?.aborted) return;
      const status = (error as { status?: number }).status ?? 0;
      if (status === 401 || status === 403 || status === 404) throw error;
      failures += 1;
      await sleep(Math.min(30_000, 500 * 2 ** Math.min(failures, 6)), signal);
    }
  }
}

export type FeedEventType =
  | "session.created"
  | "session.updated"
  | "turn.started"
  | "turn.finished"
  | "request.pending"
  | "session.archived";

export interface FeedEvent {
  type: FeedEventType;
  at: number;
  /** Resume point: pass to `--since` to continue after this event. */
  cursor: number;
  sessionId: string;
  projectId: string;
  title?: string;
  status: string;
  previousStatus?: string;
  attention?: SessionSummary["attention"];
}

/** A turn is in flight (`waiting` = blocked on a person mid-turn). */
const ACTIVE = new Set(["working", "reconciling", "waiting"]);
const pendingCount = (s: SessionSummary) => (s.attention?.permissions ?? 0) + (s.attention?.questions ?? 0);

/** Compare two snapshots of one session; emit what a script cares about. */
export function diffSession(prev: SessionSummary | undefined, next: SessionSummary): FeedEvent[] {
  const base = {
    at: next.updatedAt, cursor: next.updatedAt, sessionId: next.id, projectId: next.projectId,
    ...(next.title ? { title: next.title } : {}), status: next.status,
    ...(next.attention ? { attention: next.attention } : {}),
  };
  if (!prev) return [{ type: "session.created", ...base }];
  const out: FeedEvent[] = [];
  const statusChanged = prev.status !== next.status;
  if (statusChanged && ACTIVE.has(next.status) && !ACTIVE.has(prev.status)) {
    out.push({ type: "turn.started", ...base, previousStatus: prev.status });
  }
  if (statusChanged && ACTIVE.has(prev.status) && !ACTIVE.has(next.status) && next.status !== "archived") {
    out.push({ type: "turn.finished", ...base, previousStatus: prev.status });
  }
  if (statusChanged && next.status === "archived") out.push({ type: "session.archived", ...base, previousStatus: prev.status });
  if (pendingCount(next) > pendingCount(prev)) out.push({ type: "request.pending", ...base });
  if (!out.length && next.updatedAt > prev.updatedAt) out.push({ type: "session.updated", ...base, ...(statusChanged ? { previousStatus: prev.status } : {}) });
  return out;
}

/**
 * Cross-session feed for one project (or every project). The first read is a
 * baseline (no events) unless `since` is given, in which case sessions updated
 * after it are reported as `session.updated`.
 */
export async function* sessionFeed(
  client: Client,
  opts: { projectId?: string; since?: number; signal?: AbortSignal },
): AsyncGenerator<FeedEvent> {
  const known = new Map<string, SessionSummary>();
  let highWater = 0;
  let first = true;
  let failures = 0;
  while (!opts.signal?.aborted) {
    try {
      const page = await summaries(client, {
        ...(opts.projectId ? { projectId: opts.projectId } : {}),
        limit: 100,
        ...(first ? {} : { waitMs: LONG_POLL_MS, updatedAfter: highWater }),
      }, opts.signal);
      failures = 0;
      const ordered = [...page.sessions].sort((a, b) => a.updatedAt - b.updatedAt);
      for (const next of ordered) {
        const prev = known.get(next.id);
        known.set(next.id, next);
        highWater = Math.max(highWater, next.updatedAt);
        if (first) {
          if (opts.since !== undefined && next.updatedAt > opts.since) {
            yield {
              type: "session.updated", at: next.updatedAt, cursor: next.updatedAt, sessionId: next.id, projectId: next.projectId,
              ...(next.title ? { title: next.title } : {}), status: next.status, ...(next.attention ? { attention: next.attention } : {}),
            };
          }
          continue;
        }
        if (prev && next.updatedAt <= prev.updatedAt && next.status === prev.status) continue;
        yield* diffSession(prev, next);
      }
      first = false;
    } catch (error) {
      if (opts.signal?.aborted) return;
      const status = (error as { status?: number }).status ?? 0;
      if (status === 401 || status === 403) throw error;
      failures += 1;
      await sleep(Math.min(30_000, 500 * 2 ** Math.min(failures, 6)), opts.signal);
    }
  }
}
