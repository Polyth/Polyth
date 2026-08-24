import { Fragment, useEffect, useState } from "react";
import type { WorkflowRunDto } from "@polyth/contracts";
import { setActiveView, useStore, type AppView } from "../store.ts";
import { isWorkspaceSurface, listSurfaces } from "../surfaces.ts";
import { api } from "../api.ts";

// UX-PANE-MODEL: Files/Git/Terminal/Preview are workspace panes beside Chat,
// not primary views — the open pane is appended to the label instead.
const VIEW_LABEL: Record<AppView, string> = {
  session: "Chat",
  goals: "Goals",
  multirun: "Multi-run",
  workflow: "Workflows",
  fusion: "Fusion",
  walkthrough: "Walkthrough",
  schedule: "Schedule",
  github: "GitHub",
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
  const [activeWorkflow, setActiveWorkflow] = useState<WorkflowRunDto | null>(null);
  const paneTitle = rail !== null
    ? listSurfaces().find((s) => s.id === rail && isWorkspaceSurface(s))?.title ?? null
    : null;

  useEffect(() => {
    if (!project?.id) {
      setActiveWorkflow(null);
      return;
    }
    let mounted = true;
    const refresh = () => {
      void api.listWorkflowRuns(project.id)
        .then((runs) => {
          if (mounted) setActiveWorkflow(runs.find((run) => run.status === "running") ?? null);
        })
        .catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, 1_200);
    return () => {
      mounted = false;
      clearInterval(timer);
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
      node: <span className="sb sb-model"><span className="mono">{session?.model?.modelID ?? "No model"}</span></span>,
    });
  }
  if (session?.agent) {
    segments.push({ key: "agent", node: <span className="sb sb-agent">{session.agent} agent</span> });
  }
  if (activeWorkflow) {
    const complete = activeWorkflow.nodes.filter((node) => node.status !== "queued" && node.status !== "running").length;
    const waiting = activeWorkflow.nodes.some((node) => /awaiting (permission|answer)/i.test(node.activity ?? ""));
    segments.push({
      key: "workflow",
      node: (
        <button
          type="button"
          className={`sb sb-workflow${waiting ? " waiting" : ""}`}
          title={waiting ? "Workflow needs your approval" : "Open active workflow"}
          onClick={() => setActiveView("workflow")}
        >
          <span className="workflow-status-spinner" aria-hidden="true" />
          <span className="sb-text">{waiting ? "Approval needed" : activeWorkflow.name} · {complete}/{activeWorkflow.nodes.length}</span>
        </button>
      ),
    });
  }

  return (
    <div className="statusbar">
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
