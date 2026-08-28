// One-shot cheap-model completion used by automations that must NOT pollute a
// user session: goal auditing, commit messages, summaries (OC-03-007 "Small
// Model"). It runs on a throwaway backend session and is never written to the
// canonical log — nothing here is model-visible for the user's conversation.
import { randomUUID } from "node:crypto";
import type { AgentRuntime, ModelRef } from "@polyth/contracts";
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

  return await new Promise<string>((resolve, reject) => {
    const parts = new Map<string, string>();
    let settled = false;
    let admitted = false;
    let stopped: Extract<Parameters<Parameters<AgentRuntime["onEvent"]>[0]>[1], {
      type: "turn/stopped";
    }> | undefined;
    const timer = setTimeout(() => finish(new Error("small-model task timed out")), opts.timeoutMs ?? 90_000);

    const sub = rt.onEvent((sid, ev) => {
      if (sid !== sessionId || settled) return;
      if (ev.type === "assistant/message") parts.set(ev.partId, ev.text);
      else if (ev.type === "turn/stopped") {
        stopped = ev;
        if (admitted) finishStopped();
      }
    });

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
