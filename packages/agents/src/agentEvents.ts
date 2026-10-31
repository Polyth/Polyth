// Event wakes: which events an agent reacts to, and how often. Pure and
// browser-safe — the service persists the state below and the editor uses the
// same matcher for its "would have woken" preview.

/** Outcome of a session's turn as an agent sees it. */
export type SessionEventOutcome = "completed" | "failed" | "stopped";
/** Outcome of another agent's run. */
export type AgentRunOutcome = "ok" | "failed";

export interface AgentEvent {
  id: string;
  kind: "session" | "agent" | "webhook" | "integration";
  at: number;
  /** Absent on integration events that concern the whole Space. */
  projectId: string;
  /** Owning Space; set on integration events. */
  spaceId?: string;
  /** session/agent outcome, integration event type, or "received" for webhooks. */
  outcome: string;
  /** Integration events: the publishing source id. */
  source?: string;
  /** Webhook events: the one agent and trigger the URL belongs to. */
  target?: { agentId: string; triggerId: string };
  /** Agent whose run produced the event (its own session or its run). */
  sourceAgentId?: string;
  /** Chain depth of that run; 0 when no agent was involved. */
  chainDepth: number;
  /** Filterable, displayable facts. Values are data, never instructions. */
  fields: Record<string, string>;
}

export type FilterOp = "equals" | "not-equals" | "contains" | "not-contains";

export interface AgentEventFilter {
  field: string;
  op: FilterOp;
  value: string;
}

export interface AgentPace {
  /** Wait this long after the last matching event before waking. */
  quietMs: number;
  /** `latest`: one run with the newest event; `batch`: one run with all of them. */
  coalesce: "latest" | "batch";
  /** At most this many event wakes per rolling hour. */
  maxPerHour: number;
}

/** Shared by every event wake. `script`: an optional body of
 *  `function (events, agent)` run in a sandbox after the pace, returning
 *  { action: "run" | "skip" | "pause" }. */
interface TriggerBase {
  id: string;
  filters?: AgentEventFilter[];
  pace?: AgentPace;
  script?: string;
}

export type AgentEventTrigger =
  | TriggerBase & { kind: "session"; on: SessionEventOutcome[] }
  | TriggerBase & { kind: "agent"; agentId: string; on: AgentRunOutcome[] }
  /** `tokenHash` is server-owned: SHA-256 of the URL token, never the token. */
  | TriggerBase & { kind: "webhook"; tokenHash?: string }
  | TriggerBase & { kind: "integration"; source: string; on: string[] };

export const SCRIPT_MAX_CHARS = 8_000;

/** Persisted per trigger: events waiting for the quiet period, and recent
 *  wakes for the hourly limit. */
export interface PaceState {
  pending: AgentEvent[];
  /** When the oldest pending event arrived. */
  firstAt?: number;
  dueAt?: number;
  fired: number[];
  /** The hourly-limit hold was already logged for these pending events. */
  limited?: boolean;
}

export const MAX_CHAIN_DEPTH = 3;
export const MAX_PENDING_EVENTS = 20;
export const MAX_EVENT_TRIGGERS = 8;
export const DEFAULT_PACE: AgentPace = { quietMs: 60_000, coalesce: "latest", maxPerHour: 6 };
const HOUR_MS = 60 * 60_000;
/** A steady stream must not postpone a wake forever. */
const MAX_DEBOUNCE_FACTOR = 5;

export const EVENT_FIELDS = {
  session: ["title", "error", "harness", "model", "agent"],
  agent: ["agent", "summary", "error"],
  webhook: ["title", "event", "text"],
  integration: ["title", "text"],
} as const;

const SESSION_OUTCOMES: readonly SessionEventOutcome[] = ["completed", "failed", "stopped"];
const AGENT_OUTCOMES: readonly AgentRunOutcome[] = ["ok", "failed"];
const FILTER_OPS: readonly FilterOp[] = ["equals", "not-equals", "contains", "not-contains"];

const fail = (message: string): Error => Object.assign(new Error(message), { code: "invalid-input" });

function filterPasses(filter: AgentEventFilter, event: AgentEvent): boolean {
  const actual = (filter.field === "outcome" ? event.outcome : event.fields[filter.field] ?? "").toLocaleLowerCase();
  const expected = filter.value.trim().toLocaleLowerCase();
  if (filter.op === "equals") return actual === expected;
  if (filter.op === "not-equals") return actual !== expected;
  if (filter.op === "contains") return actual.includes(expected);
  return !actual.includes(expected);
}

export type MatchExplanation =
  | { matched: true }
  | { matched: false; reason: "own" | "source" | "outcome"; filter?: undefined }
  | { matched: false; reason: "filter"; filter: AgentEventFilter };

