// Pure transcript shaping: filters, Markdown rendering and character windows.
import type { SharedChatMessage, SharedChatRole } from "./parser.ts";

export interface TranscriptFilter {
  roles?: readonly SharedChatRole[];
  /** Inclusive Unix-millisecond bounds. */
  since?: number;
  until?: number;
}

export function filterMessages(messages: readonly SharedChatMessage[], filter: TranscriptFilter): SharedChatMessage[] {
  const dated = filter.since !== undefined || filter.until !== undefined;
  return messages.filter((message) => {
    if (filter.roles && !filter.roles.includes(message.role)) return false;
    if (!dated) return true;
    if (message.createdAt === null) return false;
    if (filter.since !== undefined && message.createdAt < filter.since) return false;
    return filter.until === undefined || message.createdAt <= filter.until;
  });
}

/** `YYYY-MM-DD HH:MM` in UTC. */
export function formatTimestamp(ms: number | null): string {
  if (ms === null) return "time unknown";
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

export function dateRange(messages: readonly SharedChatMessage[]): { first: number | null; last: number | null } {
  let first: number | null = null;
  let last: number | null = null;
  for (const { createdAt } of messages) {
    if (createdAt === null) continue;
    if (first === null || createdAt < first) first = createdAt;
    if (last === null || createdAt > last) last = createdAt;
  }
  return { first, last };
}

/** `## [YYYY-MM-DD HH:MM] role` blocks. A body line that looks like a message
 *  heading is escaped so page text cannot forge another speaker. */
export function renderTranscript(messages: readonly SharedChatMessage[]): string {
  return messages
    .map((message) => `## [${formatTimestamp(message.createdAt)}] ${message.role}\n\n${message.text.replace(/^(#{1,6}) \[/gm, "\\$1 [")}\n`)
    .join("\n");
}

/** Ends a window at a message heading, else a paragraph or line break, when one is reasonably close. */
function windowEnd(text: string, offset: number, maxChars: number): number {
  const hard = Math.min(text.length, offset + maxChars);
  if (hard >= text.length) return text.length;
  const floor = offset + Math.floor(maxChars * 0.6);
  const heading = text.lastIndexOf("\n## [", hard - 1);
  if (heading >= floor) return heading + 1;
  const paragraph = text.lastIndexOf("\n\n", hard - 2);
  if (paragraph >= floor) return paragraph + 2;
  const line = text.lastIndexOf("\n", hard - 1);
  return line >= floor ? line + 1 : hard;
}

export function transcriptWindow(text: string, offset: number, maxChars: number): {
  content: string;
  offset: number;
  nextOffset: number | null;
} {
  const start = Math.min(offset, text.length);
  const end = windowEnd(text, start, maxChars);
  return { content: text.slice(start, end), offset: start, nextOffset: end < text.length ? end : null };
}
