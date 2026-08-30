// One-shot cheap-model completion used by automations that must NOT pollute a
// user session: goal auditing, commit messages, summaries (OC-03-007 "Small
// Model"). It runs on a throwaway backend session and is never written to the
// canonical log — nothing here is model-visible for the user's conversation.
import { randomUUID } from "node:crypto";
import type { AgentRuntime, ModelRef, RuntimeEvent } from "@polyth/contracts";
import {
  executeDurableRuntimeMutation,
  type RuntimeMutationStore,
} from "@polyth/session";

export interface OneShotOptions {
  cwd: string;
  prompt: string;
  model?: ModelRef;
  agent?: string;
  timeoutMs?: number;
  /** Stable logical task identity. Retrying with the same value observes the
   * original durable mutation states and never replays an unknown operation. */
  taskId?: string;
}

/** Monotonic ordinal so repeated reconciles of the same canonical oneshot
 * session (stable-taskId retries) never trip the runtime's stale check. */
let reconciliationOrdinal = 0;

export async function oneShot(
  rt: AgentRuntime,
  opts: OneShotOptions,
  store: RuntimeMutationStore,
  taskId = opts.taskId ?? randomUUID(),
): Promise<string> {
  const sessionId = `oneshot-${taskId}`;
  const session = {
    sessionId,
    cwd: opts.cwd,
    projectId: "oneshot",
    title: "polyth small-model task",
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.agent ? { agent: opts.agent } : {}),
  };
  const created = await executeDurableRuntimeMutation({
    store,
    sessionId,
    mutationKind: "session-create",
    intentEvent: {
      type: "runtime-task/create-intended",
      data: { task: "oneshot" },
      ignorable: true,
    },
    call: (operationId) => rt.createSessionOperation
      ? rt.createSessionOperation(session, operationId)
      : Promise.resolve({
          kind: "unknown",
          operationId,
          message: "runtime lacks operation-aware session creation",
        }),
    receipt: (value) => value.backendSessionId,
    recoverConfirmed: (operation) => operation.receipt
      ? { backendSessionId: operation.receipt }
      : undefined,
  });
  if (created.kind !== "confirmed") {
    throw Object.assign(new Error(created.message), {
      code: created.kind === "unknown" ? "outcome-unknown" : created.code,
      ...(created.kind === "unknown" ? { operationId: created.operationId } : {}),
    });
  }

  // Real runtimes deliver SSE events through the observation seam, gated per
  // session by a reconciliation barrier: events for a session that was never
  // reconciled are dropped, so the turn finishes on the backend and this
  // promise would only ever settle via the timeout. Open the barrier exactly
  // like the session service does for canonical sessions. Fakes without the
  // reliability seams keep the old onEvent-only behavior.
  //
  // A freshly created backend session can take a beat to become queryable, so
  // reconcile is retried briefly. If it still fails on an observation-only
  // runtime the turn can never be seen — the promise below rejects at once with
  // this reason instead of hanging until the timeout.
  let barrierError: Error | undefined;
  if (created.receipt && rt.endpoint && rt.reconcile) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const endpoint = await rt.endpoint();
        await rt.reconcile({
          canonicalSessionId: sessionId,
          backendSessionId: created.receipt,
          authorityId: endpoint.authorityId,
          generation: endpoint.generation,
          continuity: endpoint.continuity,
          location: endpoint.location,
          reconciliationOrdinal: ++reconciliationOrdinal,
        });
        barrierError = undefined;
        break;
      } catch (error) {
        barrierError = error instanceof Error ? error : new Error(String(error));
        if (attempt < 3) await new Promise((r) => setTimeout(r, 250 * attempt));
      }
    }
    if (barrierError) {
      console.warn(`[polyth] oneshot reconcile failed for ${sessionId}`, barrierError);
    }
  }

  // Observation-only runtime whose barrier never opened: the turn would run on
  // the backend unseen and this call would only settle at the timeout. Reject
  // now with the real cause and do not submit (burning) a turn we cannot read.
  if (barrierError && rt.onObservation) {
    throw Object.assign(
      new Error(`small-model task could not start: ${barrierError.message}`),
      { code: "reconcile-failed" },
    );
  }

  return await new Promise<string>((resolve, reject) => {
    const parts = new Map<string, string>();
    let settled = false;
    let admitted = false;
    let stopped: Extract<Parameters<Parameters<AgentRuntime["onEvent"]>[0]>[1], {
      type: "turn/stopped";
    }> | undefined;
    // Safety valve only: with the barrier open above, a completed turn is
    // observed within seconds. Callers override via opts.timeoutMs.
    const timeoutMs = opts.timeoutMs ?? 90_000;
    const timer = setTimeout(
      () => finish(new Error(`small-model task timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );

    const handleEvent = (sid: string, ev: RuntimeEvent): void => {
      if (sid !== sessionId || settled) return;
      if (ev.type === "assistant/message") parts.set(ev.partId, ev.text);
      else if (ev.type === "turn/stopped") {
        stopped = ev;
        if (admitted) finishStopped();
      }
    };
    const sub = rt.onEvent(handleEvent);
    const subObservation = rt.onObservation
      ? rt.onObservation((sid, observation) => {
        for (const ev of observation.events) handleEvent(sid, ev);
      })
      : undefined;

    function finishStopped() {
      if (!stopped) return;
      if (stopped.reason === "error") finish(new Error(stopped.error ?? "small-model task failed"));
      else if (stopped.reason === "aborted") finish(new Error("small-model task was aborted"));
      else finish(null);
    }

    function finish(err: Error | null) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sub.dispose();
      subObservation?.dispose();
      if (err) reject(err);
      else resolve([...parts.values()].join("\n").trim());
    }

    void executeDurableRuntimeMutation({
      store,
      sessionId,
      mutationKind: "turn-submit",
      intentEvent: {
        type: "runtime-task/turn-intended",
        data: { task: "oneshot" },
        ignorable: true,
      },
      call: (operationId) => rt.startTurnOperation
        ? rt.startTurnOperation({
            sessionId,
            text: opts.prompt,
            ...(opts.model ? { model: opts.model } : {}),
            ...(opts.agent ? { agent: opts.agent } : {}),
          }, operationId)
        : Promise.resolve({
            kind: "unknown",
            operationId,
            message: "runtime lacks operation-aware turn submission",
          }),
    }).then((outcome) => {
      if (outcome.kind !== "confirmed") {
        finish(Object.assign(new Error(outcome.message), {
          code: outcome.kind === "unknown" ? "outcome-unknown" : outcome.code,
          ...(outcome.kind === "unknown" ? { operationId: outcome.operationId } : {}),
        }));
        return;
      }
      admitted = true;
      finishStopped();
    }).catch((error: unknown) => {
      finish(error instanceof Error ? error : new Error(String(error)));
    });
  });
}
