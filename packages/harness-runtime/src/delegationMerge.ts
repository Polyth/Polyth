import { createHash } from "node:crypto";
import type { DelegatedIsolationDto, Disposable, JsonObject, QueueItemDto } from "@polyth/contracts";
import { delegatedChildRunning } from "@polyth/contracts";
import {
  SERVER_SESSION_ISOLATION,
  SERVER_TURN_STOPPED_BUS,
  type ServerPackageHost,
} from "@polyth/plugins";

/** A running child's isolated checkout is still changing. */
export const delegationRunning = (child: DelegatedIsolationDto): boolean =>
  delegatedChildRunning(child.status);

/** What the delegating agent has to do next about one isolated child. */
export function delegationNextStep(child: DelegatedIsolationDto): string {
  if (delegationRunning(child)) return "still running: wait for its completion wake, then review and merge it";
  if (child.status === "archived") return "archived: session.restore it, then agent.merge or agent.discard";
  switch (child.state) {
    case "conflict":
      return "merge conflict: agent.resolve, then agent.merge again";
    case "merging":
    case "publishing":
    case "rebind-pending":
    case "cleanup-pending":
      return "merge or cleanup unfinished: agent.merge resumes it";
    case "missing":
    case "unowned":
    case "corrupt":
      return "isolated worktree is unavailable: report it to the user";
    default:
      return child.hasChanges
        ? "unmerged changes: review them, then agent.merge"
        : "no changes: agent.merge releases its worktree";
  }
}

export const publicDelegation = (child: DelegatedIsolationDto): JsonObject => ({
  mode: "isolated",
  state: child.state,
  hasChanges: child.hasChanges,
  worktreePath: child.worktreePath,
  branch: child.worktreeBranch,
  mergeTarget: child.targetBranch,
  ...(child.conflictFiles?.length ? { conflictFiles: child.conflictFiles.slice(0, 20) } : {}),
  next: delegationNextStep(child),
});

const REMINDER_HEADER = "[polyth] Delegated isolated work is not merged into your checkout yet.";

export function delegationReminderText(pending: readonly DelegatedIsolationDto[]): string {
  return [
    REMINDER_HEADER,
    "These agents worked in their own isolated worktrees; nothing they changed is in your workspace until you merge it:",
    ...pending.map((child) =>
      `- "${child.title}" (sessionId ${child.sessionId}, ${child.worktreeBranch} → ${child.targetBranch}): ${delegationNextStep(child)}`),
    "",
    "Review each result, then call the polyth tool with action agent.merge for it, or agent.discard to drop it on purpose. Do not finish while delegated work is unmerged; if you deliberately leave it for the user, say so.",
  ].join("\n");
}

/** One reminder per distinct pending state: the canonical send path replays
 *  an identical client operation instead of admitting a second turn. A queued
 *  send keeps this id as its queue row id, which is how a queued reminder is
 *  matched against the current state. `attempt` re-keys a state whose earlier
 *  reminder was withdrawn undelivered, so the replay does not swallow it. */
