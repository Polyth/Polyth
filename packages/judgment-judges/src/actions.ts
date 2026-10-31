// What a fired judge does. Judgment only answered; the person who saved the
// judge chose these actions, and each runs through that person's own session
// facade (chat access, account guardrails, limits) exactly as if they pressed
// the button themselves. Every precondition is re-read right before acting: a
// chat that moved on, a request someone already answered or a resume that
// already ran makes the action a recorded no-op, never a retry.
import { sessionAccessAtLeast, type SessionEvent, type SessionService } from "@polyth/contracts";
import type { ServerSessionIsolationService } from "@polyth/plugins";
import { isPersonRequest, judgeRounds, permissionEvidence } from "./evidence.ts";
import type { RouteOption } from "./routes.ts";
import { ROUNDS, type ActionEffect, type ActionKind, type ApprovalLevel, type AssessmentAction } from "./types.ts";

export interface ActionTarget {
  sessionId: string;
  /** The judge owner's own session facade. */
  sessions: SessionService;
  ownerUserId: string;
  /** Fresh canonical events of the session. */
  events(): Promise<SessionEvent[]>;
  isolation?: ServerSessionIsolationService;
  /** The turn the answer was about; a newer message from the person makes it stale. */
  turnSeq?: number;
  /** Permission judges: the request the answer was about. */
  requestId?: string;
  /** False in a Space that never answers a request automatically. */
  automaticAllowed?: boolean;
  /** Limit judges: the model the answer chose. */
  route?: RouteOption;
  maxRounds?: number;
}

export const APPROVAL_COPY: Record<ApprovalLevel, string> = { on: "Auto-Approve on", all: "Full access on", off: "Auto-Approve off" };

/** Skips a request's card can name in the person's language (`RequestVerdictData.approval.reason`). */
export const SPACE_NEVER_APPROVES = "this Space never approves automatically";
export const ACTS_FOR_NO_ONE = "this judge acts for no one; save it again to let it act for you";

const reason = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
};
const skipped = (kind: ActionKind, detail: string): AssessmentAction => ({ kind, status: "skipped", detail });

/** Why a judge's message must not be sent now, or undefined when it may be. */
export async function sendBlocked(target: ActionTarget): Promise<string | undefined> {
  const projection = await target.sessions.snapshot(target.sessionId);
  if (projection.sharing && !sessionAccessAtLeast(projection.sharing.access, "collaborate")) return "you cannot work in this chat";
  if (projection.status !== "idle") return "the chat is busy";
  if (((await target.sessions.queueList?.(target.sessionId)) ?? []).length) return "a message is already queued";
  const events = await target.events();
  if (target.turnSeq !== undefined && events.some((event) => event.seq > target.turnSeq! && isPersonRequest(event))) return "you wrote since";
  const rounds = judgeRounds(events), limit = target.maxRounds ?? ROUNDS.default;
  // An autopilot stops after its rounds and hands the chat back to its person.
  if (rounds >= limit) return `${rounds} judge ${rounds === 1 ? "message" : "messages"} in a row; waiting for you`;
  return undefined;
}

/** The fixed message, written for the judge's owner and marked as a judge's. */
export async function sendMessage(effect: Extract<ActionEffect, { kind: "send-message" }>, target: ActionTarget): Promise<void> {
  await target.sessions.send(target.sessionId, { text: effect.text, delivery: "normal" },
    { author: { userId: target.ownerUserId, via: "judge" } });
}

/** Runs one action other than sending a message (the caller records before sending). */
export async function runAction(effect: ActionEffect, target: ActionTarget): Promise<AssessmentAction> {
  try {
    switch (effect.kind) {
      case "merge-isolated": return await merge(target);
      case "approve-request": return await approve(target);
      case "deny-request": return await deny(target);
      case "set-approval": return await setApproval(effect.level, target);
      case "switch-route": return await switchRoute(target);
      default: return skipped(effect.kind, "sent separately");
    }
  } catch (error) {
    return { kind: effect.kind, status: "failed", detail: reason(error) };
  }
}