/** `triggerMatches`, with the rule that rejected the event. */
export function explainMatch(trigger: AgentEventTrigger, event: AgentEvent, selfAgentId: string): MatchExplanation {
  if (event.sourceAgentId === selfAgentId) return { matched: false, reason: "own" };
  if (trigger.kind !== event.kind) return { matched: false, reason: "source" };
  if (trigger.kind === "agent" && event.sourceAgentId !== trigger.agentId) return { matched: false, reason: "source" };
  if (trigger.kind === "integration" && event.source !== trigger.source) return { matched: false, reason: "source" };
  if (trigger.kind !== "webhook" && !(trigger.on as readonly string[]).includes(event.outcome)) return { matched: false, reason: "outcome" };
  const failed = (trigger.filters ?? []).find((filter) => !filterPasses(filter, event));
  return failed ? { matched: false, reason: "filter", filter: failed } : { matched: true };
}

/** Whether `event` wakes `selfAgentId` through `trigger`. An agent never wakes
 *  itself, which also keeps its own sessions from re-triggering it. */
export function triggerMatches(trigger: AgentEventTrigger, event: AgentEvent, selfAgentId: string): boolean {
  if (event.sourceAgentId === selfAgentId || trigger.kind !== event.kind) return false;
  if (trigger.kind === "webhook") {
    if (event.target?.agentId !== selfAgentId || event.target.triggerId !== trigger.id) return false;
  } else {
    if (trigger.kind === "agent" && event.sourceAgentId !== trigger.agentId) return false;
    if (trigger.kind === "integration" && event.source !== trigger.source) return false;
    if (!(trigger.on as readonly string[]).includes(event.outcome)) return false;
  }
  return (trigger.filters ?? []).every((filter) => filterPasses(filter, event));
}

function paceOf(raw: unknown): AgentPace {
  const pace = raw as Partial<AgentPace> | undefined;
  if (!pace || typeof pace !== "object") return { ...DEFAULT_PACE };
  const quietMs = Number(pace.quietMs ?? DEFAULT_PACE.quietMs);
  const maxPerHour = Number(pace.maxPerHour ?? DEFAULT_PACE.maxPerHour);
  if (!Number.isFinite(quietMs) || quietMs < 0 || quietMs > 24 * HOUR_MS) throw fail("quietMs must be between 0 and 24 hours");
  if (!Number.isInteger(maxPerHour) || maxPerHour < 1 || maxPerHour > 60) throw fail("maxPerHour must be a whole number from 1 to 60");
  if (pace.coalesce !== undefined && pace.coalesce !== "latest" && pace.coalesce !== "batch") throw fail("coalesce must be latest or batch");
  return { quietMs, coalesce: pace.coalesce ?? "latest", maxPerHour };
}

/** Validate untrusted trigger input; throws an `invalid-input` error. */
export function validateTrigger(raw: unknown): AgentEventTrigger {
  const input = raw as Record<string, unknown> | undefined;
  if (!input || typeof input !== "object") throw fail("trigger must be an object");
  const id = typeof input.id === "string" && /^[a-z0-9-]{1,40}$/.test(input.id) ? input.id : "";
  if (!id) throw fail("trigger id must be a short lowercase id");
  const filters = Array.isArray(input.filters) ? input.filters.slice(0, 8).map((rawFilter) => {
    const filter = rawFilter as Partial<AgentEventFilter>;
    if (typeof filter.field !== "string" || !/^[a-z]{1,20}$/.test(filter.field)) throw fail("filter field is invalid");
    if (!FILTER_OPS.includes(filter.op as FilterOp)) throw fail("filter op is invalid");
    if (typeof filter.value !== "string" || filter.value.length > 200) throw fail("filter value must be text up to 200 characters");
    return { field: filter.field, op: filter.op as FilterOp, value: filter.value };
  }) : [];
  const on = Array.isArray(input.on) ? [...new Set(input.on.map(String))] : [];
  const pace = paceOf(input.pace);
  if (input.script !== undefined && typeof input.script !== "string") throw fail("script must be text");
  const scriptText = typeof input.script === "string" ? input.script.trim() : "";
  if (scriptText.length > SCRIPT_MAX_CHARS) throw fail(`script must be at most ${SCRIPT_MAX_CHARS} characters`);
  const extra = { ...(filters.length ? { filters } : {}), pace, ...(scriptText ? { script: scriptText } : {}) };
  if (input.kind === "session") {
    if (!on.length || !on.every((item) => (SESSION_OUTCOMES as readonly string[]).includes(item))) throw fail("session trigger needs outcomes");
    return { id, kind: "session", on: on as SessionEventOutcome[], ...extra };
  }
  if (input.kind === "agent") {
    const agentId = typeof input.agentId === "string" ? input.agentId.trim() : "";
    if (!agentId) throw fail("agent trigger needs an agent");
    if (!on.length || !on.every((item) => (AGENT_OUTCOMES as readonly string[]).includes(item))) throw fail("agent trigger needs outcomes");
    return { id, kind: "agent", agentId, on: on as AgentRunOutcome[], ...extra };
  }
  if (input.kind === "webhook") {
    // The token hash is attached by the service, never accepted from input.
    return { id, kind: "webhook", ...extra };
  }
  if (input.kind === "integration") {
    const source = typeof input.source === "string" && /^[a-z0-9-]{1,40}$/.test(input.source) ? input.source : "";
    if (!source) throw fail("integration trigger needs a source");
    if (!on.length || !on.every((item) => /^[a-z0-9-]{1,40}$/.test(item))) throw fail("integration trigger needs event types");
    return { id, kind: "integration", source, on: on.slice(0, 20), ...extra };
  }
  throw fail("trigger kind must be session, agent, webhook or integration");
}

