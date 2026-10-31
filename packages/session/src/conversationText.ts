import type { SessionEvent } from "@polyth/contracts";
import { effectiveHistory } from "./history.ts";

import { stripRecoveryContextBlocks } from "@polyth/contracts";
export { stripRecoveryContextBlocks } from "@polyth/contracts";

export interface DisplayedConversationMessage {
  id: string;
  eventSeq: number;
  role: "user" | "assistant";
  text: string;
  time: number;
  finalized: boolean;
}

/** Literal Unicode case-insensitive matches, with offsets in the original text. */
export function* literalTextMatches(text: string, query: string): Generator<{ start: number; end: number }> {
  if (!query) return;
  const escaped = Array.from(query, (character) =>
    ".^$*+?()[]{}|\\".includes(character) ? "\\" + character : character).join("");
  for (const match of text.matchAll(new RegExp(escaped, "giu"))) {
    yield { start: match.index, end: match.index + match[0].length };
  }
}

/** Display text from a caller-scoped canonical log, independent of UI paging.
 * It excludes hidden prompts, rewind tails, reasoning, tools and runtime
 * metadata. This presentation selector is never a provider/model history. */
export function conversationMessages(events: readonly SessionEvent[]): DisplayedConversationMessage[] {
  const messages: DisplayedConversationMessage[] = [];
  const assistants = new Map<string, DisplayedConversationMessage>();
  let latestAssistant: DisplayedConversationMessage | undefined;
  let latestAssistantPartId = "";

  for (const event of effectiveHistory(events).events) {
    const data = event.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) continue;
    if (event.type === "user/message") {
      if (data.githubConflictResolution === true || data.hiddenUserMessage === true || data.autoResume === true) continue;
      messages.push({
        id: event.id, eventSeq: event.seq, role: "user",
        text: stripRecoveryContextBlocks(typeof data.text === "string" ? data.text : ""),
        time: event.time, finalized: true,
      });
      continue;
    }
    if (event.type !== "assistant/chunk" && event.type !== "assistant/reasoning-chunk"
      && event.type !== "assistant/message") continue;

    const partId = typeof data.partId === "string" ? data.partId : "";
    const text = typeof data.text === "string" ? data.text : undefined;
    let message = assistants.get(partId);
    if (!message && event.type === "assistant/message" && text !== undefined
      && latestAssistant && !latestAssistant.finalized && text.startsWith(latestAssistant.text)) {
      message = latestAssistant;
      assistants.delete(latestAssistantPartId);
      assistants.set(partId, message);
      latestAssistantPartId = partId;
    }
    if (!message) {
      message = {
        id: partId || event.id, eventSeq: event.seq, role: "assistant",
        text: "", time: event.time, finalized: false,
      };
      messages.push(message);
      assistants.set(partId, message);
      latestAssistant = message;
      latestAssistantPartId = partId;
    }
    if (event.type === "assistant/chunk") message.text += text ?? "";
    else if (event.type === "assistant/message") {
      if (text !== undefined) message.text = text;
      message.eventSeq = event.seq;
      message.time = event.time;
      message.finalized = true;
    }
  }
  return messages.filter((message) => message.text !== "");
}
