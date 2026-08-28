// Executes one multirun run to completion on a throwaway backend session,
// reporting streamed output + final tokens/cost via onUpdate. Same shape as
// oneshot.ts but progressive instead of resolve-once, because the multirun
// service needs to show per-run output as it streams in.
import type { AgentRuntime, ModelRef } from "@polyth/contracts";
import {
  executeDurableRuntimeMutation,
  type RuntimeMutationStore,
} from "@polyth/session";
import type { RunOneFn, RunUpdate } from "./index.ts";

export interface MultirunRunnerOptions {
  timeoutMs?: number;
  store: RuntimeMutationStore;
}

export function createMultirunRunOne(
  resolve: (sessionId: string) => Promise<{ rt: AgentRuntime; cwd: string; model?: ModelRef; agent?: string }>,
  opts: MultirunRunnerOptions,
): RunOneFn {
  return async (ctx, onUpdate: (patch: RunUpdate) => void) => {
    const { rt, cwd, model: sessionModel, agent: sessionAgent } = await resolve(ctx.sessionId);
    const backendSessionId = `multirun-${ctx.runId}`;
    const model = ctx.model ?? sessionModel;
    const agent = ctx.agent ?? sessionAgent;
    const session = {
      sessionId: backendSessionId, cwd,
      projectId: "multirun", title: "polyth multirun",
      ...(model ? { model } : {}), ...(agent ? { agent } : {}),
    };
    const created = await executeDurableRuntimeMutation({
      store: opts.store,
      sessionId: backendSessionId,
      mutationKind: "session-create",
      intentEvent: {
        type: "runtime-task/create-intended",
        data: { task: "multirun", multirunId: ctx.multirunId, runId: ctx.runId },
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

    await new Promise<void>((res, rej) => {
      let settled = false;
      let admitted = false;
      let stopped: Extract<Parameters<Parameters<AgentRuntime["onEvent"]>[0]>[1], {
        type: "turn/stopped";
      }> | undefined;
      let output = "";
      const timer = setTimeout(() => finish(new Error("multirun run timed out")), opts.timeoutMs ?? 180_000);

      const sub = rt.onEvent((sid, ev) => {
        if (sid !== backendSessionId || settled) return;
        if (ev.type === "assistant/chunk") {
          output += ev.text;
          onUpdate({ output });
        } else if (ev.type === "assistant/message" && ev.text) {
          output = ev.text;
          onUpdate({ output, tokens: ev.tokens, cost: ev.cost });
        } else if (ev.type === "usage/recorded") {
          onUpdate({ tokens: ev.tokens, cost: ev.cost });
        } else if (ev.type === "turn/stopped") {
          stopped = ev;
          if (admitted) finishStopped();
        }
      });

      function finishStopped() {
        if (!stopped) return;
        if (stopped.reason === "error") finish(new Error(stopped.error ?? "multirun run failed"));
        else if (stopped.reason === "aborted") finish(new Error("run aborted"));
        else finish(null);
      }

      function finish(err: Error | null) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sub.dispose();
        if (err) rej(err);
        else res();
      }

      void executeDurableRuntimeMutation({
        store: opts.store,
        sessionId: backendSessionId,
        mutationKind: "turn-submit",
        intentEvent: {
          type: "runtime-task/turn-intended",
          data: { task: "multirun", multirunId: ctx.multirunId, runId: ctx.runId },
          ignorable: true,
        },
        call: (operationId) => rt.startTurnOperation
          ? rt.startTurnOperation({
              sessionId: backendSessionId, text: ctx.prompt,
              ...(model ? { model } : {}), ...(agent ? { agent } : {}),
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
  };
}
