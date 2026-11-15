// A chat started with its first prompt (`SessionStartRequest.firstTurn`) keeps
// that prompt on the server's queue until its runtime is ready. The queue row
// is marked `delivery/fallback-queued` with SESSION_STARTING_QUEUE_REASON; the
// timeline shows it as the prompt, never as a queue chip, until its canonical
// `user/message` (stamped with the same `queueId`) lands. Read from the event
// log, so a reload or another device sees the same thing.

import type { AttachmentRef, SessionEvent } from "@polyth/contracts";
import { startingQueueIds } from "./components/QueuedMessageList.tsx";
import type { PendingSend } from "./store.ts";

type EventLike = Pick<SessionEvent, "type" | "data" | "seq">;

const objectData = (event: EventLike): Record<string, unknown> =>
  event.data !== null && typeof event.data === "object" && !Array.isArray(event.data)
    ? event.data as Record<string, unknown>
    : {};

/** The waiting first prompts as timeline rows, oldest first. */
export function startingQueuePrompts(
  events: readonly EventLike[],
  sessionId: string | null,
): PendingSend[] {
  if (!sessionId || events.length === 0) return [];
  const waiting = startingQueueIds(events);
  if (waiting.size === 0) return [];
  const rows: PendingSend[] = [];
  for (const event of events) {
    if (event.type !== "queue/enqueued") continue;
    const data = objectData(event);
    const queueId = data.queueId;
    if (typeof queueId !== "string" || !waiting.has(queueId) || typeof data.text !== "string") continue;
    if (data.hiddenUserMessage === true) continue;
    const attachments = Array.isArray(data.attachments)
      ? (data.attachments as unknown[]).filter((item): item is AttachmentRef =>
        item !== null && typeof item === "object" && typeof (item as { id?: unknown }).id === "string")
      : [];
    rows.push({ id: `starting:${queueId}`, sessionId, text: data.text, attachments, afterSeq: event.seq });
  }
  return rows;
}

/** The server says this chat is starting: its first prompt still waits on
 *  the queue. The status is no guide while it does: a start passes through
 *  `reconciling`, a brief `unknown` and `idle` before the prompt is admitted,
 *  and a start that failed has already taken the prompt off the queue. */
export function sessionStartingFromServer(
  status: string | undefined,
  events: readonly EventLike[],
): boolean {
  return status !== "failed" && status !== "archived" && startingQueueIds(events).size > 0;
}
