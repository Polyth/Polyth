import type {
  JsonObject,
  SessionEvent,
  SessionService,
} from "@polyth/contracts";
import type { RunNodeFn, WorkflowNodeUpdate } from "./index.ts";

const abortError = (): Error => {
  const error = new Error("workflow run stopped");
  error.name = "AbortError";
  return error;
};

type WorkflowFailurePhase = "pre-admission" | "send" | "runtime";

type WorkflowFailure = Error & {
  workflow?: {
    retryable: boolean;
    phase: WorkflowFailurePhase;
    sessionId?: string;
  };
};

const failure = (
  cause: unknown,
  retryable: boolean,
  phase: WorkflowFailurePhase,
  sessionId?: string
): WorkflowFailure => {
  const result = (cause instanceof Error ? cause : new Error(String(cause))) as WorkflowFailure;
  result.workflow = { retryable, phase, ...(sessionId ? { sessionId } : {}) };
  return result;
};

const explicitPreAdmissionProof = (cause: unknown): boolean => {
  const workflow = (cause as { workflow?: { retryable?: unknown; phase?: unknown } })
    ?.workflow;
  return workflow?.retryable === true && workflow.phase === "pre-admission";
};

const OUTPUT_LIMIT = 64_000;
const PART_LIMIT = 128;
const TRUNCATED_PART = "\u0000workflow-output-truncated";
const TRUNCATED_NOTE = "[Output shortened; open the child session for the full transcript.]";
const boundedResult = (text: string): string => text.length <= OUTPUT_LIMIT ? text
  : `${TRUNCATED_NOTE}\n\n${text.slice(-(OUTPUT_LIMIT - TRUNCATED_NOTE.length - 2))}`;
function collectOutput(parts: Map<string, string>, id: string, text: string, append: boolean): void {
  let truncated = parts.delete(TRUNCATED_PART);
  const previous = parts.get(id) ?? "";
  const limit = OUTPUT_LIMIT - TRUNCATED_NOTE.length - 2;
  const next = append ? previous + text.slice(-limit) : text.slice(-limit);
  if (text.length > limit || next.length > limit) truncated = true;
  // Keep recent output rather than allowing old progress to fill the buffer
  // before a chunk-only final report arrives.
  parts.delete(id);
  parts.set(id, next.slice(-limit));
  let used = [...parts.values()].reduce((total, value) => total + value.length + 2, 0);
  while (parts.size >= PART_LIMIT || used > limit) {
    const oldest = parts.keys().next().value!;
    if (oldest === id) break;
    used -= parts.get(oldest)!.length + 2;
    parts.delete(oldest);
    truncated = true;
  }
  if (truncated) parts.set(TRUNCATED_PART, TRUNCATED_NOTE);
}

// Reasoning-only and marker messages create empty parts. Joining them would
// put a blank paragraph between every real part of a node's output.
const joinParts = (parts: Map<string, string>): string =>
  [...parts.values()].filter((value) => value.trim()).join("\n\n");

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

const timeoutLabel = (ms: number): string => {
  if (ms % 60_000 === 0)
    return `${ms / 60_000} ${ms === 60_000 ? "minute" : "minutes"}`;
  if (ms % 1_000 === 0)
    return `${ms / 1_000} ${ms === 1_000 ? "second" : "seconds"}`;
  return `${ms}ms`;
};

function eventString(event: SessionEvent, key: string): string | undefined {
  const value = (event.data as JsonObject)[key];
  return typeof value === "string" ? value : undefined;
}

const isAssistantOutputEvent = (event: SessionEvent): boolean =>
  event.type === "assistant/chunk" || event.type === "assistant/message";

/** The child log records every permission request before its approval policy
 * answers it, so an open request alone is not a person's turn. The session
 * owner marks the child `waiting` only when the policy holds the request for a
 * person; a request still open after this grace is shown regardless. */
const PERSON_WAIT_GRACE_MS = 5_000;

/** Runs a workflow node through the canonical session service so every node
 * remains visible, permission-aware, abortable, and durably logged. */
