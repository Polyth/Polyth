// Whether a running tool call is waiting on a person: an open approval card,
// question or Credential Vault form of this session that belongs to the call.
// The server pauses its silence watchdog (and the hard ceiling) for exactly
// these calls (`toolAwaitingRequest` in packages/server/src/sessions.ts), so a
// client must not count down to an auto-stop that will not happen. This file
// mirrors that rule over the session's events; the server stays authoritative.

export type ToolAwaiting = "approval" | "answer";

interface AwaitingEvent {
  type: string;
  data: unknown;
}

type OpenRequest = { type: string; requestId: string; data: Record<string, unknown> };

const OPENS = new Set(["permission/requested", "question/asked", "secret/requested"]);
const CLOSES = new Set([
  "permission/resolved", "permission/expired",
  "question/answered", "question/expired",
  "secret/resolved", "secret/expired",
]);

/** Polyth's own agent tools arrive under their MCP-qualified names. */
const agentToolName = (tool: string): string =>
  tool.replace(/^(?:mcp__?)?polyth-agent-tools(?:__|_|-)/, "");

interface TurnFacts {
  open: OpenRequest[];
  tools: Map<string, string>;
}

/** One backward pass per events array: the current turn's open requests and
 *  the tool name of every call it started. */
const factsCache = new WeakMap<readonly AwaitingEvent[], TurnFacts>();

function turnFacts(events: readonly AwaitingEvent[]): TurnFacts {
  const cached = factsCache.get(events);
  if (cached) return cached;
  const closed = new Set<string>();
  const open: OpenRequest[] = [];
  const tools = new Map<string, string>();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === "turn/started" || event.type === "turn/stopped") break;
    const data = (event.data ?? {}) as Record<string, unknown>;
    const requestId = typeof data.requestId === "string" ? data.requestId : "";
    if (CLOSES.has(event.type)) {
      if (requestId) closed.add(requestId);
    } else if (OPENS.has(event.type)) {
      if (requestId && !closed.has(requestId)) open.push({ type: event.type, requestId, data });
    } else if ((event.type === "tool/started" || event.type === "tool/call")
      && typeof data.callId === "string" && typeof data.tool === "string" && !tools.has(data.callId)) {
      tools.set(data.callId, data.tool);
    }
  }
  const facts = { open, tools };
  factsCache.set(events, facts);
  return facts;
}

/** What the call waits for, or null when nothing of a person's is open for it. */
export function toolAwaiting(
  events: readonly AwaitingEvent[] | undefined,
  sessionId: string | null | undefined,
  callId: string,
): ToolAwaiting | null {
  if (!events?.length || !sessionId) return null;
  const { open, tools } = turnFacts(events);
  if (!open.length) return null;
  const tool = tools.get(callId) ?? "";
  for (const request of open) {
    const { data } = request;
    // A parent's mirror of a child's card cannot shelter this call.
    if (typeof data.sourceSessionId === "string" && data.sourceSessionId !== sessionId) continue;
    const matches = request.requestId === callId
      || data.tool === callId
      || ((data.permission === "package-tool" || data.origin === "agent-tool")
        && typeof data.tool === "string"
        && tool !== ""
        && agentToolName(tool) === data.tool)
      || (request.type !== "permission/requested" && tool === "question");
    if (matches) return request.type === "permission/requested" ? "approval" : "answer";
  }
  return null;
}
