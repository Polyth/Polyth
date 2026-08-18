// One-shot cheap-model completion used by automations that must NOT pollute a
// user session: goal auditing, commit messages, summaries (OC-03-007 "Small
// Model"). It runs on a throwaway backend session and is never written to the
// canonical log — nothing here is model-visible for the user's conversation.
import { randomUUID } from "node:crypto";
import type { AgentRuntime, ModelRef } from "@polyth/contracts";

export interface OneShotOptions {
  cwd: string;
  prompt: string;
  model?: ModelRef;
  agent?: string;
  timeoutMs?: number;
}

export async function oneShot(rt: AgentRuntime, opts: OneShotOptions): Promise<string> {
  const sessionId = `oneshot-${randomUUID()}`;
  await rt.ensureSession({
    sessionId,
    cwd: opts.cwd,
    projectId: "oneshot",
    title: "polyth small-model task",
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.agent ? { agent: opts.agent } : {}),
  });

  return await new Promise<string>((resolve, reject) => {
    const parts = new Map<string, string>();
    let settled = false;
    const timer = setTimeout(() => finish(new Error("small-model task timed out")), opts.timeoutMs ?? 90_000);

    const sub = rt.onEvent((sid, ev) => {
      if (sid !== sessionId || settled) return;
      if (ev.type === "assistant/message") parts.set(ev.partId, ev.text);
      else if (ev.type === "turn/stopped") {
        if (ev.reason === "error") finish(new Error(ev.error ?? "small-model task failed"));
        else finish(null);
      }
    });

    function finish(err: Error | null) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sub.dispose();
      if (err) reject(err);
      else resolve([...parts.values()].join("\n").trim());
    }

    rt.startTurn({
      sessionId,
      text: opts.prompt,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.agent ? { agent: opts.agent } : {}),
    }).catch((err: unknown) => finish(err instanceof Error ? err : new Error(String(err))));
  });
}