/** The isolation card's Merge button: commit the isolated work into the branch it came from. */
async function merge(target: ActionTarget): Promise<AssessmentAction> {
  const kind = "merge-isolated";
  if (!target.isolation) return skipped(kind, "Git isolation is not available");
  const projection = await target.sessions.snapshot(target.sessionId);
  // Merging changes the chat's workspace: only someone who manages the chat may.
  if (projection.sharing && !sessionAccessAtLeast(projection.sharing.access, "manage")) return skipped(kind, "you do not manage this chat");
  if (projection.status !== "idle") return skipped(kind, "the chat is busy");
  const status = await target.isolation.getStatus(target.sessionId);
  if (!status.isolation) return skipped(kind, "the chat is not isolated");
  if (!status.actions?.canMerge) return skipped(kind, status.delegated?.length ? "delegated work is not merged yet" : "nothing to merge yet");
  const result = await target.isolation.mergeBack(target.sessionId);
  return { kind, status: "done", detail: `Merged into ${result.targetBranch}${result.commit ? ` (${result.commit.slice(0, 7)})` : ""}` };
}

async function approve(target: ActionTarget): Promise<AssessmentAction> {
  const kind = "approve-request";
  if (!target.requestId) return skipped(kind, "no request");
  // A Space with a guarded member never answers for its people: a judge does not either.
  if (target.automaticAllowed === false) return skipped(kind, SPACE_NEVER_APPROVES);
  const request = permissionEvidence(await target.events(), target.requestId);
  if (!request?.open) return skipped(kind, "already answered");
  await target.sessions.replyPermission(target.sessionId, target.requestId, "once");
  return { kind, status: "done", detail: `Approved ${request.title}` };
}

/** The card's Deny button. Unlike approving, a guarded Space allows it, as it does its own deny rules. */
async function deny(target: ActionTarget): Promise<AssessmentAction> {
  const kind = "deny-request";
  if (!target.requestId) return skipped(kind, "no request");
  const request = permissionEvidence(await target.events(), target.requestId);
  if (!request?.open) return skipped(kind, "already answered");
  await target.sessions.replyPermission(target.sessionId, target.requestId, "reject");
  return { kind, status: "done", detail: `Denied ${request.title}` };
}

async function setApproval(level: ApprovalLevel, target: ActionTarget): Promise<AssessmentAction> {
  const kind = "set-approval";
  if (!target.sessions.autoAcceptSet) return skipped(kind, "Auto-Approve is not available");
  const current = await target.sessions.autoAcceptGet?.(target.sessionId);
  if (current?.setting === level) return skipped(kind, `${APPROVAL_COPY[level]} already`);
  try {
    await target.sessions.autoAcceptSet(target.sessionId, level);
  } catch (error) {
    // The level is saved before follow-up work (answering open cards) runs;
    // report what the chat now has, not a failure of that follow-up.
    const saved = await target.sessions.autoAcceptGet?.(target.sessionId).catch(() => undefined);
    if (saved?.setting !== level) throw error;
  }
  return { kind, status: "done", detail: APPROVAL_COPY[level] };
}

/** The rate-limit notice's "continue on another model", on the model the answer chose. */
async function switchRoute(target: ActionTarget): Promise<AssessmentAction> {
  const kind = "switch-route";
  const route = target.route;
  if (!route) return skipped(kind, "no model chosen");
  if (!target.sessions.resumeNow) return skipped(kind, "resuming is not available");
  const projection = await target.sessions.snapshot(target.sessionId);
  if (!projection.resume) return skipped(kind, "the chat already resumed");
  await target.sessions.resumeNow(target.sessionId, {
    model: { providerID: route.providerID, modelID: route.modelID },
    harness: { mode: "pinned", harnessId: route.harnessId },
  });
  return { kind, status: "done", detail: `Switched to ${route.name}` };
}
