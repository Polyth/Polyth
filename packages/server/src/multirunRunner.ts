// Executes one multirun run to completion on a throwaway backend session,
// reporting streamed output + final tokens/cost via onUpdate. Same shape as
// oneshot.ts but progressive instead of resolve-once, because the multirun
// service needs to show per-run output as it streams in.
import type { AgentRuntime, ModelRef } from "@polyth/contracts";
import type { RunOneFn, RunUpdate } from "@polyth/multirun";

export interface MultirunRunnerOptions {
  timeoutMs?: number;
}

export function createMultirunRunOne(
  resolve: (sessionId: string) => Promise<{ rt: AgentRuntime; cwd: string; model?: ModelRef; agent?: string }>,
  opts: MultirunRunnerOptions = {},
): RunOneFn {
  return async (ctx, onUpdate: (patch: RunUpdate) => void) => {
    const { rt, cwd, model: sessionModel, agent: sessionAgent } = await resolve(ctx.sessionId);
    const backendSessionId = `multirun-${ctx.runId}`;
    const model = ctx.model ?? sessionModel;
    const agent = ctx.agent ?? sessionAgent;
    await rt.ensureSession({
      sessionId: backendSessionId, cwd,
      projectId: "multirun", title: "polyth multirun",
      ...(model ? { model } : {}), ...(agent ? { agent } : {}),
    });

    await new Promise<void>((res, rej) => {
      let settled = false;
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
          if (ev.reason === "error") finish(new Error(ev.error ?? "multirun run failed"));
          else if (ev.reason === "aborted") finish(new Error("run aborted"));
          else finish(null);
        }
      });

      function finish(err: Error | null) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sub.dispose();
        if (err) rej(err);
        else res();
      }

      rt.startTurn({
        sessionId: backendSessionId, text: ctx.prompt,
        ...(model ? { model } : {}), ...(agent ? { agent } : {}),
      }).catch((err: unknown) => finish(err instanceof Error ? err : new Error(String(err))));
    });
  };
}
