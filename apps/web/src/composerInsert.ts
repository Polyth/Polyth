// Composer insert bus: file-tree @ buttons, drag-drop, and starter chips all
// go through here. If no Composer is mounted (no open session), inserts queue
// and drain when one mounts — the @ click never gets lost.
export const COMPOSER_INSERT = "polyth:composer-insert";
export const COMPOSER_REPLACE = "polyth:composer-replace";
export const COMPOSER_COMPARE_REPLACE = "polyth:composer-compare-replace";
export const COMPOSER_DICTATION = "polyth:composer-dictation";
export const COMPOSER_SUBMIT = "polyth:composer-submit";

const queue: string[] = [];
const replacementQueue: string[] = [];

/** One dictation run streaming into the draft. `runId` scopes the span so a
 *  late update from an abandoned run can never edit a newer one, and `text` is
 *  always the run's cumulative transcript — never a delta. */
export interface ComposerDictationUpdate {
  runId: string;
  text: string;
  /** The last update of the run; the span stops being dictation-owned. */
  final: boolean;
  /** Remove the run's words from the draft (a spoken command, not a message). */
  discard?: boolean;
}

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

/**
 * Stream a dictation transcript into the mounted composer so the words appear
 * as they are recognized. Interim updates are dropped when no Composer is
 * mounted — a transcript that nothing can show is not worth replaying — but an
 * unconsumed final still queues, so the mic keeps working from a header slot
 * with no open session.
 * Returns true when a mounted Composer consumed the update.
 */
export function requestComposerDictation(update: ComposerDictationUpdate): boolean {
  if (typeof window !== "undefined") {
    const consumed = !window.dispatchEvent(
      new CustomEvent(COMPOSER_DICTATION, { detail: update, cancelable: true }),
    );
    if (consumed) return true;
  }
  if (update.final && !update.discard && update.text.trim()) queueInsert(update.text.trim());
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

/** An asynchronous admission may finish after navigation or a composer remount.
 * Conditional replacements apply only to the exact visible draft and never queue
 * into an unrelated future composer. The caller retains its draft if rejected. */
export interface ComposerCompareReplace {
  scopeKey: string;
  expectedText: string;
  text: string;
}

export function requestComposerCompareReplace(update: ComposerCompareReplace): boolean {
  return typeof window !== "undefined" && !window.dispatchEvent(
    new CustomEvent(COMPOSER_COMPARE_REPLACE, { detail: update, cancelable: true }),
  );
}

export interface ComposerSubmitRequest {
  /** Follow-up mode while a turn runs; the user's setting when omitted. */
  delivery?: "queue" | "steer" | "interrupt";
}

/** Send the mounted composer's draft as if its Send control were pressed
 * (hands-free voice turns). Only one composer acts on a request. Returns true
 * when a composer accepted it; nothing is queued for a later mount, because a
 * spoken turn that no visible composer can send must not fire on its own later. */
export function requestComposerSubmit(request: ComposerSubmitRequest = {}): boolean {
  return typeof window !== "undefined" && !window.dispatchEvent(
    new CustomEvent(COMPOSER_SUBMIT, { cancelable: true, detail: request }),
  );
}
