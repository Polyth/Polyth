import type { SessionEvent } from "@polyth/contracts";
import { effectiveHistory, recoveredUserText } from "./history.ts";

/** The two textual messages that form the latest finished user → assistant turn. */
export interface CompletedExchange {
  user: string;
  assistant: string;
  userSeq: number;
  assistantSeq: number;
}

/** Compact descriptors for what the user attached to a message. The content is
 *  deliberately absent — an assistant utility needs to know a screenshot or a
 *  file was part of the ask, not to re-read it. */
function attachmentDescriptors(event: SessionEvent): string[] {
  const raw = (event.data as { attachments?: unknown }).attachments;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const ref = item as { name?: unknown; path?: unknown; mime?: unknown; kind?: unknown };
    const label = [ref.name, ref.path].find((value) => typeof value === "string" && value) as string | undefined;
    const kind = [ref.kind, ref.mime].find((value) => typeof value === "string" && value) as string | undefined;
    if (label) out.push(kind ? `${label} (${kind})` : label);
    else if (kind) out.push(kind);
  }
  return out;
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

// -------------------------------------------------- recent completed context

export interface ConversationExchange extends CompletedExchange {
  /** Compact descriptors of what the user attached, if anything. */
  attachments: string[];
}

export interface RecentContextOptions {
  /** How many completed exchanges to keep, newest first. */
  maxExchanges?: number;
  /** Total character budget across the kept exchanges. */
  maxChars?: number;
}

const DEFAULT_MAX_EXCHANGES = 3;
const DEFAULT_MAX_CHARS = 12_000;

const exchangeCost = (exchange: ConversationExchange): number =>
  exchange.user.length + exchange.assistant.length + exchange.attachments.join("").length;

/**
 * The recent COMPLETED user → assistant exchanges, oldest first.
 *
 * Assistant utilities that reason about "what just happened" cannot use the
 * last exchange alone: a conversation routinely ends with "yes", "do that" or
 * "looks good", and the work those words refer to lives one or two exchanges
 * back. Nor can they use an arbitrary transcript tail, which is mostly tool
 * noise and is bounded by nothing meaningful.
 *
 * Bounded by both exchange count and characters, and deterministic, so the
 * same log always produces the same context. When the budget binds, the
 * OLDEST exchanges are dropped — recent user intent is what matters most —
 * but the newest exchange is always kept even if it exceeds the budget alone.
 */
export function recentCompletedConversationContext(
  events: readonly SessionEvent[],
  opts: RecentContextOptions = {},
): ConversationExchange[] {
  // The newest exchange is only usable once its turn has finished; that
  // judgement (turn markers, imported logs, an active turn) already lives in
  // latestCompletedExchange, so reuse it rather than re-deriving it here.
  const newest = latestCompletedExchange(events);
  if (!newest) return [];

  const visible = effectiveHistory(events).events
    .filter((event) =>
      !event.ignorable
      && (event.type === "user/message" || event.type === "assistant/message")
      && event.seq <= newest.assistantSeq);

  // Pair each user message with the last assistant reply before the next one.
  const pairs: ConversationExchange[] = [];
  for (let i = 0; i < visible.length; i += 1) {
    const userEvent = visible[i]!;
    if (userEvent.type !== "user/message") continue;
    let assistantEvent: SessionEvent | undefined;
    for (let j = i + 1; j < visible.length && visible[j]!.type !== "user/message"; j += 1) {
      if (eventText(visible[j]!, "assistant")) assistantEvent = visible[j]!;
    }
    if (!assistantEvent) continue;
    const user = eventText(userEvent, "user");
    const assistant = eventText(assistantEvent, "assistant");
    const attachments = attachmentDescriptors(userEvent);
    if (!assistant || (!user && attachments.length === 0)) continue;
    pairs.push({
      user,
      assistant,
      attachments,
      userSeq: userEvent.seq,
      assistantSeq: assistantEvent.seq,
    });
  }

  const maxExchanges = Math.max(1, opts.maxExchanges ?? DEFAULT_MAX_EXCHANGES);
  const maxChars = Math.max(1, opts.maxChars ?? DEFAULT_MAX_CHARS);
  const kept = pairs.slice(-maxExchanges);
  let total = kept.reduce((sum, exchange) => sum + exchangeCost(exchange), 0);
  while (kept.length > 1 && total > maxChars) {
    total -= exchangeCost(kept.shift()!);
  }
  return kept;
}

/** Render the context as the plain transcript an assistant utility reads. */
export function renderConversationContext(context: readonly ConversationExchange[]): string {
  return context.map((exchange) => {
    const lines = [`User: ${exchange.user}`];
    if (exchange.attachments.length > 0) lines.push(`(attached: ${exchange.attachments.join(", ")})`);
    lines.push(`Assistant: ${exchange.assistant}`);
    return lines.join("\n");
  }).join("\n\n");
}