/** Take one matching event: queue it and (re)start the quiet period. The
 *  wait never stretches past `MAX_DEBOUNCE_FACTOR` quiet periods from the
 *  first queued event, so a steady stream still wakes the agent. */
export function offerEvent(state: PaceState | undefined, event: AgentEvent, pace: AgentPace, now: number): PaceState {
  const previous = state ?? { pending: [], fired: [] };
  const firstAt = previous.pending.length ? previous.firstAt ?? now : now;
  return {
    pending: pace.coalesce === "latest" ? [event] : [...previous.pending, event].slice(-MAX_PENDING_EVENTS),
    firstAt,
    dueAt: Math.min(now + pace.quietMs, firstAt + pace.quietMs * MAX_DEBOUNCE_FACTOR),
    fired: previous.fired.filter((at) => at > now - HOUR_MS),
    // Joining a batch already held by the hourly limit is not news.
    ...(previous.pending.length && previous.limited ? { limited: true } : {}),
  };
}

export type PaceResult =
  | { kind: "idle" }
  | { kind: "wait"; until: number }
  /** Over the hourly limit: the events stay pending until a slot frees. */
  | { kind: "limited"; until: number }
  | { kind: "fire"; events: AgentEvent[]; state: PaceState };

/** Decide what a trigger's pending events do at `now`. */
export function settlePace(state: PaceState | undefined, pace: AgentPace, now: number): PaceResult {
  if (!state?.pending.length || state.dueAt === undefined) return { kind: "idle" };
  if (now < state.dueAt) return { kind: "wait", until: state.dueAt };
  const fired = state.fired.filter((at) => at > now - HOUR_MS);
  if (fired.length >= pace.maxPerHour) return { kind: "limited", until: fired[0]! + HOUR_MS };
  return { kind: "fire", events: state.pending, state: { pending: [], fired: [...fired, now] } };
}

/** Depth of the run an event wake would start, or undefined past the limit. */
export function nextChainDepth(events: readonly AgentEvent[]): number | undefined {
  const depth = Math.max(0, ...events.map((event) => event.chainDepth)) + 1;
  return depth > MAX_CHAIN_DEPTH ? undefined : depth;
}

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

/** One line describing an event for the agent's prompt. */
export function describeEvent(event: AgentEvent): string {
  const title = clip(event.fields.title || event.fields.agent || "untitled", 120);
  const extra = event.fields.error || event.fields.summary;
  const detail = extra ? ` — ${clip(extra.replace(/\s+/g, " ").trim(), 400)}` : "";
  if (event.kind === "agent") {
    return `Agent “${title}” ${event.outcome === "ok" ? "completed a run" : "failed a run"}${detail}`;
  }
  if (event.kind === "webhook") {
    const kind = event.fields.event ? ` (${clip(event.fields.event, 60)})` : "";
    const body = event.fields.text ? ` — ${clip(event.fields.text.replace(/\s+/g, " ").trim(), 600)}` : "";
    return `Webhook “${title}”${kind}${body}`;
  }
  if (event.kind === "integration") {
    const body = event.fields.text ? ` — ${clip(event.fields.text.replace(/\s+/g, " ").trim(), 400)}` : "";
    return `${event.source ?? "integration"} · ${event.outcome}: ${title}${body}`;
  }
  return `Session “${title}” ${event.outcome}${detail}`;
}

/** How many wakes `events` (oldest first) would have caused under `pace`,
 *  replaying the same quiet-period and hourly-limit rules the service uses. */
export function simulateWakes(events: readonly AgentEvent[], pace: AgentPace): number {
  let state: PaceState | undefined;
  let wakes = 0;
  const drain = (until: number) => {
    for (let guard = 0; guard < 1_000; guard += 1) {
      const result = settlePace(state, pace, until);
      if (result.kind === "fire") { state = result.state; wakes += 1; continue; }
      if (result.kind === "wait" || result.kind === "limited") {
        if (result.until > until) return;
        // Advance to the moment the rule releases and try again.
        const next = settlePace(state, pace, result.until);
        if (next.kind !== "fire") return;
        state = next.state;
        wakes += 1;
        continue;
      }
      return;
    }
  };
  for (const event of events) {
    drain(event.at);
    state = offerEvent(state, event, pace, event.at);
  }
  drain(Infinity);
  return wakes;
}