export function createWorkflowRunNode(sessions: SessionService): RunNodeFn {
  return async (context, onUpdate) => {
    if (context.signal.aborted) throw abortError();
    // A rework continues in the unit's own child session. Everything already
    // in that log belongs to earlier turns; only events after this mark
    // describe the follow-up turn sent below.
    let resumed: { sessionId: string; afterSeq: number } | undefined;
    if (context.resumeSessionId) {
      try {
        const child = await sessions.snapshot(context.resumeSessionId);
        if (child && child.id === context.resumeSessionId) {
          const latest = await sessions.events(context.resumeSessionId, 0, { limit: 1 });
          resumed = {
            sessionId: context.resumeSessionId,
            afterSeq: latest.reduce((max, event) => Math.max(max, event.seq), 0),
          };
        }
      } catch {
        // The unit continues in a fresh child; its brief is repeated there.
      }
    }
    let sessionId: string;
    if (resumed) sessionId = resumed.sessionId;
    else try {
      ({ id: sessionId } = await sessions.create({
        projectId: context.projectId,
        parentId: context.parentSessionId,
        purpose: "workflow",
        title: context.node.role.trim(),
        ...(context.node.harness ? { harness: context.node.harness } : {}),
        ...(context.node.model ? { model: context.node.model } : {}),
        ...(context.node.agent ? { agent: context.node.agent } : {}),
      }));
    } catch (cause) {
      const failedSessionId = (cause as { sessionId?: unknown })?.sessionId;
      if (typeof failedSessionId === "string" && failedSessionId) {
        // The create boundary may have prepared a canonical row before the
        // runtime rejected or became uncertain. Preserve that identity when
        // possible, but never replace the original admission evidence with a
        // projection update failure.
        try {
          await onUpdate({ sessionId: failedSessionId });
        } catch {
          // The node projection can be reconciled from the fenced error.
        }
      }
      throw failure(
        cause,
        // Only an explicit typed rejection before canonical child admission
        // is retryable. A missing id or a thrown create error is not proof.
        explicitPreAdmissionProof(cause),
        "pre-admission",
        typeof failedSessionId === "string" ? failedSessionId : undefined
      );
    }
    let cancellation: Promise<void> | undefined;
    let sent = false;
    const clientOperationId = `workflow:${context.runId}:${context.node.id}:${context.attempt ?? 1}`;
    const stop = () => {
      cancellation ??= (async () => {
        // A capacity wait has no active turn to abort. Cancel its server-owned
        // timer too, so stopping the workflow cannot leave an orphan resend.
        await sessions.cancelResume?.(sessionId).catch(() => {});
        await sessions.abort(sessionId).catch(() => {});
      })();
    };
    context.signal.addEventListener("abort", stop, { once: true });
    try {
      if (context.signal.aborted) {
        stop();
        throw abortError();
      }
      await onUpdate({ sessionId, activity: "configuring permissions" });

      if (!sessions.autoAcceptSet) {
        if (context.permissions === "auto") {
          throw failure(
            Object.assign(
              new Error("workflow auto-permission policy is unavailable"),
              { code: "unsupported" }
            ),
            false,
            "pre-admission",
            sessionId
          );
        }
      } else {
        // A node inherits the launching chat's approval level, and follows it
        // when the chat changes it mid-run. "auto" only raises a chat that
        // asks for everything to routine Auto-Approve; it never lowers Full
        // access.
        const chatLevel = context.permissions === "auto"
          ? (await sessions.autoAcceptGet?.(context.parentSessionId).catch(() => undefined))?.level
          : undefined;
        await sessions.autoAcceptSet(
          sessionId,
          context.permissions === "auto" && chatLevel !== "all" ? "on" : "inherit"
        );
      }

      if (context.signal.aborted) throw abortError();
      await onUpdate({ activity: "starting agent" });
      if (context.signal.aborted) throw abortError();
      try {
        await sessions.send(sessionId, {
          text: context.prompt,
          clientOperationId,
          autoTitle: false,
          ...(context.context?.attachments?.length
            ? { attachments: context.context.attachments }
            : {}),
        });
        sent = true;
      } catch (cause) {
        // The canonical admission authority distinguishes a catalog refusal
        // from a lost response after a prepared/queued/confirmed mutation.
        // Never infer release from abort, timeout, or a missing child id.
        const admission = await sessions.clientMutationStatus?.(sessionId, clientOperationId).catch(() => undefined);
        const preflightCode = (cause as { code?: unknown })?.code;
        const catalogRefusal = ["invalid-model", "invalid-variant", "discovery-unavailable"].includes(String(preflightCode));
        const safeRejection = (admission?.state === "rejected" && admission.mutationKind === "turn-submit")
          || (admission?.state === "absent" && catalogRefusal);
        if (safeRejection && sessions.delete) {
          try {
            const events = await sessions.events(sessionId, 0);
            const evidenced = events.some((event) => /^(user\/message|assistant\/|tool\/|permission\/requested|question\/asked|secret\/requested)/.test(event.type));
            if (!evidenced) {
              await sessions.delete(sessionId, { expectedLastEventSeq: events.at(-1)?.seq ?? 0 });
              await onUpdate({ sessionId: undefined });
            }
          } catch {
            // Keep a child that gained evidence or whose canonical cleanup
            // could not establish release. Never remove it by guessed PID.
          }
        }
        throw failure(
          cause,
          !sent && (safeRejection || explicitPreAdmissionProof(cause)),
          "pre-admission",
          sessionId
        );
      }

      const deadline = Date.now() + context.timeoutMs;
      const parts = new Map<string, string>();
      let lastReply: string | undefined;
      let lastReplyPart: string | undefined;
      let awaitingResume = false;
      let afterSeq = resumed?.afterSeq ?? 0;
      const openPermissions = new Map<string, { activity: string; since: number }>();
      let permissionWaitShown = false;
      const heldForPerson = async (): Promise<boolean> => {
        const oldest = Math.min(...[...openPermissions.values()].map((open) => open.since));
        if (!sessions.snapshot || Date.now() - oldest >= PERSON_WAIT_GRACE_MS) return true;
        const child = await sessions.snapshot(sessionId).catch(() => undefined);
        return child?.status === "waiting";
      };
      while (true) {
        if (context.signal.aborted) throw abortError();
        if (Date.now() >= deadline) {
          stop();
          await cancellation;
          throw failure(
            new Error(
              `Timed out after ${timeoutLabel(
                context.timeoutMs
              )}. Open the child session to review its last activity.`
            ),
            false,
            "runtime",
            sessionId
          );
        }

        const events = await sessions.events(sessionId, afterSeq);
        let pendingOutput: WorkflowNodeUpdate | undefined;
        for (const event of events) {
          afterSeq = Math.max(afterSeq, event.seq);
          if (event.type === "turn/started" && awaitingResume) {
            // Only the canonical session service admits the continuation. A
            // failed attempt's progress is not the next worker's handoff.
            awaitingResume = false;
            parts.clear();
            lastReply = undefined;
            lastReplyPart = undefined;
          }
          const update = await progressFromEvent(event, parts);
          if (isAssistantOutputEvent(event)) {
            const partId = eventString(event, "partId") ?? event.id;
            const text = eventString(event, "text");
            if (event.type === "assistant/chunk" && partId !== lastReplyPart && text) lastReply = undefined;
            if (event.type === "assistant/message") {
              const reply = text === undefined ? parts.get(partId) : text;
              if (reply?.trim()) {
                lastReply = boundedResult(reply.trim());
                lastReplyPart = partId;
              }
            }
            // Keep canonical event ordering intact while coalescing adjacent
            // output callbacks into one projection per fetched batch.
            if (update) pendingOutput = update;
            continue;
          }
          if (pendingOutput) {
            await onUpdate(pendingOutput);
            pendingOutput = undefined;
          }
          if (event.type === "permission/requested") {
            // Shown after the batch, once the policy proves it needs a person.
            openPermissions.set(eventString(event, "requestId") ?? event.id, {
              activity: `awaiting permission: ${eventString(event, "permission") ?? "tool"}`,
              since: Date.now(),
            });
          } else if (event.type === "permission/resolved" || event.type === "permission/expired") {
            openPermissions.delete(eventString(event, "requestId") ?? "");
            if (permissionWaitShown && openPermissions.size === 0) {
              permissionWaitShown = false;
              await onUpdate({ activity: "thinking" });
            }
          }
          if (update) await onUpdate(update);
          if (event.type === "turn/resume-cancelled" && awaitingResume
            && eventString(event, "reason") === "user") throw abortError();
          // A person stopped the node they had paused: now it is over.
          if (event.type === "session/pause-ended" && awaitingResume
            && eventString(event, "outcome") === "stopped") throw abortError();
          if (event.type === "turn/stopped") {
            const reason = eventString(event, "reason");
            if (reason === "aborted" && (event.data as JsonObject).paused === true) {
              // Paused, not over: keep watching the same child (within the
              // node's deadline) until the person continues or stops it.
              awaitingResume = true;
              await onUpdate({ activity: "paused by a person" });
              continue;
            }
            if (reason === "error") {
              const retry = (event.data as JsonObject).retry as { resumeAt?: unknown; retryable?: unknown } | undefined;
              if (retry && retry.retryable !== false && typeof retry.resumeAt === "number"
                && Number.isFinite(retry.resumeAt) && retry.resumeAt > 0) {
                // This is a persisted server resume plan, not permission to
                // retry a mutation here. Keep watching the same child within
                // the original deadline while the session owner recovers it.
                awaitingResume = true;
                await onUpdate({ activity: "waiting for provider capacity" });
                continue;
              }
              throw failure(
                new Error(
                  eventString(event, "error") ?? "workflow node failed"
                ),
                false,
                "runtime",
                sessionId
              );
            }
            if (reason === "aborted") throw abortError();
            const hasOutput = [...parts].some(([id, text]) => id !== TRUNCATED_PART && text.trim());
            const output = lastReply ?? (hasOutput ? joinParts(parts).trim() : "");
            if (reason !== "completed" || !output) throw failure(
              new Error(reason === "completed" ? "Workflow node completed without an assistant result."
                : "Workflow node stopped without a confirmed completion."),
              false, "runtime", sessionId
            );
            return {
              sessionId,
              output,
            };
          }
        }
        if (pendingOutput) await onUpdate(pendingOutput);
        if (openPermissions.size > 0 && !permissionWaitShown && await heldForPerson()) {
          permissionWaitShown = true;
          await onUpdate({ activity: openPermissions.values().next().value!.activity });
        }
        await wait(
          Math.min(100, Math.max(1, deadline - Date.now())),
          context.signal
        );
      }
    } finally {
      context.signal.removeEventListener("abort", stop);
      if (cancellation) await cancellation;
    }
  };
}

