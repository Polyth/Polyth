import type { IsolationStatusDto, SessionProjection } from "@polyth/contracts";
import { api } from "@polyth/session/web-api";
import { getState, setUiError, upsertSession, useStore } from "../../../apps/web/src/store.ts";
import { friendlyError } from "../../../apps/web/src/settings.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { CombineIcon, Icon, confirmAlert } from "../../../apps/web/src/components/ui/index.ts";
import { isolationMenuChoice } from "./IsolationMenuAction.tsx";

type Failure = { id: string; code: string };
export type BulkReport = (operation: string, succeeded: number, failed: Failure[]) => void;

const isIsolated = (session: Pick<SessionProjection, "isolation" | "isolationSummary">): boolean =>
  session.isolation?.kind === "git-worktree" || session.isolationSummary === "git-worktree";

export interface IsolationPlan {
  /** Nothing to integrate: the session goes straight back to its workspace. */
  returns: string[];
  /** Changes to commit and merge into the session's target branch. */
  merges: string[];
  /** Conflicts, running agents, delegated work or recovery: the isolation
   *  card has to explain these one at a time, so a bulk action leaves them. */
  skipped: Failure[];
}

/** Read every isolation live and sort it the way the row menu would. */
export async function planIsolationExit(sessionIds: readonly string[]): Promise<IsolationPlan> {
  const plan: IsolationPlan = { returns: [], merges: [], skipped: [] };
  for (const id of sessionIds) {
    const session = getState().sessions.find((candidate) => candidate.id === id);
    if (!session || !isIsolated(session)) continue;
    let status: IsolationStatusDto;
    try {
      status = await api.isolationStatus(id);
    } catch (cause) {
      plan.skipped.push({ id, code: (cause as { code?: string })?.code ?? "unavailable" });
      continue;
    }
    const choice = isolationMenuChoice(status, session.status);
    if (choice?.kind === "return") plan.returns.push(id);
    else if (choice?.kind === "integrate") plan.merges.push(id);
    else plan.skipped.push({ id, code: "needs-review" });
  }
  return plan;
}

/** Carry the plan out one session at a time: merges into a shared branch must
 *  not race, and the server re-checks each one, so a stale plan cannot
 *  discard work. */
export async function runIsolationExit(plan: IsolationPlan): Promise<{ succeeded: number; failed: Failure[] }> {
  let succeeded = 0;
  const failed: Failure[] = [...plan.skipped];
  for (const id of plan.returns) {
    try {
      upsertSession(await api.isolationReturn(id));
      succeeded += 1;
    } catch (cause) {
      failed.push({ id, code: (cause as { code?: string })?.code ?? "error" });
    }
  }
  for (const id of plan.merges) {
    try {
      upsertSession((await api.isolationMerge(id)).session);
      succeeded += 1;
    } catch (cause) {
      failed.push({ id, code: (cause as { code?: string })?.code ?? "error" });
    }
  }
  return { succeeded, failed };
}

/** Selection-bar entry: return or integrate every selected isolated session. */
export function IsolationBulkAction({ sessionIds, closeMenu, done, report }: {
  sessionIds: readonly string[];
  closeMenu?: () => void;
  done?: () => void;
  report?: BulkReport;
}) {
  const isolatedCount = useStore((state) => state.sessions
    .filter((session) => sessionIds.includes(session.id) && isIsolated(session)).length);
  if (isolatedCount === 0) return null;

  const run = async () => {
    closeMenu?.();
    try {
      const plan = await planIsolationExit(sessionIds);
      const ready = plan.returns.length + plan.merges.length;
      if (ready === 0) {
        report?.(tr("isolation.bulkLeft"), 0, plan.skipped);
        return;
      }
      if (!await confirmAlert(tr("isolation.bulkConfirm", {
        merges: plan.merges.length,
        returns: plan.returns.length,
        skipped: plan.skipped.length,
      }), {
        title: tr("isolation.bulkLeave"),
        confirmLabel: tr("isolation.bulkLeave"),
        destructive: false,
      })) return;
      done?.();
      const result = await runIsolationExit(plan);
      report?.(tr("isolation.bulkLeft"), result.succeeded, result.failed);
    } catch (cause) {
      setUiError(friendlyError(tr("common.error"), cause));
    }
  };

  return (
    <button type="button" role="menuitem" className="ui-menu-item" onClick={() => void run()}>
      <Icon icon={CombineIcon} size="sm" />
      <span className="ui-menu-item-copy"><span className="ui-menu-item-label">{tr("isolation.bulkLeave")}</span></span>
    </button>
  );
}
