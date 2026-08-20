// Composer insert bus: file-tree @ buttons, drag-drop, and starter chips all
// go through here. If no Composer is mounted (no open session), inserts queue
// and drain when one mounts — the @ click never gets lost.
export const COMPOSER_INSERT = "polyth:composer-insert";
export const COMPOSER_REPLACE = "polyth:composer-replace";

const queue: string[] = [];

/** Queue an insert for the next Composer mount. Exported for tests. */
export function queueInsert(text: string): void {
  queue.push(text);
}

/** Remove and return all queued inserts. */
export function drainInserts(): string[] {
  return queue.splice(0, queue.length);
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

/** Replace the mounted composer's draft, used by session rewind. */
export function requestComposerReplace(text: string): boolean {
  if (typeof window === "undefined") return false;
  return !window.dispatchEvent(
    new CustomEvent(COMPOSER_REPLACE, { detail: text, cancelable: true }),
  );
}
