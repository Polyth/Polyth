import type { QueueItemDto, SessionEvent } from "@polyth/contracts";

const eventQueueId = (event: SessionEvent): string | undefined => {
  const queueId = (event.data as { queueId?: unknown }).queueId;
  return typeof queueId === "string" ? queueId : undefined;
};

/**
 * A user Stop pauses only follow-ups that already existed at interruption time.
 * A later turn/started is the durable Resume boundary. The timestamp fallback
 * keeps this correct when the caller intentionally supplies only a recent event
 * window and an older queue/enqueued marker is outside that window.
 */
export function queuePausedAfterUserInterrupt(
  events: readonly SessionEvent[],
  queued: readonly QueueItemDto[],
): boolean {
  if (!queued.some((item) => !item.heldForReview)) return false;

  let abortIndex = -1;
  let abortTime = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === "turn/started") return false;
    if (
      event.type === "turn/abort-requested"
      && (event.data as { reason?: unknown }).reason === "user"
    ) {
      abortIndex = index;
      abortTime = event.time;
      break;
    }
  }
  if (abortIndex < 0) return false;

  const enqueuedAt = new Map<string, number>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (event.type !== "queue/enqueued") continue;
    const queueId = eventQueueId(event);
    if (queueId) enqueuedAt.set(queueId, index);
  }

  return queued.some((item) => {
    if (item.heldForReview) return false;
    const enqueueIndex = enqueuedAt.get(item.id);
    return enqueueIndex === undefined
      ? item.createdAt <= abortTime
      : enqueueIndex <= abortIndex;
  });
}
