// Composer insert bus: file-tree @ buttons, drag-drop, and starter chips all
// go through here. If no Composer is mounted (no open session), inserts queue
// and drain when one mounts — the @ click never gets lost.
export const COMPOSER_INSERT = "polyth:composer-insert";
export const COMPOSER_REPLACE = "polyth:composer-replace";

const queue: string[] = [];
const replacementQueue: string[] = [];

/** Queue an insert for the next Composer mount. Exported for tests. */
export function queueInsert(text: string): void {
  queue.push(text);
}

/** Remove and return all queued inserts. */
export function drainInserts(): string[] {
  return queue.splice(0, queue.length);
}

/** Return only the newest queued replacement; replacements supersede rather
 * than concatenate while no Composer is mounted. */
export function drainComposerReplacement(): string | undefined {
  const latest = replacementQueue.at(-1);
  replacementQueue.length = 0;
  return latest;
}

/**
 * Insert text into the composer. A mounted Composer consumes the event
 * (preventDefault); otherwise the text queues until one mounts.
 * Returns true when consumed immediately.
 */
export function requestComposerInsert(text: string): boolean {
  if (typeof window !== "undefined") {
    const consumed = !window.dispatchEvent(
      new CustomEvent(COMPOSER_INSERT, { detail: text, cancelable: true }),
    );
    if (consumed) return true;
  }
  queueInsert(text);
  return false;
}

/** Replace the mounted composer's draft, used by session rewind. If a timeline
 * transition is currently swapping Composer instances, preserve the newest
 * replacement for the next mount instead of dropping it in that gap. */
export function requestComposerReplace(text: string): boolean {
  if (typeof window !== "undefined") {
    const consumed = !window.dispatchEvent(
      new CustomEvent(COMPOSER_REPLACE, { detail: text, cancelable: true }),
    );
    if (consumed) return true;
  }
  replacementQueue.push(text);
  return false;
}
