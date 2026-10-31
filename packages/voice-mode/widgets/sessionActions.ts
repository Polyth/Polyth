// The two spoken commands that act on the conversation rather than the draft:
// stop the running turn, and deliver the queued messages now. Both use the
// session API the composer and the queue list use; nothing new on the server.
import type { QueueItemDto } from "@polyth/contracts";

export interface QueueApi {
  abort(sessionId: string, source?: string): Promise<unknown>;
  queueList(sessionId: string): Promise<QueueItemDto[]>;
  queueSendNow(sessionId: string, queueId: string, text: string): Promise<unknown>;
  queueRemove(sessionId: string, queueId: string): Promise<unknown>;
}

export async function stopTurn(api: QueueApi, sessionId: string): Promise<void> {
  await api.abort(sessionId, "voice");
}

/** A plain message can be merged; attachments, native commands and hidden
 *  retries keep their own delivery. */
const plain = (item: QueueItemDto): boolean =>
  !item.heldForReview && !item.attachments?.length && !item.command && !item.hiddenUserMessage && !!item.text.trim();

/**
 * Deliver the queue now, interrupting the running turn. The plain messages at
 * the head of the queue are merged into one turn — "now" cannot be several
 * turns at once; anything else is promoted alone and the rest keep their
 * order behind it. Resolves how many messages went.
 * The merged message is sent before the others are removed, so a failure can
 * repeat words but never lose them.
 */
export async function sendQueuedNow(api: QueueApi, sessionId: string): Promise<number> {
  const items = (await api.queueList(sessionId))
    .filter((item) => !item.heldForReview)
    .sort((a, b) => a.position - b.position);
  const first = items[0];
  if (!first) return 0;
  if (!plain(first)) {
    await api.queueSendNow(sessionId, first.id, first.text);
    return 1;
  }
  const run = items.findIndex((item) => !plain(item));
  const merged = run === -1 ? items : items.slice(0, run);
  await api.queueSendNow(sessionId, first.id, merged.map((item) => item.text.trim()).join("\n\n"));
  for (const item of merged.slice(1)) {
    await api.queueRemove(sessionId, item.id).catch(() => {});
  }
  return merged.length;
}
