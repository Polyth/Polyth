import { createHash } from "node:crypto";
import type { DelegatedIsolationDto, Disposable, JsonObject } from "@polyth/contracts";
import { isolationBlocksUserMutation } from "@polyth/contracts";
import {
  SERVER_SESSION_ISOLATION,
  SERVER_TURN_STOPPED_BUS,
  type ServerPackageHost,
} from "@polyth/plugins";

/** A running child's isolated checkout is still changing. */
export const delegationRunning = (child: DelegatedIsolationDto): boolean =>
  isolationBlocksUserMutation(child.status) && child.status !== "archived";

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

export function delegationReminderText(pending: readonly DelegatedIsolationDto[]): string {
  return [
    "[polyth] Delegated isolated work is not merged into your checkout yet.",
    "These agents worked in their own isolated worktrees; nothing they changed is in your workspace until you merge it:",
    ...pending.map((child) =>
      `- "${child.title}" (sessionId ${child.sessionId}, ${child.worktreeBranch} → ${child.targetBranch}): ${delegationNextStep(child)}`),
    "",
    "Review each result, then call the polyth tool with action agent.merge for it, or agent.discard to drop it on purpose. Do not finish while delegated work is unmerged; if you deliberately leave it for the user, say so.",
  ].join("\n");
}

/** One reminder per distinct pending state: the canonical send path replays
 *  an identical client operation instead of admitting a second turn. */
const reminderOperationId = (parentId: string, pending: readonly DelegatedIsolationDto[]): string => {
  const state = pending
    .map((child) => `${child.sessionId}:${child.status === "archived" ? "archived" : "live"}:${child.state}:${child.revision}`)
    .sort()
    .join("|");
  const hex = createHash("sha256").update(`delegation-merge-reminder\0${parentId}\0${state}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${(8 | (parseInt(hex[16]!, 16) & 3)).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

const KNOWN_LIMIT = 5_000;

export interface DelegationMergeReminder extends Disposable {
  /** Called when a session delegates into an isolated checkout. */
  noteDelegation(parentSessionId: string): void;
}

/**
 * When a delegating session completes a turn while every isolated child it
 * spawned has settled and at least one still holds an isolation record, wake
 * it once with the list of work it still has to merge or discard. Running
 * children are left to their own completion watches; the next completed turn
 * re-checks. Aborted and failed turns never trigger a reminder.
 */
export function registerDelegationMergeReminder(host: ServerPackageHost): DelegationMergeReminder {
  // false = this session had no delegated isolated children when last
  // checked, so ordinary turn ends skip the project scan until it delegates.
  const known = new Map<string, boolean>();
  const inFlight = new Set<string>();
  const bus = host.services.get(SERVER_TURN_STOPPED_BUS);
  const subscription = bus?.subscribe(async ({ sessionId, reason }) => {
    if (reason !== "completed" || known.get(sessionId) === false || inFlight.has(sessionId)) return;
    const isolation = host.services.get(SERVER_SESSION_ISOLATION);
    if (!isolation) return;
    inFlight.add(sessionId);
    try {
      const pending = await isolation.delegatedChildren(sessionId);
      if (known.size >= KNOWN_LIMIT) known.clear();
      known.set(sessionId, pending.length > 0);
      if (pending.length === 0 || pending.some(delegationRunning)) return;
      const parent = await host.sessions.snapshot(sessionId);
      // A turn that started meanwhile ends with its own check.
      if (parent.status !== "idle" && parent.status !== "finished") return;
      await host.sessions.send(sessionId, {
        text: delegationReminderText(pending),
        delivery: "normal",
        hiddenUserMessage: true,
        clientOperationId: reminderOperationId(sessionId, pending),
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
    dispose() {
      subscription?.dispose();
      known.clear();
    },
  };
}
