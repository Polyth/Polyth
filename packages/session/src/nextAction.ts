import type { SessionEvent } from "@polyth/contracts";
import { effectiveHistory, recoveredUserText } from "./history.ts";

/** The two textual messages that form the latest finished user → assistant turn. */
export interface CompletedExchange {
  user: string;
  assistant: string;
  userSeq: number;
  assistantSeq: number;
}

function eventText(event: SessionEvent, role: "user" | "assistant"): string {
  const data = event.data as { text?: unknown; recoveryContext?: unknown };
  const text = String(data.text ?? "");
  return (role === "user"
    ? recoveredUserText(text, typeof data.recoveryContext === "string" ? data.recoveryContext : undefined)
    : text).trim();
}

/**
 * Resolve the latest completed exchange from the effective log. A completed
 * turn's start/stop markers are the canonical linkage when present. Imported
 * or older logs can lack those markers, so a finalized assistant record with
 * no later user/turn start is used as a conservative fallback.
 */
export function latestCompletedExchange(events: readonly SessionEvent[]): CompletedExchange | null {
  const visible = effectiveHistory(events).events;
  const completedAt = visible.findLastIndex((event) =>
    event.type === "turn/stopped"
    && (event.data as { reason?: unknown }).reason === "completed");

  const exchangeFor = (assistantIndex: number, beforeUserIndex: number): CompletedExchange | null => {
    const assistantEvent = visible[assistantIndex];
    if (!assistantEvent || assistantEvent.type !== "assistant/message" || assistantEvent.ignorable) return null;
    const userIndex = visible.findLastIndex((event, index) =>
      index < beforeUserIndex && event.type === "user/message" && !event.ignorable);
    const userEvent = visible[userIndex];
    if (!userEvent || userEvent.type !== "user/message") return null;
    const user = eventText(userEvent, "user");
    const assistant = eventText(assistantEvent, "assistant");
    return user && assistant ? { user, assistant, userSeq: userEvent.seq, assistantSeq: assistantEvent.seq } : null;
  };

  if (completedAt >= 0) {
    const stopped = visible[completedAt]!;
    const turnId = (stopped.data as { turnId?: unknown }).turnId;
    const startedAt = visible.findLastIndex((event, index) =>
      index < completedAt
      && event.type === "turn/started"
      && (typeof turnId !== "string" || (event.data as { turnId?: unknown }).turnId === turnId));
    if (startedAt >= 0) {
      const assistantAt = visible.findLastIndex((event, index) =>
        index > startedAt && index < completedAt && event.type === "assistant/message"
        && !event.ignorable && eventText(event, "assistant") !== "");
      const exchange = exchangeFor(assistantAt, startedAt);
      if (exchange) return exchange;
    }
  }

  const assistantAt = visible.findLastIndex((event) =>
    event.type === "assistant/message" && !event.ignorable && eventText(event, "assistant") !== "");
  if (assistantAt < 0) return null;
  // A newer prompt or active turn means this answer is no longer the latest
  // completed exchange, even if the projection update has not arrived yet.
  if (visible.slice(assistantAt + 1).some((event) =>
    event.type === "user/message" || event.type === "turn/started")) return null;
  return exchangeFor(assistantAt, assistantAt);
}
