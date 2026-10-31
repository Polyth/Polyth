// The workflow status-bar segment. The package owns both the data (the active
// run poll) and the presentation, so the shell never imports workflow code.
// The same component serves the full bar (a chip inside a widget area) and the
// minimal `statusBar: "workflows"` activity strip: in the strip it owns the
// bar frame and disappears entirely when no run needs attention.
import { useEffect, useState, type ReactNode } from "react";
import type { WorkflowRunDto } from "@polyth/contracts";
import type { WebPackageHost } from "@polyth/web-sdk";
import { api, httpStatusOf } from "@polyth/session/web-api";
import { HelpIcon, Icon, ShieldAlertIcon, WrenchIcon } from "../../../apps/web/src/components/ui/index.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { subscribeWorkflowRuns } from "./workflowMonitor.ts";
import { prioritizeWorkflowRuns, workflowFinishedCount, workflowHumanWait, workflowNeedsFix } from "./workflowRun.ts";
import { handOffWorkflowLaunch } from "./workflowLaunch.ts";

// Two-tier cadence: the fast poll only runs while a run is actually active, so
// an idle project costs one slow heartbeat. WS pushes wake the fast poll the
// moment a run starts, so responsiveness never depends on the slow tier.
const ACTIVE_POLL_MS = 1_200;
const IDLE_POLL_MS = 30_000;

/**
 * The active workflow runs of a project, most urgent first. Mounted by the
 * segment only, so nothing polls while the segment is not on screen.
 */
export function useWorkflowRuns(projectId: string | null): readonly WorkflowRunDto[] {
  const [state, setState] = useState<{ projectId: string; runs: WorkflowRunDto[] } | null>(null);
  useEffect(() => {
    if (!projectId) {
      setState(null);
      return;
    }
    let mounted = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (hasActiveRuns: boolean) => {
      if (!mounted) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(refresh, hasActiveRuns ? ACTIVE_POLL_MS : IDLE_POLL_MS);
    };
    const refresh = () => {
      void api.listWorkflowRuns(projectId)
        .then((runs) => {
          if (!mounted) return;
          const activeRuns = prioritizeWorkflowRuns(runs);
          setState(activeRuns.length > 0 ? { projectId, runs: activeRuns } : null);
          schedule(activeRuns.length > 0);
        })
        // 404 means the package is disabled on this server: stop polling
        // instead of spamming the console every 30s forever.
        .catch((error) => { if (httpStatusOf(error) !== 404) schedule(false); });
    };
    refresh();
    const unsubscribe = subscribeWorkflowRuns((updated) => {
      if (updated.projectId && updated.projectId !== projectId) return;
      setState((current) => {
        const existing = current?.projectId === projectId ? current.runs : [];
        const activeRuns = prioritizeWorkflowRuns([
          updated,
          ...existing.filter((run) => run.id !== updated.id),
        ]);
        schedule(activeRuns.length > 0);
        return activeRuns.length > 0 ? { projectId, runs: activeRuns } : null;
      });
    });
    return () => {
      mounted = false;
      if (timer !== null) clearTimeout(timer);
      unsubscribe();
    };
  }, [projectId]);
  return state && state.projectId === projectId ? state.runs : [];
}

/** The most urgent active run as one button, or nothing. */
function WorkflowChip({ host, projectId, runs }: {
  host: WebPackageHost;
  projectId: string;
  runs: readonly WorkflowRunDto[];
}): ReactNode {
  const run = runs[0];
  if (!run) return null;
  const total = run.nodes.length;
  const complete = workflowFinishedCount(run);
  const wait = run.nodes.some((node) => workflowHumanWait(node) === "permission")
    ? "permission"
    : run.nodes.some((node) => workflowHumanWait(node) === "answer")
      ? "answer"
      : run.nodes.some(workflowNeedsFix)
        ? "fix"
        : null;
  const actionLabel = wait === "permission"
    ? tr("statusbar.approvalNeeded")
    : wait === "answer"
      ? tr("statusbar.answerNeeded")
      : wait === "fix"
        ? tr("statusbar.fixNeeded")
        : null;
  // The request is answered in the waiting unit's own chat, so the chip goes
  // straight there instead of to a run overview that only points at it. A fix
  // is made in the run itself.
  const waitingSessionId = wait && wait !== "fix"
    ? run.nodes.find((node) => workflowHumanWait(node) === wait && node.sessionId)?.sessionId
    : undefined;
  const workflowLabel = runs.length > 1 ? tr("statusbar.workflowsCount", { count: runs.length }) : run.name;
  const openWorkflow = () => {
    if (waitingSessionId) {
      void host.conversation.openSession(waitingSessionId).catch((error) =>
        host.errors.show?.(error instanceof Error ? error.message : String(error)));
      return;
    }
    handOffWorkflowLaunch({
      projectId: run.projectId ?? projectId,
      ...(run.parentSessionId ? { sessionId: run.parentSessionId } : {}),
      workflowId: run.workflowId,
      input: run.input,
      run,
    });
    host.navigation.openWorkspacePane("workflow");
  };
  return (
    <button
      type="button"
      className={`sb sb-workflow sb-action${actionLabel ? " waiting" : ""}`}
      data-fit-keep=""
      title={actionLabel ? tr("statusbar.workflowActionRequired", { action: actionLabel }) : tr("statusbar.openWorkflow")}
      aria-label={tr("statusbar.workflowSummary", { label: actionLabel ?? workflowLabel, complete, total })}
      onClick={openWorkflow}
    >
      {wait
        ? <Icon icon={wait === "permission" ? ShieldAlertIcon : wait === "fix" ? WrenchIcon : HelpIcon} size="sm" className="workflow-status-wait" />
        : <span className="workflow-status-spinner" aria-hidden="true" />}
      <span className="sb-text">{actionLabel ?? workflowLabel} · {complete}/{total}</span>
    </button>
  );
}

/**
 * Only this segment is a live region: a run that starts needing the user is
 * announced while the rest of the bar stays quiet. The region has no box of
 * its own and, in the full bar, exists before there is anything to announce.
 */
export default function WorkflowStatusbarSegment({ host, projectId, strip }: {
  host: WebPackageHost;
  projectId: string | null;
  /** True in the minimal activity strip, where this segment owns the bar. */
  strip?: boolean;
}): ReactNode {
  const runs = useWorkflowRuns(projectId);
  const region = (
    <span className="sb-region" role="status" aria-live="polite">
      {projectId && runs.length > 0 ? <WorkflowChip host={host} projectId={projectId} runs={runs} /> : null}
    </span>
  );
  if (!strip) return region;
  // The strip exists only while there is something to show, so an idle project
  // keeps the bar out of the layout entirely.
  if (!projectId || runs.length === 0) return null;
  return <div className="statusbar" data-statusbar="workflows">{region}</div>;
}
