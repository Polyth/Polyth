import type { SessionEvent } from "@polyth/contracts";

function eventReason(event: SessionEvent): unknown {
  const data = event.data;
  return data !== null && typeof data === "object" ? (data as { reason?: unknown }).reason : undefined;
}

function hasRetryPlan(event: SessionEvent): boolean {
  const data = event.data;
  if (data === null || typeof data !== "object") return false;
  const retry = (data as { retry?: unknown }).retry;
  return retry !== null && typeof retry === "object";
}

/** Agent-visible output includes streamed text and reasoning, not only the
 * final assistant/message row. A partial answer must keep the session. */
export function isAgentMessageEvent(event: SessionEvent): boolean {
  return event.type === "assistant/chunk"
    || event.type === "assistant/reasoning-chunk"
    || event.type === "assistant/message";
}

function isContextFullRefusal(event: SessionEvent): boolean {
  const data = event.data;
  return data !== null && typeof data === "object" && (data as { code?: unknown }).code === "context-full";
}

/** Only durable terminal failures qualify. Transport uncertainty and an
 * aborted/completed turn must never trigger destructive cleanup. A chat refused
 * for being full is no failed startup: it holds what the person wrote, and
 * compacting gets it going. */
export function isConfirmedStartupFailureEvent(event: SessionEvent): boolean {
  return event.type === "turn/failed"
    || (event.type === "turn/stopped" && eventReason(event) === "error" && !hasRetryPlan(event) && !isContextFullRefusal(event));
}

/** The caller supplies the event window for one newly-created session. The
 * failure must still be the newest fact, so a user retry cannot race deletion. */
export function shouldDeleteFailedStartupSession(events: readonly SessionEvent[]): boolean {
  const latest = events.at(-1);
  return latest !== undefined
    && isConfirmedStartupFailureEvent(latest)
    && !events.some(isAgentMessageEvent);
}

/** Creation can fail before a turn exists. Its durable log has the creation
 * marker but no user or assistant message at all. */
export function isEmptyFailedStartupSession(events: readonly SessionEvent[]): boolean {
  const latest = events.at(-1);
  return events.some((event) => event.type === "session/created")
    && !events.some((event) => event.type === "user/message")
    && !events.some(isAgentMessageEvent)
    && (latest?.type === "session/created" || (latest !== undefined && isConfirmedStartupFailureEvent(latest)));
}
