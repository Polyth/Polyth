// "Answer later": a pending agent question or approval may fold into one
// waiting line above the composer, so background work never moves what a
// person is typing. Pure client UI state for this tab, keyed by the session
// that holds the request and its request id; it never enters session history,
// and attention counts (session row, badges, phone) keep counting the item.
//
// Two ways in: by hand ("Later", Esc) — stays folded until the person opens
// it — or automatically, when an item first shows up while the composer of the
// chat on screen holds unsent text. Auto items open again once that draft is
// sent or cleared. docs/dev/ui.md "Answer later".
import { useSyncExternalStore } from "react";

export type AnswerLaterKind = "question" | "approval";
type Reason = "manual" | "auto";

interface Entry { reason: Reason; view: string | null }

const deferred = new Map<string, Entry>();
/** Items this tab has already shown or folded: only a first sight is an arrival. */
const seen = new Set<string>();
const drafts = new Map<string, boolean>();
let focusRequest: string | null = null;
let version = 0;
let notifyQueued = false;
const listeners = new Set<() => void>();

export function answerLaterKey(kind: AnswerLaterKind, sessionId: string, requestId: string): string {
  return `${kind}\u0000${sessionId}\u0000${requestId}`;
}

function emit(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/** Writes made while React renders notify after the render, never during it. */
function emitLater(): void {
  if (notifyQueued) return;
  notifyQueued = true;
  queueMicrotask(() => { notifyQueued = false; emit(); });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Re-render on any change; read the state through the functions below. */
export function useAnswerLaterVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => version);
}

export function isDeferred(key: string): boolean {
  return deferred.has(key);
}

/** The composer of the chat on screen reports whether it holds unsent text. */
export function reportComposerDraft(viewSessionId: string | null, hasDraft: boolean): void {
  const view = viewSessionId ?? "";
  const was = drafts.get(view) ?? false;
  if (was === hasDraft) return;
  if (hasDraft) drafts.set(view, true); else drafts.delete(view);
  if (hasDraft) return;
  // Sent or cleared: what folded itself while the person typed comes back.
  let changed = false;
  for (const [key, entry] of deferred) {
    if (entry.reason === "auto" && (entry.view ?? "") === view) { deferred.delete(key); changed = true; }
  }
  if (changed) emit();
}

export function composerHoldsDraft(viewSessionId: string | null): boolean {
  return drafts.get(viewSessionId ?? "") ?? false;
}

/** Called while rendering an item. The first sight of an item that arrives
 *  while the composer holds a draft folds it before it ever paints, so nothing
 *  moves under the caret. `keys` is one card's items (a grouped approval row
 *  holds several): a new item joining a card already on screen never folds. */
export function admitAnswerLater(keys: readonly string[], viewSessionId: string | null): void {
  const fresh = keys.filter((key) => !seen.has(key));
  if (fresh.length === 0) return;
  for (const key of fresh) seen.add(key);
  const rowVisible = keys.some((key) => !fresh.includes(key) && !deferred.has(key));
  if (rowVisible || !composerHoldsDraft(viewSessionId)) return;
  for (const key of fresh) deferred.set(key, { reason: "auto", view: viewSessionId });
  emitLater();
}

/** "Later" or Esc: fold by hand until the person opens it. */
export function deferAnswerLater(keys: readonly string[], viewSessionId: string | null = null): void {
  for (const key of keys) { seen.add(key); deferred.set(key, { reason: "manual", view: viewSessionId }); }
  emit();
}

/** "Answer": open the given items; the first one takes focus when it mounts. */
export function openAnswerLater(keys: readonly string[]): void {
  if (keys.length === 0) return;
  for (const key of keys) deferred.delete(key);
  focusRequest = keys[0]!;
  emit();
}

/** An item that just opened from the waiting line claims the focus once. */
export function takeAnswerLaterFocus(keys: readonly string[]): boolean {
  if (focusRequest === null || !keys.includes(focusRequest)) return false;
  focusRequest = null;
  return true;
}

/** Test seam: forget everything. */
export function resetAnswerLater(): void {
  deferred.clear(); seen.clear(); drafts.clear(); focusRequest = null;
  emit();
}
