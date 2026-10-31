import type { SessionEvent, SessionProjection } from "@polyth/contracts";
import { tr } from "./i18n/index.ts";
import { contextHasSample, type ContextGauge, type RenderModel, type Totals } from "./reduce.ts";

/** A display excerpt of the most recent cached user message, not a recap of
 * the agent's work. Preserve information across line breaks. */
export function latestRequestExcerpt(prompt: string | undefined, max = 180): string {
  const text = prompt?.replace(/\s+/g, " ").trim() ?? "";
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Duration bounds and message counts share one history pass. The reducer
 * clones the array on updates and bumps version for in-place message edits. */
const messageFactsCache = new WeakMap<RenderModel["messages"], {
  version: number;
  first: number;
  end: number;
  all: number;
  visible: number;
}>();

function messageFacts(model: Pick<RenderModel, "messages" | "version">) {
  let facts = messageFactsCache.get(model.messages);
  if (facts && facts.version === model.version) return facts;
  const first = model.messages[0]?.time ?? 0;
  let end = first;
  let all = 0;
  let visible = 0;
  for (const message of model.messages) {
    const completed = message.kind === "assistant" ? message.completedAt ?? message.time : message.time;
    end = Math.max(end, completed);
    if (message.kind === "user" || message.kind === "assistant") {
      all++;
      if (!message.undone) visible++;
    }
  }
  facts = { version: model.version, first, end, all, visible };
  messageFactsCache.set(model.messages, facts);
  return facts;
}

export function sessionMessageCounts(model: Pick<RenderModel, "messages" | "version">): { all: number; visible: number } {
  const { all, visible } = messageFacts(model);
  return { all, visible };
}

/** The same first-message-to-last-activity wall-clock span used by ChatMetrics.
 * An empty session has no measurable duration, even if it has a creation time. */
export function sessionDurationMs(
  session: Pick<SessionProjection, "createdAt"> | null,
  model: Pick<RenderModel, "messages" | "turn" | "version">,
  now: number,
): number | null {
  if (!session || model.messages.length === 0) return null;
  const bounds = messageFacts(model);
  const turnEnd = model.turn?.status === "working"
    ? now
    : model.turn?.stoppedAt ?? bounds.end;
  return Math.max(0, Math.max(bounds.end, turnEnd) - bounds.first);
}

/** Keep partial counts and fractions useful without inventing missing token
 * counts or limits. Estimated counts retain their visible approximation mark. */
export function contextUsageLabel(
  gauge: ContextGauge | null | undefined,
  percentLabel: string | null,
  notice: string | null | undefined,
  unavailable: string,
  formatTokens: (value: number) => string,
): string {
  const prefix = gauge?.quality === "estimated" ? "~" : "";
  if (gauge?.known && gauge.contextTokens > 0) {
    return `${prefix}${formatTokens(gauge.inputTokens)} / ${formatTokens(gauge.contextTokens)}`;
  }
  if (gauge && contextHasSample(gauge)) {
    return tr("context.observedTokensWindowUnavailable", {
      tokens: `${prefix}${formatTokens(gauge.inputTokens)}`,
    });
  }
  return percentLabel ?? notice ?? unavailable;
}

/** Zero is only a reported zero when a usage event actually supplied that
 * field. A new/unsupported session's reducer totals also start at zero. */
export function reportedSessionUsage(totals: Totals, events: readonly SessionEvent[] | undefined): {
  tokens: number | null;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  cost: number | null;
} {
  let hasTokens = totals.input !== 0 || totals.output !== 0 || totals.reasoning !== 0
    || totals.cacheRead !== 0 || totals.cacheWrite !== 0;
  let hasCost = totals.cost !== 0;
  if ((!hasTokens || !hasCost) && events) {
    for (const event of events) {
      if (event.type !== "usage/recorded") continue;
      if (event.data.tokens && typeof event.data.tokens === "object") hasTokens = true;
      if (typeof event.data.cost === "number") hasCost = true;
      if (hasTokens && hasCost) break;
    }
  }
  return {
    tokens: hasTokens ? totals.input + totals.output + totals.reasoning : null,
    input: hasTokens ? totals.input : null,
    output: hasTokens ? totals.output : null,
    cacheRead: hasTokens ? totals.cacheRead : null,
    cacheWrite: hasTokens ? totals.cacheWrite : null,
    cost: hasCost ? totals.cost : null,
  };
}
