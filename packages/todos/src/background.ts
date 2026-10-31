// Messages waiting in a session's queue, read from canonical events so the
// status bar needs no request of its own. Mirrors the host composer's
// `departedQueueIds`: a row leaves the queue when it is dispatched or removed,
// and is already in the chat once its `user/message` (stamped with the
// `queueId`) is admitted; a turn that ends without dispatch puts it back.
import type { SessionEvent } from "@polyth/contracts";

const LEFT = new Set(["queue/dispatched", "queue/removed"]);
const TURN_END = new Set(["turn/stopped", "turn/failed"]);

const queueIdOf = (event: Pick<SessionEvent, "data">): string | undefined => {
  const value = (event.data as { queueId?: unknown } | undefined)?.queueId;
  return typeof value === "string" && value ? value : undefined;
};

export function queuedMessageIds(events: readonly Pick<SessionEvent, "type" | "data">[]): string[] {
  const queued = new Set<string>();
  let admitted: string | null = null;
  for (const event of events) {
    const queueId = queueIdOf(event);
    if (event.type === "queue/enqueued") {
      if (queueId) queued.add(queueId);
    } else if (LEFT.has(event.type)) {
      if (queueId) queued.delete(queueId);
    } else if (event.type === "user/message") {
      admitted = queueId ?? null;
    } else if (TURN_END.has(event.type)) {
      admitted = null;
    }
  }
  if (admitted) queued.delete(admitted);
  return [...queued];
}
