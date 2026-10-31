import type { SessionEvent } from "@polyth/contracts";
import { conversationMessages, literalTextMatches } from "@polyth/session/conversation";

export const FIND_PAGE_SIZE = 100;
export const FIND_QUERY_MAX = 256;

export interface ConversationMatch {
  index: number;
  messageId: string;
  eventSeq: number;
  role: "user" | "assistant";
  start: number;
  end: number;
  occurrence: number;
  before: string;
  hit: string;
  after: string;
}

export interface ConversationFindResult {
  sessionId: string;
  query: string;
  throughSeq: number;
  total: number;
  offset: number;
  matches: ConversationMatch[];
}

export function findConversation(
  sessionId: string,
  events: readonly SessionEvent[],
  query: string,
  offset = 0,
): ConversationFindResult {
  if (query.length > FIND_QUERY_MAX || !Number.isSafeInteger(offset) || offset < 0) {
    throw Object.assign(new Error("Invalid conversation search"), { code: "invalid-input" });
  }
  const matches: ConversationMatch[] = [];
  let total = 0;
  if (query) for (const message of conversationMessages(events)) {
    let occurrence = 0;
    for (const range of literalTextMatches(message.text, query)) {
      if (total >= offset && matches.length < FIND_PAGE_SIZE) {
        let from = Math.max(0, range.start - 64);
        let to = Math.min(message.text.length, range.end + 64);
        // Keep surrogate pairs intact at the bounded snippet's edges.
        if (from > 0 && /[\uDC00-\uDFFF]/.test(message.text[from]!)) from -= 1;
        if (to < message.text.length && /[\uDC00-\uDFFF]/.test(message.text[to]!)) to += 1;
        matches.push({
          index: total, messageId: message.id, eventSeq: message.eventSeq,
          role: message.role, start: range.start, end: range.end, occurrence,
          before: (from > 0 ? "…" : "") + message.text.slice(from, range.start),
          hit: message.text.slice(range.start, range.end),
          after: message.text.slice(range.end, to) + (to < message.text.length ? "…" : ""),
        });
      }
      total += 1;
      occurrence += 1;
    }
  }
  return { sessionId, query, throughSeq: events.at(-1)?.seq ?? 0, total, offset, matches };
}
