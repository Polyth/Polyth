// Follows one admitted planner run through the target session's canonical
// event log until its turn really stops. Only events after the run's own
// `schedule/run-started` marker count; nothing here sends, retries or replays.
//
// A turn that ends while background work it started still runs (a command
// or agent started in the background, a monitor) is not the run's end when
// its last message carries no `Report:` line: the agent said it waits. The
// run then waits, bounded, for that work to wake the agent (a hidden user
// message), and the turns it wakes are the run's too. Its report is the
// final message of the last of them.
import type { JsonObject, SessionEvent, TokenUsage } from "@polyth/contracts";
import { parseAgentReport } from "./agentReport.ts";
import type {
  AgentBackgroundWait, AgentRunActivity, AgentRunMoment, AgentWaitingRequest, ScheduleRunRecord, ScheduleRunSettlement,
} from "./index.ts";

export interface RunSettlementOptions {
  /** Canonical events of `sessionId` with seq > afterSeq, oldest first. */
  events(sessionId: string, afterSeq: number): Promise<SessionEvent[]>;
  signal: AbortSignal;
  now?: () => number;
  /** Observation limit measured from the run's start. */
  maxRunMs?: number;
  minPollMs?: number;
  maxPollMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Called whenever the set of requests waiting for a person changes. */
  onWaiting?: (waiting: AgentWaitingRequest[]) => void;
  /** A request open this long gets `onApprovalTimeout`, once. */
  approvalTimeoutMs?: number;
  onApprovalTimeout?: (request: AgentWaitingRequest) => Promise<void>;
  /** Route the run is on: 0 = main, n = nth backup. */
  backup?: number;
  /** The turn stopped because its route failed (provider refused the model,
   *  sign-in expired, rate limit, quota, overload). Move the run to route
   *  `next`; resolve true when the prompt was sent there, false when there
   *  is nowhere to go. */
  onRouteFailure?: (next: number) => Promise<boolean>;
  /** The run's turn took a step: its newest one, and how many distinct tool
   *  calls it made so far. Only the run's own turn counts. */
  onActivity?: (activity: AgentRunActivity, steps: number) => void;
  /** The run waits for its background work to wake the agent; `null` once
   *  it is woken. */
  onBackground?: (wait: AgentBackgroundWait | null) => void;
  /** How long a run waits for its background work; 0 never waits. */
  backgroundWaitMs?: number;
  /** The person asked to stop the run. A waiting run has no turn to abort,
   *  so it ends here. */
  stopRequested?: () => boolean;
}

/** A run that waits for background work: long enough for a CI run, short
 *  enough that work lost with its process does not keep it "working". */
const DEFAULT_BACKGROUND_WAIT_MS = 60 * 60_000;
const WAITING_POLL_MS = 5_000;
const MOMENTS_KEPT = 20;
const MOMENT_CHARS = 160;
const WAIT_TASKS = 3;

const TOOL_INPUT_KEYS = 8;
const TOOL_INPUT_CHARS = 240;
const LINE_CHARS = 200;
/** Streamed text kept per part, enough to find its newest line. */
const STREAM_TAIL = 2_000;

const clipText = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
};

/** The newest non-empty line of `text`, bounded. */
const newestLine = (text: string): string | undefined => {
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    if (line) return clipText(line, LINE_CHARS);
  }
  return undefined;
};

