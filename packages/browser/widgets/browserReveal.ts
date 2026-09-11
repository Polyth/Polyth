import type { SessionEvent } from "@polyth/contracts";
import type { BrowserVisibilityMode } from "./browserVisibility.ts";

/**
 * Browser requests are presentation triggers only. Authorization and the
 * browser mutation remain server-owned; this predicate merely recognizes the
 * durable request fact early enough for the package surface to be visible.
 */
export function isBrowserToolRequest(event: SessionEvent): boolean {
  const data = event.data as {
    tool?: unknown;
    toolId?: unknown;
    toolName?: unknown;
    owner?: unknown;
  };
  if (event.type === "package-tool/requested") {
    return data.toolId === "browser.polyth-browser"
      || data.owner === "browser"
      || (typeof data.toolName === "string" && data.toolName.startsWith("browser."));
  }
  if (event.type !== "tool/call" && event.type !== "tool/started") return false;
  return typeof data.tool === "string"
    && (data.tool === "browser.polyth-browser" || data.tool.startsWith("browser."));
}

export function isBrowserRequestForSession(event: SessionEvent, sessionId: string | null): boolean {
  return sessionId !== null && event.sessionId === sessionId && isBrowserToolRequest(event);
}

export function shouldAutoRevealBrowserRequest(
  event: SessionEvent,
  sessionId: string | null,
  visibility: BrowserVisibilityMode,
): boolean {
  return visibility === "auto-show" && isBrowserRequestForSession(event, sessionId);
}

export function browserRequestKey(event: SessionEvent): string {
  const data = event.data as { requestId?: unknown; callId?: unknown };
  const requestId = typeof data.requestId === "string" ? data.requestId : undefined;
  const callId = typeof data.callId === "string" ? data.callId : undefined;
  return `${event.sessionId}:${requestId ?? callId ?? event.id}`;
}
