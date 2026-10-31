// Choosing conversation messages to start an agent session. The timeline owns
// the selectable rows and the start dialog; the composer dock owns the entry
// action and, while choosing, the "N selected" bar in its place. One small
// external store keeps both in step without threading state through the shell.
import { useSyncExternalStore } from "react";

export interface ConversationSelectionState {
  /** The conversation being chosen from; null when not choosing. */
  sessionId: string | null;
  /** Chosen `person/message` seqs in conversation order. */
  seqs: readonly number[];
  /** The start dialog is open over the current choice. */
  dialogOpen: boolean;
}

const IDLE: ConversationSelectionState = { sessionId: null, seqs: [], dialogOpen: false };
let state: ConversationSelectionState = IDLE;
const listeners = new Set<() => void>();

const set = (next: ConversationSelectionState): void => {
  state = next;
  for (const listener of listeners) listener();
};

/** Start choosing in `sessionId`, optionally with one message already chosen
 *  (a long press on a phone chooses the pressed message). */
export function beginConversationSelection(sessionId: string, seq?: number): void {
  set({ sessionId, seqs: seq === undefined ? [] : [seq], dialogOpen: false });
}

export function toggleConversationMessage(seq: number): void {
  if (state.sessionId === null) return;
  const seqs = state.seqs.includes(seq)
    ? state.seqs.filter((candidate) => candidate !== seq)
    : [...state.seqs, seq].sort((left, right) => left - right);
  set({ ...state, seqs });
}

export function openConversationStart(): void {
  if (state.sessionId === null || state.seqs.length === 0) return;
  set({ ...state, dialogOpen: true });
}

export function closeConversationStart(): void {
  if (!state.dialogOpen) return;
  set({ ...state, dialogOpen: false });
}

export function endConversationSelection(): void {
  if (state === IDLE) return;
  set(IDLE);
}

export function conversationSelection(): ConversationSelectionState {
  return state;
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/** The choice for `sessionId`, or the idle state for any other session. */
export function useConversationSelection(sessionId: string | null): ConversationSelectionState {
  const current = useSyncExternalStore(subscribe, conversationSelection, conversationSelection);
  return sessionId !== null && current.sessionId === sessionId ? current : IDLE;
}