const reminderOperationId = (parentId: string, pending: readonly DelegatedIsolationDto[], attempt = 0): string => {
  const state = pending
    .map((child) => `${child.sessionId}:${child.status === "archived" ? "archived" : "live"}:${child.state}:${child.revision}`)
    .sort()
    .join("|");
  const retry = attempt > 0 ? `\0withdrawn-${attempt}` : "";
  const hex = createHash("sha256").update(`delegation-merge-reminder\0${parentId}\0${state}${retry}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${(8 | (parseInt(hex[16]!, 16) & 3)).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

/** Every isolated child settled and at least one still holds a record. */
const reminderDue = (pending: readonly DelegatedIsolationDto[]): boolean =>
  pending.length > 0 && !pending.some(delegationRunning);

const isQueuedReminder = (item: QueueItemDto): boolean =>
  item.hiddenUserMessage === true && item.text.startsWith(REMINDER_HEADER);

const KNOWN_LIMIT = 5_000;

export interface DelegationMergeReminder extends Disposable {
  /** Called when a session delegates into an isolated checkout. */
  noteDelegation(parentSessionId: string): void;
  /** Called after a delegator merged, discarded or started resolving one of
   *  its isolated children: withdraws a reminder still waiting in its queue
   *  that no longer matches the children's state. Never throws. */
  revalidate(parentSessionId: string): Promise<void>;
}

/**
 * When a delegating session completes a turn while every isolated child it
 * spawned has settled and at least one still holds an isolation record, wake
 * it once with the list of work it still has to merge or discard. Running
 * children are left to their own completion watches; the next completed turn
 * re-checks. Aborted and failed turns never trigger a reminder.
 *
 * The reminder is computed when a turn stops but may wait in the queue behind
 * a turn that was already being admitted (a watch wake, a person's message).
 * That turn can merge the very children it lists, so a queued reminder is
 * revalidated when the delegator merges, discards or resolves a child and on
 * every later turn stop, and withdrawn when its state no longer holds; the
 * next completed turn sends a fresh one if work is still unmerged.
 */
export function registerDelegationMergeReminder(host: ServerPackageHost): DelegationMergeReminder {
  // false = this session had no delegated isolated children when last
  // checked, so ordinary turn ends skip the project scan until it delegates.
  const known = new Map<string, boolean>();
  const inFlight = new Set<string>();
  // Reminder operation ids withdrawn from a queue before delivery.
  const withdrawn = new Set<string>();
  const operationId = (parentId: string, pending: readonly DelegatedIsolationDto[]): string => {
    let attempt = 0;
    let id = reminderOperationId(parentId, pending);
    while (withdrawn.has(id)) id = reminderOperationId(parentId, pending, ++attempt);
    return id;
  };

  /** Remove queued reminders of `parentId` that do not describe `pending`. */
  const withdrawStale = async (parentId: string, pending?: readonly DelegatedIsolationDto[]): Promise<void> => {
    const { queueList, queueRemove } = host.sessions;
    if (!queueList || !queueRemove) return;
    const queued = (await queueList.call(host.sessions, parentId)).filter(isQueuedReminder);
    if (queued.length === 0) return;
    const isolation = host.services.get(SERVER_SESSION_ISOLATION);
    if (!isolation) return;
    const children = pending ?? await isolation.delegatedChildren(parentId);
    const current = reminderDue(children) ? operationId(parentId, children) : undefined;
    let kept = false;
    for (const item of queued) {
      if (item.id === current && !kept) {
        kept = true;
        continue;
      }
      try {
        await queueRemove.call(host.sessions, parentId, item.id);
        if (withdrawn.size >= KNOWN_LIMIT) withdrawn.clear();
        withdrawn.add(item.id);
      } catch {
        // Already dispatched or removed meanwhile: nothing left to withdraw.
      }
    }
  };

  const bus = host.services.get(SERVER_TURN_STOPPED_BUS);
  const subscription = bus?.subscribe(async ({ sessionId, reason }) => {
    if (known.get(sessionId) === false || inFlight.has(sessionId)) return;
    const isolation = host.services.get(SERVER_SESSION_ISOLATION);
    if (!isolation) return;
    inFlight.add(sessionId);
    try {
      const pending = await isolation.delegatedChildren(sessionId);
      if (known.size >= KNOWN_LIMIT) known.clear();
      known.set(sessionId, pending.length > 0);
      await withdrawStale(sessionId, pending);
      if (reason !== "completed" || !reminderDue(pending)) return;
      const parent = await host.sessions.snapshot(sessionId);
      // A turn that started meanwhile ends with its own check.
      if (parent.status !== "idle" && parent.status !== "finished") return;
      await host.sessions.send(sessionId, {
        text: delegationReminderText(pending),
        delivery: "normal",
        hiddenUserMessage: true,
        clientOperationId: operationId(sessionId, pending),
      });
    } catch (error) {
      console.warn(`[polyth] delegated merge reminder for ${sessionId} was not delivered: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      inFlight.delete(sessionId);
    }
  });
  return {
    noteDelegation(parentSessionId) {
      known.set(parentSessionId, true);
    },
    async revalidate(parentSessionId) {
      try {
        await withdrawStale(parentSessionId);
      } catch (error) {
        console.warn(`[polyth] queued merge reminder for ${parentSessionId} was not revalidated: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    dispose() {
      subscription?.dispose();
      known.clear();
      withdrawn.clear();
    },
  };
}
