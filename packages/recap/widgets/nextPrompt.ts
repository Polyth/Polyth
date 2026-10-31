/** Suggested next prompts for the open chat's idle composer, kept per page load.
 *
 * An answer belongs to the conversation it was generated for
 * (`assistFreshnessSeq`): it is offered only while that conversation has not
 * moved, and each conversation state is asked about automatically at most once,
 * so a remount or a session switch never pays for a second model call. */

const ANSWERS_MAX = 100;

/** One answer: `explicit` when the person asked for it with the button, which
 * puts it over a harness hint whatever the priority setting says. */
export interface NextPromptAnswer {
  seq: number;
  text: string;
  explicit: boolean;
}

const answers = new Map<string, NextPromptAnswer>();
const asked = new Map<string, number>();
const pending = new Map<string, { seq: number; since: number; explicit: boolean }>();
const listeners = new Set<() => void>();
let version = 0;

function changed(): void {
  version += 1;
  for (const listener of [...listeners]) listener();
}

export function subscribeNextPrompts(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function nextPromptsVersion(): number {
  return version;
}

/** Record that `seq` of `sessionId` has been asked about (automatically or explicitly). */
export function markNextPromptAsked(sessionId: string, seq: number): void {
  asked.delete(sessionId);
  asked.set(sessionId, seq);
  while (asked.size > ANSWERS_MAX) asked.delete(asked.keys().next().value!);
}

/** Whether `seq` of `sessionId` (or a later state) has already been asked about. */
export function nextPromptAsked(sessionId: string, seq: number): boolean {
  const at = asked.get(sessionId);
  return at !== undefined && at >= seq;
}

export function rememberNextPrompt(sessionId: string, seq: number, text: string, options?: { explicit?: boolean }): void {
  markNextPromptAsked(sessionId, seq);
  // A late automatic answer never replaces the one the person just asked for.
  const current = answers.get(sessionId);
  if (current?.explicit && current.seq >= seq && options?.explicit !== true) return;
  answers.delete(sessionId);
  answers.set(sessionId, { seq, text: text.trim(), explicit: options?.explicit === true });
  while (answers.size > ANSWERS_MAX) answers.delete(answers.keys().next().value!);
  changed();
}

/** The answer for this conversation state, or null (none, stale or empty). The
 * server may answer for a state this client has not caught up to yet, so an
 * answer at or past `seq` counts; one the conversation moved past does not. */
export function nextPromptFor(sessionId: string, seq: number): NextPromptAnswer | null {
  const answer = answers.get(sessionId);
  return answer && answer.seq >= seq && answer.text ? answer : null;
}

/** A request for `sessionId` at `seq` is in flight from `now`. */
export function beginNextPrompt(sessionId: string, seq: number, explicit: boolean, now = Date.now()): void {
  pending.set(sessionId, { seq, since: now, explicit });
  changed();
}

export function endNextPrompt(sessionId: string, seq: number): void {
  if (pending.get(sessionId)?.seq !== seq) return;
  pending.delete(sessionId);
  changed();
}

/** The request in flight for this conversation state, if any. */
export function pendingNextPrompt(sessionId: string, seq: number): { since: number; explicit: boolean } | null {
  const flight = pending.get(sessionId);
  return flight && flight.seq >= seq ? { since: flight.since, explicit: flight.explicit } : null;
}

/** Whether to ask the small model for a suggestion on its own: the feature is
 * on, the chat is idle after a completed exchange, the composer is empty and
 * free, nothing that wins the chip (a harness hint ahead of Session Assist, or
 * the idle recap) already suggests a prompt, and this conversation state has
 * not been asked about yet. */
export function shouldSuggestNextPrompt(input: {
  enabled: boolean;
  sessionId: string | null;
  seq: number;
  status: string | undefined;
  busy: boolean;
  draft: string;
  offered: string | undefined;
  hasCompletedExchange(): boolean;
}): boolean {
  if (!input.enabled || !input.sessionId || input.seq <= 0) return false;
  if (input.status !== "idle" || input.busy || input.draft.trim() || input.offered?.trim()) return false;
  if (asked.get(input.sessionId) !== undefined && asked.get(input.sessionId)! >= input.seq) return false;
  return input.hasCompletedExchange();
}

/** Test seam: forget every answer. */
export function resetNextPrompts(): void {
  answers.clear();
  asked.clear();
  pending.clear();
  changed();
}
