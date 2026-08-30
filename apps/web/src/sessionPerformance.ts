export type SessionPerformanceMark =
  | "session_click"
  | "route_committed"
  | "cached_tail_rendered"
  | "request_started"
  | "response_received"
  | "messages_ingested"
  | "first_message_painted";

export function markSessionPerformance(name: SessionPerformanceMark, sessionId: string): void {
  if (typeof globalThis.performance?.mark !== "function") return;
  globalThis.performance.mark(name, { detail: { sessionId } });
}
