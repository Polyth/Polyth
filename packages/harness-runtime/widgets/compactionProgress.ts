// Where a requested compaction stands, read from the canonical log. A
// Polyth-owned compaction answers its request before the summary is written,
// so the timeline, not a toast, carries its progress and its failure.
import type { SessionEvent } from "@polyth/contracts";

export type CompactionRequestState =
  | { kind: "pending" }
  | { kind: "failed"; error: string }
  | { kind: "settled" };

/** A request with no outcome this old was lost with its process. */
export const COMPACTION_PENDING_MAX_MS = 10 * 60_000;

export function compactionRequestState(
  events: readonly SessionEvent[],
  request: SessionEvent,
  now: number,
): CompactionRequestState {
  let failed: CompactionRequestState | undefined;
  for (const event of events) {
    if (event.seq <= request.seq) continue;
    // The conversation moved on: a failure stays visible only until then.
    if (
      event.type === "session/compacted"
      || event.type === "session/compaction-requested"
      || event.type === "turn/started"
      || event.type === "user/message"
    ) return { kind: "settled" };
    if (event.type === "session/compaction-failed" && !failed) {
      const data = event.data as { strategy?: unknown; error?: unknown };
      // A native refusal answers the request itself and is shown there.
      failed = data.strategy === "native"
        ? { kind: "settled" }
        : { kind: "failed", error: typeof data.error === "string" ? data.error : "" };
    }
  }
  if (failed) return failed;
  return now - request.time < COMPACTION_PENDING_MAX_MS ? { kind: "pending" } : { kind: "settled" };
}
