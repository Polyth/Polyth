import { Fragment, useEffect, useState } from "react";
import type { WorkflowRunDto } from "@polyth/contracts";
import { openWorkspacePane, useStore, type AppView } from "../store.ts";
import { isWorkspaceSurface, listSurfaces } from "../surfaces.ts";
import { api } from "@polyth/session/web-api";
import {
  prioritizeWorkflowRuns,
  workflowFinishedCount,
  workflowHumanWait,
} from "../../../../packages/workflow/widgets/workflowRun.ts";
import { handOffWorkflowLaunch } from "../../../../packages/workflow/widgets/workflowLaunch.ts";
import { subscribeWorkflowRuns } from "../../../../packages/workflow/widgets/workflowMonitor.ts";
import { tr } from "../i18n/index.ts";

// UX-PANE-MODEL: Files/Git/Terminal/Preview are workspace panes beside Chat,
// not primary views — the open pane is appended to the label instead.
const VIEW_LABEL: Record<AppView, string> = {
  session: tr("statusbar.chat"),
  goals: tr("statusbar.goals"),
  multirun: tr("widgets.builtinwidgets.multiRun"),
  workflow: tr("statusbar.workflows"),
  fusion: tr("statusbar.fusion"),
  walkthrough: tr("statusbar.walkthrough"),
  schedule: tr("statusbar.schedule"),
  github: tr("statusbar.github"),
};

// UX-A390: every segment carries a stable key/class so narrow widths can
// prioritize deterministically in CSS: project identity/status stays at the
// start, the current view at the end; branch/model/agent are visually
// suppressed at phone width (they remain in the drawer/header/panels) instead
// of being clipped half-visible. The bar itself never scrolls horizontally.
export default function StatusBar() {
  const branch = useStore((s) => s.gitBranch);
  const project = useStore((s) => s.projectRegistry.projects.find((p) => p.id === s.activeProjectId) ?? null);
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeSessionId) ?? null);
  const view = useStore((s) => s.activeView);
  const rail = useStore((s) => s.railPlugin);
  const [workflowState, setWorkflowState] = useState<{ projectId: string; runs: WorkflowRunDto[] } | null>(null);
  const activeWorkflows = workflowState && workflowState.projectId === project?.id ? workflowState.runs : [];
  const activeWorkflow = activeWorkflows[0] ?? null;
  const paneTitle = rail !== null
    ? listSurfaces().find((s) => s.id === rail && isWorkspaceSurface(s))?.title ?? null
    : null;

  useEffect(() => {
    if (!project?.id) {
      setWorkflowState(null);
      return;
    }
    setWorkflowState((current) => current?.projectId === project.id ? current : null);
    let mounted = true;
    // Two-tier cadence: the 1.2s poll only runs while a workflow is actually
    // active (progress % updates); an idle project costs one slow heartbeat.
    // WS pushes (subscribeWorkflowRuns) wake the fast poll the moment a run
    // starts, so responsiveness never depends on the slow tier.
    const ACTIVE_POLL_MS = 1_200;
    const IDLE_POLL_MS = 30_000;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (hasActiveRuns: boolean) => {
      if (!mounted) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(refresh, hasActiveRuns ? ACTIVE_POLL_MS : IDLE_POLL_MS);
    };
    const refresh = () => {
      void api.listWorkflowRuns(project.id)
        .then((runs) => {
          if (!mounted) return;
          const activeRuns = prioritizeWorkflowRuns(runs);
          setWorkflowState(activeRuns.length > 0 ? { projectId: project.id, runs: activeRuns } : null);
          schedule(activeRuns.length > 0);
        })
        .catch(() => schedule(false));
    };
    refresh();
    const unsubscribe = subscribeWorkflowRuns((updated) => {
      if (updated.projectId && updated.projectId !== project.id) return;
      setWorkflowState((current) => {
        const existing = current?.projectId === project.id ? current.runs : [];
        const activeRuns = prioritizeWorkflowRuns([
          updated,
          ...existing.filter((run) => run.id !== updated.id),
        ]);
        schedule(activeRuns.length > 0);
        return activeRuns.length > 0 ? { projectId: project.id, runs: activeRuns } : null;
      });
    });
    return () => {
      mounted = false;
      if (timer !== null) clearTimeout(timer);
      unsubscribe();
    };
  }, [project?.id]);

  const segments: Array<{ key: string; node: React.ReactNode }> = [];
  segments.push({
    key: "project",
    node: (
      <span className="sb sb-project">
        <span className="sb-live" aria-hidden />
        <span className="sb-text">{project?.name || project?.path || "Polyth"}</span>
      </span>
    ),
  });
  if (branch) {
    segments.push({ key: "branch", node: <span className="sb sb-branch"><span className="mono">{branch}</span></span> });
  }
  if (project) {
    segments.push({
      key: "model",
      node: <span className="sb sb-model"><span className="mono">{session?.model?.modelID ?? tr("statusbar.noModel")}</span></span>,
    });
  }
  if (session?.agent) {
    segments.push({ key: "agent", node: <span className="sb sb-agent">{session.agent} {tr("statusbar.agent")}</span> });
  }
  if (activeWorkflow && project) {
    const complete = workflowFinishedCount(activeWorkflow);
    const waits = activeWorkflow.nodes.map(workflowHumanWait);
    const waitingForPermission = waits.includes("permission");
    const waitingForAnswer = waits.includes("answer");
    const actionLabel = waitingForPermission ? "Approval needed" : waitingForAnswer ? "Answer needed" : null;
    const workflowLabel = activeWorkflows.length > 1 ? `${activeWorkflows.length} workflows` : activeWorkflow.name;
    const openWorkflow = () => {
      handOffWorkflowLaunch({
        projectId: activeWorkflow.projectId ?? project.id,
        ...(activeWorkflow.parentSessionId ? { sessionId: activeWorkflow.parentSessionId } : {}),
        workflowId: activeWorkflow.workflowId,
        input: activeWorkflow.input,
        run: activeWorkflow,
      });
      openWorkspacePane("workflow");
    };
    segments.push({
      key: "workflow",
      node: (
        <button
          type="button"
          className={`sb sb-workflow${actionLabel ? " waiting" : ""}`}
          title={actionLabel ? `Workflow action required: ${actionLabel.toLowerCase()}` : "Open active workflow"}
          aria-label={`${actionLabel ?? workflowLabel}, ${complete} of ${activeWorkflow.nodes.length} nodes finished. Open workflow`}
          onClick={openWorkflow}
        >
          <span className="workflow-status-spinner" aria-hidden="true" />
          <span className="sb-text">{actionLabel ?? workflowLabel} · {complete}/{activeWorkflow.nodes.length}</span>
        </button>
      ),
    });
  }

  return (
    <div className="statusbar" role="status" aria-live="polite">
      {segments.map((s, i) => (
        <Fragment key={s.key}>
          {i > 0 && <span className="sb-sep" aria-hidden />}
          {s.node}
        </Fragment>
      ))}
      <span className="header-spacer" />
      <span className="sb sb-view">{VIEW_LABEL[view]}{paneTitle !== null ? ` · ${paneTitle}` : ""}</span>
    </div>
  );
}
