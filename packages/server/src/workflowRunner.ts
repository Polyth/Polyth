import type { JsonObject, SessionEvent, SessionService } from "@polyth/contracts";
import type { RunNodeFn, WorkflowNodeUpdate } from "@polyth/workflow";

const abortError = (): Error => {
  const error = new Error("workflow run stopped");
  error.name = "AbortError";
  return error;
};

const wait = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener("abort", stopped);
      resolve();
    }
    function stopped() {
      clearTimeout(timer);
      signal.removeEventListener("abort", stopped);
      reject(abortError());
    }
    signal.addEventListener("abort", stopped, { once: true });
  });

function eventString(event: SessionEvent, key: string): string | undefined {
  const value = (event.data as JsonObject)[key];
  return typeof value === "string" ? value : undefined;
}

/** Runs a workflow node through the canonical session service so every node
 * remains visible, permission-aware, abortable, and durably logged. */
export function createWorkflowRunNode(sessions: SessionService): RunNodeFn {
  return async (context, onUpdate) => {
    if (context.signal.aborted) throw abortError();
    const { id: sessionId } = await sessions.create({
      projectId: context.projectId,
      parentId: context.parentSessionId,
      title: `${context.node.role} · workflow ${context.runId.slice(0, 8)}`,
      ...(context.node.model ? { model: context.node.model } : {}),
      ...(context.node.agent ? { agent: context.node.agent } : {}),
    });
    await onUpdate({ sessionId, activity: "configuring permissions" });

    if (!sessions.autoAcceptSet) {
      if (context.permissions === "auto") {
        throw Object.assign(new Error("workflow auto-permission policy is unavailable"), { code: "unsupported" });
      }
    } else {
      await sessions.autoAcceptSet(sessionId, context.permissions === "auto" ? "on" : "off");
    }

    const stop = () => { void sessions.abort(sessionId).catch(() => {}); };
    context.signal.addEventListener("abort", stop, { once: true });
    try {
      await onUpdate({ activity: "queued" });
      await sessions.send(sessionId, { text: context.prompt });

      const deadline = Date.now() + context.timeoutMs;
      const parts = new Map<string, string>();
      let afterSeq = 0;
      while (true) {
        if (context.signal.aborted) throw abortError();
        if (Date.now() >= deadline) {
          await sessions.abort(sessionId).catch(() => {});
          throw new Error(`workflow node timed out after ${context.timeoutMs}ms`);
        }

        const events = await sessions.events(sessionId, afterSeq);
        for (const event of events) {
          afterSeq = Math.max(afterSeq, event.seq);
          const update = await progressFromEvent(event, parts);
          if (update) await onUpdate(update);
          if (event.type === "turn/stopped") {
            const reason = eventString(event, "reason");
            if (reason === "error") throw new Error(eventString(event, "error") ?? "workflow node failed");
            if (reason === "aborted") throw abortError();
            return { sessionId, output: [...parts.values()].filter(Boolean).join("\n\n").trim() };
          }
        }
        await wait(Math.min(100, Math.max(1, deadline - Date.now())), context.signal);
      }
    } finally {
      context.signal.removeEventListener("abort", stop);
    }
  };
}

async function progressFromEvent(
  event: SessionEvent,
  parts: Map<string, string>,
): Promise<WorkflowNodeUpdate | null> {
  if (event.type === "turn/started") return { activity: "thinking" };
  if (event.type === "tool/call") return { activity: `tool: ${eventString(event, "tool") ?? "unknown"}` };
  if (event.type === "tool/result" || event.type === "tool/error") return { activity: "thinking" };
  if (event.type === "permission/requested") {
    return { activity: `awaiting permission: ${eventString(event, "permission") ?? "tool"}` };
  }
  if (event.type === "permission/resolved") return { activity: "thinking" };
  if (event.type === "question/asked" || event.type === "secret/requested") {
    return { activity: "awaiting answer" };
  }
  if (event.type === "assistant/chunk") {
    const partId = eventString(event, "partId") ?? event.id;
    parts.set(partId, (parts.get(partId) ?? "") + (eventString(event, "text") ?? ""));
    return { activity: "writing", output: [...parts.values()].join("\n\n") };
  }
  if (event.type === "assistant/message") {
    const partId = eventString(event, "partId") ?? event.id;
    parts.set(partId, eventString(event, "text") ?? "");
    return { activity: "writing", output: [...parts.values()].join("\n\n") };
  }
  return null;
}
