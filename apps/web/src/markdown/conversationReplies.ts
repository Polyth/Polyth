// The user message that follows each agent answer, for package fences
// (`MarkdownFenceContext.reply`): a block whose buttons send messages can
// recognise its own reply and show itself answered after a reload.
//
// The timeline owns one store and replaces its map from canonical history;
// a fence reads only its own answer's entry, so a new message re-renders
// just the blocks whose reply changed, never every answer in the chat.
import { createContext, useContext, useSyncExternalStore } from "react";

export interface ConversationReplies {
  get(messageId: string): string | undefined;
  subscribe(listener: () => void): () => void;
}

export interface ConversationRepliesStore extends ConversationReplies {
  /** Swap in the map during render, so children rendered in the same pass
   *  read it at once; `notify` (from an effect) reaches the rest. */
  replace(next: ReadonlyMap<string, string>): void;
  notify(): void;
}

export function createConversationReplies(): ConversationRepliesStore {
  let map: ReadonlyMap<string, string> = new Map();
  const listeners = new Set<() => void>();
  return {
    get: (messageId) => map.get(messageId),
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    replace(next) { map = next; },
    notify() { for (const listener of [...listeners]) listener(); },
  };
}

interface ReplySource {
  kind: string;
  id: string;
  text?: string;
  raw?: string;
  undone?: boolean;
}

/** Each assistant message id → the text of the first user message after it.
 *  Rewound (undone) prompts are not replies. One backward pass. */
export function followingReplies(messages: readonly ReplySource[]): Map<string, string> {
  const replies = new Map<string, string>();
  let next: string | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.kind === "user" && !message.undone) next = message.raw ?? message.text ?? "";
    else if (message.kind === "assistant" && next !== undefined) replies.set(message.id, next);
  }
  return replies;
}

export const ConversationRepliesContext = createContext<ConversationReplies | null>(null);

const noSubscribe = () => () => {};

/** The reply to one answer, or undefined (no store, no id, no reply yet). */
export function useConversationReply(messageId: string | undefined): string | undefined {
  const store = useContext(ConversationRepliesContext);
  return useSyncExternalStore(
    store ? store.subscribe : noSubscribe,
    () => (store && messageId ? store.get(messageId) : undefined),
    () => undefined,
  );
}