async function progressFromEvent(
  event: SessionEvent,
  parts: Map<string, string>
): Promise<WorkflowNodeUpdate | null> {
  if (event.type === "turn/started") return { activity: "thinking" };
  if (event.type === "tool/call")
    return { activity: `tool: ${eventString(event, "tool") ?? "unknown"}` };
  if (event.type === "tool/result" || event.type === "tool/error")
    return { activity: "thinking" };
  // Permission requests are reported by the poll loop, which knows whether
  // the child's approval policy answered them or holds them for a person.
  if (event.type === "question/asked" || event.type === "secret/requested") {
    return { activity: "awaiting answer" };
  }
  // An expired request no longer waits on anyone; leaving the wait would keep
  // "Answer needed" up with nothing left to answer.
  if (event.type === "question/answered" || event.type === "question/expired"
    || event.type === "secret/resolved" || event.type === "secret/expired") {
    return { activity: "thinking" };
  }
  if (event.type === "assistant/chunk") {
    const partId = eventString(event, "partId") ?? event.id;
    collectOutput(parts, partId, eventString(event, "text") ?? "", true);
    return { activity: "writing", output: joinParts(parts) };
  }
  if (event.type === "assistant/message") {
    const partId = eventString(event, "partId") ?? event.id;
    const text = eventString(event, "text");
    // Some runtime adapters emit a terminal assistant marker without
    // repeating the streamed text. Never erase chunks already collected.
    if (text !== undefined) collectOutput(parts, partId, text, false);
    return { activity: "writing", output: joinParts(parts) };
  }
  return null;
}
