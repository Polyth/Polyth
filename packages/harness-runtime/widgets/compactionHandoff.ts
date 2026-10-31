// What a `session/compacted` marker carries for a reader, and the editable
// draft that starts a fresh conversation from it. Presentation only: the
// draft lands in a new chat's composer and nothing is sent until the user
// sends it. Recovery of the compacted session itself stays server-owned.
import type { SessionEvent } from "@polyth/contracts";
import { conversationMessages } from "@polyth/session/conversation";

export interface CompactionMessage {
  role: "user" | "assistant";
  text: string;
}

export interface CompactionContext {
  /** The harness's own summary, when it shared one. */
  summary?: string;
  /** User-pinned messages that were active at the compaction. */
  pinned: CompactionMessage[];
  /** The latest visible messages before the compaction (oldest first). */
  recent: CompactionMessage[];
}

export const COMPACTION_RECENT_MESSAGES = 6;
export const COMPACTION_MESSAGE_CHARS = 1_500;
export const COMPACTION_SUMMARY_CHARS = 8_000;

const clip = (text: string, max: number): string => {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1).trimEnd()}…` : trimmed;
};

export function compactionSummary(event: SessionEvent): string | undefined {
  const summary = (event.data as { summary?: unknown } | undefined)?.summary;
  return typeof summary === "string" && summary.trim() ? summary.trim() : undefined;
}

/** Fold the loaded canonical log up to the marker. A partially paged log
 * yields fewer recent messages, never messages from after the compaction. */
export function compactionContext(events: readonly SessionEvent[], compaction: SessionEvent): CompactionContext {
  const before = events.filter((event) => event.seq < compaction.seq);
  const messages = conversationMessages(before).filter((message) => message.text.trim());
  const pins = new Map<number, boolean>();
  for (const event of before) {
    if (event.type !== "context/pinned" && event.type !== "context/unpinned") continue;
    const seq = Number((event.data as { sourceEventSeq?: unknown }).sourceEventSeq);
    if (Number.isSafeInteger(seq) && seq > 0) pins.set(seq, event.type === "context/pinned");
  }
  const summary = compactionSummary(compaction);
  return {
    ...(summary ? { summary } : {}),
    pinned: messages
      .filter((message) => pins.get(message.eventSeq) === true)
      .map((message) => ({ role: message.role, text: clip(message.text, COMPACTION_MESSAGE_CHARS) })),
    recent: messages
      .slice(-COMPACTION_RECENT_MESSAGES)
      .map((message) => ({ role: message.role, text: clip(message.text, COMPACTION_MESSAGE_CHARS) })),
  };
}

export interface CompactionDraftLabels {
  intro: string;
  summary: string;
  pinned: string;
  recent: string;
  user: string;
  assistant: string;
}

/** The new chat's editable first prompt. Sections the source did not have
 * are omitted; the intro always names the source chat. */
export function compactionHandoffDraft(context: CompactionContext, labels: CompactionDraftLabels): string {
  const line = (message: CompactionMessage) =>
    `**${message.role === "user" ? labels.user : labels.assistant}:** ${message.text}`;
  const sections = [labels.intro];
  if (context.summary) sections.push(`## ${labels.summary}\n\n${clip(context.summary, COMPACTION_SUMMARY_CHARS)}`);
  if (context.pinned.length) sections.push(`## ${labels.pinned}\n\n${context.pinned.map(line).join("\n\n")}`);
  if (context.recent.length) sections.push(`## ${labels.recent}\n\n${context.recent.map(line).join("\n\n")}`);
  return `${sections.join("\n\n")}\n\n`;
}
