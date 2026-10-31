// Follows one admitted planner run through the target session's canonical
// event log until its turn really stops. Only events after the run's own
// `planner/run-started` marker count; nothing here sends, retries or replays.
import type { JsonObject, SessionEvent } from "@polyth/contracts";
import type { PlannerRunRecord, PlannerRunSettlement } from "./model.ts";

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
}

const DEFAULT_MAX_RUN_MS = 24 * 60 * 60_000;

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

export async function settlePlannedRun(
  run: Pick<PlannerRunRecord, "sessionId" | "markerSeq" | "queueId" | "startedAt">,
  opts: RunSettlementOptions,
): Promise<PlannerRunSettlement> {
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
  let phase: "queued" | "admitted" | "turn" = run.queueId ? "queued" : "admitted";
  let cursor = run.markerSeq;
  let poll = minPoll;
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
      if (phase === "queued") {
        if (event.type === "queue/dispatched" && str(event, "queueId") === run.queueId) phase = "admitted";
        else if (event.type === "queue/removed" && str(event, "queueId") === run.queueId) {
          return { status: "unknown", error: "The queued run was removed or sent separately; its result is not tracked." };
        }
        continue;
      }
      if (event.type === "turn/started") {
        phase = "turn";
        continue;
      }
      if (event.type !== "turn/stopped") continue;
      const reason = str(event, "reason");
      if (reason === "completed") return { status: "ok" };
      if (reason === "error" && resumable(event)) {
        phase = "admitted";
        continue;
      }
      if (reason === "error") return { status: "failed", error: str(event, "error") ?? "The run's turn failed." };
      if (reason === "aborted") return { status: "failed", error: "Stopped before it finished." };
      return { status: "unknown", error: `The run's turn stopped without a confirmed result (${reason ?? "no reason"}).` };
    }
    poll = events.length ? minPoll : Math.min(maxPoll, Math.round(poll * 1.5));
    if (now() >= deadline) {
      return { status: "unknown", error: "No result was confirmed within the observation limit." };
    }
    await sleep(Math.min(poll, Math.max(1, deadline - now())), opts.signal);
  }
}