/** The first line of a message, as plain words. */
const firstLine = (text: string): string | undefined => {
  for (const line of text.split("\n")) {
    const plain = clipText(line.replace(/^\s*(#+|[-*+]|\d+[.)]|>)\s+/, "").replace(/[*_`]+/g, ""), MOMENT_CHARS);
    if (plain) return plain;
  }
  return undefined;
};

/** A tool call that leaves work running past the turn (a background command
 *  or agent, a monitor): its description, "" without one. Anything else:
 *  undefined. */
function backgroundLaunch(event: SessionEvent): string | undefined {
  if (event.type !== "tool/started" && !(event.type === "tool/call" && str(event, "status") !== "pending")) return undefined;
  const input = (event.data as JsonObject | undefined)?.input as JsonObject | undefined;
  if (input?.run_in_background !== true && str(event, "tool") !== "Monitor") return undefined;
  return typeof input?.description === "string" ? clipText(input.description, 120) : "";
}

/** A tool's input as the agent's page may show it: primitive values only,
 *  strings clipped, a handful of keys. Nested objects and lists are dropped. */
function boundedInput(raw: unknown): Record<string, string | number | boolean> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, string | number | boolean> = {};
  let kept = 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (kept >= TOOL_INPUT_KEYS) break;
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    let next: string | number | boolean | undefined;
    if (typeof value === "string") next = clipText(value, TOOL_INPUT_CHARS);
    else if (typeof value === "number" && Number.isFinite(value)) next = value;
    else if (typeof value === "boolean") next = value;
    if (next === undefined || next === "") continue;
    out[key.slice(0, 64)] = next;
    kept += 1;
  }
  return kept ? out : undefined;
}

/** Stops that blame the route, not the work: worth a backup model. */
const ROUTE_STOP_CODES = new Set(["rate-limited", "quota-exhausted", "overloaded", "auth-expired", "model-unavailable"]);
const ROUTE_RETRY_SCOPES = new Set(["rate", "quota", "overloaded"]);

const routeFailed = (event: SessionEvent): boolean => {
  const data = (event.data ?? {}) as JsonObject;
  const scope = (data.retry as { scope?: unknown } | undefined)?.scope;
  return (typeof data.code === "string" && ROUTE_STOP_CODES.has(data.code))
    || (typeof scope === "string" && ROUTE_RETRY_SCOPES.has(scope));
};

const REQUEST_OPENED: Record<string, AgentWaitingRequest["kind"]> = {
  "permission/requested": "permission",
  "question/asked": "question",
};
const REQUEST_CLOSED = new Set(["permission/resolved", "permission/expired", "question/answered", "question/expired"]);

function requestTitle(event: SessionEvent): string {
  const data = (event.data ?? {}) as JsonObject;
  if (event.type === "permission/requested") {
    const patterns = Array.isArray(data.patterns) ? data.patterns.filter((item) => typeof item === "string").slice(0, 3) : [];
    return [String(data.permission ?? data.tool ?? "permission"), ...patterns].join(" · ").slice(0, 200);
  }
  const first = Array.isArray(data.questions) ? data.questions[0] as JsonObject | undefined : undefined;
  return String(first?.question ?? first?.header ?? "question").slice(0, 200);
}

const DEFAULT_MAX_RUN_MS = 24 * 60 * 60_000;
const OPEN_REQUEST_POLL_MS = 2_000;

const str = (event: SessionEvent, key: string): string | undefined => {
  const value = (event.data as JsonObject | undefined)?.[key];
  return typeof value === "string" ? value : undefined;
};

/** A provider limit stop with a persisted resume plan is not the end: the
 *  session owner resumes the same turn later. */
const resumable = (event: SessionEvent): boolean => {
  const retry = (event.data as JsonObject | undefined)?.retry as { resumeAt?: unknown; retryable?: unknown } | undefined;
  return !!retry && retry.retryable !== false
    && typeof retry.resumeAt === "number" && Number.isFinite(retry.resumeAt) && retry.resumeAt > 0;
};

const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : 0;

function addUsage(total: TokenUsage | undefined, sample: Partial<TokenUsage>): TokenUsage {
  const next: TokenUsage = {
    input: (total?.input ?? 0) + count(sample.input),
    output: (total?.output ?? 0) + count(sample.output),
  };
  for (const key of ["reasoning", "cacheRead", "cacheWrite"] as const) {
    if (total?.[key] !== undefined || sample[key] !== undefined) next[key] = (total?.[key] ?? 0) + count(sample[key]);
  }
  return next;
}

const abortError = (): Error => Object.assign(new Error("settlement observation detached"), { name: "AbortError" });

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

export async function settleScheduledRun(
  run: Pick<ScheduleRunRecord, "sessionId" | "markerSeq" | "queueId" | "startedAt">,
  opts: RunSettlementOptions,
): Promise<ScheduleRunSettlement> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const deadline = run.startedAt + (opts.maxRunMs ?? DEFAULT_MAX_RUN_MS);
  const minPoll = opts.minPollMs ?? 1_000;
  const maxPoll = opts.maxPollMs ?? 15_000;
  const sessionId = run.sessionId;
  if (!sessionId || run.markerSeq === undefined) {
    return { status: "unknown", error: "The run has no admission record to follow." };
  }
  // queued → (dispatched) → admitted → (turn/started) → turn → (turn/stopped)
  // → waiting (background work runs) → (its wake) → admitted → …
  let phase: "queued" | "admitted" | "turn" | "waiting" = run.queueId ? "queued" : "admitted";
  const waitMs = opts.backgroundWaitMs ?? DEFAULT_BACKGROUND_WAIT_MS;
  // Background work the run started (call id → description), and the wakes
  // it has had so far.
  const launched = new Map<string, string>();
  let woken = 0;
  let waitSince = 0;
  // The turn's newest words: whether they carry a Report line.
  let turnText = "";
  // How the run went: the agent's passing lines and its waits.
  const moments: Array<AgentRunMoment & { seq?: number }> = [];
  let summarySeq: number | undefined;
  let cursor = run.markerSeq;
  let poll = minPoll;
  const open = new Map<string, AgentWaitingRequest>();
  const handled = new Set<string>();
  const report = () => opts.onWaiting?.([...open.values()]);
  // Journal material: the run's last answer and its summed usage.
  let summary: string | undefined;
  let tokens: TokenUsage | undefined;
  let cost: number | undefined;
  let backup = opts.backup ?? 0;
  const startedOn = backup;
  // Live activity: distinct tool calls, the newest step, the streamed part.
  // A step keeps its id (the tool call or message part) and the time it
  // began while its words grow, so the page animates only a new step.
  const steps = new Set<string>();
  let latest: AgentRunActivity | undefined;
  let latestKey = "";
  let reportedSteps = 0;
  let stream: { part: string; kind: "text" | "thinking"; text: string; id: string } | undefined;
  let unnamed = 0;
  const began = new Map<string, number>();
  const step = (id: string | undefined, at: number): { id: string; at: number } => {
    const key = id || `step-${++unnamed}`;
    if (!began.has(key)) began.set(key, at);
    return { id: key, at: began.get(key)! };
  };
  const noteActivity = (event: SessionEvent): void => {
    const at = typeof event.time === "number" && Number.isFinite(event.time) ? event.time : now();
    const callId = str(event, "callId");
    if (callId && event.type.startsWith("tool/")) steps.add(callId);
    let next: AgentRunActivity | undefined;
    if (event.type === "tool/started" || (event.type === "tool/call" && str(event, "status") !== "pending")) {
      stream = undefined;
      const input = boundedInput((event.data as JsonObject | undefined)?.input);
      next = { kind: "tool", ...step(callId, at), tool: clipText(str(event, "tool") ?? "tool", 80), ...(input ? { input } : {}) };
    } else if (event.type === "assistant/chunk" || event.type === "assistant/reasoning-chunk") {
      const kind = event.type === "assistant/chunk" ? "text" : "thinking";
      const part = str(event, "partId") ?? "";
      if (stream?.part !== part || stream.kind !== kind) stream = { part, kind, text: "", id: step(part, at).id };
      stream.text = (stream.text + (str(event, "text") ?? "")).slice(-STREAM_TAIL);
      const text = newestLine(stream.text);
      if (text) next = { kind, ...step(stream.id, at), text };
    } else if (event.type === "assistant/message") {
      // The message that ends a streamed part is that same step.
      const part = str(event, "partId") || (stream?.kind === "text" ? stream.id : undefined);
      stream = undefined;
      const text = newestLine(str(event, "text") ?? "");
      if (text) next = { kind: "text", ...step(part, at), text };
    }
    let changed = false;
    if (next) {
      const key = JSON.stringify([next.id, next.kind, next.tool ?? null, next.input ?? null, next.text ?? null]);
      if (key !== latestKey) {
        latestKey = key;
        latest = next;
        changed = true;
      }
    }
    if (latest && (changed || steps.size !== reportedSteps)) {
      reportedSteps = steps.size;
      opts.onActivity!(latest, steps.size);
    }
  };
  const result = (settled: ScheduleRunSettlement): ScheduleRunSettlement => {
    // The final message is the report itself, not a step on the way.
    const timeline = moments
      .filter((moment) => moment.seq === undefined || moment.seq !== summarySeq)
      .slice(-MOMENTS_KEPT)
      .map(({ seq: _seq, ...moment }) => moment);
    return {
      ...settled,
      ...(backup !== startedOn ? { backup } : {}),
      ...(summary ? { summary } : {}),
      ...(tokens ? { tokens } : {}),
      ...(cost !== undefined ? { cost } : {}),
      ...(timeline.length ? { timeline } : {}),
    };
  };
  const eventTime = (event: SessionEvent): number =>
    typeof event.time === "number" && Number.isFinite(event.time) ? event.time : now();
  /** What the run still waits on: the newest launches not yet followed by a wake. */
  const waitingOn = (): string[] => {
    const open = [...launched.values()].slice(-(launched.size - woken));
    return [...new Set(open.filter(Boolean))].slice(-WAIT_TASKS);
  };
  while (true) {
    if (opts.signal.aborted) throw abortError();
    let events: SessionEvent[];
    try {
      events = await opts.events(sessionId, cursor);
    } catch (error) {
      if ((error as { code?: unknown })?.code === "not-found") {
        return { status: "unknown", error: "The run's session no longer exists." };
      }
      throw error;
    }
    for (const event of events) {
      cursor = Math.max(cursor, event.seq);
      const requestId = str(event, "requestId");
      if (requestId && REQUEST_OPENED[event.type]) {
        open.set(requestId, { requestId, kind: REQUEST_OPENED[event.type]!, title: requestTitle(event), since: event.time ?? now() });
        report();
      } else if (requestId && REQUEST_CLOSED.has(event.type) && open.delete(requestId)) {
        report();
      }
      if (phase === "waiting") {
        if (event.type === "user/message" && (event.data as JsonObject | undefined)?.hiddenUserMessage === true) {
          // Server work, no person: the background work woke the agent.
          // A monitor may wake it more than once for one launch.
          woken = Math.min(woken + 1, launched.size);
          phase = "admitted";
          const wait = moments.findLast((moment) => moment.kind === "wait");
          if (wait) wait.until = eventTime(event);
          opts.onBackground?.(null);
          continue;
        }
        if (event.type === "user/message" || event.type === "turn/started" || event.type === "schedule/run-started") {
          // The session went on with other work: the run ended with its last turn.
          return result({ status: "ok" });
        }
        continue;
      }
      if (phase === "queued") {
        if (event.type === "queue/dispatched" && str(event, "queueId") === run.queueId) phase = "admitted";
        else if (event.type === "queue/removed" && str(event, "queueId") === run.queueId) {
          return { status: "unknown", error: "The queued run was removed or sent separately; its result is not tracked." };
        }
        continue;
      }
      if (event.type === "turn/started") {
        phase = "turn";
        turnText = "";
        continue;
      }
      if (phase === "turn" && opts.onActivity) noteActivity(event);
      if (phase === "turn") {
        const launch = backgroundLaunch(event);
        const callId = str(event, "callId");
        if (launch !== undefined && callId) launched.set(callId, launch || launched.get(callId) || "");
      }
      if (phase === "turn" && event.type === "assistant/message") {
        const text = str(event, "text")?.trim();
        if (text) {
          summary = text;
          summarySeq = event.seq;
          turnText = text;
          const line = firstLine(text);
          if (line) moments.push({ at: eventTime(event), text: line, seq: event.seq });
        }
        continue;
      }
      if (phase === "turn" && event.type === "usage/recorded") {
        // Adapters may report a turn as several samples; the run's figure is their sum.
        const data = event.data as JsonObject;
        const sample = data.tokens as Partial<TokenUsage> | undefined;
        if (sample && typeof sample === "object") tokens = addUsage(tokens, sample);
        if (typeof data.cost === "number" && Number.isFinite(data.cost)) cost = (cost ?? 0) + data.cost;
        continue;
      }
      if (event.type !== "turn/stopped") continue;
      const reason = str(event, "reason");
      if (reason === "completed" && phase === "turn" && waitMs > 0 && launched.size > woken
        && !parseAgentReport(turnText).signal) {
        // No report yet, and work it started still runs: it waits for that.
        phase = "waiting";
        waitSince = eventTime(event);
        const tasks = waitingOn();
        moments.push({ at: waitSince, text: tasks.join(" · "), kind: "wait" });
        opts.onBackground?.({ since: waitSince, tasks });
        continue;
      }
      if (reason === "completed") return result({ status: "ok" });
      if (reason === "error" && opts.onRouteFailure && routeFailed(event)) {
        const moved = await opts.onRouteFailure(backup + 1).catch(() => false);
        if (moved) {
          backup += 1;
          phase = "admitted";
          continue;
        }
      }
      if (reason === "error" && resumable(event)) {
        phase = "admitted";
        continue;
      }
      if (reason === "error") return result({ status: "failed", error: str(event, "error") ?? "The run's turn failed." });
      if (reason === "aborted") return result({ status: "failed", error: "Stopped before it finished." });
      return result({ status: "unknown", error: `The run's turn stopped without a confirmed result (${reason ?? "no reason"}).` });
    }
    if (opts.approvalTimeoutMs !== undefined && opts.onApprovalTimeout) {
      for (const request of open.values()) {
        if (handled.has(request.requestId) || now() - request.since < opts.approvalTimeoutMs) continue;
        handled.add(request.requestId);
        await opts.onApprovalTimeout(request).catch(() => {});
      }
    }
    if (phase === "waiting") {
      if (opts.stopRequested?.()) return result({ status: "failed", error: "Stopped before it finished." });
      // Work lost with its process never wakes anyone: the run ends with
      // what its last turn said.
      // Only once caught up: a later page may hold the wake.
      if (!events.length && now() - waitSince >= waitMs) return result({ status: "ok" });
    }
    // A person's decision should reach the agent's page soon after the click;
    // a stop of a waiting run, too.
    const pollLimit = open.size ? Math.min(maxPoll, OPEN_REQUEST_POLL_MS)
      : phase === "waiting" ? Math.min(maxPoll, WAITING_POLL_MS) : maxPoll;
    poll = events.length ? minPoll : Math.min(pollLimit, Math.round(poll * 1.5));
    if (now() >= deadline) {
      return { status: "unknown", error: "No result was confirmed within the observation limit." };
    }
    const until = phase === "waiting" ? Math.min(deadline, waitSince + waitMs) : deadline;
    await sleep(Math.min(poll, Math.max(1, until - now())), opts.signal);
  }
}
